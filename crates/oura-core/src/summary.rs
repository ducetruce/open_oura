//! Daily summary built from stored ring events — the single "brain" the app renders.
//!
//! Everything here is derived offline from the decoded history events in SQLite:
//! no model, no cloud. The interpretation rules follow upstream `open_health`
//! (`crates/oura-summary`), which validated them on real rings:
//!
//! - **Clock.** Ring timestamps are deciseconds on a per-boot counter. They are
//!   mapped to wall-clock time through anchors: the ring's `time_sync` (0x42) and
//!   `rtc_beacon` (0x85) events, plus the phone-clock anchor each sync stores. A
//!   stretch with no anchor is timed from when it was synced and the summary is
//!   flagged `clock_estimated`. (Upstream withholds such nights instead, and also
//!   cross-checks anchors against each other; that is not done here.)
//! - **Nights** come from the ring's `bedtime_period` (0x76) events, falling back to
//!   runs of per-window sleep samples (0x6a).
//! - **Sleep stages** are the ring's *own* hypnogram, `sleep_phase_data` (0x5a): 30 s
//!   epochs in numbered pages written in one burst when the ring finishes analysing
//!   a sleep, so a run *ends* at its last page and runs back from there. This is
//!   firmware staging, not Oura's phone-side model. Epochs the ring did not analyse
//!   are unknown, never awake; a partly staged night gets no latency, efficiency or
//!   scores.
//! - **Packed samples** (`hrv_event`: several 5-minute averages under one stamp) are
//!   stamped at their *last* sample and walk back from it.
//! - **Skin temperature** uses only `sleep_temp_event` (0x75). The generic
//!   `temp_event` mixes device and ambient channels.
//! - **Scores**: see [`crate::scores`] and [`crate::calibration`].

use std::collections::{BTreeMap, HashMap};

use oura_analysis::ported::{spo2, temperature};
use oura_store::storage::Store;
use serde_json::Value;

use crate::calibration::{self, Calibration};
use crate::scores::{self, NormsInputs, ReadinessInputs, Score};
use crate::CoreError;

const TAG_RING_START: u8 = 0x41;
const TAG_TIME_SYNC: u8 = 0x42;
const TAG_RTC_BEACON: u8 = 0x85;
const TAG_HRV: u8 = 0x5d;
const TAG_SLEEP_PERIOD: u8 = 0x6a;
const TAG_SPO2: u8 = 0x6f;
const TAG_SPO2_R: u8 = 0x8b;
const TAG_ACTIVITY: u8 = 0x50;
const TAG_BEDTIME: u8 = 0x76;
const TAG_DEBUG_DATA: u8 = 0x61;
const TAG_SLEEP_TEMP: u8 = 0x75;
const TAG_SLEEP_PHASE_DATA: u8 = 0x5a;

/// A ring counter that drops by more than this (deciseconds) means the ring rebooted.
const REBOOT_REGRESSION_DS: i64 = 36_000;
/// Plausible wall-clock range for an anchor (2020-01-01 .. 2100-01-01).
const UNIX_MIN: i64 = 1_577_836_800;
const UNIX_MAX: i64 = 4_102_444_800;
const MAX_POINTS_PER_SERIES: usize = 300;
const MAX_HYPNOGRAM_POINTS: usize = 240;
/// Seconds of sleep per `sleep_phase_data` epoch.
const EPOCH_S: i64 = 30;
/// Age assumed for the age-specific sleep recommendations when none is set.
const DEFAULT_AGE: f64 = 40.0;
/// Shortest stretch in bed that counts as a main sleep, so naps do not enter the
/// personal baselines or get a readiness score.
const MIN_MAIN_SLEEP_S: u32 = 3 * 3600;
/// Trailing baselines only look at nights from the last three weeks.
const BASELINE_MAX_AGE_S: i64 = 21 * 86_400;

/// Stage codes in [`SleepNight::stages`].
pub const STAGE_DEEP: u8 = 0;
pub const STAGE_LIGHT: u8 = 1;
pub const STAGE_REM: u8 = 2;
pub const STAGE_AWAKE: u8 = 3;
/// The ring did not analyse this epoch.
pub const STAGE_UNKNOWN: u8 = 4;

/// One timestamped value in a chart series.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Point {
    pub unix: i64,
    pub value: f64,
}

/// One detected night of sleep.
#[derive(Clone, Debug, uniffi::Record)]
pub struct SleepNight {
    pub start_unix: i64,
    pub end_unix: i64,
    pub time_in_bed_s: u32,
    /// Whether the ring's own hypnogram covers any of this night.
    pub has_stages: bool,
    /// Whether it covers all of it. Latency, efficiency, awakenings and the sleep
    /// scores are only computed for completely staged nights.
    pub stages_complete: bool,
    pub total_sleep_s: u32,
    pub deep_s: u32,
    pub light_s: u32,
    pub rem_s: u32,
    pub awake_s: u32,
    /// Fraction of the time in bed spent asleep, 0..1.
    pub efficiency: f64,
    /// Time from getting into bed to first falling asleep.
    pub latency_s: u32,
    /// Time awake between first falling asleep and the final awakening.
    pub waso_s: u32,
    /// Awakenings of at least a minute during the night.
    pub wake_count: u32,
    /// Hypnogram across the night, evenly spaced: 0 deep, 1 light, 2 REM, 3 awake,
    /// 4 not analysed.
    pub stages: Vec<u8>,
    pub lowest_hr_bpm: Option<f64>,
    pub avg_hr_bpm: Option<f64>,
    pub avg_hrv_ms: Option<f64>,
    pub avg_breath_rate: Option<f64>,
    pub avg_spo2_percent: Option<f64>,
    pub skin_temp_c: Option<f64>,
    /// Hours between the night's lowest heart rate and waking up.
    pub recovery_index_h: Option<f64>,
    /// Sleep score from published sleep-science norms (not Oura's score).
    pub sleep_score: Option<Score>,
    /// Sleep score calibrated to the user's Oura history, when a calibration is
    /// loaded.
    pub oura_sleep_score: Option<Score>,
    /// Readiness for the day this night ends on: Oura-calibrated when a calibration
    /// is loaded, otherwise an uncalibrated estimate.
    pub readiness_score: Option<Score>,
}

