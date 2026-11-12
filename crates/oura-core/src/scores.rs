//! **Estimated** Sleep and Readiness scores.
//!
//! These are not Oura's scores. What is known about Oura's (see
//! `docs/algorithms/score-weights.md`) is the *combiner*: each score is
//! `round(Σ wᵢ·contributorᵢ / 100)`, and the weights were recovered by regression
//! against a trends export. Those weights are used here as-is.
//!
//! What is **not** recoverable from this repository is how Oura turns a raw metric
//! into each 0-100 contributor: the tables don't read back from the binary, and the
//! repo's Python tools re-fit them per user from a personal Oura export. The curves
//! below are therefore this project's own, hand-set to general sleep-health
//! guidance. Expect the same direction as Oura's numbers, not the same values.
//!
//! Not attempted: the Activity score (its largest contributors depend on a personal
//! calorie goal and multi-day training load held by the Oura account) and
//! Readiness's two activity contributors, for the same reason. Readiness is
//! combined from the remaining contributors with their weights renormalised.
//! See `docs/algorithms/estimated-scores.md`.

/// One input to a score, already mapped to 0-100.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Contributor {
    pub name: String,
    pub score: u8,
    /// Share of the final score, in percent of the contributors present.
    pub weight_percent: u8,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Score {
    pub value: u8,
    pub contributors: Vec<Contributor>,
    /// True while the personal baselines behind this score are still filling in
    /// (fewer than [`MATURE_NIGHTS`] nights of history).
    pub provisional: bool,
}

/// Nights of history a baseline looks back over, and needs to be considered settled.
pub const MATURE_NIGHTS: usize = 14;
/// Fewest prior nights before a baseline-relative contributor is used at all.
pub const MIN_BASELINE_NIGHTS: usize = 3;

/// Piecewise-linear interpolation through `(x, y)` knots sorted by x, clamped at
/// both ends.
fn interp(knots: &[(f64, f64)], x: f64) -> f64 {
    let (first, last) = (knots[0], knots[knots.len() - 1]);
    if x <= first.0 {
        return first.1;
    }
    if x >= last.0 {
        return last.1;
    }
    for pair in knots.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if x <= x1 {
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    last.1
}

/// Shortest distance between two clock hours on a 24 h circle.
fn clock_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(24.0);
    d.min(24.0 - d)
}

/// Circular mean of clock hours (so 23:00 and 01:00 average to midnight).
fn clock_mean(hours: &[f64]) -> Option<f64> {
    if hours.is_empty() {
        return None;
    }
    let (sin, cos) = hours.iter().fold((0.0, 0.0), |(s, c), h| {
        let angle = h * std::f64::consts::PI / 12.0;
        (s + angle.sin(), c + angle.cos())
    });
    Some((sin.atan2(cos) * 12.0 / std::f64::consts::PI).rem_euclid(24.0))
}

fn combine(parts: Vec<(&str, f64, f64)>, provisional: bool) -> Score {
    let total_weight: f64 = parts.iter().map(|(_, _, w)| w).sum();
    let value = parts.iter().map(|(_, s, w)| s * w).sum::<f64>() / total_weight;
    Score {
        value: value.round().clamp(0.0, 100.0) as u8,
        contributors: parts
            .into_iter()
            .map(|(name, score, weight)| Contributor {
                name: name.to_string(),
                score: score.round().clamp(0.0, 100.0) as u8,
                weight_percent: (weight / total_weight * 100.0).round() as u8,
            })
            .collect(),
        provisional,
    }
}

const TOTAL_SLEEP_HOURS: [(f64, f64); 7] = [
    (0.0, 0.0),
    (4.0, 20.0),
    (5.0, 40.0),
    (6.0, 60.0),
    (7.0, 80.0),
    (7.75, 95.0),
    (8.5, 100.0),
];

fn total_sleep_score(seconds: f64) -> f64 {
    interp(&TOTAL_SLEEP_HOURS, seconds / 3600.0)
}

pub struct SleepInputs {
    pub total_sleep_s: u32,
    pub deep_s: u32,
    pub rem_s: u32,
    pub awake_s: u32,
    pub time_in_bed_s: u32,
    /// Fraction of the night asleep, 0..1.
    pub efficiency: f64,
    pub latency_s: u32,
    /// Local clock hour (0..24) of the middle of the night.
    pub midpoint_hour: f64,
    /// Midpoint hours of up to the 7 preceding nights, for regularity.
    pub prior_midpoint_hours: Vec<f64>,
}

