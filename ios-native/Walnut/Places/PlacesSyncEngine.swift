import CoreLocation
import Foundation

/// The outcome of one Places run, as the screen and the log read it.
enum PlacesRunOutcome: String, Codable, Sendable {
    case synced, upToDate, macUnreachable, macTooOld, unauthorized, notPaired, cancelled, failed
}

/// What a run reads from the world, injectable for tests.
struct PlacesSyncEnvironment: Sendable {
    var state: @Sendable () async -> PlacesPhoneState
    var isPaired: @Sendable () -> Bool
    var now: @Sendable () -> Date
    /// A place name and address for a spot.
    var lookUpName: @Sendable (_ latitude: Double, _ longitude: Double) async -> PlacesNameLookup.Answer

    static let live = PlacesSyncEnvironment(
        state: { await PlacesRecorder.shared.phoneState() },
        isPaired: { AppConfig.serverURL != nil && !(AppConfig.token ?? "").isEmpty },
        now: { Date() },
        lookUpName: { latitude, longitude in await PlacesNameLookup.name(latitude: latitude, longitude: longitude) }
    )
}

/// Keeps the Mac current with the visits Walnut has kept, and with the Places
/// state here. One run at a time. A visit leaves the queue's "to send" set only
/// once the Mac answered 200 for its current version; anything else keeps it for
/// the next run.
actor PlacesSyncEngine {
    static let shared = PlacesSyncEngine(store: .shared, transport: WalnutPlacesTransport(), env: .live)

    /// Visits per call (the server takes up to 200).
    static let batchSize = 100
    /// Name look-ups per run (iOS throttles them).
    static let maxLookUpsPerRun = 5
    /// A spot Apple's look-up has no name for is tried again this many times. A
    /// look-up that got no answer at all (offline, throttled) does not count.
    static let maxNameAttempts = 3
    /// Look-ups stop for this run after this long: a visit iOS delivers in the
    /// background comes with only seconds of time, and the visit itself goes first.
    static let lookUpBudget: TimeInterval = 12
    /// With nothing new, the phone still checks in this often, so the Mac can
    /// tell a quiet week at home from a phone that stopped sending.
    static let checkInInterval: TimeInterval = 86_400

    private let store: PlacesQueueStore
    private let transport: PlacesTransport
    private let env: PlacesSyncEnvironment
    private var running = false
    private var again = false
    /// Places is on in this run: a visit the Mac now has is kept a while here.
    private var keepSent = true

    init(store: PlacesQueueStore, transport: PlacesTransport, env: PlacesSyncEnvironment) {
        self.store = store
        self.transport = transport
        self.env = env
    }

    /// Run now; a call while a run is under way runs once more after it.
    @discardableResult
    func run(reason: String) async -> PlacesRunOutcome {
        if running {
            again = true
            return .cancelled
        }
        running = true
        defer { running = false }
        var outcome = await runOnce(reason: reason)
        while again {
            again = false
            outcome = await runOnce(reason: "again")
        }
        return outcome
    }

    private func runOnce(reason: String) async -> PlacesRunOutcome {
        guard env.isPaired() else { return .notPaired }
        let generation = store.generation
        let state = await env.state()
        keepSent = state.enabled
        await lookUpNames(generation: generation)
        let snapshot = store.read()
        let pending = snapshot.visits.filter(\.needsSend)
        // Places off, and the Mac already knows (or never heard of Places): nothing
        // to say, not even the daily check-in.
        let macKnowsOff = snapshot.sentState.map { !$0.enabled } ?? true
        if pending.isEmpty && !state.enabled && macKnowsOff {
            return .upToDate
        }
        let recent = snapshot.lastSyncAt.map { env.now().timeIntervalSince($0) < Self.checkInInterval } ?? false
        if pending.isEmpty && snapshot.sentState == state && recent {
            return .upToDate
        }
        let outcome = await send(pending, state: state, generation: generation)
        store.update(generation: generation) { s in
            s.lastOutcome = outcome.rawValue
            if outcome == .synced { s.lastSyncAt = self.env.now() }
        }
        AppLog.info("places", "sync run ended", [
            "reason": reason, "outcome": outcome.rawValue, "visits": String(pending.count),
            "state": state.enabled ? state.access.rawValue : "off",
        ])
        return outcome
    }

    private func lookUpNames(generation: Int) async {
        let wanted = store.read().visits
            .filter { $0.name == nil && $0.nameAttempts < Self.maxNameAttempts }
            .suffix(Self.maxLookUpsPerRun)
        let started = env.now()
        for record in wanted {
            guard env.now().timeIntervalSince(started) < Self.lookUpBudget else { break }
            let answer = await env.lookUpName(record.latitude, record.longitude)
            if case .failed = answer { continue }
            store.update(generation: generation) { s in
                guard let i = s.visits.firstIndex(where: { $0.id == record.id }),
                      s.visits[i].latitude == record.latitude, s.visits[i].longitude == record.longitude else { return }
                s.visits[i].nameAttempts += 1
                if case let .found(name, address) = answer {
                    s.visits[i].name = name
                    s.visits[i].address = address
                    s.visits[i].version += 1
                }
            }
        }
    }

    private func send(_ pending: [PlaceVisitRecord], state: PlacesPhoneState, generation: Int) async -> PlacesRunOutcome {
        // One call per zone: the Mac reads every visit in a call in that call's zone.
        var groups: [(zone: String, visits: [PlaceVisitRecord])] = []
        for record in pending {
            if let i = groups.firstIndex(where: { $0.zone == record.timeZoneId }) {
                groups[i].visits.append(record)
            } else {
                groups.append((record.timeZoneId, [record]))
            }
        }
        if groups.isEmpty { groups = [(TimeZone.current.identifier, [])] }
        var stateSent = false
        for group in groups {
            var start = 0
            repeat {
                let chunk = Array(group.visits[start..<min(start + Self.batchSize, group.visits.count)])
                let outcome = await post(chunk, zone: group.zone, state: stateSent ? nil : state, generation: generation, depth: 0)
                guard outcome == .synced else { return outcome }
                if !stateSent {
                    stateSent = true
                    store.update(generation: generation) { $0.sentState = state }
                }
                start += Self.batchSize
            } while start < group.visits.count
        }
        return .synced
    }

    private func post(_ visits: [PlaceVisitRecord], zone: String, state: PlacesPhoneState?, generation: Int, depth: Int) async -> PlacesRunOutcome {
        let body = Self.body(visits, zone: zone, state: state)
        let reply: PlacesSyncReply
        do {
            do {
                reply = try await transport.placesSync(body: body, timeout: 30)
            } catch where HealthSyncEngine.isDroppedConnection(error) {
                // The first call after Walnut comes back to the foreground often
                // fails at once (iOS dropped the connection). The Mac upserts by
                // id, so the same call goes once more.
                AppLog.info("places", "connection dropped, sent again")
                try? await Task.sleep(for: .milliseconds(500))
                reply = try await transport.placesSync(body: body, timeout: 30)
            }
        } catch {
            return Self.outcome(for: error)
        }
        switch reply {
        case .ok:
            store.markSent(Dictionary(visits.map { ($0.id, $0.version) }, uniquingKeysWith: max),
                           generation: generation, now: env.now(), keepSent: keepSent)
            return .synced
        case .tooLarge:
            guard visits.count > 1, depth < 8 else { return .failed }
            let half = visits.count / 2
            let first = await post(Array(visits[..<half]), zone: zone, state: state, generation: generation, depth: depth + 1)
            guard first == .synced else { return first }
            return await post(Array(visits[half...]), zone: zone, state: nil, generation: generation, depth: depth + 1)
        case .unavailable:
            return .macUnreachable
        case .notSupported:
            return .macTooOld
        }
    }

    static func body(_ visits: [PlaceVisitRecord], zone: String, state: PlacesPhoneState?) -> Data {
        let tz = TimeZone(identifier: zone) ?? .current
        var object: [String: Any] = [
            "tz": tz.identifier,
            "visits": visits.map { v -> [String: Any] in
                var item: [String: Any] = ["id": v.id, "lat": v.latitude, "lon": v.longitude]
                if let arrival = v.arrival { item["arrival"] = HealthWireTime.iso(arrival, in: tz) }
                if let departure = v.departure { item["departure"] = HealthWireTime.iso(departure, in: tz) }
                if let accuracy = v.accuracyM { item["accuracyM"] = (accuracy * 10).rounded() / 10 }
                if let name = v.name { item["name"] = name }
                if let address = v.address { item["address"] = address }
                return item
            },
        ]
        if let state { object["state"] = ["enabled": state.enabled, "access": state.access.rawValue] }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    static func outcome(for error: Error) -> PlacesRunOutcome {
        switch HealthSyncEngine.outcome(for: error) {
        case .cancelled: return .cancelled
        case .macUnreachable: return .macUnreachable
        case .unauthorized: return .unauthorized
        case .notPaired: return .notPaired
        default: return .failed
        }
    }
}

/// A name for a spot, from Apple's own look-up (the same one the Maps app uses).
enum PlacesNameLookup {
    enum Answer: Equatable, Sendable {
        case found(name: String?, address: String?)
        /// Apple answered, with nothing for this spot.
        case nothing
        /// No answer: offline, throttled, or it hung and gave up.
        case failed
    }

    static func name(latitude: Double, longitude: Double) async -> Answer {
        let location = CLLocation(latitude: latitude, longitude: longitude)
        let geocoder = CLGeocoder()
        // A look-up that hangs gives up (its completion then runs, cancelled).
        let timeout = Task {
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { geocoder.cancelGeocode() }
        }
        let reply: (CLPlacemark?, Error?) = await withCheckedContinuation { done in
            geocoder.reverseGeocodeLocation(location) { marks, error in done.resume(returning: (marks?.first, error)) }
        }
        timeout.cancel()
        return answer(placemark: reply.0, error: reply.1)
    }

    static func answer(placemark: CLPlacemark?, error: Error?) -> Answer {
        if let placemark {
            let found = describe(name: placemark.name, areaOfInterest: placemark.areasOfInterest?.first,
                                 number: placemark.subThoroughfare, street: placemark.thoroughfare,
                                 city: placemark.locality, region: placemark.administrativeArea)
            return found.name == nil && found.address == nil ? .nothing : .found(name: found.name, address: found.address)
        }
        if let error = error as? CLError, error.code == .geocodeFoundNoResult || error.code == .geocodeFoundPartialResult {
            return .nothing
        }
        return error == nil ? .nothing : .failed
    }

    /// A point of interest when there is one ("Golden Gate Park"), else the
    /// placemark's own name (often the street address); the address is street and city.
    static func describe(name: String?, areaOfInterest: String?, number: String?, street: String?,
                         city: String?, region: String?) -> (name: String?, address: String?) {
        let streetLine = [number, street].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ")
        let parts = [streetLine.isEmpty ? nil : streetLine, city, region].compactMap { $0?.isEmpty == false ? $0 : nil }
        let address = parts.isEmpty ? nil : parts.joined(separator: ", ")
        let title = areaOfInterest?.isEmpty == false ? areaOfInterest : (name?.isEmpty == false ? name : nil)
        return (title, address)
    }
}
