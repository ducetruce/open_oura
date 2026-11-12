import CoreBluetooth
import Foundation

struct DiscoveredRing: Identifiable, Equatable {
    let id: UUID
    var name: String
    var rssi: Int
}

enum LinkState: Equatable {
    case unavailable(String)
    case idle
    case scanning
    case connecting
    case ready
}

/// Owns CoreBluetooth: scans for rings, connects, subscribes to the Oura service
/// and hands the Rust core a write channel (`RingLink`) plus every notification.
///
/// All CoreBluetooth work happens on `queue`; `@Published` state is only touched
/// on the main thread.
final class RingConnection: NSObject, ObservableObject {
    @Published private(set) var state: LinkState = .idle
    @Published private(set) var discovered: [DiscoveredRing] = []
    @Published private(set) var rememberedRing: UUID?
    /// Why the last connection attempt failed, if it did.
    @Published private(set) var lastProblem: String?

    private static let rememberedKey = "ringIdentifier"
    /// Ring 5's charging case advertises an Oura-looking name and its own service.
    /// It must never be connected to in place of the ring.
    private static let chargingCaseService = CBUUID(string: "8BC5888F-C577-4F5D-857F-377354093F13")
    private static let writeTimeout: DispatchTimeInterval = .seconds(10)

    private let core: OuraCore
    private let queue = DispatchQueue(label: "dev.openoura.ble")
    private let serviceUUID = CBUUID(string: ouraServiceUuid())
    private let writeUUID = CBUUID(string: ouraWriteUuid())
    private var central: CBCentralManager!

    // Touched only on `queue`.
    private var seen: [UUID: CBPeripheral] = [:]
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var pendingSubscriptions = 0
    private var attached = false
    private var wanted: UUID?
    /// Signalled with the outcome of the write-with-response in flight.
    private var pendingWrite: (DispatchSemaphore, (Bool) -> Void)?

    init(core: OuraCore) {
        self.core = core
        super.init()
        let remembered = UserDefaults.standard.string(forKey: Self.rememberedKey)
            .flatMap { UUID(uuidString: $0) }
        rememberedRing = remembered
        wanted = remembered
        central = CBCentralManager(delegate: self, queue: queue)
    }

    // MARK: Intents (call from the main thread)

    func startScan() {
        discovered = []
        queue.async {
            guard self.central.state == .poweredOn else { return }
            self.seen.removeAll()
            // Unfiltered, with duplicates: the ring's name only arrives in its scan
            // response, which a worn ring answers lazily, and a service-filtered
            // scan can coalesce it into one early name-less report. Rings are
            // matched in `didDiscover` instead.
            self.central.scanForPeripherals(
                withServices: nil,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
            self.publish(.scanning)
        }
    }

    func stopScan() {
        queue.async {
            guard self.central.state == .poweredOn, self.central.isScanning else { return }
            self.central.stopScan()
            if self.peripheral == nil { self.publish(.idle) }
        }
    }

    func connect(to id: UUID) {
        UserDefaults.standard.set(id.uuidString, forKey: Self.rememberedKey)
        rememberedRing = id
        lastProblem = nil
        queue.async {
            self.wanted = id
            self.connectWanted()
        }
    }

    /// Disconnect and stop reconnecting to the remembered ring.
    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.rememberedKey)
        rememberedRing = nil
        lastProblem = nil
        queue.async {
            self.wanted = nil
            if let peripheral = self.peripheral {
                self.central.cancelPeripheralConnection(peripheral)
            }
            self.tearDown()
            self.publish(.idle)
        }
    }

    // MARK: Queue-confined helpers

    private func publish(_ state: LinkState) {
        DispatchQueue.main.async { self.state = state }
    }

    private func report(_ problem: String?) {
        DispatchQueue.main.async { self.lastProblem = problem }
    }

    /// Start (or restart) a connection to the wanted ring. A CoreBluetooth connect
    /// request never times out, so this also serves as "reconnect when in range".
    private func connectWanted() {
        guard central.state == .poweredOn, let id = wanted else { return }
        if central.isScanning { central.stopScan() }
        guard let target = seen[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
            publish(.idle)
            return
        }
        tearDown()
        peripheral = target
        target.delegate = self
        central.connect(target)
        publish(.connecting)
    }

    private func tearDown() {
        if attached {
            core.detach()
            attached = false
        }
        finishWrite(false)
        writeCharacteristic = nil
        pendingSubscriptions = 0
        peripheral?.delegate = nil
        peripheral = nil
    }

    private func fail(_ peripheral: CBPeripheral, _ problem: String) {
        report(problem)
        central.cancelPeripheralConnection(peripheral)
    }

    /// Reconnect after a short pause, so a ring that keeps dropping the link is
    /// not hammered in a tight loop.
    private func reconnectSoon() {
        queue.asyncAfter(deadline: .now() + 2) {
            guard self.peripheral == nil else { return }
            self.connectWanted()
        }
    }

    private func finishWrite(_ succeeded: Bool) {
        guard let (semaphore, record) = pendingWrite else { return }
        pendingWrite = nil
        record(succeeded)
        semaphore.signal()
    }
}