/// Sleep score: Oura's recovered weights (35/15/10/10/10/10/10) over this
/// project's contributor curves.
pub fn sleep_score(i: &SleepInputs) -> Score {
    let minutes = |s: u32| s as f64 / 60.0;
    let awake_fraction = i.awake_s as f64 / i.time_in_bed_s.max(1) as f64;

    // Very short latency usually means sleep deprivation; long means trouble
    // falling asleep. Best around a quarter of an hour.
    let latency = interp(
        &[
            (0.0, 70.0),
            (5.0, 85.0),
            (12.0, 100.0),
            (20.0, 100.0),
            (30.0, 85.0),
            (45.0, 60.0),
            (90.0, 20.0),
            (150.0, 0.0),
        ],
        minutes(i.latency_s),
    );

    // Best with the middle of the night near 03:00, less when it drifts from the
    // previous week's pattern.
    let alignment = interp(
        &[
            (1.0, 100.0),
            (2.0, 85.0),
            (3.0, 65.0),
            (4.5, 35.0),
            (6.0, 10.0),
            (8.0, 0.0),
        ],
        clock_distance(i.midpoint_hour, 3.0),
    );
    let drift = clock_mean(&i.prior_midpoint_hours)
        .map(|usual| clock_distance(i.midpoint_hour, usual))
        .unwrap_or(0.0);
    let timing = (alignment - ((drift - 0.5) * 10.0).clamp(0.0, 25.0)).max(0.0);

    combine(
        vec![
            (
                "Total sleep",
                total_sleep_score(i.total_sleep_s as f64),
                35.0,
            ),
            (
                "Restfulness",
                interp(
                    &[
                        (0.0, 100.0),
                        (0.05, 90.0),
                        (0.10, 75.0),
                        (0.20, 50.0),
                        (0.35, 20.0),
                        (0.50, 0.0),
                    ],
                    awake_fraction,
                ),
                15.0,
            ),
            (
                "Efficiency",
                interp(
                    &[
                        (0.50, 0.0),
                        (0.65, 25.0),
                        (0.75, 50.0),
                        (0.85, 85.0),
                        (0.90, 95.0),
                        (0.95, 100.0),
                    ],
                    i.efficiency,
                ),
                10.0,
            ),
            (
                "REM sleep",
                interp(
                    &[
                        (0.0, 0.0),
                        (30.0, 30.0),
                        (60.0, 65.0),
                        (90.0, 90.0),
                        (120.0, 100.0),
                    ],
                    minutes(i.rem_s),
                ),
                10.0,
            ),
            (
                "Deep sleep",
                interp(
                    &[
                        (0.0, 0.0),
                        (20.0, 30.0),
                        (45.0, 65.0),
                        (75.0, 90.0),
                        (105.0, 100.0),
                    ],
                    minutes(i.deep_s),
                ),
                10.0,
            ),
            ("Latency", latency, 10.0),
            ("Timing", timing, 10.0),
        ],
        false,
    )
}

/// Tonight's values and the trailing personal baselines they are compared against.
/// A `None` baseline means too little history; that contributor is left out.
#[derive(Default)]
pub struct ReadinessInputs {
    pub sleep_score: Option<u8>,
    pub lowest_hr_bpm: Option<f64>,
    pub baseline_lowest_hr_bpm: Option<f64>,
    pub hrv_ms: Option<f64>,
    pub baseline_hrv_ms: Option<f64>,
    pub skin_temp_c: Option<f64>,
    pub baseline_skin_temp_c: Option<f64>,
    /// Mean total sleep over the trailing nights including this one.
    pub recent_sleep_s: Option<f64>,
    /// Hours between the night's lowest heart rate and waking up.
    pub recovery_index_h: Option<f64>,
    pub history_nights: usize,
}

