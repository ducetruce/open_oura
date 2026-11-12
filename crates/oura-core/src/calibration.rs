//! Oura-calibrated scores: evaluate a `score_params.json` produced by
//! `tools/calibrate_scores.py`.
//!
//! That tool fits, from the user's own Oura trends export, a curve from raw
//! metric(s) to each 0-100 contributor, and stores them next to the recovered
//! combiner weights. This module is the Rust twin of `score_from_params` in
//! `tools/fit_sleep_score.py`: same curve kinds, same fallbacks, same combiner
//! (`round(Σ wᵢ·subᵢ / 100)`), so a night scores the same here as on the desktop
//! given the same inputs.
//!
//! The inputs are where the app still differs from Oura: stages come from the
//! ring's firmware hypnogram rather than Oura's phone-side staging model, and the
//! day's average MET is this app's own aggregate. See
//! `docs/algorithms/estimated-scores.md`.

use std::collections::HashMap;

use serde_json::Value;

use crate::scores::{Contributor, Score, ScoreBasis};

pub const SLEEP: &str = "Sleep Score";
pub const READINESS: &str = "Readiness Score";

/// Summary of an imported calibration, for display.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CalibrationInfo {
    /// File name of the trends export it was fitted from.
    pub source: String,
    /// Days of export data behind the fit.
    pub days: u32,
    pub has_sleep: bool,
    pub has_readiness: bool,
}

#[derive(Debug)]
enum Curve {
    /// Isotonic curve on one driver (negated first when `sign` is -1).
    Mono {
        sign: f64,
        xs: Vec<f64>,
        ys: Vec<f64>,
    },
    /// Binned empirical curve on one driver (e.g. the U-shaped latency curve).
    Emp { xs: Vec<f64>, ys: Vec<f64> },
    /// Linear fit over several drivers; the last coefficient is the intercept.
    Lin { b: Vec<f64> },
    /// Constant, for contributors whose driver is not in the export.
    Mean { v: f64 },
}

#[derive(Debug)]
struct Spec {
    drivers: Vec<String>,
    curve: Curve,
}

#[derive(Debug)]
pub struct Calibration {
    /// Score name → `(contributor, weight)` in descending weight order.
    weights: HashMap<String, Vec<(String, f64)>>,
    contributors: HashMap<String, Spec>,
    info: CalibrationInfo,
}

/// `numpy.interp`: linear interpolation over increasing `xs`, clamped at the ends.
fn interp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let upper = xs.partition_point(|v| *v <= x);
    if upper == 0 {
        return ys[0];
    }
    if upper == xs.len() {
        return ys[ys.len() - 1];
    }
    let (x0, x1) = (xs[upper - 1], xs[upper]);
    let (y0, y1) = (ys[upper - 1], ys[upper]);
    if x1 <= x0 {
        y0
    } else {
        y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    }
}

fn numbers(value: &Value, what: &str) -> Result<Vec<f64>, String> {
    let list = value
        .as_array()
        .ok_or_else(|| format!("{what} is not a list"))?;
    list.iter()
        .map(|v| {
            v.as_f64()
                .filter(|f| f.is_finite())
                .ok_or_else(|| format!("{what} holds a non-number"))
        })
        .collect()
}

fn parse_curve(name: &str, value: &Value, drivers: usize) -> Result<Curve, String> {
    let points = |value: &Value| -> Result<(Vec<f64>, Vec<f64>), String> {
        let xs = numbers(&value["xs"], &format!("{name}.xs"))?;
        let ys = numbers(&value["ys"], &format!("{name}.ys"))?;
        if xs.is_empty() || xs.len() != ys.len() {
            return Err(format!(
                "{name}: xs and ys must be non-empty and equal in length"
            ));
        }
        if xs.windows(2).any(|w| w[1] < w[0]) {
            return Err(format!("{name}: xs must be increasing"));
        }
        Ok((xs, ys))
    };
    match value["kind"].as_str() {
        Some("mono") => {
            let (xs, ys) = points(value)?;
            let sign = value["sign"].as_f64().unwrap_or(1.0);
            Ok(Curve::Mono { sign, xs, ys })
        }
        Some("emp") => {
            let (xs, ys) = points(value)?;
            Ok(Curve::Emp { xs, ys })
        }
        Some("lin") => {
            let b = numbers(&value["b"], &format!("{name}.b"))?;
            if b.len() != drivers + 1 {
                return Err(format!(
                    "{name}: {} coefficients for {drivers} drivers",
                    b.len()
                ));
            }
            Ok(Curve::Lin { b })
        }
        Some("mean") => value["v"]
            .as_f64()
            .map(|v| Curve::Mean { v })
            .ok_or_else(|| format!("{name}: constant curve has no value")),
        other => Err(format!("{name}: unknown curve kind {other:?}")),
    }
}