/// Everything the app shows for one local calendar day.
#[derive(Clone, Debug, uniffi::Record)]
pub struct DaySummary {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    /// Unix time of local midnight at the start of this day.
    pub day_start_unix: i64,
    /// The night that ended on this day (the longest, if several).
    pub sleep: Option<SleepNight>,
    pub resting_hr_bpm: Option<f64>,
    pub avg_hrv_ms: Option<f64>,
    pub avg_spo2_percent: Option<f64>,
    pub skin_temp_c: Option<f64>,
    pub avg_met: Option<f64>,
    pub heart_rate: Vec<Point>,
    pub hrv: Vec<Point>,
    /// Nocturnal skin temperature samples.
    pub temperature: Vec<Point>,
    pub met: Vec<Point>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct Summary {
    /// Most recent day last.
    pub days: Vec<DaySummary>,
    /// Latest battery level the ring logged, if any.
    pub battery_percent: Option<u8>,
    pub battery_unix: Option<i64>,
    pub event_total: u64,
    /// True when some timestamps had no clock anchor and were estimated from the
    /// time of the sync instead.
    pub clock_estimated: bool,
}

struct Row {
    segment: usize,
    ts: i64,
    tag: u8,
    json: Value,
}

struct Segment {
    /// `(ring_ts, unix)` anchors sorted by ring_ts.
    anchors: Vec<(i64, i64)>,
    last_ts: i64,
    last_captured: i64,
}

struct Clock {
    segments: Vec<Segment>,
    estimated: std::cell::Cell<bool>,
}

impl Clock {
    fn to_unix(&self, segment: usize, ts: i64) -> i64 {
        let seg = &self.segments[segment];
        let anchor = seg
            .anchors
            .iter()
            .rev()
            .find(|(a_ts, _)| *a_ts <= ts)
            .or_else(|| seg.anchors.first());
        match anchor {
            Some((a_ts, a_unix)) => a_unix + (ts - a_ts) / 10,
            None => {
                self.estimated.set(true);
                seg.last_captured - (seg.last_ts - ts) / 10
            }
        }
    }
}

#[derive(Default)]
struct Samples {
    hrv_hr: Vec<Point>,
    hrv: Vec<Point>,
    /// Per-window sleep heart rate (0x6a); used when a night has no `hrv_event`s.
    sleep_hr: Vec<Point>,
    /// Breathing rate from windows the ring scored as asleep.
    breath: Vec<Point>,
    temp: Vec<Point>,
    spo2: Vec<Point>,
    met: Vec<Point>,
    /// The ring's analysed sleeps: `(start_unix, codes)` at [`EPOCH_S`] per code.
    stage_runs: Vec<(i64, Vec<u8>)>,
    /// `(start_unix, end_unix)`.
    bedtimes: Vec<(i64, i64)>,
    battery: Option<(i64, u8)>,
}

fn f64_array(v: &Value, key: &str) -> Vec<f64> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default()
}

fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn in_window(points: &[Point], start: i64, end: i64) -> Vec<Point> {
    points
        .iter()
        .filter(|p| p.unix >= start && p.unix <= end)
        .cloned()
        .collect()
}

fn values(points: &[Point]) -> Vec<f64> {
    points.iter().map(|p| p.value).collect()
}

/// Keep at most `max` points by averaging equal-sized runs.
fn downsample(points: Vec<Point>, max: usize) -> Vec<Point> {
    if points.len() <= max {
        return points;
    }
    let chunk = points.len().div_ceil(max);
    points
        .chunks(chunk)
        .map(|c| Point {
            unix: c[c.len() / 2].unix,
            value: round2(c.iter().map(|p| p.value).sum::<f64>() / c.len() as f64),
        })
        .collect()
}

/// `YYYY-MM-DD` for a count of days since the Unix epoch (proleptic Gregorian).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// SpO2 percent from the optical R ratio: ecore's `spo2_simple_calculate` with the
/// gen4 coefficients upstream uses, clamped to the 85-100 display range.
fn spo2_from_ratio(r: f64) -> f64 {
    spo2::spo2_simple(r, 105.2, -5.1, -13.4).clamp(85.0, 100.0)
}

