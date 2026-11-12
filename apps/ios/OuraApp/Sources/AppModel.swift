import Combine
import Foundation
import UIKit

/// Plain message for an error, unwrapping the Rust core's error enum.
func describe(_ error: Error) -> String {
    if let error = error as? CoreError {
        switch error {
        case .NotConnected(let message), .Busy(let message), .InvalidKey(let message),
             .Ring(let message), .Storage(let message), .InvalidCalibration(let message):
            return message
        }
    }
    return error.localizedDescription
}

/// Run blocking work on a background queue and await its result.
private func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(with: Result { try work() })
        }
    }
}

private final class SyncProgressRelay: SyncListener {
    let handler: (UInt32, UInt32) -> Void
    init(_ handler: @escaping (UInt32, UInt32) -> Void) { self.handler = handler }
    func onProgress(eventsSynced: UInt32, bytesLeft: UInt32) {
        DispatchQueue.main.async { self.handler(eventsSynced, bytesLeft) }
    }
}

private final class HeartRateRelay: HeartRateListener {
    let handler: (UInt16) -> Void
    init(_ handler: @escaping (UInt16) -> Void) { self.handler = handler }
    func onSample(bpm: UInt16, ibiMs: UInt16) {
        DispatchQueue.main.async { self.handler(bpm) }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let liveSeconds: UInt32 = 30
    private static let historyDays: UInt32 = 30

    let ring: RingConnection
    private let core: OuraCore
    private var subscriptions: Set<AnyCancellable> = []

    @Published private(set) var summary: Summary?
    @Published private(set) var ringInfo: RingInfo?
    @Published private(set) var storedDevice: StoredDevice?
    @Published private(set) var eventCounts: [EventCount] = []
    @Published private(set) var latest: LatestReadings?
    @Published private(set) var liveBpm: UInt16?
    @Published private(set) var hasKey: Bool
    /// Label of the ring operation in flight, if any. One runs at a time.
    @Published private(set) var activity: String?
    @Published private(set) var syncProgress: String?
    @Published private(set) var lastSyncResult: String?
    @Published var errorMessage: String?
    @Published var selectedDate: String?
    /// The imported Oura score calibration, if any.
    @Published private(set) var calibration: CalibrationInfo?
    /// Age in years for the age-specific sleep recommendations; 0 means not set.
    @Published var age: Int {
        didSet {
            UserDefaults.standard.set(age, forKey: "age")
            Task { await reloadStoredData() }
        }
    }

    private let calibrationFile: URL

    init() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let core: OuraCore
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            core = try OuraCore(dbPath: directory.appendingPathComponent("oura.db").path)
        } catch {
            fatalError("Could not open the ring database: \(describe(error))")
        }
        self.core = core
        ring = RingConnection(core: core)
        hasKey = KeyStore.load() != nil
        age = UserDefaults.standard.integer(forKey: "age")
        calibrationFile = directory.appendingPathComponent("score_params.json")
        // A calibration imported earlier is kept next to the database.
        if let saved = try? String(contentsOf: calibrationFile, encoding: .utf8) {
            calibration = try? core.setScoreCalibration(json: saved)
        }

