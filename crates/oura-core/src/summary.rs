//! Daily summary built from stored ring events — the single "brain" the app renders.
//!
//! Everything here is derived offline from the decoded history events in SQLite:
//! no model, no cloud. What that means in practice:
//!
//! - **Clock.** Ring timestamps are deciseconds on the ring's own counter. They are
//!   mapped to wall-clock time through the ring's `time_sync` (0x42) / `rtc_beacon`
//!   (0x85) anchors. If a stretch of events has no anchor, the time the events were
//!   captured is used instead and the summary is flagged `clock_estimated`.
//! - **Nights** come from the ring's `bedtime_period` (0x76) events, falling back to
//!   runs of per-window sleep samples (0x6a).
//! - **Sleep stages** are the ring's *firmware* hypnogram (0x4b/0x4e/0x5a), not
//!   Oura's phone-side SleepNet model, so they will differ from the official app.
//!   The epoch length of those events is not documented, so stage durations are the
//!   stage *proportions* scaled to the time in bed.
//! - **Scores** are estimates, not Oura's: see [`crate::scores`].
//! - Multi-sample events (HRV: one sample per 5 min) are laid out ending at the
//!   event's timestamp.

use oura_analysis::ported::{sleep, temperature};
use oura_store::storage::Store;
use serde_json::Value;

use crate::scores::{self, ReadinessInputs, Score, SleepInputs};
use crate::CoreError;

const TAG_TIME_SYNC: u8 = 0x42;
const TAG_RTC_BEACON: u8 = 0x85;
const TAG_HRV: u8 = 0x5d;
const TAG_SLEEP_PERIOD: u8 = 0x6a;
const TAG_SPO2: u8 = 0x6f;
const TAG_ACTIVITY: u8 = 0x50;
const TAG_BEDTIME: u8 = 0x76;
const TAG_DEBUG_DATA: u8 = 0x61;
const TEMP_TAGS: [u8; 3] = [0x46, 0x69, 0x75];
const PHASE_TAGS: [u8; 3] = [0x4b, 0x4e, 0x5a];

/// A ring counter that drops by more than this (deciseconds) means the ring rebooted.
const REBOOT_REGRESSION_DS: i64 = 36_000;
/// Plausible wall-clock range for an anchor (2020-01-01 .. 2100-01-01).
const UNIX_MIN: i64 = 1_577_836_800;
const UNIX_MAX: i64 = 4_102_444_800;
const MAX_POINTS_PER_SERIES: usize = 300;
const MAX_HYPNOGRAM_POINTS: usize = 240;

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
    /// Whether the ring's firmware hypnogram was available for this night. When
    /// false the stage durations and `stages` are empty/zero.
    pub has_stages: bool,
    pub total_sleep_s: u32,
    pub deep_s: u32,
    pub light_s: u32,
    pub rem_s: u32,
    pub awake_s: u32,
    /// Fraction asleep, 0..1.
    pub efficiency: f64,
    pub wake_count: u32,
    /// Hypnogram codes spread evenly across the night: 0 deep, 1 light, 2 REM, 3 awake.
    pub stages: Vec<u8>,
    pub lowest_hr_bpm: Option<f64>,
    pub avg_hr_bpm: Option<f64>,
    pub avg_hrv_ms: Option<f64>,
    pub avg_breath_rate: Option<f64>,
    pub avg_spo2_percent: Option<f64>,
    pub skin_temp_c: Option<f64>,
    /// Time from getting into bed to first falling asleep (needs stages).
    pub latency_s: u32,
    /// Hours between the night's lowest heart rate and waking up.
    pub recovery_index_h: Option<f64>,
    /// Estimated sleep score (needs stages and at least 3 h in bed).
    pub sleep_score: Option<Score>,
    /// Estimated readiness score for the day this night ends on.
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
    /// True when some timestamps had no ring clock anchor and were estimated from
    /// the time of the sync instead.
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
    sleep_hr: Vec<Point>,
    breath: Vec<Point>,
    temp: Vec<Point>,
    spo2: Vec<Point>,
    met: Vec<Point>,
    /// `(unix, tag, codes)` per hypnogram event.
    phases: Vec<(i64, u8, Vec<u8>)>,
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