fn load(store: &Store) -> Result<(Vec<Row>, Clock), CoreError> {
    let tags = [
        TAG_RING_START,
        TAG_TIME_SYNC,
        TAG_RTC_BEACON,
        TAG_HRV,
        TAG_SLEEP_PERIOD,
        TAG_SPO2,
        TAG_SPO2_R,
        TAG_ACTIVITY,
        TAG_BEDTIME,
        TAG_DEBUG_DATA,
        TAG_SLEEP_TEMP,
        TAG_SLEEP_PHASE_DATA,
    ];
    let raw = store
        .decoded_events_for_tags(&tags)
        .map_err(|e| CoreError::Storage(e.to_string()))?;

    let mut rows = Vec::with_capacity(raw.len());
    let mut segments: Vec<Segment> = Vec::new();
    let mut prev_ts: Option<i64> = None;
    for (ts, tag, json, captured) in raw {
        // A boot record or a counter that jumps backwards starts a new boot epoch.
        let rebooted =
            tag == TAG_RING_START || prev_ts.is_some_and(|p| ts < p - REBOOT_REGRESSION_DS);
        if segments.is_empty() || rebooted {
            segments.push(Segment {
                anchors: Vec::new(),
                last_ts: ts,
                last_captured: captured,
            });
        }
        prev_ts = Some(ts);
        let index = segments.len() - 1;
        let seg = &mut segments[index];
        if ts >= seg.last_ts {
            seg.last_ts = ts;
            seg.last_captured = captured;
        }
        if tag == TAG_RING_START {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(&json) else {
            continue;
        };
        if tag == TAG_TIME_SYNC || tag == TAG_RTC_BEACON {
            if let Some(unix) = json.get("unix_time").and_then(Value::as_i64) {
                if (UNIX_MIN..UNIX_MAX).contains(&unix) {
                    seg.anchors.push((ts, unix));
                }
            }
            continue;
        }
        rows.push(Row {
            segment: index,
            ts,
            tag,
            json,
        });
    }
    for seg in &mut segments {
        seg.anchors.sort_unstable();
    }
    Ok((
        rows,
        Clock {
            segments,
            estimated: std::cell::Cell::new(false),
        },
    ))
}

fn stage_code(phase: &str) -> u8 {
    match phase {
        "deep" => STAGE_DEEP,
        "light" => STAGE_LIGHT,
        "rem" => STAGE_REM,
        "awake" => STAGE_AWAKE,
        _ => STAGE_UNKNOWN,
    }
}

fn collect(rows: &[Row], clock: &Clock) -> Samples {
    let mut s = Samples::default();
    // The sleep being assembled from consecutive `sleep_phase_data` pages:
    // `(segment, last page number, last page unix, codes)`.
    let mut run: Option<(usize, i64, i64, Vec<u8>)> = None;
    let finish_run = |run: Option<(usize, i64, i64, Vec<u8>)>, s: &mut Samples| {
        if let Some((_, _, end_unix, codes)) = run {
            // The pages are written when analysis finishes, at the end of the sleep.
            s.stage_runs
                .push((end_unix - codes.len() as i64 * EPOCH_S, codes));
        }
    };

    for row in rows {
        let unix = clock.to_unix(row.segment, row.ts);
        let v = &row.json;
        match row.tag {
            TAG_HRV => {
                // Stamped at the packet's last sample; earlier ones walk back.
                let step = v
                    .get("interval_min")
                    .and_then(Value::as_i64)
                    .unwrap_or(5)
                    .max(1)
                    * 60;
                let push = |key: &str, floor: f64, out: &mut Vec<Point>| {
                    let samples = f64_array(v, key);
                    let n = samples.len() as i64;
                    for (i, value) in samples.into_iter().enumerate() {
                        if value > floor {
                            out.push(Point {
                                unix: unix - (n - 1 - i as i64) * step,
                                value,
                            });
                        }
                    }
                };
                push("hr_bpm", 20.0, &mut s.hrv_hr);
                push("rmssd_ms", 0.0, &mut s.hrv);
            }
            TAG_SLEEP_PERIOD => {
                if let Some(hr) = v.get("average_hr").and_then(Value::as_f64) {
                    if hr > 20.0 {
                        s.sleep_hr.push(Point { unix, value: hr });
                    }
                }
                // Breathing while awake is faster and more variable, so only
                // windows the ring scored as asleep count.
                if v.get("sleep_state").and_then(Value::as_i64) == Some(1) {
                    if let Some(b) = v.get("breath").and_then(Value::as_f64) {
                        if (4.0..=40.0).contains(&b) {
                            s.breath.push(Point { unix, value: b });
                        }
                    }
                }
            }
            TAG_SPO2 => {
                let valid: Vec<f64> = f64_array(v, "spo2_percent")
                    .into_iter()
                    .filter(|p| (50.0..=100.0).contains(p))
                    .collect();
                if let Some(m) = mean(&valid) {
                    s.spo2.push(Point { unix, value: m });
                }
            }
            TAG_SPO2_R => {
                let percents: Vec<f64> = f64_array(v, "r")
                    .into_iter()
                    .filter(|r| *r > 0.0)
                    .map(spo2_from_ratio)
                    .collect();
                if let Some(m) = mean(&percents) {
                    s.spo2.push(Point { unix, value: m });
                }
            }
            TAG_ACTIVITY => {
                if let Some(m) = mean(&f64_array(v, "met")) {
                    s.met.push(Point {
                        unix,
                        value: round2(m),
                    });
                }
            }
            TAG_BEDTIME => {
                let start = v.get("bedtime_start_ds").and_then(Value::as_i64);
                let end = v.get("bedtime_end_ds").and_then(Value::as_i64);
                if let (Some(start), Some(end)) = (start, end) {
                    let (a, b) = (
                        clock.to_unix(row.segment, start),
                        clock.to_unix(row.segment, end),
                    );
                    if (3600..=18 * 3600).contains(&(b - a)) && !s.bedtimes.contains(&(a, b)) {
                        s.bedtimes.push((a, b));
                    }
                }
            }
            TAG_DEBUG_DATA => {
                if v.get("kind").and_then(Value::as_str) == Some("battery_level_changed") {
                    if let Some(pct) = v.get("battery_pct").and_then(Value::as_u64) {
                        if pct <= 100 && s.battery.is_none_or(|(t, _)| unix >= t) {
                            s.battery = Some((unix, pct as u8));
                        }
                    }
                }
            }
            TAG_SLEEP_TEMP => {
                for value in f64_array(v, "temps_c") {
                    if value > 0.0 {
                        s.temp.push(Point { unix, value });
                    }
                }
            }
            TAG_SLEEP_PHASE_DATA => {
                let page = v.get("header").and_then(Value::as_i64).unwrap_or(-1);
                let codes: Vec<u8> = v
                    .get("phases")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|p| p.as_str().map_or(STAGE_UNKNOWN, stage_code))
                            .collect()
                    })
                    .unwrap_or_default();
                // Pages count up from zero within one sleep; anything else, or a
                // different boot, starts the next sleep.
                match &mut run {
                    Some((segment, last_page, end_unix, all))
                        if *segment == row.segment && page == *last_page + 1 =>
                    {
                        *last_page = page;
                        *end_unix = unix;
                        all.extend(codes);
                    }
                    _ => {
                        finish_run(run.take(), &mut s);
                        run = Some((row.segment, page, unix, codes));
                    }
                }
            }
            _ => {}
        }
    }
    finish_run(run.take(), &mut s);

    for series in [
        &mut s.hrv_hr,
        &mut s.hrv,
        &mut s.sleep_hr,
        &mut s.breath,
        &mut s.temp,
        &mut s.spo2,
        &mut s.met,
    ] {
        series.sort_by_key(|p| p.unix);
    }
    s
}

/// Night windows: the ring's bedtime periods, plus any run of per-window sleep
/// samples (gaps <= 30 min, at least 2 h long) that no bedtime period covers.
fn night_windows(s: &Samples) -> Vec<(i64, i64)> {
    let mut windows = s.bedtimes.clone();
    let mut runs: Vec<(i64, i64)> = Vec::new();
    for p in &s.sleep_hr {
        match runs.last_mut() {
            Some((_, end)) if p.unix - *end <= 1800 => *end = p.unix,
            _ => runs.push((p.unix, p.unix)),
        }
    }
    for (a, b) in runs {
        let overlaps = windows.iter().any(|(wa, wb)| a < *wb && b > *wa);
        if b - a >= 2 * 3600 && !overlaps {
            windows.push((a, b));
        }
    }
    windows.sort_unstable();
    windows
}

/// Count maximal runs of `code` at least `min_len` epochs long.
fn count_bouts(stages: &[u8], code: u8, min_len: usize) -> u32 {
    let mut count = 0;
    let mut run = 0usize;
    for &c in stages {
        if c == code {
            run += 1;
        } else {
            if run >= min_len {
                count += 1;
            }
            run = 0;
        }
    }
    if run >= min_len {
        count += 1;
    }
    count
}

fn is_asleep(code: u8) -> bool {
    matches!(code, STAGE_DEEP | STAGE_LIGHT | STAGE_REM)
}

