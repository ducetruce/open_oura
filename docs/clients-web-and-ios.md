# Clients: web and iOS

Feature ↔ client map. The shared brain is `crates/oura-core/src/summary.rs`
(`build_summary`): add a computed metric there once, then render it in every client.

| Feature | iOS (`apps/ios/OuraApp`) | Web dashboard |
| --- | --- | --- |
| Scan / connect / reconnect | `RingConnection.swift` | not in this repo |
| Key import, factory-reset pairing | `RingView.swift`, `KeyStore.swift` | - |
| History sync with progress | `AppModel.sync` → `OuraCore.sync` | - |
| Live heart rate, latest HR / SpO2 | `RingView.swift` | - |
| Estimated Readiness + Sleep scores, contributors, score trends | `TodayView.swift`, `SleepView.swift`, `TrendsView.swift` (`scores.rs`) | - |
| Day metrics + HR / HRV / MET charts | `TodayView.swift` | - |
| Night detail + hypnogram | `SleepView.swift` | - |
| 30-day trends | `TrendsView.swift` | - |
| Device info, stored event counts | `RingView.swift` | - |

## Known gaps

- **No web dashboard in this repository.** It lives upstream in `open_health`; the
  iOS app is the only client here, so every feature above is iOS-only.
- **Scores are estimates.** Sleep and Readiness use Oura's recovered weights over
  this project's own contributor curves (`docs/algorithms/estimated-scores.md`);
  there is no Activity score and no per-user calibration from a trends export.
- **No models on either client.** No SleepNet staging, no cardiovascular age, no workout classification. Sleep stages
  are the ring's firmware hypnogram.
- **iOS:** no background sync, no HealthKit export, single ring, no accelerometer
  or RData tooling (those stay in the `oura` CLI).
- **iOS app not yet compiled or run on a device** (written on Linux without Xcode).
