# Open Oura for iOS

A native iPhone app that reads an Oura ring directly over Bluetooth: no Oura
account, no cloud, no ML models. Everything stays in a SQLite database on the phone.

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
history events:

| Shown | Source |
| --- | --- |
| Night window | `bedtime_period` (0x76), else runs of `sleep_period_information_2` (0x6a) |
| Sleep stages | the ring's **firmware** hypnogram (0x4b/0x4e/0x5a) |
| Heart rate, HRV | `hrv_event` (0x5d, 5-minute averages), 0x6a during sleep |
| Breathing rate | 0x6a |
| Blood oxygen | `spo2_event` (0x6f) |
| Skin temperature | temperature events (0x46/0x69/0x75) through the ported nightly-temperature algorithm |
| Activity | `activity_information` (0x50) MET levels |

Limits worth knowing:

- **No Readiness / Sleep / Activity scores.** Oura computes those on the phone with
  proprietary models that are not part of this repository.
- **Sleep stages differ from the official app**, which uses its SleepNet model
  rather than the firmware hypnogram. The epoch length of the firmware events is
  not documented, so stage durations are each stage's share of the night scaled to
  the time in bed.
- **Times depend on the ring's clock anchors** (`time_sync` / `rtc_beacon`). Data
  with no anchor is timed from the moment it was synced and flagged in the app;
  *Set ring clock when syncing* writes an anchor on each sync.
- Syncing happens while the app is open; there is no background sync.

## Status

The Rust core is covered by tests (`cargo test -p oura-core`), including the auth
handshake through the foreign link and the summary on synthetic events. The Swift
app was written without access to Xcode or a ring, so it has **not been compiled or
run on a device yet**: expect to fix small compile errors on the first build.