fn build_night(s: &Samples, start: i64, end: i64) -> SleepNight {
    let time_in_bed_s = (end - start).max(0) as u32;

    // Paint the ring's analysed sleeps onto this night's 30 s grid.
    let cells = ((end - start) / EPOCH_S).max(1) as usize;
    let mut grid = vec![STAGE_UNKNOWN; cells];
    for (run_start, codes) in &s.stage_runs {
        let run_end = run_start + codes.len() as i64 * EPOCH_S;
        if run_end <= start || *run_start >= end {
            continue;
        }
        for (i, code) in codes.iter().enumerate() {
            let at = run_start + i as i64 * EPOCH_S;
            if at >= start && at < end {
                grid[(((at - start) / EPOCH_S) as usize).min(cells - 1)] = *code;
            }
        }
    }
    let count = |code: u8| grid.iter().filter(|c| **c == code).count() as u32 * EPOCH_S as u32;
    let has_stages = grid.iter().any(|c| *c != STAGE_UNKNOWN);
    let (deep_s, light_s, rem_s) = (count(STAGE_DEEP), count(STAGE_LIGHT), count(STAGE_REM));
    let total_sleep_s = deep_s + light_s + rem_s;

    // Clinical readouts only make sense for a completely staged night that
    // contains sleep (upstream `sleep_metrics`).
    let onset = grid.iter().position(|c| is_asleep(*c));
    let final_sleep = grid.iter().rposition(|c| is_asleep(*c));
    let stages_complete = !grid.contains(&STAGE_UNKNOWN) && onset.is_some();
    let (mut efficiency, mut latency_s, mut waso_s, mut wake_count) = (0.0, 0, 0, 0);
    if let (true, Some(onset), Some(final_sleep)) = (stages_complete, onset, final_sleep) {
        let sleep_span = &grid[onset..=final_sleep];
        efficiency = round2(total_sleep_s as f64 / (cells as f64 * EPOCH_S as f64));
        latency_s = onset as u32 * EPOCH_S as u32;
        waso_s = sleep_span.iter().filter(|c| **c == STAGE_AWAKE).count() as u32 * EPOCH_S as u32;
        // An awakening is at least a minute, so scoring flicker is not counted.
        wake_count = count_bouts(sleep_span, STAGE_AWAKE, 2);
    }
    let stages = if !has_stages {
        Vec::new()
    } else if grid.len() > MAX_HYPNOGRAM_POINTS {
        let step = grid.len() as f64 / MAX_HYPNOGRAM_POINTS as f64;
        (0..MAX_HYPNOGRAM_POINTS)
            .map(|i| grid[(i as f64 * step) as usize])
            .collect()
    } else {
        grid.clone()
    };

    let mut hr_points = in_window(&s.hrv_hr, start, end);
    if hr_points.is_empty() {
        hr_points = in_window(&s.sleep_hr, start, end);
    }
    let hr = values(&hr_points);
    let temps = values(&in_window(&s.temp, start, end));
    let centi: Vec<u16> = temps
        .iter()
        .map(|t| (t * 100.0).round().clamp(0.0, u16::MAX as f64) as u16)
        .collect();
    let skin_temp_c = temperature::nightly_temperature(&centi)
        .map(|c| c as f64 / 100.0)
        .or_else(|| mean(&temps))
        .map(round2);

    SleepNight {
        start_unix: start,
        end_unix: end,
        time_in_bed_s,
        has_stages,
        stages_complete,
        total_sleep_s,
        deep_s,
        light_s,
        rem_s,
        awake_s: count(STAGE_AWAKE),
        efficiency,
        latency_s,
        waso_s,
        wake_count,
        stages,
        lowest_hr_bpm: hr.iter().copied().reduce(f64::min).map(round1),
        avg_hr_bpm: mean(&hr).map(round1),
        avg_hrv_ms: mean(&values(&in_window(&s.hrv, start, end))).map(round1),
        avg_breath_rate: median(&values(&in_window(&s.breath, start, end))).map(round1),
        avg_spo2_percent: mean(&values(&in_window(&s.spo2, start, end))).map(round1),
        skin_temp_c,
        recovery_index_h: recovery_index_h(&hr_points, end),
        sleep_score: None,
        oura_sleep_score: None,
        readiness_score: None,
    }
}

/// Hours between the night's lowest (smoothed) heart rate and waking up: the
/// earlier the heart rate bottoms out, the more of the night was spent recovered.
fn recovery_index_h(night_hr: &[Point], end: i64) -> Option<f64> {
    if night_hr.len() < 12 {
        return None;
    }
    // Rolling median of 5 so a single noisy sample can't be the minimum.
    let lowest = night_hr
        .windows(5)
        .map(|w| (median(&values(w)).unwrap_or(f64::MAX), w[2].unix))
        .min_by(|a, b| a.0.total_cmp(&b.0))?;
    Some(round2((end - lowest.1) as f64 / 3600.0))
}

/// What the scores need beyond the nights themselves.
pub struct ScoreContext<'a> {
    /// Local offset from UTC, seconds.
    pub tz: i64,
    pub age: f64,
    pub calibration: Option<&'a Calibration>,
    /// Average MET per local day (days since the epoch).
    pub met_by_day: BTreeMap<i64, f64>,
}

