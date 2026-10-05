import CoreLocation
import Foundation

/// Places: once the user turns it on, iOS visit monitoring tells Walnut when the
/// user arrives somewhere and leaves, from then on only (iOS keeps its own
/// history to itself, so there is nothing earlier to read). Each visit goes only
/// to the user's Mac.

/// One visit as iOS reported it. Both ends are optional: iOS reports an arrival
/// before the departure is known, and sometimes a departure whose arrival it missed.
struct PlaceVisitEvent: Equatable, Sendable {
    var arrival: Date?
    var departure: Date?
    var latitude: Double
    var longitude: Double
    var accuracyM: Double?

    /// iOS marks an unknown end with `distantPast` / `distantFuture`.
    init(arrival: Date?, departure: Date?, latitude: Double, longitude: Double, accuracyM: Double?) {
        let earliest = Date(timeIntervalSince1970: 0)
        let latest = Date(timeIntervalSince1970: 32_503_680_000) // year 3000
        self.arrival = arrival.flatMap { $0 <= earliest || $0 >= latest ? nil : $0 }
        self.departure = departure.flatMap { $0 <= earliest || $0 >= latest ? nil : $0 }
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyM = accuracyM.flatMap { $0 >= 0 ? $0 : nil }
    }

    init(_ visit: CLVisit) {
        self.init(arrival: visit.arrivalDate, departure: visit.departureDate,
                  latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude,
                  accuracyM: visit.horizontalAccuracy)
    }
}

/// A visit Walnut keeps until the Mac has it (and a while after, so the
/// departure finds its arrival and the screen can list recent visits).
struct PlaceVisitRecord: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var arrival: Date?
    var departure: Date?
    var latitude: Double
    var longitude: Double
    var accuracyM: Double?
    var name: String?
    var address: String?
    var nameAttempts = 0
    /// The zone the phone was in when iOS reported it: the visit's times are local to it.
    var timeZoneId: String
    var recordedAt: Date
    /// Bumped on every change; the Mac has `sentVersion`.
    var version = 1
    var sentVersion = 0

    var needsSend: Bool { sentVersion < version }
    var lastMoment: Date { departure ?? arrival ?? recordedAt }
}

/// The Places queue on disk, shared by the recorder (main thread) and the sync
/// (an actor), so it is lock-protected. Application Support, readable after the
/// first unlock (iOS may relaunch Walnut in the background to deliver a visit),
/// excluded from iCloud backup.
///
/// `generation` bumps on every erase: a sync that was in flight then cannot mark
/// anything sent in the erased queue, or write it back.
final class PlacesQueueStore: @unchecked Sendable {
    static let shared = PlacesQueueStore(
        fileURL: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil ? nil : defaultURL
    )

    struct Snapshot: Codable, Equatable {
        var visits: [PlaceVisitRecord] = []
        /// The state the Mac last accepted, so an unchanged one is not sent again.
        var sentState: PlacesPhoneState?
        var lastSyncAt: Date?
        var lastOutcome: String?
    }

    /// A departure this close in time to an arrival already kept is that visit.
    static let sameArrivalWindow: TimeInterval = 120
    static let sameArrivalMeters: CLLocationDistance = 500
    /// A visit the Mac has is kept this long, then forgotten here.
    static let keepSentFor: TimeInterval = 14 * 86_400
    static let maxKept = 3_000

    private let lock = NSLock()
    private let fileURL: URL?
    private var snapshot: Snapshot?
    private var loadFailed = false
    private var generationValue = 0