fn in_window(points: &[Point], start: i64, end: i64) -> Vec<f64> {
    points
        .iter()
        .filter(|p| p.unix >= start && p.unix <= end)
        .map(|p| p.value)
        .collect()
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

fn load(store: &Store) -> Result<(Vec<Row>, Clock), CoreError> {
    let mut tags = vec![
        TAG_TIME_SYNC,
        TAG_RTC_BEACON,
        TAG_HRV,
        TAG_SLEEP_PERIOD,
        TAG_SPO2,
        TAG_ACTIVITY,
        TAG_BEDTIME,
        TAG_DEBUG_DATA,
    ];
    tags.extend(TEMP_TAGS);
    tags.extend(PHASE_TAGS);

    let raw = store
        .decoded_events_for_tags(&tags)
        .map_err(|e| CoreError::Storage(e.to_string()))?;

    let mut rows = Vec::with_capacity(raw.len());
    let mut segments: Vec<Segment> = Vec::new();
    let mut prev_ts: Option<i64> = None;
    for (ts, tag, json, captured) in raw {
        let rebooted = prev_ts.is_some_and(|p| ts < p - REBOOT_REGRESSION_DS);
        if segments.is_empty() || rebooted {
            segments.push(Segment {
                anchors: Vec::new(),
                last_ts: ts,
                last_captured: captured,
            });
        }
        prev_ts = Some(ts);
        let Ok(json) = serde_json::from_str::<Value>(&json) else {
            continue;
        };
        let index = segments.len() - 1;
        let seg = &mut segments[index];
        if ts >= seg.last_ts {
            seg.last_ts = ts;
            seg.last_captured = captured;
        }
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

fn collect(rows: &[Row], clock: &Clock) -> Samples {
    let mut s = Samples::default();
    for row in rows {
        let unix = clock.to_unix(row.segment, row.ts);
        let v = &row.json;
        match row.tag {
            TAG_HRV => {
                let hr = f64_array(v, "hr_bpm");
                let rmssd = f64_array(v, "rmssd_ms");
                let n = hr.len().max(rmssd.len()) as i64;
                for (i, value) in hr.iter().enumerate() {
                    if *value > 20.0 {
                        s.hrv_hr.push(Point {
                            unix: unix - (n - 1 - i as i64) * 300,
                            value: *value,
                        });
                    }
                }
                for (i, value) in rmssd.iter().enumerate() {
                    if *value > 0.0 {
                        s.hrv.push(Point {
                            unix: unix - (n - 1 - i as i64) * 300,
                            value: *value,
                        });
                    }
                }
            }
            TAG_SLEEP_PERIOD => {
                if let Some(hr) = v.get("average_hr").and_then(Value::as_f64) {
                    if hr > 20.0 {
                        s.sleep_hr.push(Point { unix, value: hr });
                    }
                }
                if let Some(b) = v.get("breath").and_then(Value::as_f64) {
                    if b > 4.0 {
                        s.breath.push(Point { unix, value: b });
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
            t if TEMP_TAGS.contains(&t) => {
                if let Some(m) = median(&f64_array(v, "temps_c")) {
                    s.temp.push(Point { unix, value: m });
                }
            }
            t if PHASE_TAGS.contains(&t) => {
                let codes: Vec<u8> = v
                    .get("phases")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| match p.as_str()? {
                                "deep" => Some(0),
                                "light" => Some(1),
                                "rem" => Some(2),
                                "awake" => Some(3),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !codes.is_empty() {
                    s.phases.push((unix, t, codes));
                }
            }
            _ => {}
        }
    }
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
    s.phases.sort_by_key(|p| p.0);
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

fn build_night(s: &Samples, start: i64, end: i64) -> SleepNight {
    let time_in_bed_s = (end - start).max(0) as u32;

    // The three hypnogram tags can describe the same night; use only the one with
    // the most epochs so stages are never double-counted.
    let mut codes: Vec<u8> = Vec::new();
    for tag in PHASE_TAGS {
        let candidate: Vec<u8> = s
            .phases
            .iter()
            .filter(|(unix, t, _)| *t == tag && *unix >= start - 600 && *unix <= end + 600)
            .flat_map(|(_, _, c)| c.iter().copied())
            .collect();
        if candidate.len() > codes.len() {
            codes = candidate;
        }
    }

    let has_stages = !codes.is_empty();
    let (mut total, mut deep, mut light, mut rem, mut awake) = (0, 0, 0, 0, 0);
    let (mut efficiency, mut wake_count, mut latency_s) = (0.0, 0, 0);
    if has_stages {
        let summary = sleep::summarize(&codes, None);
        let epochs_s = (codes.len() as u32 * sleep::EPOCH_SECONDS) as f64;
        let scale =
            |stage_s: u32| (stage_s as f64 / epochs_s * time_in_bed_s as f64).round() as u32;
        deep = scale(summary.deep_s);
        light = scale(summary.light_s);
        rem = scale(summary.rem_s);
        awake = scale(summary.awake_s);
        total = deep + light + rem;
        efficiency = round2(summary.efficiency);
        wake_count = summary.wake_count;
        latency_s = scale(summary.onset_latency_s);
    }
    let stages = if codes.len() > MAX_HYPNOGRAM_POINTS {
        let step = codes.len() as f64 / MAX_HYPNOGRAM_POINTS as f64;
        (0..MAX_HYPNOGRAM_POINTS)
            .map(|i| codes[(i as f64 * step) as usize])
            .collect()
    } else {
        codes
    };

    let mut hr = in_window(&s.sleep_hr, start, end);
    hr.extend(in_window(&s.hrv_hr, start, end));
    let temps = in_window(&s.temp, start, end);
    let centi: Vec<u16> = temps
        .iter()
        .filter(|t| **t > 0.0)
        .map(|t| (t * 100.0).round() as u16)
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
        total_sleep_s: total,
        deep_s: deep,
        light_s: light,
        rem_s: rem,
        awake_s: awake,
        efficiency,
        wake_count,
        stages,
        lowest_hr_bpm: hr.iter().copied().reduce(f64::min).map(round1),
        avg_hr_bpm: mean(&hr).map(round1),
        avg_hrv_ms: mean(&in_window(&s.hrv, start, end)).map(round1),
        avg_breath_rate: mean(&in_window(&s.breath, start, end)).map(round1),
        avg_spo2_percent: mean(&in_window(&s.spo2, start, end)).map(round1),
        skin_temp_c,
        latency_s,
        recovery_index_h: recovery_index_h(s, start, end),
        sleep_score: None,
        readiness_score: None,
    }
}

/// Hours between the night's lowest (smoothed) heart rate and waking up: the
/// earlier the heart rate bottoms out, the more of the night was spent recovered.
fn recovery_index_h(s: &Samples, start: i64, end: i64) -> Option<f64> {
    let window = |series: &[Point]| -> Vec<Point> {
        series
            .iter()
            .filter(|p| p.unix >= start && p.unix <= end)
            .cloned()
            .collect()
    };
    let mut points = window(&s.sleep_hr);
    if points.len() < 12 {
        points = window(&s.hrv_hr);
    }
    if points.len() < 12 {
        return None;
    }
    // Rolling median of 5 so a single noisy sample can't be the minimum.
    let lowest = points
        .windows(5)
        .map(|w| {
            let values: Vec<f64> = w.iter().map(|p| p.value).collect();
            (median(&values).unwrap_or(f64::MAX), w[2].unix)
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))?;
    Some(round2((end - lowest.1) as f64 / 3600.0))
}

/// Shortest stretch in bed that counts as a night for scoring and baselines, so
/// naps neither get scores nor skew the baselines.
const MIN_SCORED_NIGHT_S: u32 = 3 * 3600;
/// Baselines only look at nights from the last three weeks.
const BASELINE_MAX_AGE_S: i64 = 21 * 86_400;

/// Fill in the estimated scores. `nights` must be in chronological order: each
/// night is compared against baselines from the nights before it only.
fn score_nights(nights: &mut [SleepNight], tz: i64) {
    let midpoint_hour =
        |n: &SleepNight| ((n.start_unix + n.end_unix) / 2 + tz).rem_euclid(86_400) as f64 / 3600.0;

    for index in 0..nights.len() {
        let (earlier, rest) = nights.split_at_mut(index);
        let night = &mut rest[0];
        if night.time_in_bed_s < MIN_SCORED_NIGHT_S {
            continue;
        }
        let history: Vec<&SleepNight> = earlier
            .iter()
            .rev()
            .filter(|n| {
                n.time_in_bed_s >= MIN_SCORED_NIGHT_S
                    && n.end_unix >= night.end_unix - BASELINE_MAX_AGE_S
            })
            .take(scores::MATURE_NIGHTS)
            .collect();
        let baseline = |value: fn(&SleepNight) -> Option<f64>| {
            let values: Vec<f64> = history.iter().filter_map(|n| value(n)).collect();
            (values.len() >= scores::MIN_BASELINE_NIGHTS)
                .then(|| mean(&values))
                .flatten()
        };

        if night.has_stages {
            night.sleep_score = Some(scores::sleep_score(&SleepInputs {
                total_sleep_s: night.total_sleep_s,
                deep_s: night.deep_s,
                rem_s: night.rem_s,
                awake_s: night.awake_s,
                time_in_bed_s: night.time_in_bed_s,
                efficiency: night.efficiency,
                latency_s: night.latency_s,
                midpoint_hour: midpoint_hour(night),
                prior_midpoint_hours: history.iter().take(7).map(|n| midpoint_hour(n)).collect(),
            }));
        }

        let mut recent_sleep: Vec<f64> = history
            .iter()
            .filter(|n| n.has_stages)
            .map(|n| n.total_sleep_s as f64)
            .collect();
        if night.has_stages {
            recent_sleep.push(night.total_sleep_s as f64);
        }
        night.readiness_score = scores::readiness_score(&ReadinessInputs {
            sleep_score: night.sleep_score.as_ref().map(|s| s.value),
            lowest_hr_bpm: night.lowest_hr_bpm,
            baseline_lowest_hr_bpm: baseline(|n| n.lowest_hr_bpm),
            hrv_ms: night.avg_hrv_ms,
            baseline_hrv_ms: baseline(|n| n.avg_hrv_ms),
            skin_temp_c: night.skin_temp_c,
            baseline_skin_temp_c: baseline(|n| n.skin_temp_c),
            recent_sleep_s: (recent_sleep.len() > scores::MIN_BASELINE_NIGHTS)
                .then(|| mean(&recent_sleep))
                .flatten(),
            recovery_index_h: night.recovery_index_h,
            history_nights: history.len(),
        });
    }
}

/// Build the summary for the most recent `days` local days that have data.
pub fn build_summary(
    store: &Store,
    tz_offset_seconds: i32,
    days: u32,
) -> Result<Summary, CoreError> {
    let (rows, clock) = load(store)?;
    let samples = collect(&rows, &clock);
    let tz = tz_offset_seconds as i64;
    let day_of = |unix: i64| (unix + tz).div_euclid(86_400);

    let mut nights: Vec<SleepNight> = night_windows(&samples)
        .into_iter()
        .map(|(a, b)| build_night(&samples, a, b))
        .collect();
    score_nights(&mut nights, tz);

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
            let day_points = |series: &[Point]| -> Vec<Point> {
                series
                    .iter()
                    .filter(|p| p.unix >= start && p.unix <= end)
                    .cloned()
                    .collect()
            };
            let sleep = nights
                .iter()
                .filter(|n| day_of(n.end_unix) == day)
                .max_by_key(|n| n.time_in_bed_s)
                .cloned();

            let mut heart_rate = day_points(&samples.hrv_hr);
            if heart_rate.is_empty() {
                heart_rate = day_points(&samples.sleep_hr);
            }
            let hrv = day_points(&samples.hrv);
            let temperature = day_points(&samples.temp);
            let met = day_points(&samples.met);
            let values = |pts: &[Point]| pts.iter().map(|p| p.value).collect::<Vec<_>>();

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
                    .or_else(|| mean(&values(&day_points(&samples.spo2))).map(round1)),
                skin_temp_c: night
                    .and_then(|n| n.skin_temp_c)
                    .or_else(|| mean(&values(&temperature)).map(round2)),
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

    /// A ring whose counter read 0 at `MIDNIGHT - 2h`, with one night 23:00-07:00.
    fn store_with_night(anchored: bool) -> Store {
        let store = Store::open_in_memory().unwrap();
        let ds = |unix: u32| (unix - (MIDNIGHT - 7200)) * 10;
        let mut events = Vec::new();
        if anchored {
            events.push(event(
                0x42,
                ds(MIDNIGHT - 7000),
                (MIDNIGHT - 7000).to_le_bytes().to_vec(),
            ));
        }
        let (bed, wake) = (MIDNIGHT - 3600, MIDNIGHT + 7 * 3600);
        // HRV: 3 samples of (hr, rmssd) ending 02:00.
        events.push(event(
            0x5d,
            ds(MIDNIGHT + 7200),
            vec![52, 40, 50, 60, 48, 80],
        ));
        // Per-window sleep sample at 03:00: HR 45 bpm (raw 90), breath 14/min (raw 112).
        events.push(event(
            0x6a,
            ds(MIDNIGHT + 3 * 3600),
            vec![90, 0, 0, 0, 112, 0, 0, 1, 0, 0],
        ));
        // Hypnogram: 4 epochs deep, 8 light, 2 rem, 2 awake.
        events.push(event(
            0x4b,
            ds(MIDNIGHT + 3600),
            vec![0, 0b0000_0000, 0b0101_0101, 0b0101_0101, 0b1010_1111],
        ));
        let mut bedtime = (ds(bed)).to_le_bytes().to_vec();
        bedtime.extend(ds(wake).to_le_bytes());
        events.push(event(0x76, ds(wake), bedtime));
        // Battery 87 % at 08:00.
        events.push(event(
            0x61,
            ds(MIDNIGHT + 8 * 3600),
            vec![0x24, 87, 0x10, 0x10],
        ));
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
        let summary = build_summary(&store_with_night(true), 0, 7).unwrap();
        assert!(!summary.clock_estimated);
        assert_eq!(summary.battery_percent, Some(87));
        assert_eq!(summary.event_total, 6);

        let day = summary.days.last().unwrap();
        assert_eq!(day.date, "2024-03-10");
        assert_eq!(day.day_start_unix, MIDNIGHT as i64);
        let night = day.sleep.as_ref().unwrap();
        assert_eq!(night.start_unix, (MIDNIGHT - 3600) as i64);
        assert_eq!(night.time_in_bed_s, 8 * 3600);
        assert!(night.has_stages);
        // 16 epochs over 8 h: each epoch stands for 30 min.
        assert_eq!(night.deep_s, 2 * 3600);
        assert_eq!(night.light_s, 4 * 3600);
        assert_eq!(night.rem_s, 3600);
        assert_eq!(night.awake_s, 3600);
        assert_eq!(night.total_sleep_s, 7 * 3600);
        assert_eq!(night.efficiency, 0.88);
        assert_eq!(night.stages.len(), 16);
        assert_eq!(night.lowest_hr_bpm, Some(45.0));
        assert_eq!(night.avg_hrv_ms, Some(60.0));
        assert_eq!(night.avg_breath_rate, Some(14.0));
        // Asleep from the first epoch.
        assert_eq!(night.latency_s, 0);
        let sleep_score = night.sleep_score.as_ref().unwrap();
        assert_eq!(sleep_score.contributors.len(), 7);
        assert!(
            (60..=95).contains(&sleep_score.value),
            "{}",
            sleep_score.value
        );
        // One night is not enough history for a readiness score.
        assert!(night.readiness_score.is_none());

        assert_eq!(day.resting_hr_bpm, Some(45.0));
        assert_eq!(day.hrv.len(), 3);
        // Samples are laid out ending at the event time, 5 min apart.
        assert_eq!(day.hrv[2].unix, (MIDNIGHT + 7200) as i64);
        assert_eq!(day.hrv[0].unix, (MIDNIGHT + 7200 - 600) as i64);
    }

    #[test]
    fn local_timezone_moves_the_day_boundary() {
        // UTC-10: the 07:00 UTC wake-up is 21:00 the previous local day.
        let summary = build_summary(&store_with_night(true), -10 * 3600, 7).unwrap();
        let night_day = summary.days.iter().find(|d| d.sleep.is_some()).unwrap();
        assert_eq!(night_day.date, "2024-03-09");
    }

    #[test]
    fn missing_anchor_falls_back_to_capture_time() {
        let summary = build_summary(&store_with_night(false), 0, 7).unwrap();
        assert!(summary.clock_estimated);
        assert!(!summary.days.is_empty());
    }

    #[test]
    fn empty_store_is_an_empty_summary() {
        let summary = build_summary(&Store::open_in_memory().unwrap(), 0, 7).unwrap();
        assert!(summary.days.is_empty());
        assert_eq!(summary.battery_percent, None);
    }

    fn night(end_unix: i64, hr: f64, hrv: f64) -> SleepNight {
        SleepNight {
            start_unix: end_unix - 8 * 3600,
            end_unix,
            time_in_bed_s: 8 * 3600,
            has_stages: true,
            total_sleep_s: 7 * 3600,
            deep_s: 80 * 60,
            light_s: 250 * 60,
            rem_s: 90 * 60,
            awake_s: 60 * 60,
            efficiency: 0.88,
            wake_count: 3,
            stages: Vec::new(),
            lowest_hr_bpm: Some(hr),
            avg_hr_bpm: Some(hr + 6.0),
            avg_hrv_ms: Some(hrv),
            avg_breath_rate: None,
            avg_spo2_percent: None,
            skin_temp_c: Some(34.8),
            latency_s: 15 * 60,
            recovery_index_h: Some(4.0),
            sleep_score: None,
            readiness_score: None,
        }
    }

    #[test]
    fn readiness_appears_once_baselines_exist_and_reacts_to_a_bad_night() {
        let wake = |day: i64| MIDNIGHT as i64 + day * 86_400 + 7 * 3600;
        let mut nights: Vec<SleepNight> = (0..5).map(|d| night(wake(d), 50.0, 60.0)).collect();
        // Sixth night: resting HR up 8 bpm, HRV down a third.
        nights.push(night(wake(5), 58.0, 40.0));
        // A nap neither gets scored nor enters the baselines.
        let mut nap = night(wake(5) + 8 * 3600, 70.0, 20.0);
        nap.time_in_bed_s = 3600;
        nights.push(nap);
        score_nights(&mut nights, 0);

        assert!(nights
            .iter()
            .all(|n| n.sleep_score.is_some() || n.time_in_bed_s == 3600));
        // The first three nights have no baseline to compare against yet.
        assert!(nights[..3].iter().all(|n| n.readiness_score.is_none()));
        let steady = nights[4].readiness_score.as_ref().unwrap();
        let strained = nights[5].readiness_score.as_ref().unwrap();
        assert!(steady.provisional && strained.provisional);
        assert!(
            strained.value + 15 <= steady.value,
            "steady {} vs strained {}",
            steady.value,
            strained.value
        );
        assert!(nights[6].sleep_score.is_none() && nights[6].readiness_score.is_none());
    }
}
