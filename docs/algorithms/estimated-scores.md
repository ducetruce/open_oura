# Estimated Sleep and Readiness scores (`oura-core::scores`)

The iOS app shows a Sleep and a Readiness score. **They are estimates, not a port
of Oura's scores**, and this file records exactly which parts are Oura's and which
are ours.

- **Impl:** `crates/oura-core/src/scores.rs`, wired per night in
  `summary.rs::score_nights`.
- **Status:** approximate by design. Not validated against Oura's numbers: no
  paired ring data + official scores were available when this was written.

## What is Oura's

The combiner, `round(Σ wᵢ·contributorᵢ / Σ wᵢ)`, and the weights, as recovered in
[`score-weights.md`](score-weights.md):

| Sleep | weight | Readiness | weight |
| --- | --- | --- | --- |
| Total sleep | 35 | Resting heart rate | 17 |
| Restfulness | 15 | Previous night | 15 |
| Efficiency | 10 | HRV balance | 15 |
| REM sleep | 10 | Body temperature | 13 |
| Deep sleep | 10 | Sleep balance | 12 |
| Latency | 10 | Recovery index | 10 |
| Timing | 10 | *Previous day activity* | *10, not computed* |
| | | *Activity balance* | *7, not computed* |

Readiness is combined over the contributors that are present, with their weights
renormalised (so the six computed ones carry 82 points of weight between them).

## What is ours

Every contributor curve. ecore's tables do not read back from the binary, and the
repository's Python scorers (`tools/calibrate_scores.py`) re-fit them per user from
a personal Oura trends export into `local/score_params.json`, which the app does
not have. The curves below are piecewise-linear, hand-set to general sleep-health
guidance, clamped at both ends.

### Sleep

| Contributor | Input | Knots (input → score) |
| --- | --- | --- |
| Total sleep | hours asleep | 0→0, 4→20, 5→40, 6→60, 7→80, 7.75→95, 8.5→100 |
| Restfulness | awake time ÷ time in bed | 0→100, 5%→90, 10%→75, 20%→50, 35%→20, 50%→0 |
| Efficiency | asleep ÷ time in bed | 50%→0, 65%→25, 75%→50, 85%→85, 90%→95, 95%→100 |
| REM sleep | minutes | 0→0, 30→30, 60→65, 90→90, 120→100 |
| Deep sleep | minutes | 0→0, 20→30, 45→65, 75→90, 105→100 |
| Latency | minutes to first sleep | 0→70, 5→85, 12–20→100, 30→85, 45→60, 90→20, 150→0 |
| Timing | hours between sleep midpoint and 03:00 | ≤1→100, 2→85, 3→65, 4.5→35, 6→10, 8→0; minus 10 per hour (max 25) that the midpoint drifts beyond 30 min from the circular mean of the previous 7 nights |

The shapes follow what `score-weights.md` found in Oura's data (monotone duration
curves, a U-shaped latency curve, timing peaked at a ~03:00 midpoint plus
regularity); the numbers are not Oura's.

### Readiness

Baselines are the mean over up to 14 earlier nights from the last 21 days, and need
at least 3 of them. Naps (under 3 h in bed) are neither scored nor used.

| Contributor | Input | Knots |
| --- | --- | --- |
| Resting heart rate | lowest night HR − baseline (bpm) | ≤0→100, +2→85, +5→55, +8→30, +12→0 |
| Previous night | that night's sleep score | identity |
| HRV balance | night HRV ÷ baseline | 0.4→0, 0.6→30, 0.8→65, 0.9→85, ≥1→100 |
| Body temperature | \|night skin temp − baseline\| (°C) | ≤0.3→100, 0.5→85, 1.0→45, 1.5→10, 2.0→0 |
| Sleep balance | mean total sleep over the trailing nights incl. this one | the Total sleep curve |
| Recovery index | hours from the lowest (median-of-5 smoothed) HR to wake-up | 0→20, 1→40, 3→70, ≥6→100 |

A readiness score needs at least three contributors and is flagged `provisional`
until 14 nights of history exist.

## Known differences from Oura

- Inputs: stage durations come from the ring's **firmware** hypnogram scaled to time
  in bed, not SleepNet; HR/HRV are the ring's 5-minute averages.
- Oura's HRV balance compares a 14-day trend with a ~3-month one, and its resting-HR
  contributor also penalises unusually *low* values; ours do neither.
- No rest/recovery-mode override, no Activity score, no activity contributors.

## Making it closer

The honest route to Oura-like values is the one the Python tools already take:
calibrate the curves from the user's own trends export. Importing a
`score_params.json` into the app would replace the tables above without changing
the combiner.