    static var defaultURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("WalnutPlaces", isDirectory: true)
            .appendingPathComponent("visits.json")
    }

    init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    var generation: Int { lock.withLock { generationValue } }

    func read() -> Snapshot {
        lock.withLock {
            loadLocked()
            return snapshot ?? Snapshot()
        }
    }

    /// Apply `body` unless the queue was erased since `generation` was read.
    @discardableResult
    func update(generation expected: Int? = nil, _ body: (inout Snapshot) -> Void) -> Bool {
        lock.withLock {
            if let expected, expected != generationValue { return false }
            loadLocked()
            guard !loadFailed else { return false }
            var value = snapshot ?? Snapshot()
            body(&value)
            guard value != snapshot else { return true }
            snapshot = value
            writeLocked(value)
            return true
        }
    }

    /// Keep what iOS reported: one record per visit, its two deliveries merged.
    /// Returns the record as kept, or nil when the event carries no time at all.
    @discardableResult
    func record(_ event: PlaceVisitEvent, now: Date = Date(), timeZone: TimeZone = .current) -> PlaceVisitRecord? {
        guard event.arrival != nil || event.departure != nil else { return nil }
        var kept: PlaceVisitRecord?
        update { state in
            let index = Self.matchIndex(for: event, in: state.visits)
            if let index {
                var record = state.visits[index]
                let before = record
                record.arrival = record.arrival ?? event.arrival
                record.departure = event.departure ?? record.departure
                record.latitude = event.latitude
                record.longitude = event.longitude
                record.accuracyM = event.accuracyM ?? record.accuracyM
                // A new spot is a new place: the name looked up for the old one goes.
                if Self.meters(before, event) > 200 {
                    record.name = nil
                    record.address = nil
                    record.nameAttempts = 0
                }
                if record != before { record.version += 1 }
                state.visits[index] = record
                kept = record
            } else {
                let record = PlaceVisitRecord(
                    id: Self.visitId(for: event), arrival: event.arrival, departure: event.departure,
                    latitude: event.latitude, longitude: event.longitude, accuracyM: event.accuracyM,
                    timeZoneId: timeZone.identifier, recordedAt: now
                )
                state.visits.append(record)
                kept = record
            }
            Self.prune(&state, now: now)
        }
        return kept
    }

    /// The Mac has these versions now.
    func markSent(_ sent: [String: Int], generation: Int) {
        update(generation: generation) { state in
            for i in state.visits.indices {
                if let version = sent[state.visits[i].id], version > state.visits[i].sentVersion {
                    state.visits[i].sentVersion = min(version, state.visits[i].version)
                }
            }
        }
    }

    func erase() {
        lock.withLock {
            generationValue += 1
            snapshot = Snapshot()
            loadFailed = false
            if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        }
    }

    // MARK: - Rules

    static func visitId(for event: PlaceVisitEvent) -> String {
        if let arrival = event.arrival { return "v-\(Int(arrival.timeIntervalSince1970))" }
        return "v-d\(Int((event.departure ?? Date()).timeIntervalSince1970))"
    }

    static func matchIndex(for event: PlaceVisitEvent, in visits: [PlaceVisitRecord]) -> Int? {
        let id = visitId(for: event)
        if let exact = visits.lastIndex(where: { $0.id == id }) { return exact }
        guard let arrival = event.arrival else { return nil }
        return visits.lastIndex { record in
            guard let other = record.arrival else { return false }
            return abs(other.timeIntervalSince(arrival)) <= sameArrivalWindow && meters(record, event) <= sameArrivalMeters
        }
    }

    static func meters(_ record: PlaceVisitRecord, _ event: PlaceVisitEvent) -> CLLocationDistance {
        CLLocation(latitude: record.latitude, longitude: record.longitude)
            .distance(from: CLLocation(latitude: event.latitude, longitude: event.longitude))
    }

    static func prune(_ state: inout Snapshot, now: Date) {
        state.visits.removeAll { !$0.needsSend && now.timeIntervalSince($0.lastMoment) > keepSentFor }
        if state.visits.count > maxKept {
            // The oldest the Mac already has go first; unsent ones only past the cap.
            let excess = state.visits.count - maxKept
            let sentOldest = state.visits.enumerated().filter { !$0.element.needsSend }
                .sorted { $0.element.lastMoment < $1.element.lastMoment }.prefix(excess).map { $0.offset }
            let drop = Set(sentOldest)
            state.visits = state.visits.enumerated().filter { !drop.contains($0.offset) }.map { $0.element }
            if state.visits.count > maxKept { state.visits.removeFirst(state.visits.count - maxKept) }
        }
    }

    // MARK: - File

    private func loadLocked() {
        guard snapshot == nil, !loadFailed else { return }
        guard let fileURL else { snapshot = Snapshot(); return }
        guard FileManager.default.fileExists(atPath: fileURL.path) else { snapshot = Snapshot(); return }
        do {
            let data = try Data(contentsOf: fileURL)
            snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError {
            // Locked since boot: try again later, never start over.
            loadFailed = true
        } catch {
            AppLog.warn("places", "queue unreadable, starting empty", ["error": String(describing: error)])
            snapshot = Snapshot()
        }
    }

    private func writeLocked(_ value: Snapshot) {
        guard let fileURL else { return }
        do {
            let dir = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var resource = URLResourceValues()
            resource.isExcludedFromBackup = true
            var mutableDir = dir
            try? mutableDir.setResourceValues(resource)
            let data = try JSONEncoder().encode(value)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            AppLog.warn("places", "queue not saved", ["error": String(describing: error)])
        }
    }
}
