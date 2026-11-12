# Scores in the iOS app (`oura-core`)

The app shows up to three kinds of score. None is a port of Oura's scoring: its
constant tables do not read back from the binary (see [`README.md`](README.md)).
Each `Score` carries a `basis` saying which kind it is.

| Basis | Score | Source of the thresholds | Code |
| --- | --- | --- | --- |
| `PublishedNorms` | Sleep | published sleep-science recommendations | `scores.rs::norms_sleep_score` |
| `OuraCalibrated` | Sleep, Readiness | Oura's weights + curves fitted to the user's own Oura trends export | `calibration.rs` |
| `Estimate` | Readiness | Oura's weights + this project's hand-set curves | `scores.rs::readiness_score` |

There is no Activity score: its main contributors depend on a personal calorie
goal and multi-day training load held by the Oura account, not on the ring.

All sleep scores need a **completely staged** night. Stages are the ring's own
`sleep_phase_data` hypnogram (firmware staging), not Oura's phone-side staging
model, which is the main remaining difference from the official app's inputs.

## Published-norms sleep score

Ported from upstream `open_health` (`crates/oura-summary/src/sleep_score.rs`, MIT,
© Thomas Marchand), which describes it as "a sleep score you can argue with": every
threshold traces to a paper rather than to a fit against Oura's number. Each
component is a piecewise-linear curve pinned at the papers' band edges; components
combine as a weighted mean, and a component with no data drops out.

| Component | Weight | Input | Source |
| --- | --- | --- | --- |
| Duration | 30 | hours asleep, against the recommended range for the age band | Hirshkowitz 2015 (NSF duration) |
| Efficiency | 20 | asleep ÷ time in bed; ≥85 % appropriate | Ohayon 2017 (NSF quality) |
| Awake during the night | 15 | minutes awake after sleep onset; ≤20 appropriate (≤30 from 65) | Ohayon 2017 |
| Time to fall asleep | 10 | onset latency; ≤15 min appropriate | Ohayon 2017 |
| Sleep stages | 10 | deep 13-23 %, REM 20-25 % of the night | Boulos 2019 |
| Heart rate and HRV | 10 | lowest HR and mean HRV as z-scores against the wearer's own earlier main sleeps (needs 3) | personal baseline |
| Awakenings | 5 | awakenings ≥ 1 min | Ohayon 2017 (scored leniently: the paper counts only > 5 min) |

Stage architecture is weighted low because consumer staging is weakest at telling
stages apart (de Zambotti 2019). Age comes from the app's setting; 40 is assumed
when unset. These are consensus appropriateness bands, not clinical cut-offs.

## Oura-calibrated scores

`tools/calibrate_scores.py` fits, from an Oura account's trends export, one curve
per contributor (isotonic, binned-empirical, linear, or constant) and stores them
with the recovered combiner weights in `score_params.json`. The app imports that
file (Ring tab → Scores) and `calibration.rs` evaluates it exactly like
`tools/fit_sleep_score.py::score_from_params`: same curve kinds, same clamp to
1-100, same fallbacks for a missing driver, same `round(Σ wᵢ·subᵢ / 100)`.

Drivers supplied per night (`summary.rs::score_nights`):

- **Sleep:** total / REM / deep duration and latency in seconds, efficiency in
  percent, awake fraction of time in bed, and the timing features of
  `fit_sleep_score.engineer` (midpoint hour wrapped to 24-30, squared distance from
  03:00, circular distance from the mean midpoint of the previous 7 nights).
- **Readiness:** as `tools/score_readiness.py`: the calibrated sleep score, night
  HRV and lowest / average HR against their trailing-14-night means, skin
  temperature deviation from its trailing mean, total sleep against its trailing
  mean, the previous day's average MET against its trailing-14-day mean. A baseline
  with no history falls back to tonight's value (no deviation). Recovery Index uses
  the calibration's constant, as on the desktop.

Expected accuracy is bounded by the repository's own measurements
([`score-weights.md`](score-weights.md)): Sleep end-to-end R² ≈ 0.96-0.97 *with
Oura's staging model*, Readiness ≈ 0.49. With firmware stages and this app's MET
aggregate, expect somewhat worse. This path has not been checked against a real
calibration file and paired ring data.

## Estimated readiness (no calibration)

Oura's recovered weights, renormalised over the contributors that can be computed
without a calibration; the two activity contributors are left out. Baselines are
the mean over up to 14 earlier main sleeps from the last 21 days and need 3.

| Contributor | Weight | Input | Knots (input → score) |
| --- | --- | --- | --- |
| Resting heart rate | 17 | lowest night HR − baseline (bpm) | ≤0→100, +2→85, +5→55, +8→30, +12→0 |
| Previous night | 15 | the published-norms sleep score | identity |
| HRV balance | 15 | night HRV ÷ baseline | 0.4→0, 0.6→30, 0.8→65, 0.9→85, ≥1→100 |
| Body temperature | 13 | \|night skin temp − baseline\| (°C) | ≤0.3→100, 0.5→85, 1.0→45, 1.5→10, 2.0→0 |
| Sleep balance | 12 | mean total sleep over the trailing nights | 0 h→0, 4→20, 5→40, 6→60, 7→80, 7.75→95, 8.5→100 |
| Recovery index | 10 | hours from the lowest (median-of-5) HR to wake-up | 0→20, 1→40, 3→70, ≥6→100 |

These curves are hand-set and unvalidated. A score needs three contributors and is
`provisional` until 14 nights of history exist.