/// "Sleep Timin Score" (the export's own typo) → "Sleep timing".
fn display_name(contributor: &str) -> String {
    let lower = contributor
        .trim_end_matches(" Score")
        .replace("Sleep Timin", "Sleep Timing")
        .to_lowercase();
    let mut chars = lower.chars();
    let sentence = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => lower,
    };
    sentence
        .replace("Hrv", "HRV")
        .replace("hrv", "HRV")
        .replace("Rem ", "REM ")
}

impl Calibration {
    /// Parse and validate the JSON written by `tools/calibrate_scores.py`.
    pub fn parse(json: &str) -> Result<Self, String> {
        let root: Value = serde_json::from_str(json).map_err(|e| format!("not valid JSON: {e}"))?;
        let weights_json = root["weights"]
            .as_object()
            .ok_or("no \"weights\" section: is this a score_params.json?")?;
        let specs_json = root["contributors"]
            .as_object()
            .ok_or("no \"contributors\" section: is this a score_params.json?")?;

        let mut contributors = HashMap::new();
        for (name, spec) in specs_json {
            let drivers: Vec<String> = spec["drivers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let curve = parse_curve(name, &spec["curve"], drivers.len())?;
            contributors.insert(name.clone(), Spec { drivers, curve });
        }

        let mut weights = HashMap::new();
        for (score, entries) in weights_json {
            let mut list: Vec<(String, f64)> = entries
                .as_object()
                .ok_or_else(|| format!("weights for {score} are not an object"))?
                .iter()
                .filter_map(|(name, w)| w.as_f64().map(|w| (name.clone(), w)))
                .collect();
            list.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            weights.insert(score.clone(), list);
        }

        let covered = |score: &str| {
            weights
                .get(score)
                .is_some_and(|list| list.iter().any(|(name, _)| contributors.contains_key(name)))
        };
        let info = CalibrationInfo {
            source: root["source"].as_str().unwrap_or("").to_string(),
            days: root["n_days"].as_u64().unwrap_or(0) as u32,
            has_sleep: covered(SLEEP),
            has_readiness: covered(READINESS),
        };
        if !info.has_sleep && !info.has_readiness {
            return Err("the file calibrates neither the Sleep nor the Readiness score".into());
        }
        Ok(Self {
            weights,
            contributors,
            info,
        })
    }

    pub fn info(&self) -> CalibrationInfo {
        self.info.clone()
    }

    /// Score one night/day from its raw metrics. A contributor whose driver is
    /// missing falls back to its fitted constant, or 50, as the Python scorer does.
    /// `None` when the calibration does not cover `score_name`.
    pub fn score(
        &self,
        score_name: &str,
        metrics: &HashMap<&str, f64>,
        provisional: bool,
    ) -> Option<Score> {
        let covered = match score_name {
            SLEEP => self.info.has_sleep,
            READINESS => self.info.has_readiness,
            _ => false,
        };
        if !covered {
            return None;
        }
        let weights = self.weights.get(score_name)?;
        let mut total = 0.0;
        let mut contributors = Vec::with_capacity(weights.len());
        for (name, weight) in weights {
            let sub = self.sub_score(name, metrics);
            total += weight * sub / 100.0;
            contributors.push(Contributor {
                name: display_name(name),
                score: sub.round() as u8,
                weight_percent: weight.round().clamp(0.0, 100.0) as u8,
            });
        }
        Some(Score {
            value: total.round().clamp(0.0, 100.0) as u8,
            contributors,
            provisional,
            basis: ScoreBasis::OuraCalibrated,
        })
    }

    fn sub_score(&self, name: &str, metrics: &HashMap<&str, f64>) -> f64 {
        let Some(spec) = self.contributors.get(name) else {
            return 50.0;
        };
        let driver = |i: usize| metrics.get(spec.drivers.get(i)?.as_str()).copied();
        let raw = match &spec.curve {
            Curve::Mean { v } => Some(*v),
            Curve::Mono { sign, xs, ys } => driver(0).map(|x| interp(xs, ys, sign * x)),
            Curve::Emp { xs, ys } => driver(0).map(|x| interp(xs, ys, x)),
            Curve::Lin { b } => (0..spec.drivers.len())
                .map(driver)
                .collect::<Option<Vec<f64>>>()
                .map(|values| {
                    values.iter().zip(b).map(|(x, c)| x * c).sum::<f64>() + b[b.len() - 1]
                }),
        };
        raw.unwrap_or(50.0).clamp(1.0, 100.0)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A small calibration shaped exactly like `tools/calibrate_scores.py` output.
    pub(crate) const SAMPLE: &str = r#"{
      "source": "oura_trends.csv",
      "n_days": 336,
      "weights": {
        "Sleep Score": {
          "Total Sleep Score": 35, "Restfulness Score": 15, "Sleep Efficiency Score": 10,
          "REM Sleep Score": 10, "Deep Sleep Score": 10, "Sleep Latency Score": 10,
          "Sleep Timin Score": 10
        },
        "Readiness Score": {
          "Resting Heart Rate Score": 17, "Previous Night Score": 15, "HRV Balance Score": 15,
          "Temperature Score": 13, "Sleep Balance Score": 12,
          "Previous Day Activity Score": 10, "Recovery Index Score": 10,
          "Activity Balance Score": 8
        }
      },
      "contributors": {
        "Total Sleep Score": {"drivers": ["Total Sleep Duration"],
          "curve": {"kind": "mono", "sign": 1.0, "xs": [14400, 21600, 28800], "ys": [20, 60, 100]}},
        "Sleep Efficiency Score": {"drivers": ["Sleep Efficiency"],
          "curve": {"kind": "mono", "sign": 1.0, "xs": [60, 95], "ys": [10, 100]}},
        "REM Sleep Score": {"drivers": ["REM Sleep Duration"],
          "curve": {"kind": "mono", "sign": 1.0, "xs": [0, 7200], "ys": [0, 100]}},
        "Deep Sleep Score": {"drivers": ["Deep Sleep Duration"],
          "curve": {"kind": "mono", "sign": 1.0, "xs": [0, 5400], "ys": [0, 100]}},
        "Sleep Latency Score": {"drivers": ["Sleep Latency"],
          "curve": {"kind": "emp", "xs": [0, 900, 3600], "ys": [70, 100, 30]}},
        "Restfulness Score": {"drivers": ["awake_frac", "Sleep Efficiency"],
          "curve": {"kind": "lin", "b": [-200.0, 0.5, 45.0]}},
        "Sleep Timin Score": {"drivers": ["mid_opt", "mid_reg", "mid_hour"],
          "curve": {"kind": "lin", "b": [8.0, -10.0, 0.0, 100.0]}},
        "Previous Night Score": {"drivers": ["Sleep Score"],
          "curve": {"kind": "mono", "sign": 1.0, "xs": [40, 100], "ys": [40, 100]}},
        "Resting Heart Rate Score": {"drivers": ["Lowest Resting Heart Rate",
            "Average Resting Heart Rate", "trail14_Average Resting Heart Rate"],
          "curve": {"kind": "lin", "b": [-3.0, -2.0, 5.0, 90.0]}},
        "HRV Balance Score": {"drivers": ["Average HRV", "trail14_Average HRV"],
          "curve": {"kind": "lin", "b": [1.5, -1.5, 85.0]}},
        "Temperature Score": {"drivers": ["Temperature Deviation (°C)"],
          "curve": {"kind": "emp", "xs": [-1.0, 0.0, 1.0], "ys": [60, 100, 50]}},
        "Sleep Balance Score": {"drivers": ["Total Sleep Duration", "trail14_Total Sleep Duration"],
          "curve": {"kind": "lin", "b": [0.001, 0.002, 5.0]}},
        "Previous Day Activity Score": {"drivers": ["prev_Average MET"],
          "curve": {"kind": "mono", "sign": -1.0, "xs": [-2.0, -1.2], "ys": [60, 95]}},
        "Activity Balance Score": {"drivers": ["prev_Average MET", "trail14_Average MET"],
          "curve": {"kind": "lin", "b": [-10.0, 10.0, 90.0]}},
        "Recovery Index Score": {"drivers": [], "curve": {"kind": "mean", "v": 88.0}}
      }
    }"#;

    #[test]
    fn interp_matches_numpy() {
        let (xs, ys) = ([0.0, 10.0, 20.0], [0.0, 100.0, 50.0]);
        assert_eq!(interp(&xs, &ys, -1.0), 0.0);
        assert_eq!(interp(&xs, &ys, 5.0), 50.0);
        assert_eq!(interp(&xs, &ys, 10.0), 100.0);
        assert_eq!(interp(&xs, &ys, 15.0), 75.0);
        assert_eq!(interp(&xs, &ys, 99.0), 50.0);
    }

    #[test]
    fn scores_a_night_like_the_python_scorer() {
        let calibration = Calibration::parse(SAMPLE).unwrap();
        assert_eq!(
            calibration.info(),
            CalibrationInfo {
                source: "oura_trends.csv".into(),
                days: 336,
                has_sleep: true,
                has_readiness: true,
            }
        );
        let metrics = HashMap::from([
            ("Total Sleep Duration", 25_200.0), // 7 h → 80
            ("Sleep Efficiency", 88.0),         // → 82
            ("REM Sleep Duration", 5_400.0),    // → 75
            ("Deep Sleep Duration", 4_050.0),   // → 75
            ("Sleep Latency", 900.0),           // → 100
            ("awake_frac", 0.1),                // -20 + 44 + 45 → 69
            ("mid_opt", -1.0),                  // -8 - 5 + 100 → 87
            ("mid_reg", 0.5),
            ("mid_hour", 28.0),
        ]);
        let score = calibration.score(SLEEP, &metrics, false).unwrap();
        // 0.35·80 + 0.15·69 + 0.1·(82 + 75 + 75 + 100 + 87) = 80.25
        assert_eq!(score.value, 80);
        assert_eq!(score.basis, ScoreBasis::OuraCalibrated);
        assert_eq!(score.contributors[0].name, "Total sleep");
        assert_eq!(score.contributors[0].weight_percent, 35);
        let names: Vec<&str> = score.contributors.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Sleep timing") && names.contains(&"REM sleep"));
    }

    #[test]
    fn missing_drivers_fall_back_instead_of_failing() {
        let calibration = Calibration::parse(SAMPLE).unwrap();
        let score = calibration.score(READINESS, &HashMap::new(), true).unwrap();
        let by_name = |name: &str| {
            score
                .contributors
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .score
        };
        // A constant curve keeps its fitted value; everything else is neutral.
        assert_eq!(by_name("Recovery index"), 88);
        assert_eq!(by_name("HRV balance"), 50);
        assert!(score.provisional);
    }

    #[test]
    fn rejects_files_that_are_not_calibrations() {
        assert!(Calibration::parse("not json").is_err());
        assert!(Calibration::parse("{}").is_err());
        let broken = SAMPLE.replace("\"xs\": [0, 7200]", "\"xs\": [0]");
        assert!(Calibration::parse(&broken).unwrap_err().contains("REM"));
        let unsorted = SAMPLE.replace("\"xs\": [60, 95]", "\"xs\": [95, 60]");
        assert!(Calibration::parse(&unsorted).is_err());
    }
}
