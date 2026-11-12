//! Sleep and Readiness scores.
//!
//! Three different things live here, and each [`Score`] says which it is through
//! its [`ScoreBasis`]:
//!
//! - **Published norms** ([`norms_sleep_score`]): a sleep score whose every
//!   threshold comes from published sleep-science recommendations. Ported from
//!   `open_health` (`crates/oura-summary/src/sleep_score.rs`, MIT, © Thomas
//!   Marchand). It is deliberately *not* Oura's score.
//! - **Oura-calibrated** ([`crate::calibration`]): Oura's recovered weights with
//!   contributor curves fitted to the user's own Oura trends export.
//! - **Estimate** ([`readiness_score`]): Oura's recovered Readiness weights over
//!   this project's own hand-set curves, used until a calibration is imported.
//!
//! None of these is a port of Oura's scoring: its constant tables do not read back
//! from the binary (`docs/algorithms/README.md`). There is no Activity score: its
//! main contributors depend on a personal calorie goal and training load held by
//! the Oura account. See `docs/algorithms/estimated-scores.md`.

/// Where a score's thresholds come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ScoreBasis {
    /// Published sleep-science recommendations; not Oura's score.
    PublishedNorms,
    /// Oura's weights with curves fitted to the user's own Oura export.
    OuraCalibrated,
    /// Oura's weights with this project's uncalibrated curves.
    Estimate,
}

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
    pub basis: ScoreBasis,
}

/// Nights of history a baseline looks back over, and needs to be considered settled.
pub const MATURE_NIGHTS: usize = 14;
/// Fewest prior nights before a baseline-relative contributor is used at all.
pub const MIN_BASELINE_NIGHTS: usize = 3;

/// Piecewise-linear interpolation through `(x, y)` knots sorted by x, clamped at
/// both ends.
pub(crate) fn interp(knots: &[(f64, f64)], x: f64) -> f64 {
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
pub(crate) fn clock_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(24.0);
    d.min(24.0 - d)
}

/// Circular mean of clock hours (so 23:00 and 01:00 average to midnight).
pub(crate) fn clock_mean(hours: &[f64]) -> Option<f64> {
    if hours.is_empty() {
        return None;
    }
    let (sin, cos) = hours.iter().fold((0.0, 0.0), |(s, c), h| {
        let angle = h * std::f64::consts::PI / 12.0;
        (s + angle.sin(), c + angle.cos())
    });
    Some((sin.atan2(cos) * 12.0 / std::f64::consts::PI).rem_euclid(24.0))
}

