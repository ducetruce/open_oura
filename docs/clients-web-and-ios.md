# Clients: web and iOS

Feature ↔ client map. The shared brain is `crates/oura-core/src/summary.rs`
(`build_summary`): add a computed metric there once, then render it in every client.

| Feature | iOS (`apps/ios/OuraApp`) | Web dashboard |
| --- | --- | --- |
| Scan / connect / reconnect | `RingConnection.swift` | not in this repo |
| Key import, factory-reset pairing | `RingView.swift`, `KeyStore.swift` | - |
| History sync with progress | `AppModel.sync` → `OuraCore.sync` | - |
| Live heart rate, latest HR / SpO2 | `RingView.swift` | - |
| Sleep score (published norms), Readiness, optional Oura-calibrated scores | `TodayView.swift`, `SleepView.swift`, `TrendsView.swift` (`scores.rs`, `calibration.rs`) | - |
| Score calibration import, age setting | `RingView.swift` | - |
| Day metrics + HR / HRV / MET charts | `TodayView.swift` | - |
| Night detail + ring hypnogram, latency, awakenings | `SleepView.swift` | - |
| 30-day trends | `TrendsView.swift` | - |
| Device info, stored event counts | `RingView.swift` | - |

## Compared with upstream `open_health`

Checked against `Th0rgal/open_health` at `8f616ec` (2026-10-25). Its iOS app and
shared summary are roughly ten times the size of this one; this app is a subset.

### Same behaviour (ported or matching)

| Area | Upstream | Here |
| --- | --- | --- |
| Sync: phone clock pushed to the ring | `oura-core::sync_inner` | `OuraCore::sync` |
| Sync: ask the ring to run sleep analysis first | same | same |
| Sync: restart from zero after a ring reboot or a rejected Ring 5 cursor | `cursor_marker_present`, `is_rejected_history_cursor` | same logic |
| Sync: batch + cursor committed atomically | `drain_into_store` | `OuraCore::drain_into_store` |
| Phone-clock anchor stored after each sync | `phone_anchor_event` | same row format |
| Boot epochs split on counter resets, timed by their own anchors | `ring_time.rs` | `summary.rs::load` (simplified, see gaps) |
| Packed HR/HRV samples walk back from the packet stamp | `packed_series` | `summary.rs::collect` |
| Ring hypnogram from `sleep_phase_data`, 30 s epochs ending at the last page | `ring_hypnograms` | `summary.rs::build_night` |
| Unanalysed epochs are unknown; partial staging gets no metrics or score | `sleep_metrics` | same |
| Skin temperature from `sleep_temp_event` only | `build_summary` | same |
| Breathing rate only from windows scored asleep | same | same |
| SpO2 from the R ratio with the gen4 coefficients | `spo2_pct` | `spo2_from_ratio` |
| Day ↔ night pairing by wake date, longest night wins | `wakeYmd` | `build_summary` |
| Published-norms sleep score, causal baselines excluding naps | `sleep_score.rs` | `scores.rs` |
| Unfiltered scan, charging case skipped, ready only after all subscriptions | `BLETransport.swift` | `RingConnection.swift` |
| Writes wait for the ring's acknowledgement | `BLETransport.write` | `RingConnection.write` |
| Screen kept awake during ring work | `IdleTimerLock` | `AppModel.perform` |

### Here but not upstream

- Readiness score (estimate, or calibrated from a trends export).
- Oura-calibrated sleep score from an imported `score_params.json`.

## Known gaps

Not in this repository at all:

- **Web dashboard**, DNA explorer, blood panel. iOS is the only client, so every
  feature above is iOS-only.
- **On-device models**: Oura's sleep-staging model (upstream's main hypnogram
  source; here only the firmware hypnogram), cardiovascular age, activity /
  workout detection, illness detection, stress.

iOS features upstream has and this app does not:

- **Clock robustness**: anchors are not cross-checked for a stalled or fast
  counter, and nights without an anchor are shown with estimated times (flagged)
  instead of being withheld; no per-boot clock diagnostics.
- **Bedtime repair**: premature `bedtime_period` ends are not extended from
  sleep-only sensor evidence, and adjacent periods are not merged; no manual
  bedtime override.
- **Sleep report**: no polysomnograph lanes (movement, per-stage HR/HRV), REM
  latency, cycles, fragmentation, 5-minute hypnogram, or signal-based staging
  fallback when the ring wrote no hypnogram.
- **Sleep debt** and personalised sleep need.
- **Activity report**: no steps, calories, distance, 24 h MET profile or workouts.
- **Symptom Radar**, VO2max estimate, hourly heart-rate bands, battery history,
  the daily digest and baseline-relative vital deltas.
- **Profile** beyond age (sex, height, weight; Apple Health import).
- **Apple Health export**, day JSON export, research export, raw database export.
- **Diagnostics**: no shareable report, event browser or database integrity check;
  no factory reset from the app; no on-ring feature toggles.
- **Sync plumbing**: Ring 5 history frames are not coalesced before crossing the
  FFI (slower, not incorrect); a sync cannot be cancelled; no background sync.

Scores:

- **No exact Oura scores and no Activity score** on any client
  (`docs/algorithms/estimated-scores.md`).

Verification:

- **The iOS app has not been compiled or run on a device** (written on Linux
  without Xcode), and nothing here has been tested against a physical ring.