/// Fill in the scores. `nights` must be in chronological order: each night is
/// compared against baselines from the nights before it only.
fn score_nights(nights: &mut [SleepNight], ctx: &ScoreContext) {
    let midpoint_hour = |n: &SleepNight| {
        ((n.start_unix + n.end_unix) / 2 + ctx.tz).rem_euclid(86_400) as f64 / 3600.0
    };
    let is_main = |n: &SleepNight| n.time_in_bed_s >= MIN_MAIN_SLEEP_S;

    for index in 0..nights.len() {
        let (earlier, rest) = nights.split_at_mut(index);
        let night = &mut rest[0];
        let main = is_main(night);
        // Strictly preceding main sleeps, newest first.
        let prior: Vec<&SleepNight> = earlier
            .iter()
            .rev()
            .filter(|n| is_main(n) && n.end_unix <= night.start_unix)
            .collect();
        // The trailing fortnight the Oura-style contributors compare against.
        let recent: Vec<&SleepNight> = prior
            .iter()
            .copied()
            .filter(|n| n.end_unix >= night.end_unix - BASELINE_MAX_AGE_S)
            .take(scores::MATURE_NIGHTS)
            .collect();
        let recent_values = |value: fn(&SleepNight) -> Option<f64>| -> Vec<f64> {
            recent.iter().filter_map(|n| value(n)).collect()
        };
        let trailing_mean = |value: fn(&SleepNight) -> Option<f64>| {
            let found = recent_values(value);
            (found.len() >= scores::MIN_BASELINE_NIGHTS)
                .then(|| mean(&found))
                .flatten()
        };
        let staged_sleep = |n: &SleepNight| n.stages_complete.then_some(n.total_sleep_s as f64);

        // ── published-norms sleep score ──
        if night.stages_complete {
            let all_prior = |value: fn(&SleepNight) -> Option<f64>| -> Vec<f64> {
                prior.iter().filter_map(|n| value(n)).collect()
            };
            let grid_s = (night.time_in_bed_s as i64 / EPOCH_S).max(1) as f64 * EPOCH_S as f64;
            night.sleep_score = scores::norms_sleep_score(&NormsInputs {
                asleep_min: (night.total_sleep_s > 0).then(|| night.total_sleep_s as f64 / 60.0),
                efficiency_pct: Some(night.total_sleep_s as f64 / grid_s * 100.0),
                onset_latency_min: Some(night.latency_s as f64 / 60.0),
                waso_min: Some(night.waso_s as f64 / 60.0),
                awakenings: Some(night.wake_count as f64),
                deep_pct: Some(night.deep_s as f64 / grid_s * 100.0),
                rem_pct: Some(night.rem_s as f64 / grid_s * 100.0),
                rhr: night.lowest_hr_bpm.map(f64::round),
                rhr_baseline: main
                    .then(|| scores::causal_baseline(&all_prior(|n| n.lowest_hr_bpm)))
                    .flatten(),
                hrv_ms: night.avg_hrv_ms.map(f64::round),
                hrv_baseline: main
                    .then(|| scores::causal_baseline(&all_prior(|n| n.avg_hrv_ms)))
                    .flatten(),
                age: ctx.age,
            });
        }

        // ── Oura-calibrated sleep score ──
        if let (Some(calibration), true) = (ctx.calibration, night.stages_complete) {
            let hour = midpoint_hour(night);
            // The calibration wraps small hours past midnight to 24-30.
            let wrapped = if hour < 12.0 { hour + 24.0 } else { hour };
            let previous: Vec<f64> = prior.iter().take(7).map(|n| midpoint_hour(n)).collect();
            let regularity = scores::clock_mean(&previous)
                .map(|usual| scores::clock_distance(hour, usual))
                .unwrap_or(0.0);
            let metrics = HashMap::from([
                ("Total Sleep Duration", night.total_sleep_s as f64),
                ("Sleep Efficiency", night.efficiency * 100.0),
                ("REM Sleep Duration", night.rem_s as f64),
                ("Deep Sleep Duration", night.deep_s as f64),
                ("Sleep Latency", night.latency_s as f64),
                (
                    "awake_frac",
                    night.awake_s as f64 / night.time_in_bed_s.max(1) as f64,
                ),
                ("mid_hour", wrapped),
                ("mid_opt", -((wrapped - 27.0).powi(2))),
                ("mid_reg", regularity),
            ]);
            night.oura_sleep_score = calibration.score(calibration::SLEEP, &metrics, false);
        }

        // ── readiness ──
        if !main || (night.lowest_hr_bpm.is_none() && night.avg_hrv_ms.is_none()) {
            continue;
        }
        let calibrated = ctx
            .calibration
            .filter(|calibration| calibration.info().has_readiness);
        if let Some(calibration) = calibrated {
            // Same inputs and cold-baseline fallbacks as tools/score_readiness.py: a
            // baseline with no history falls back to tonight's value (no deviation).
            let day = (night.end_unix + ctx.tz).div_euclid(86_400);
            let previous_met = ctx
                .met_by_day
                .get(&(day - 1))
                .or_else(|| ctx.met_by_day.get(&day))
                .copied()
                .unwrap_or(1.4);
            let met_history: Vec<f64> = ctx
                .met_by_day
                .range(day - scores::MATURE_NIGHTS as i64..day)
                .map(|(_, met)| *met)
                .collect();
            let baseline = |value: fn(&SleepNight) -> Option<f64>| mean(&recent_values(value));
            let hrv = night.avg_hrv_ms.unwrap_or(60.0);
            let avg_hr = night.avg_hr_bpm.unwrap_or(58.0);
            let total_sleep = staged_sleep(night).unwrap_or(27_000.0);
            let temp_deviation = match (night.skin_temp_c, baseline(|n| n.skin_temp_c)) {
                (Some(temp), Some(usual)) => temp - usual,
                _ => 0.0,
            };
            let metrics = HashMap::from([
                (
                    "Sleep Score",
                    night
                        .oura_sleep_score
                        .as_ref()
                        .map_or(70.0, |s| s.value as f64),
                ),
                ("Average HRV", hrv),
                (
                    "trail14_Average HRV",
                    baseline(|n| n.avg_hrv_ms).unwrap_or(hrv),
                ),
                (
                    "Lowest Resting Heart Rate",
                    night.lowest_hr_bpm.unwrap_or(55.0),
                ),
                ("Average Resting Heart Rate", avg_hr),
                (
                    "trail14_Average Resting Heart Rate",
                    baseline(|n| n.avg_hr_bpm).unwrap_or(avg_hr),
                ),
                ("Temperature Deviation (°C)", temp_deviation),
                ("Total Sleep Duration", total_sleep),
                (
                    "trail14_Total Sleep Duration",
                    baseline(staged_sleep).unwrap_or(total_sleep),
                ),
                ("prev_Average MET", previous_met),
                (
                    "trail14_Average MET",
                    mean(&met_history).unwrap_or(previous_met),
                ),
            ]);
            night.readiness_score = calibration.score(
                calibration::READINESS,
                &metrics,
                recent.len() < scores::MATURE_NIGHTS,
            );
        } else {
            let mut recent_sleep = recent_values(staged_sleep);
            recent_sleep.extend(staged_sleep(night));
            night.readiness_score = scores::readiness_score(&ReadinessInputs {
                sleep_score: night.sleep_score.as_ref().map(|s| s.value),
                lowest_hr_bpm: night.lowest_hr_bpm,
                baseline_lowest_hr_bpm: trailing_mean(|n| n.lowest_hr_bpm),
                hrv_ms: night.avg_hrv_ms,
                baseline_hrv_ms: trailing_mean(|n| n.avg_hrv_ms),
                skin_temp_c: night.skin_temp_c,
                baseline_skin_temp_c: trailing_mean(|n| n.skin_temp_c),
                recent_sleep_s: (recent_sleep.len() > scores::MIN_BASELINE_NIGHTS)
                    .then(|| mean(&recent_sleep))
                    .flatten(),
                recovery_index_h: night.recovery_index_h,
                history_nights: recent.len(),
            });
        }
    }
}

