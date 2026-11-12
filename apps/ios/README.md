# Open Oura for iOS

A native iPhone app that reads an Oura ring directly over Bluetooth: no Oura
account, no cloud, no ML models. Everything stays in a SQLite database on the phone.

- **Scores** - a Sleep score from published sleep norms, a Readiness score, and
  optionally Oura-calibrated versions of both (see "Scores" below).
- **Today** - sleep, resting heart rate, HRV, blood oxygen, skin temperature and
  activity for a day, with heart-rate / HRV / activity charts.
- **Sleep** - the night's window, stage hypnogram and breakdown, lowest and average
  heart rate, HRV, breathing rate, SpO2, skin temperature.
- **Trends** - the last 30 days of each metric.
- **Ring** - scan and connect, key management, sync, live heart rate, device info.

## How it is put together

```
SwiftUI views ── AppModel ── OuraCore (Rust, via UniFFI) ── oura-link / oura-store / oura-analysis
                    │              ▲ write()        │ on_notification()
                    └── RingConnection (CoreBluetooth) ──── ring
```

Swift owns CoreBluetooth (`Sources/RingConnection.swift`) and gives the Rust core
(`crates/oura-core`) a write channel plus every notification frame. The auth
handshake, the history-event drain, storage and the daily summary are the same Rust
the `oura` CLI uses.

## Build

Requires macOS with Xcode 15+, [rustup](https://rustup.rs) and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
apps/ios/build-rust.sh
```

```bash
cd apps/ios/OuraApp && xcodegen generate && open OuraApp.xcodeproj
```

Set your development team under *Signing & Capabilities* and run on an iPhone
(iOS 17+). The simulator has no Bluetooth, so it only shows the empty state.
Re-run `build-rust.sh` whenever `crates/oura-core` changes.

## The ring key

History, battery and live readings are gated by the ring's 16-byte app-auth key.

- **Ring already set up with the official Oura app:** the key lives in that app's
  database. Export it (see [`crates/README.md`](../../crates/README.md), "Auth
  key") and paste the 32 hex characters into *Ring → Ring key*.
- **Factory-reset ring:** *Ring → Pair a factory-reset ring* creates a key, saves
  it in the Keychain, installs it on the ring and turns on heart-rate and SpO2
  measurement. The official app cannot use the ring afterwards until it is reset
  again, and this phone's Keychain holds the only copy of the key.

The ring talks to one central at a time: close the official app (or briefly dock
the ring) if the app stays on "Connecting…".

## What the numbers are

All metrics are computed in `crates/oura-core/src/summary.rs` from the ring's own
history events, following the rules upstream `open_health` validated on real rings:

| Shown | Source |
| --- | --- |
| Night window | `bedtime_period` (0x76), else runs of `sleep_period_information_2` (0x6a) |
| Sleep stages, latency, awakenings | the ring's own hypnogram, `sleep_phase_data` (0x5a): 30 s epochs written when the ring finishes analysing a sleep |
| Heart rate, HRV | `hrv_event` (0x5d, 5-minute averages) |
| Breathing rate | 0x6a windows the ring scored as asleep |
| Blood oxygen | `spo2_event` (0x6f), or the R ratio of `spo2_r_pi_event` (0x8b) through the ported SpO2 curve |
| Skin temperature | `sleep_temp_event` (0x75) through the ported nightly-temperature algorithm |
| Activity | `activity_information` (0x50) MET levels |

Limits worth knowing:

- **Sleep stages are the ring's firmware analysis**, not the staging model the
  official app runs on the phone, so they can differ from the official app. A night
  the ring only partly analysed shows its stages with gaps and gets no efficiency,
  latency or sleep score.
- **Times depend on clock anchors.** Every sync sets the ring's clock and stores a
  phone-clock anchor, so data synced by this app is timed exactly. Older data with
  no anchor is timed from the moment it was synced and flagged in the app.
- Syncing happens while the app is open; there is no background sync.

## Scores

Details: [`docs/algorithms/estimated-scores.md`](../../docs/algorithms/estimated-scores.md).

- **Sleep score** (always): scored against published sleep-science recommendations
  for your age (set it in Ring → Scores). Ported from `open_health`. It is
  deliberately not Oura's score.
- **Readiness** (always, from about the fourth night): an estimate using Oura's
  weights and this app's own curves, comparing each night with your baseline.
- **Oura-calibrated Sleep and Readiness** (optional): export your trends from your
  Oura account, run `tools/calibrate_scores.py --csv trends.csv` on a computer and
  import the resulting `score_params.json` in Ring → Scores. The app then also shows
  an Oura-style sleep score and switches Readiness to the calibrated curves.
- **No Activity score**, and no exact Oura scores: see the document above for why.

## Compared with open_health

Upstream's [`open_health`](https://github.com/Th0rgal/open_health) app is far more
complete. This app shares its sync behaviour, clock anchoring, signal sources and
sleep score, and does not have its models, reports or exports. The full list is in
[`docs/clients-web-and-ios.md`](../../docs/clients-web-and-ios.md).

## Status

The Rust core is covered by tests (`cargo test -p oura-core`), including the auth
handshake through the foreign link, the summary on synthetic events, the scores and
the calibration evaluator. The Swift
app was written without access to Xcode or a ring, so it has **not been compiled or
run on a device yet**: expect to fix small compile errors on the first build.