        ring.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &subscriptions)
        ring.$state
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                if state == .ready {
                    Task { await self.refreshRingInfo() }
                } else {
                    self.ringInfo = nil
                    self.liveBpm = nil
                }
            }
            .store(in: &subscriptions)
    }

    var isConnected: Bool { ring.state == .ready }
    var isBusy: Bool { activity != nil }

    var selectedDay: DaySummary? {
        guard let days = summary?.days, !days.isEmpty else { return nil }
        return days.first(where: { $0.date == selectedDate }) ?? days.last
    }

    /// Move the selected day by `offset` days within the days that have data.
    func stepDay(_ offset: Int) {
        guard let days = summary?.days, let current = selectedDay,
              let index = days.firstIndex(where: { $0.date == current.date })
        else { return }
        let next = min(max(index + offset, 0), days.count - 1)
        selectedDate = days[next].date
    }

    func canStepDay(_ offset: Int) -> Bool {
        guard let days = summary?.days, let current = selectedDay,
              let index = days.firstIndex(where: { $0.date == current.date })
        else { return false }
        return days.indices.contains(index + offset)
    }

    // MARK: Offline data

    func reloadStoredData() async {
        let core = core
        let offset = Int32(TimeZone.current.secondsFromGMT())
        let days = Self.historyDays
        let ageBand: UInt8? = (1...120).contains(age) ? UInt8(age) : nil
        do {
            let loaded = try await offMain {
                try (
                    core.summary(tzOffsetSeconds: offset, days: days, age: ageBand),
                    core.storedDevice(),
                    core.eventCounts()
                )
            }
            summary = loaded.0
            storedDevice = loaded.1
            eventCounts = loaded.2
        } catch {
            errorMessage = describe(error)
        }
    }

    // MARK: Ring operations

    /// Run one blocking core call off the main thread, surfacing any error.
    private func perform<T>(_ label: String, _ work: @escaping () throws -> T) async -> T? {
        guard activity == nil else { return nil }
        activity = label
        // iOS suspends a locked phone's foreground app mid-transfer; keep the screen
        // on for the duration of a ring operation.
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            activity = nil
            UIApplication.shared.isIdleTimerDisabled = false
        }
        do {
            return try await offMain(work)
        } catch {
            errorMessage = describe(error)
            return nil
        }
    }

    func refreshRingInfo() async {
        let core = core
        let key = KeyStore.load()
        if let info = await perform("Reading ring", { try core.ringInfo(keyHex: key) }) {
            ringInfo = info
        }
    }

    func sync() async {
        guard let key = KeyStore.load() else {
            errorMessage = "Add your ring's key first (Ring tab)."
            return
        }
        let core = core
        syncProgress = "Starting…"
        let listener = SyncProgressRelay { [weak self] events, bytesLeft in
            let remaining = ByteCountFormatter.string(fromByteCount: Int64(bytesLeft), countStyle: .memory)
            self?.syncProgress = "\(events) events, \(remaining) left on ring"
        }
        let report = await perform("Syncing") {
            try core.sync(keyHex: key, listener: listener)
        }
        syncProgress = nil
        if let report {
            lastSyncResult = "\(report.eventsReceived) events received, \(report.newEvents) new"
            await reloadStoredData()
            await refreshRingInfo()
        }
    }

    func readLatest() async {
        guard let key = KeyStore.load() else { return }
        let core = core
        if let readings = await perform("Reading latest values", { try core.latest(keyHex: key) }) {
            latest = readings
        }
    }

    func streamHeartRate() async {
        guard let key = KeyStore.load() else { return }
        let core = core
        liveBpm = nil
        let seconds = Self.liveSeconds
        let listener = HeartRateRelay { [weak self] bpm in self?.liveBpm = bpm }
        _ = await perform("Measuring heart rate") {
            try core.liveHeartRate(keyHex: key, seconds: seconds, listener: listener)
        }
    }

    // MARK: Score calibration

    /// Import a `score_params.json` made by `tools/calibrate_scores.py` from an
    /// Oura trends export. Scores are then calibrated to that history.
    func importCalibration(from url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let json = try String(contentsOf: url, encoding: .utf8)
            calibration = try core.setScoreCalibration(json: json)
            try json.write(to: calibrationFile, atomically: true, encoding: .utf8)
        } catch {
            errorMessage = describe(error)
            return
        }
        await reloadStoredData()
    }

    func removeCalibration() async {
        try? FileManager.default.removeItem(at: calibrationFile)
        calibration = try? core.setScoreCalibration(json: nil)
        await reloadStoredData()
    }

    // MARK: Key management

    /// Use a key exported from the phone that originally onboarded this ring.
    func importKey(_ text: String) async {
        let key = text.filter { !$0.isWhitespace }.lowercased()
        guard isValidAuthKey(keyHex: key) else {
            errorMessage = "A ring key is 32 hexadecimal characters (16 bytes)."
            return
        }
        do {
            try KeyStore.save(key)
            hasKey = true
        } catch {
            errorMessage = describe(error)
            return
        }
        if isConnected { await refreshRingInfo() }
    }

    /// Install a brand-new key on a factory-reset ring.
    func pairFactoryResetRing() async {
        guard !hasKey else { return }
        let core = core
        let key: String
        do {
            key = try generateAuthKey()
            // Saved before it is installed: if the app dies mid-pairing, the only
            // copy of a key that may already be live on the ring is not lost.
            try KeyStore.save(key)
            hasKey = true
        } catch {
            errorMessage = describe(error)
            return
        }
        let installed: Void? = await perform("Pairing") {
            try core.installKey(keyHex: key)
            // Heart rate and SpO2 are off after a key-only pairing.
            try core.enableMeasurements(keyHex: key)
        }
        if installed != nil { await refreshRingInfo() }
    }

    func removeKey() {
        KeyStore.delete()
        hasKey = false
        ringInfo = nil
    }
}