/// Build the summary for the most recent `days` local days that have data.
pub fn build_summary(
    store: &Store,
    tz_offset_seconds: i32,
    days: u32,
    age: Option<u8>,
    calibration: Option<&Calibration>,
) -> Result<Summary, CoreError> {
    let (rows, clock) = load(store)?;
    let samples = collect(&rows, &clock);
    let tz = tz_offset_seconds as i64;
    let day_of = |unix: i64| (unix + tz).div_euclid(86_400);

    let mut met_by_day: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    for point in &samples.met {
        met_by_day
            .entry(day_of(point.unix))
            .or_default()
            .push(point.value);
    }
    let mut nights: Vec<SleepNight> = night_windows(&samples)
        .into_iter()
        .map(|(a, b)| build_night(&samples, a, b))
        .collect();
    score_nights(
        &mut nights,
        &ScoreContext {
            tz,
            age: age.map_or(DEFAULT_AGE, f64::from),
            calibration,
            met_by_day: met_by_day
                .iter()
                .filter_map(|(day, mets)| mean(mets).map(|m| (*day, m)))
                .collect(),
        },
    );

    let mut day_ids: Vec<i64> = samples
        .hrv_hr
        .iter()
        .chain(&samples.hrv)
        .chain(&samples.sleep_hr)
        .chain(&samples.temp)
        .chain(&samples.spo2)
        .chain(&samples.met)
        .map(|p| day_of(p.unix))
        .chain(nights.iter().map(|n| day_of(n.end_unix)))
        .collect();
    day_ids.sort_unstable();
    day_ids.dedup();
    let skip = day_ids.len().saturating_sub(days.max(1) as usize);

    let out_days = day_ids[skip..]
        .iter()
        .map(|&day| {
            let start = day * 86_400 - tz;
            let end = start + 86_399;
            // The night you woke from this day; the longest, so a nap can't shadow it.
            let sleep = nights
                .iter()
                .filter(|n| day_of(n.end_unix) == day)
                .max_by_key(|n| n.time_in_bed_s)
                .cloned();

            let mut heart_rate = in_window(&samples.hrv_hr, start, end);
            if heart_rate.is_empty() {
                heart_rate = in_window(&samples.sleep_hr, start, end);
            }
            let hrv = in_window(&samples.hrv, start, end);
            let temperature = in_window(&samples.temp, start, end);
            let met = in_window(&samples.met, start, end);

            let night = sleep.as_ref();
            DaySummary {
                date: civil_date(day),
                day_start_unix: start,
                resting_hr_bpm: night
                    .and_then(|n| n.lowest_hr_bpm)
                    .or_else(|| values(&heart_rate).into_iter().reduce(f64::min).map(round1)),
                avg_hrv_ms: night
                    .and_then(|n| n.avg_hrv_ms)
                    .or_else(|| mean(&values(&hrv)).map(round1)),
                avg_spo2_percent: night
                    .and_then(|n| n.avg_spo2_percent)
                    .or_else(|| mean(&values(&in_window(&samples.spo2, start, end))).map(round1)),
                skin_temp_c: night.and_then(|n| n.skin_temp_c),
                avg_met: mean(&values(&met)).map(round2),
                heart_rate: downsample(heart_rate, MAX_POINTS_PER_SERIES),
                hrv: downsample(hrv, MAX_POINTS_PER_SERIES),
                temperature: downsample(temperature, MAX_POINTS_PER_SERIES),
                met: downsample(met, MAX_POINTS_PER_SERIES),
                sleep,
            }
        })
        .collect();

    Ok(Summary {
        days: out_days,
        battery_percent: samples.battery.map(|(_, pct)| pct),
        battery_unix: samples.battery.map(|(unix, _)| unix),
        event_total: store
            .event_total()
            .map_err(|e| CoreError::Storage(e.to_string()))? as u64,
        clock_estimated: clock.estimated.get(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scores::ScoreBasis;
    use oura_protocol::events::{decode_event_body, event_name, RingEvent};

    fn event(tag: u8, ts: u32, body: Vec<u8>) -> RingEvent {
        RingEvent {
            tag,
            name: event_name(tag),
            timestamp: ts,
            decoded: decode_event_body(tag, &body),
            body,
        }
    }

    /// 2024-03-10 00:00:00 UTC.
    const MIDNIGHT: u32 = 1_710_028_800;

    /// `sleep_phase_data` pages for a hypnogram: 2-bit codes, four per byte
    /// MSB-first, 13 bytes (52 epochs) per page, pages numbered from zero.
    fn stage_pages(codes: &[u8]) -> Vec<Vec<u8>> {
        codes
            .chunks(52)
            .enumerate()
            .map(|(page, epochs)| {
                let mut body = vec![page as u8];
                for quad in epochs.chunks(4) {
                    let mut byte = 0u8;
                    for (i, code) in quad.iter().enumerate() {
                        byte |= code << (6 - 2 * i);
                    }
                    body.push(byte);
                }
                body
            })
            .collect()
    }

    /// 8 hours in bed: 10 min to fall asleep, 2 h deep, 4 h light, 1.5 h REM, a
    /// 5-minute awakening, then 15 min light.
    fn hypnogram() -> Vec<u8> {
        [
            (STAGE_AWAKE, 20),
            (STAGE_DEEP, 240),
            (STAGE_LIGHT, 480),
            (STAGE_REM, 180),
            (STAGE_AWAKE, 10),
            (STAGE_LIGHT, 30),
        ]
        .iter()
        .flat_map(|(code, epochs)| std::iter::repeat_n(*code, *epochs))
        .collect()
    }

    /// A ring whose counter read 0 at `MIDNIGHT - 2h`, with one night 23:00-07:00.
    fn store_with_night(anchored: bool) -> Store {
        let store = Store::open_in_memory().unwrap();
        let ds = |unix: u32| (unix - (MIDNIGHT - 7200)) * 10;
        let mut events = Vec::new();
        let (bed, wake) = (MIDNIGHT - 3600, MIDNIGHT + 7 * 3600);
        // HRV: 3 samples of (hr, rmssd) ending 02:00.
        events.push(event(
            0x5d,
            ds(MIDNIGHT + 7200),
            vec![52, 40, 50, 60, 48, 80],
        ));
        // Per-window sleep sample at 03:00: HR 45 bpm (raw 90), breath 14/min (raw
        // 112), asleep. And one awake window at 06:55 breathing faster.
        events.push(event(
            0x6a,
            ds(MIDNIGHT + 3 * 3600),
            vec![90, 0, 0, 0, 112, 0, 0, 1, 0, 0],
        ));
        events.push(event(
            0x6a,
            ds(wake - 300),
            vec![120, 0, 0, 0, 160, 0, 0, 0, 0, 0],
        ));
        // Skin temperature 35.10 °C at 04:00; a generic temp_event must be ignored.
        events.push(event(
            0x75,
            ds(MIDNIGHT + 4 * 3600),
            3510i16.to_le_bytes().to_vec(),
        ));
        events.push(event(
            0x46,
            ds(MIDNIGHT + 4 * 3600),
            2200i16.to_le_bytes().to_vec(),
        ));
        // The ring analyses the sleep at wake-up and writes its hypnogram then.
        for page in stage_pages(&hypnogram()) {
            events.push(event(0x5a, ds(wake), page));
        }
        let mut bedtime = (ds(bed)).to_le_bytes().to_vec();
        bedtime.extend(ds(wake).to_le_bytes());
        events.push(event(0x76, ds(wake), bedtime));
        // Battery 87 % at 08:00.
        events.push(event(
            0x61,
            ds(MIDNIGHT + 8 * 3600),
            vec![0x24, 87, 0x10, 0x10],
        ));
        if anchored {
            // The anchor a sync stores: newest ring time paired with the phone clock.
            let mut body = (MIDNIGHT + 8 * 3600 + 60).to_le_bytes().to_vec();
            body.extend(b"phone");
            events.push(event(0x42, ds(MIDNIGHT + 8 * 3600 + 60), body));
        }
        // The ring hands events back in chronological order.
        events.sort_by_key(|ev| ev.timestamp);
        for ev in &events {
            assert!(ev.decoded.is_some(), "tag {:#x} did not decode", ev.tag);
            store.insert_event("TEST", ev).unwrap();
        }
        store
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(19_792), "2024-03-10");
        assert_eq!(civil_date(19_782), "2024-02-29");
    }

    #[test]
    fn builds_a_night_from_anchored_events() {
        let summary = build_summary(&store_with_night(true), 0, 7, None, None).unwrap();
        assert!(!summary.clock_estimated);
        assert_eq!(summary.battery_percent, Some(87));

        let day = summary.days.last().unwrap();
        assert_eq!(day.date, "2024-03-10");
        assert_eq!(day.day_start_unix, MIDNIGHT as i64);
        let night = day.sleep.as_ref().unwrap();
        assert_eq!(night.start_unix, (MIDNIGHT - 3600) as i64);
        assert_eq!(night.time_in_bed_s, 8 * 3600);
        assert!(night.has_stages && night.stages_complete);
        // The hypnogram ends at the wake-up burst and runs back 30 s per epoch.
        assert_eq!(night.deep_s, 2 * 3600);
        assert_eq!(night.light_s, 4 * 3600 + 15 * 60);
        assert_eq!(night.rem_s, 90 * 60);
        assert_eq!(night.awake_s, 15 * 60);
        assert_eq!(night.total_sleep_s, 7 * 3600 + 45 * 60);
        assert_eq!(night.efficiency, 0.97);
        assert_eq!(night.latency_s, 10 * 60);
        assert_eq!(night.waso_s, 5 * 60);
        assert_eq!(night.wake_count, 1);
        assert_eq!(night.stages.len(), MAX_HYPNOGRAM_POINTS);
        assert_eq!(night.stages[0], STAGE_AWAKE);
        // Night HR comes from the 5-minute averages; 0x6a is only a fallback.
        assert_eq!(night.lowest_hr_bpm, Some(48.0));
        assert_eq!(night.avg_hrv_ms, Some(60.0));
        // Only the window the ring scored as asleep counts for breathing.
        assert_eq!(night.avg_breath_rate, Some(14.0));
        assert_eq!(night.skin_temp_c, Some(35.1));

        let score = night.sleep_score.as_ref().unwrap();
        assert_eq!(score.basis, ScoreBasis::PublishedNorms);
        assert!(score.value >= 90, "{}", score.value);
        assert!(night.oura_sleep_score.is_none());
        // One night is not enough history for a readiness score.
        assert!(night.readiness_score.is_none());

        assert_eq!(day.resting_hr_bpm, Some(48.0));
        assert_eq!(day.hrv.len(), 3);
        // Packed samples end at the event time and walk back 5 min apart.
        assert_eq!(day.hrv[2].unix, (MIDNIGHT + 7200) as i64);
        assert_eq!(day.hrv[0].unix, (MIDNIGHT + 7200 - 600) as i64);
    }

    #[test]
    fn calibration_adds_an_oura_style_sleep_score() {
        let calibration = Calibration::parse(crate::calibration::tests::SAMPLE).unwrap();
        let summary =
            build_summary(&store_with_night(true), 0, 7, Some(30), Some(&calibration)).unwrap();
        let night = summary.days.last().unwrap().sleep.clone().unwrap();
        let score = night.oura_sleep_score.unwrap();
        assert_eq!(score.basis, ScoreBasis::OuraCalibrated);
        assert_eq!(score.contributors.len(), 7);
        // Both kinds of sleep score are reported side by side.
        assert!(night.sleep_score.is_some());
        // Readiness is calibrated too, and provisional on a single night.
        let readiness = night.readiness_score.unwrap();
        assert_eq!(readiness.basis, ScoreBasis::OuraCalibrated);
        assert!(readiness.provisional);
    }

    #[test]
    fn a_partly_staged_night_reports_durations_but_no_scores() {
        let store = Store::open_in_memory().unwrap();
        let ds = |unix: u32| (unix - (MIDNIGHT - 7200)) * 10;
        let (bed, wake) = (MIDNIGHT - 3600, MIDNIGHT + 7 * 3600);
        // Only the last two hours of the night were analysed.
        let mut events: Vec<RingEvent> = stage_pages(&[STAGE_LIGHT; 240])
            .into_iter()
            .map(|page| event(0x5a, ds(wake), page))
            .collect();
        let mut bedtime = (ds(bed)).to_le_bytes().to_vec();
        bedtime.extend(ds(wake).to_le_bytes());
        events.push(event(0x76, ds(wake), bedtime));
        events.push(event(
            0x42,
            ds(wake) + 10,
            (wake + 1).to_le_bytes().to_vec(),
        ));
        for ev in &events {
            store.insert_event("TEST", ev).unwrap();
        }
        let summary = build_summary(&store, 0, 7, None, None).unwrap();
        let night = summary.days.last().unwrap().sleep.clone().unwrap();
        assert!(night.has_stages && !night.stages_complete);
        assert_eq!(night.light_s, 2 * 3600);
        assert_eq!(night.stages[0], STAGE_UNKNOWN);
        // Unanalysed time is unknown, not awake: no efficiency, latency or score.
        assert_eq!(night.awake_s, 0);
        assert_eq!(night.efficiency, 0.0);
        assert!(night.sleep_score.is_none());
    }

    #[test]
    fn local_timezone_moves_the_day_boundary() {
        // UTC-10: the 07:00 UTC wake-up is 21:00 the previous local day.
        let summary = build_summary(&store_with_night(true), -10 * 3600, 7, None, None).unwrap();
        let night_day = summary.days.iter().find(|d| d.sleep.is_some()).unwrap();
        assert_eq!(night_day.date, "2024-03-09");
    }

    #[test]
    fn missing_anchor_falls_back_to_capture_time() {
        let summary = build_summary(&store_with_night(false), 0, 7, None, None).unwrap();
        assert!(summary.clock_estimated);
        assert!(!summary.days.is_empty());
    }

    #[test]
    fn a_reboot_is_timed_by_its_own_anchor() {
        let store = Store::open_in_memory().unwrap();
        // First boot: counter 500_000 ds anchored at MIDNIGHT.
        // Second boot restarts near zero and is anchored 25 hours later.
        let events = [
            event(0x42, 500_000, MIDNIGHT.to_le_bytes().to_vec()),
            event(0x5d, 503_000, vec![60, 50]),
            event(0x41, 10, vec![0; 14]),
            event(0x5d, 3_000, vec![62, 55]),
            event(0x42, 6_000, (MIDNIGHT + 90_000).to_le_bytes().to_vec()),
        ];
        for ev in &events {
            store.insert_event("TEST", ev).unwrap();
        }
        let summary = build_summary(&store, 0, 7, None, None).unwrap();
        assert!(!summary.clock_estimated);
        let dates: Vec<&str> = summary.days.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(dates, ["2024-03-10", "2024-03-11"]);
        // The second boot's sample sits 300 s before its own anchor.
        assert_eq!(
            summary.days[1].heart_rate[0].unix,
            (MIDNIGHT + 90_000 - 300) as i64
        );
    }

    #[test]
    fn empty_store_is_an_empty_summary() {
        let summary = build_summary(&Store::open_in_memory().unwrap(), 0, 7, None, None).unwrap();
        assert!(summary.days.is_empty());
        assert_eq!(summary.battery_percent, None);
    }

    fn night(end_unix: i64, hr: f64, hrv: f64) -> SleepNight {
        SleepNight {
            start_unix: end_unix - 8 * 3600,
            end_unix,
            time_in_bed_s: 8 * 3600,
            has_stages: true,
            stages_complete: true,
            total_sleep_s: 7 * 3600,
            deep_s: 80 * 60,
            light_s: 250 * 60,
            rem_s: 90 * 60,
            awake_s: 60 * 60,
            efficiency: 0.88,
            latency_s: 15 * 60,
            waso_s: 30 * 60,
            wake_count: 3,
            stages: Vec::new(),
            lowest_hr_bpm: Some(hr),
            avg_hr_bpm: Some(hr + 6.0),
            avg_hrv_ms: Some(hrv),
            avg_breath_rate: None,
            avg_spo2_percent: None,
            skin_temp_c: Some(34.8),
            recovery_index_h: Some(4.0),
            sleep_score: None,
            oura_sleep_score: None,
            readiness_score: None,
        }
    }

    fn context(calibration: Option<&Calibration>) -> ScoreContext<'_> {
        ScoreContext {
            tz: 0,
            age: 40.0,
            calibration,
            met_by_day: BTreeMap::new(),
        }
    }

    #[test]
    fn readiness_appears_once_baselines_exist_and_reacts_to_a_bad_night() {
        let wake = |day: i64| MIDNIGHT as i64 + day * 86_400 + 7 * 3600;
        let mut nights: Vec<SleepNight> = (0..5)
            .map(|d| night(wake(d), 50.0 + (d % 2) as f64, 60.0 - (d % 2) as f64))
            .collect();
        // Sixth night: resting HR up 8 bpm, HRV down a third.
        nights.push(night(wake(5), 58.0, 40.0));
        // A nap gets a sleep score but no readiness, and stays out of the baselines.
        let mut nap = night(wake(5) + 8 * 3600, 70.0, 20.0);
        nap.start_unix = nap.end_unix - 3600;
        nap.time_in_bed_s = 3600;
        nights.push(nap);
        nights.push(night(wake(6), 50.0, 60.0));
        score_nights(&mut nights, &context(None));

        assert!(nights.iter().all(|n| n.sleep_score.is_some()));
        // The first three nights have no baseline to compare against yet.
        assert!(nights[..3].iter().all(|n| n.readiness_score.is_none()));
        let steady = nights[4].readiness_score.as_ref().unwrap();
        let strained = nights[5].readiness_score.as_ref().unwrap();
        assert_eq!(steady.basis, ScoreBasis::Estimate);
        assert!(steady.provisional && strained.provisional);
        assert!(
            strained.value + 15 <= steady.value,
            "steady {} vs strained {}",
            steady.value,
            strained.value
        );
        // The strained night also loses sleep-score points on physiology.
        assert!(
            nights[5].sleep_score.as_ref().unwrap().value
                < nights[4].sleep_score.as_ref().unwrap().value
        );
        assert!(nights[6].readiness_score.is_none());
        // The nap's 70 bpm did not drag the baseline up for the next night.
        let after = nights[7].readiness_score.as_ref().unwrap();
        let resting = after
            .contributors
            .iter()
            .find(|c| c.name == "Resting heart rate")
            .unwrap();
        assert!(resting.score >= 85, "{}", resting.score);
    }

    #[test]
    fn calibrated_readiness_compares_with_the_trailing_baseline() {
        let calibration = Calibration::parse(crate::calibration::tests::SAMPLE).unwrap();
        let wake = |day: i64| MIDNIGHT as i64 + day * 86_400 + 7 * 3600;
        let mut nights: Vec<SleepNight> = (0..5).map(|d| night(wake(d), 50.0, 60.0)).collect();
        nights.push(night(wake(5), 58.0, 40.0));
        score_nights(&mut nights, &context(Some(&calibration)));

        let score = |n: &SleepNight, name: &str| {
            n.readiness_score
                .as_ref()
                .unwrap()
                .contributors
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .score
        };
        // Steady night: HRV equals its baseline → the fit's intercept, 85.
        assert_eq!(score(&nights[4], "HRV balance"), 85);
        // 20 ms under baseline at 1.5 per ms → 55.
        assert_eq!(score(&nights[5], "HRV balance"), 55);
        // The very first night has a cold baseline: no deviation, not a penalty.
        assert_eq!(score(&nights[0], "HRV balance"), 85);
        assert!(
            nights[5].readiness_score.as_ref().unwrap().value
                < nights[4].readiness_score.as_ref().unwrap().value
        );
    }
}