pub(crate) fn combine(parts: Vec<(&str, f64, f64)>, provisional: bool, basis: ScoreBasis) -> Score {
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
        basis,
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

/// What a night supplies to [`norms_sleep_score`]. Everything is optional:
/// components with no input drop out of the weighting rather than scoring zero.
#[derive(Default, Clone, Copy)]
pub struct NormsInputs {
    pub asleep_min: Option<f64>,
    pub efficiency_pct: Option<f64>,
    pub onset_latency_min: Option<f64>,
    /// Minutes awake after first falling asleep.
    pub waso_min: Option<f64>,
    pub awakenings: Option<f64>,
    /// Share of the night in deep / REM sleep, in percent.
    pub deep_pct: Option<f64>,
    pub rem_pct: Option<f64>,
    /// Lowest heart rate of the night, with the wearer's own baseline `(mean, sd)`.
    pub rhr: Option<f64>,
    pub rhr_baseline: Option<(f64, f64)>,
    pub hrv_ms: Option<f64>,
    pub hrv_baseline: Option<(f64, f64)>,
    /// Age in years: the recommendation bands are age-specific.
    pub age: f64,
}

/// `(mean, sd)` of strictly preceding nights, or `None` with fewer than
/// [`MIN_BASELINE_NIGHTS`] of them.
pub fn causal_baseline(prior_values: &[f64]) -> Option<(f64, f64)> {
    if prior_values.len() < MIN_BASELINE_NIGHTS {
        return None;
    }
    let n = prior_values.len() as f64;
    let mean = prior_values.iter().sum::<f64>() / n;
    let variance = prior_values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    let sd = variance.sqrt();
    Some((mean, if sd > 1e-6 { sd } else { 1.0 }))
}

/// Recommended sleep duration in hours for an age (Hirshkowitz 2015, Table 1):
/// `(may be appropriate low, recommended low, recommended high, may be appropriate
/// high)`.
fn duration_band(age: f64) -> (f64, f64, f64, f64) {
    match age {
        a if a < 14.0 => (7.0, 9.0, 11.0, 12.0),
        a if a < 18.0 => (7.0, 8.0, 10.0, 11.0),
        a if a < 26.0 => (6.0, 7.0, 9.0, 11.0),
        a if a < 65.0 => (6.0, 7.0, 9.0, 10.0),
        _ => (5.0, 7.0, 8.0, 9.0),
    }
}

/// A sleep score built from published sleep science rather than fitted to Oura's.
///
/// Thresholds are transcribed (via `open_health`) from:
/// Hirshkowitz 2015 (NSF duration by age); Ohayon 2017 (NSF sleep-quality bands for
/// efficiency, latency, wake after sleep onset, awakenings); Boulos 2019 (healthy
/// stage percentages). Stage architecture is weighted low because consumer staging
/// is weakest at telling stages apart (de Zambotti 2019). Resting heart rate and
/// HRV are scored against the wearer's own baseline. They are consensus
/// appropriateness bands, not clinical cut-offs.
///
/// A component with no data drops out and the rest renormalise. `None` when
/// nothing scoreable was supplied.
pub fn norms_sleep_score(input: &NormsInputs) -> Option<Score> {
    let mut parts: Vec<(&str, f64, f64)> = Vec::new();

    if let Some(asleep_min) = input.asleep_min {
        let (may_lo, rec_lo, rec_hi, may_hi) = duration_band(input.age);
        let score = interp(
            &[
                (may_lo - 2.0, 0.0),
                (may_lo, 50.0),
                (rec_lo, 90.0),
                (rec_lo + 0.5, 100.0),
                (rec_hi, 100.0),
                (may_hi, 75.0),
                (may_hi + 2.0, 40.0),
            ],
            asleep_min / 60.0,
        );
        parts.push(("Duration", score, 30.0));
    }
    if let Some(efficiency) = input.efficiency_pct {
        let score = interp(
            &[
                (60.0, 0.0),
                (75.0, 40.0),
                (85.0, 85.0),
                (92.0, 100.0),
                (100.0, 100.0),
            ],
            efficiency,
        );
        parts.push(("Efficiency", score, 20.0));
    }
    if let Some(latency) = input.onset_latency_min {
        let score = interp(
            &[
                (0.0, 100.0),
                (15.0, 100.0),
                (30.0, 70.0),
                (45.0, 40.0),
                (60.0, 20.0),
                (120.0, 0.0),
            ],
            latency,
        );
        parts.push(("Time to fall asleep", score, 10.0));
    }
    if let Some(waso) = input.waso_min {
        let appropriate = if input.age >= 65.0 { 30.0 } else { 20.0 };
        let score = interp(
            &[
                (0.0, 100.0),
                (appropriate, 95.0),
                (appropriate * 2.0, 65.0),
                (appropriate * 3.0, 35.0),
                (appropriate * 5.0, 0.0),
            ],
            waso,
        );
        parts.push(("Awake during the night", score, 15.0));
    }
    if let Some(awakenings) = input.awakenings {
        // Ohayon counts only awakenings over 5 minutes; a hypnogram count includes
        // brief arousals, so this is scored leniently and weighted low.
        let score = interp(
            &[
                (0.0, 100.0),
                (2.0, 95.0),
                (5.0, 75.0),
                (10.0, 45.0),
                (20.0, 10.0),
            ],
            awakenings,
        );
        parts.push(("Awakenings", score, 5.0));
    }

    let mut architecture: Vec<f64> = Vec::new();
    if let Some(deep) = input.deep_pct {
        architecture.push(interp(
            &[
                (0.0, 0.0),
                (8.0, 50.0),
                (13.0, 95.0),
                (16.0, 100.0),
                (23.0, 100.0),
                (35.0, 85.0),
            ],
            deep,
        ));
    }
    if let Some(rem) = input.rem_pct {
        architecture.push(interp(
            &[
                (0.0, 0.0),
                (10.0, 45.0),
                (20.0, 95.0),
                (22.0, 100.0),
                (25.0, 100.0),
                (35.0, 80.0),
            ],
            rem,
        ));
    }
    if !architecture.is_empty() {
        let score = architecture.iter().sum::<f64>() / architecture.len() as f64;
        parts.push(("Sleep stages", score, 10.0));
    }

    let mut physiology: Vec<f64> = Vec::new();
    if let (Some(rhr), Some((mean, sd))) = (input.rhr, input.rhr_baseline) {
        if sd > 0.0 {
            physiology.push(interp(
                &[
                    (-2.0, 100.0),
                    (0.0, 90.0),
                    (1.0, 70.0),
                    (2.0, 40.0),
                    (3.5, 10.0),
                ],
                (rhr - mean) / sd,
            ));
        }
    }
    if let (Some(hrv), Some((mean, sd))) = (input.hrv_ms, input.hrv_baseline) {
        if sd > 0.0 {
            physiology.push(interp(
                &[
                    (-3.0, 10.0),
                    (-2.0, 35.0),
                    (-1.0, 70.0),
                    (0.0, 90.0),
                    (1.5, 100.0),
                ],
                (hrv - mean) / sd,
            ));
        }
    }
    if !physiology.is_empty() {
        let score = physiology.iter().sum::<f64>() / physiology.len() as f64;
        parts.push(("Heart rate and HRV", score, 10.0));
    }

    if parts.is_empty() {
        return None;
    }
    Some(combine(parts, false, ScoreBasis::PublishedNorms))
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
    Some(combine(
        parts,
        i.history_nights < MATURE_NIGHTS,
        ScoreBasis::Estimate,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn adult(mut input: NormsInputs) -> NormsInputs {
        input.age = 40.0;
        input
    }

    #[test]
    fn a_textbook_night_scores_high() {
        let score = norms_sleep_score(&adult(NormsInputs {
            asleep_min: Some(8.0 * 60.0),
            efficiency_pct: Some(92.0),
            onset_latency_min: Some(12.0),
            waso_min: Some(15.0),
            awakenings: Some(1.0),
            deep_pct: Some(18.0),
            rem_pct: Some(22.0),
            ..Default::default()
        }))
        .unwrap();
        assert!(score.value >= 95, "{}", score.value);
        assert_eq!(score.basis, ScoreBasis::PublishedNorms);
    }

    #[test]
    fn short_broken_sleep_scores_low() {
        let score = norms_sleep_score(&adult(NormsInputs {
            asleep_min: Some(4.0 * 60.0),
            efficiency_pct: Some(66.0),
            onset_latency_min: Some(55.0),
            waso_min: Some(90.0),
            awakenings: Some(12.0),
            deep_pct: Some(5.0),
            rem_pct: Some(8.0),
            ..Default::default()
        }))
        .unwrap();
        assert!(score.value <= 40, "{}", score.value);
    }

    #[test]
    fn missing_components_renormalise_instead_of_scoring_zero() {
        let full = norms_sleep_score(&adult(NormsInputs {
            asleep_min: Some(8.0 * 60.0),
            efficiency_pct: Some(90.0),
            deep_pct: Some(18.0),
            rem_pct: Some(22.0),
            ..Default::default()
        }))
        .unwrap();
        let partial = norms_sleep_score(&adult(NormsInputs {
            asleep_min: Some(8.0 * 60.0),
            efficiency_pct: Some(90.0),
            ..Default::default()
        }))
        .unwrap();
        assert!((full.value as i32 - partial.value as i32).abs() < 6);
        let weights: u32 = partial
            .contributors
            .iter()
            .map(|c| c.weight_percent as u32)
            .sum();
        assert_eq!(weights, 100);
        assert_eq!(norms_sleep_score(&NormsInputs::default()), None);
    }

    #[test]
    fn duration_bands_follow_age() {
        let night = |hours: f64, age: f64| {
            norms_sleep_score(&NormsInputs {
                asleep_min: Some(hours * 60.0),
                age,
                ..Default::default()
            })
            .unwrap()
            .value
        };
        assert_eq!(night(7.5, 40.0), 100);
        assert_eq!(night(7.5, 70.0), 100);
        // 9.5 h is still "may be appropriate" at 40 but past the older-adult band.
        assert!(night(9.5, 40.0) > night(9.5, 70.0));
    }

    #[test]
    fn physiology_is_scored_against_the_personal_baseline() {
        let base = causal_baseline(&[50.0, 52.0, 51.0, 49.0]).unwrap();
        assert_eq!(causal_baseline(&[50.0, 52.0]), None);
        let night = |rhr: f64| {
            norms_sleep_score(&adult(NormsInputs {
                rhr: Some(rhr),
                rhr_baseline: Some(base),
                ..Default::default()
            }))
            .unwrap()
            .value
        };
        assert!(night(50.0) > night(56.0));
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
