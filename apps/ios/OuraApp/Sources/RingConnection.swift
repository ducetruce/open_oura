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

    private static let rememberedKey = "ringIdentifier"

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
            self.central.scanForPeripherals(withServices: [self.serviceUUID])
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
        queue.async {
            self.wanted = id
            self.connectWanted()
        }
    }

    /// Disconnect and stop reconnecting to the remembered ring.
    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.rememberedKey)
        rememberedRing = nil
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
        writeCharacteristic = nil
        pendingSubscriptions = 0
        peripheral?.delegate = nil
        peripheral = nil
    }

    private func fail(_ peripheral: CBPeripheral) {
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
}

extension RingConnection: RingLink {
    /// Called by the Rust core from a background thread (never from `queue`).
    func write(data: Data) -> Bool {
        queue.sync { () -> Bool in
            guard self.attached, let peripheral = self.peripheral,
                  let characteristic = self.writeCharacteristic,
                  peripheral.state == .connected
            else { return false }
            peripheral.writeValue(data, for: characteristic, type: .withResponse)
            return true
        }
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
        seen[peripheral.identifier] = peripheral
        // A bonded ring often stops advertising its name.
        let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? "Oura Ring"
        let ring = DiscoveredRing(id: peripheral.identifier, name: name, rssi: RSSI.intValue)
        DispatchQueue.main.async {
            if let index = self.discovered.firstIndex(where: { $0.id == ring.id }) {
                self.discovered[index] = ring
            } else {
                self.discovered.append(ring)
            }
            self.discovered.sort { $0.rssi > $1.rssi }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        tearDown()
        reconnectSoon()
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        guard peripheral.identifier == self.peripheral?.identifier else { return }
        tearDown()
        publish(.idle)
        reconnectSoon()
    }
}

extension RingConnection: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            fail(peripheral)
            return
        }
        peripheral.discoverCharacteristics(nil, for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        let characteristics = service.characteristics ?? []
        guard let write = characteristics.first(where: { $0.uuid == writeUUID }) else {
            fail(peripheral)
            return
        }
        writeCharacteristic = write
        // Subscribe to every notify/indicate characteristic in the service: newer
        // rings expose extra ones beyond the main notify characteristic.
        let notifying = characteristics.filter {
            $0.properties.contains(.notify) || $0.properties.contains(.indicate)
        }
        guard !notifying.isEmpty else {
            fail(peripheral)
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
        guard !attached, pendingSubscriptions > 0 else { return }
        pendingSubscriptions -= 1
        if pendingSubscriptions == 0 {
            attached = true
            core.attach(link: self)
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
}
