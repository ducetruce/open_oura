import SwiftUI

struct RingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var keyText = ""
    @State private var confirmPair = false
    @State private var confirmRemoveKey = false

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                if model.ring.rememberedRing == nil {
                    scanSection
                }
                keySection
                if model.isConnected && model.hasKey {
                    syncSection
                    liveSection
                }
                deviceSection
                storageSection
            }
            .navigationTitle("Ring")
            .disabled(model.isBusy)
        }
    }

    // MARK: Connection

    private var connectionSection: some View {
        Section {
            HStack {
                Label(statusText, systemImage: statusIcon)
                Spacer()
                if model.isBusy || model.ring.state == .connecting || model.ring.state == .scanning {
                    ProgressView()
                }
            }
            if let activity = model.activity {
                Text(model.syncProgress ?? "\(activity)…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if model.ring.rememberedRing != nil {
                Button("Forget this ring", role: .destructive) {
                    model.ring.forget()
                }
            }
        } header: {
            Text("Connection")
        } footer: {
            if model.ring.state == .connecting {
                Text("Waiting for the ring. It can only talk to one phone at a time: close the official Oura app, or put the ring on its charger for a moment.")
            }
        }
    }

    private var statusText: String {
        switch model.ring.state {
        case .unavailable(let reason): reason
        case .idle: model.ring.rememberedRing == nil ? "No ring selected" : "Disconnected"
        case .scanning: "Scanning…"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        }
    }

    private var statusIcon: String {
        switch model.ring.state {
        case .ready: "checkmark.circle.fill"
        case .unavailable: "exclamationmark.triangle"
        default: "circle.dashed"
        }
    }

    private var scanSection: some View {
        Section("Nearby rings") {
            ForEach(model.ring.discovered) { ring in
                Button {
                    model.ring.connect(to: ring.id)
                } label: {
                    HStack {
                        Text(ring.name)
                        Spacer()
                        Text("\(ring.rssi) dBm")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
            }
            if model.ring.state == .scanning {
                Button("Stop scanning") { model.ring.stopScan() }
            } else {
                Button("Scan for rings") { model.ring.startScan() }
                    .disabled(model.ring.state != .idle)
            }
        }
    }

    // MARK: Key

    @ViewBuilder
    private var keySection: some View {
        if model.hasKey {
            Section {
                Label("Key stored in the Keychain", systemImage: "key.fill")
                Button("Remove key", role: .destructive) { confirmRemoveKey = true }
                    .confirmationDialog(
                        "Remove the ring key from this phone?",
                        isPresented: $confirmRemoveKey,
                        titleVisibility: .visible
                    ) {
                        Button("Remove key", role: .destructive) { model.removeKey() }
                    } message: {
                        Text("If this app created the key, it is the only copy. Without it the ring must be factory-reset before it can be read again.")
                    }
            } header: {
                Text("Ring key")
            }
        } else {
            Section {
                TextField("32 hex characters", text: $keyText, axis: .vertical)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Use this key") {
                    Task {
                        await model.importKey(keyText)
                        if model.hasKey { keyText = "" }
                    }
                }
                .disabled(keyText.isEmpty)
            } header: {
                Text("Ring key")
            } footer: {
                Text("History, battery and live readings need the ring’s 16-byte key. A ring set up with the official app already has one, stored by that app; see the repository docs for exporting it.")
            }
            Section {
                Button("Pair a factory-reset ring") { confirmPair = true }
                    .disabled(!model.isConnected)
                    .confirmationDialog(
                        "Install a new key on this ring?",
                        isPresented: $confirmPair,
                        titleVisibility: .visible
                    ) {
                        Button("Install new key") { Task { await model.pairFactoryResetRing() } }
                    } message: {
                        Text("This only works on a ring that has been factory-reset. The official Oura app will no longer be able to use the ring until it is reset again.")
                    }
            } footer: {
                Text("For a ring with no key yet: creates one, saves it in the Keychain and installs it on the ring.")
            }
        }
    }

    // MARK: Sync and live readings

    private var syncSection: some View {
        Section {
            Button("Sync now") { Task { await model.sync() } }
            if let result = model.lastSyncResult {
                Text(result).foregroundStyle(.secondary)
            }
            Toggle("Set ring clock when syncing", isOn: $model.setRingClock)
        } header: {
            Text("Sync")
        } footer: {
            Text("The official app sets the ring’s clock on every sync. Turn this on if this app is the only one syncing the ring, so readings get exact times.")
        }
    }

    private var liveSection: some View {
        Section {
            HStack {
                Button("Measure heart rate (\(AppModel.liveSeconds)s)") {
                    Task { await model.streamHeartRate() }
                }
                Spacer()
                if let bpm = model.liveBpm {
                    Text("\(bpm) bpm").monospacedDigit().foregroundStyle(.red)
                }
            }
            Button("Read latest values") { Task { await model.readLatest() } }
            if let latest = model.latest {
                LabeledContent("Heart rate", value: latest.heartRateBpm.map { "\($0) bpm" } ?? "–")
                LabeledContent("Blood oxygen", value: latest.spo2Percent.map { "\($0) %" } ?? "–")
            }
        } header: {
            Text("Live")
        } footer: {
            Text("The ring must be on your finger.")
        }
    }

    // MARK: Device and storage

    @ViewBuilder
    private var deviceSection: some View {
        if let info = model.ringInfo {
            Section("Device") {
                if let battery = info.batteryPercent {
                    LabeledContent("Battery", value: "\(battery) %")
                }
                LabeledContent("Serial", value: info.serial)
                LabeledContent("Hardware", value: info.hardwareId)
                LabeledContent("Firmware", value: info.firmwareVersion)
            }
        } else if let device = model.storedDevice {
            Section("Last seen ring") {
                if let battery = model.summary?.batteryPercent {
                    LabeledContent("Battery (last logged)", value: "\(battery) %")
                }
                LabeledContent("Serial", value: device.serial)
                LabeledContent("Firmware", value: device.firmwareVersion)
                if device.lastSyncUnix > 0 {
                    LabeledContent("Last sync") {
                        Text(dateFromUnix(device.lastSyncUnix), format: .relative(presentation: .named))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var storageSection: some View {
        if let total = model.summary?.eventTotal, total > 0 {
            Section {
                DisclosureGroup("\(total) events stored on this phone") {
                    ForEach(model.eventCounts, id: \.name) { entry in
                        LabeledContent(entry.name, value: "\(entry.count)")
                            .font(.footnote.monospaced())
                    }
                }
            } header: {
                Text("Storage")
            } footer: {
                Text("Everything stays on this phone. Nothing is sent to Oura or anywhere else.")
            }
        }
    }
}