extension RingConnection: RingLink {
    /// Called by the Rust core from a background thread (never from `queue`).
    /// Waits for the ring to acknowledge the write, so a failed write surfaces as
    /// an error instead of a request that silently never got an answer.
    func write(data: Data) -> Bool {
        let done = DispatchSemaphore(value: 0)
        var succeeded = false
        let started: Bool = queue.sync {
            guard self.attached, let peripheral = self.peripheral,
                  let characteristic = self.writeCharacteristic,
                  peripheral.state == .connected, self.pendingWrite == nil
            else { return false }
            self.pendingWrite = (done, { succeeded = $0 })
            peripheral.writeValue(data, for: characteristic, type: .withResponse)
            return true
        }
        guard started else { return false }
        if done.wait(timeout: .now() + Self.writeTimeout) == .timedOut {
            queue.sync { self.pendingWrite = nil }
            return false
        }
        return succeeded
    }
}

extension RingConnection: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if wanted != nil {
                connectWanted()
            } else {
                publish(.idle)
            }
        case .poweredOff:
            tearDown()
            publish(.unavailable("Bluetooth is turned off."))
        case .unauthorized:
            tearDown()
            publish(.unavailable("Bluetooth access is denied. Allow it in Settings."))
        case .unsupported:
            publish(.unavailable("This device does not support Bluetooth LE."))
        default:
            tearDown()
            publish(.unavailable("Bluetooth is not ready yet."))
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advertisedName ?? peripheral.name ?? ""
        let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let lowerName = name.lowercased()
        if lowerName.contains("charging case") || services.contains(Self.chargingCaseService) {
            return
        }
        // A ring advertises the Oura service; a bonded ring often has no name.
        guard services.contains(serviceUUID) || lowerName.contains("oura") else { return }

        seen[peripheral.identifier] = peripheral
        let ring = DiscoveredRing(
            id: peripheral.identifier,
            name: name.isEmpty ? "Oura Ring" : name,
            rssi: RSSI.intValue
        )
        DispatchQueue.main.async {
            if let index = self.discovered.firstIndex(where: { $0.id == ring.id }) {
                // Keep a real name once seen: later duplicates may lack it.
                var updated = ring
                if name.isEmpty { updated.name = self.discovered[index].name }
                // Duplicate reports arrive constantly; only redraw on a real change.
                let current = self.discovered[index]
                guard current.name != updated.name || abs(current.rssi - updated.rssi) >= 5
                else { return }
                self.discovered[index] = updated
            } else {
                self.discovered.append(ring)
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === self.peripheral else { return }
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        guard peripheral === self.peripheral else { return }
        report(error?.localizedDescription ?? "Could not connect to the ring.")
        tearDown()
        reconnectSoon()
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        guard peripheral === self.peripheral else { return }
        tearDown()
        publish(.idle)
        reconnectSoon()
    }
}

extension RingConnection: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === self.peripheral else { return }
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            fail(peripheral, "This device does not expose the Oura service.")
            return
        }
        peripheral.discoverCharacteristics(nil, for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard peripheral === self.peripheral else { return }
        let characteristics = service.characteristics ?? []
        guard let write = characteristics.first(where: { $0.uuid == writeUUID }) else {
            fail(peripheral, "The ring's write characteristic is missing.")
            return
        }
        writeCharacteristic = write
        // Subscribe to every notify/indicate characteristic in the service: newer
        // rings expose extra ones beyond the main notify characteristic.
        let notifying = characteristics.filter {
            $0.properties.contains(.notify) || $0.properties.contains(.indicate)
        }
        guard !notifying.isEmpty else {
            fail(peripheral, "The ring exposes no notification characteristics.")
            return
        }
        pendingSubscriptions = notifying.count
        for characteristic in notifying {
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard peripheral === self.peripheral, !attached, pendingSubscriptions > 0 else { return }
        if let error {
            // A pairing/encryption demand surfaces here ("Authentication is
            // insufficient"): the ring is bonded to another phone.
            fail(peripheral, "The ring refused the connection: \(error.localizedDescription)")
            return
        }
        pendingSubscriptions -= 1
        // Not ready until every subscription is confirmed, or the core could send
        // a request before its answer can be received.
        if pendingSubscriptions == 0 {
            attached = true
            core.attach(link: self)
            report(nil)
            publish(.ready)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let value = characteristic.value, !value.isEmpty else { return }
        core.onNotification(data: value)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        finishWrite(error == nil)
    }
}