/// Readiness score from the contributors that can be derived from the ring, with
/// Oura's recovered weights renormalised over those present. `None` when fewer
/// than three contributors are available (typically the first few nights).
pub fn readiness_score(i: &ReadinessInputs) -> Option<Score> {
    let mut parts: Vec<(&str, f64, f64)> = Vec::new();

    if let (Some(hr), Some(base)) = (i.lowest_hr_bpm, i.baseline_lowest_hr_bpm) {
        let score = interp(
            &[
                (0.0, 100.0),
                (2.0, 85.0),
                (5.0, 55.0),
                (8.0, 30.0),
                (12.0, 0.0),
            ],
            hr - base,
        );
        parts.push(("Resting heart rate", score, 17.0));
    }
    if let Some(score) = i.sleep_score {
        parts.push(("Previous night", score as f64, 15.0));
    }
    if let (Some(hrv), Some(base)) = (i.hrv_ms, i.baseline_hrv_ms) {
        if base > 0.0 {
            let score = interp(
                &[
                    (0.4, 0.0),
                    (0.6, 30.0),
                    (0.8, 65.0),
                    (0.9, 85.0),
                    (1.0, 100.0),
                ],
                hrv / base,
            );
            parts.push(("HRV balance", score, 15.0));
        }
    }
    if let (Some(temp), Some(base)) = (i.skin_temp_c, i.baseline_skin_temp_c) {
        let score = interp(
            &[
                (0.3, 100.0),
                (0.5, 85.0),
                (1.0, 45.0),
                (1.5, 10.0),
                (2.0, 0.0),
            ],
            (temp - base).abs(),
        );
        parts.push(("Body temperature", score, 13.0));
    }
    if let Some(recent) = i.recent_sleep_s {
        parts.push(("Sleep balance", total_sleep_score(recent), 12.0));
    }
    if let Some(hours) = i.recovery_index_h {
        let score = interp(
            &[(0.0, 20.0), (1.0, 40.0), (3.0, 70.0), (6.0, 100.0)],
            hours,
        );
        parts.push(("Recovery index", score, 10.0));
    }

    if parts.len() < 3 {
        return None;
    }
    Some(combine(parts, i.history_nights < MATURE_NIGHTS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_night() -> SleepInputs {
        SleepInputs {
            total_sleep_s: 8 * 3600,
            deep_s: 100 * 60,
            rem_s: 110 * 60,
            awake_s: 20 * 60,
            time_in_bed_s: 8 * 3600 + 20 * 60,
            efficiency: 0.96,
            latency_s: 15 * 60,
            midpoint_hour: 3.0,
            prior_midpoint_hours: vec![3.0, 3.2, 2.8],
        }
    }

    #[test]
    fn interpolates_and_clamps() {
        let knots = [(0.0, 0.0), (10.0, 100.0)];
        assert_eq!(interp(&knots, -5.0), 0.0);
        assert_eq!(interp(&knots, 2.5), 25.0);
        assert_eq!(interp(&knots, 99.0), 100.0);
    }

    #[test]
    fn clock_maths_wraps_midnight() {
        assert_eq!(clock_distance(23.0, 1.0), 2.0);
        let mean = clock_mean(&[23.0, 1.0]).unwrap();
        assert!(clock_distance(mean, 0.0) < 1e-9);
        assert_eq!(clock_mean(&[]), None);
    }

    #[test]
    fn sleep_weights_are_the_recovered_ones() {
        let score = sleep_score(&good_night());
        let weights: Vec<u8> = score
            .contributors
            .iter()
            .map(|c| c.weight_percent)
            .collect();
        assert_eq!(weights, [35, 15, 10, 10, 10, 10, 10]);
        assert!(score.value >= 90, "good night scored {}", score.value);
        assert!(!score.provisional);
    }

    #[test]
    fn a_short_broken_late_night_scores_low() {
        let score = sleep_score(&SleepInputs {
            total_sleep_s: 4 * 3600 + 1800,
            deep_s: 15 * 60,
            rem_s: 25 * 60,
            awake_s: 90 * 60,
            time_in_bed_s: 6 * 3600,
            efficiency: 0.75,
            latency_s: 50 * 60,
            midpoint_hour: 7.0,
            prior_midpoint_hours: vec![3.0, 3.0],
        });
        assert!(score.value < 50, "bad night scored {}", score.value);
        // Every contributor moved the right way.
        let good = sleep_score(&good_night());
        for (bad, good) in score.contributors.iter().zip(&good.contributors) {
            assert!(bad.score < good.score, "{} did not drop", bad.name);
        }
    }

    #[test]
    fn readiness_needs_enough_contributors() {
        let inputs = ReadinessInputs {
            sleep_score: Some(80),
            recovery_index_h: Some(4.0),
            ..Default::default()
        };
        assert_eq!(readiness_score(&inputs), None);
    }

    #[test]
    fn readiness_tracks_strain_against_baseline() {
        let rested = ReadinessInputs {
            sleep_score: Some(88),
            lowest_hr_bpm: Some(50.0),
            baseline_lowest_hr_bpm: Some(51.0),
            hrv_ms: Some(62.0),
            baseline_hrv_ms: Some(60.0),
            skin_temp_c: Some(34.9),
            baseline_skin_temp_c: Some(34.8),
            recent_sleep_s: Some(7.8 * 3600.0),
            recovery_index_h: Some(5.5),
            history_nights: 20,
        };
        let strained = ReadinessInputs {
            sleep_score: Some(55),
            lowest_hr_bpm: Some(58.0),
            hrv_ms: Some(40.0),
            skin_temp_c: Some(35.9),
            recovery_index_h: Some(0.5),
            history_nights: 5,
            ..rested
        };
        let rested = readiness_score(&rested).unwrap();
        let strained = readiness_score(&strained).unwrap();
        assert!(rested.value >= 90, "rested scored {}", rested.value);
        assert!(strained.value < 55, "strained scored {}", strained.value);
        assert!(!rested.provisional);
        assert!(strained.provisional);
        // Weights are renormalised over the six contributors present.
        let total: u32 = rested
            .contributors
            .iter()
            .map(|c| c.weight_percent as u32)
            .sum();
        assert!((99..=101).contains(&total));
    }
}
