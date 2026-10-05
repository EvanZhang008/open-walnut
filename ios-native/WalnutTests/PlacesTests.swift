import CoreLocation
import XCTest
@testable import Walnut

/// Places on the phone: one record per visit across iOS's two deliveries, the
/// wire body, the sync's honesty (a visit leaves the queue only on a 200 for
/// its current version), and when the in-chat offer appears. Invented places.
final class PlacesTests: XCTestCase {
    private let zone = TimeZone(identifier: "Europe/Lisbon")!
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func event(arrival: Date?, departure: Date?, lat: Double = 38.7139, lon: Double = -9.1394) -> PlaceVisitEvent {
        PlaceVisitEvent(arrival: arrival, departure: departure, latitude: lat, longitude: lon, accuracyM: 40)
    }

    // MARK: - Queue

    func testIOSUnknownEndsBecomeNil() {
        let e = PlaceVisitEvent(arrival: .distantPast, departure: .distantFuture, latitude: 1, longitude: 2, accuracyM: -1)
        XCTAssertNil(e.arrival)
        XCTAssertNil(e.departure)
        XCTAssertNil(e.accuracyM)
    }

    func testArrivalThenDepartureIsOneVisit() {
        let q = PlacesQueueStore(fileURL: nil)
        let first = q.record(event(arrival: t0, departure: nil), now: t0, timeZone: zone)!
        XCTAssertEqual(first.id, "v-\(Int(t0.timeIntervalSince1970))")
        XCTAssertNil(first.departure)
        let second = q.record(event(arrival: t0, departure: t0.addingTimeInterval(3600)), now: t0.addingTimeInterval(3600), timeZone: zone)!
        XCTAssertEqual(second.id, first.id)
        XCTAssertEqual(second.version, 2)
        XCTAssertEqual(q.read().visits.count, 1)
        XCTAssertEqual(q.read().visits[0].timeZoneId, "Europe/Lisbon")
        // The same delivery again changes nothing.
        let again = q.record(event(arrival: t0, departure: t0.addingTimeInterval(3600)), timeZone: zone)!
        XCTAssertEqual(again.version, 2)
    }

    func testDepartureWhoseArrivalDiffersBySecondsStillFindsItsVisit() {
        let q = PlacesQueueStore(fileURL: nil)
        q.record(event(arrival: t0.addingTimeInterval(0.7), departure: nil), now: t0, timeZone: zone)
        q.record(event(arrival: t0.addingTimeInterval(1.2), departure: t0.addingTimeInterval(900)), now: t0, timeZone: zone)
        XCTAssertEqual(q.read().visits.count, 1)
        XCTAssertNotNil(q.read().visits[0].departure)
        // A different place at the same moment is a different visit.
        q.record(event(arrival: t0.addingTimeInterval(30), departure: nil, lat: 41.15, lon: -8.61), now: t0, timeZone: zone)
        XCTAssertEqual(q.read().visits.count, 2)
    }

    func testDepartureOnlyAndEmptyEvents() {
        let q = PlacesQueueStore(fileURL: nil)
        let d = q.record(event(arrival: nil, departure: t0), now: t0, timeZone: zone)!
        XCTAssertEqual(d.id, "v-d\(Int(t0.timeIntervalSince1970))")
        XCTAssertNil(q.record(event(arrival: nil, departure: nil), now: t0, timeZone: zone))
        XCTAssertEqual(q.read().visits.count, 1)
    }

    func testSentVisitsAreForgottenAfterTwoWeeksUnsentOnesAreKept() {
        let q = PlacesQueueStore(fileURL: nil)
        let sent = q.record(event(arrival: t0, departure: t0.addingTimeInterval(60)), now: t0, timeZone: zone)!
        q.record(event(arrival: t0.addingTimeInterval(7200), departure: t0.addingTimeInterval(7300), lat: 40, lon: -8), now: t0, timeZone: zone)
        q.markSent([sent.id: sent.version], generation: q.generation)
        q.record(event(arrival: t0.addingTimeInterval(15 * 86_400), departure: nil, lat: 39, lon: -9),
                 now: t0.addingTimeInterval(15 * 86_400), timeZone: zone)
        let ids = q.read().visits.map(\.id)
        XCTAssertFalse(ids.contains(sent.id))
        XCTAssertEqual(ids.count, 2)
    }

    func testEraseWinsOverASyncThatWasInFlight() {
        let q = PlacesQueueStore(fileURL: nil)
        let v = q.record(event(arrival: t0, departure: nil), now: t0, timeZone: zone)!
        let generation = q.generation
        q.erase()
        q.markSent([v.id: v.version], generation: generation)
        XCTAssertTrue(q.read().visits.isEmpty)
        XCTAssertFalse(q.update(generation: generation) { $0.lastSyncAt = Date() })
    }

    func testQueueSurvivesOnDisk() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("places-\(UUID().uuidString)/visits.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let q = PlacesQueueStore(fileURL: url)
        q.record(event(arrival: t0, departure: nil), now: t0, timeZone: zone)
        let reopened = PlacesQueueStore(fileURL: url)
        XCTAssertEqual(reopened.read().visits.count, 1)
        let values = try url.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    // MARK: - Wire

    func testBodyCarriesLocalTimesStateAndOnlyKnownFields() throws {
        var v = PlaceVisitRecord(id: "v-1", arrival: t0, departure: nil, latitude: 38.71, longitude: -9.14, accuracyM: 35.27,
                                 timeZoneId: "Europe/Lisbon", recordedAt: t0)
        v.name = "Jardim"
        let data = PlacesSyncEngine.body([v], zone: "Europe/Lisbon", state: PlacesPhoneState(enabled: true, access: .whenInUse))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["tz"] as? String, "Europe/Lisbon")
        XCTAssertEqual(object["state"] as? [String: AnyHashable], ["enabled": true, "access": "when_in_use"])
        let item = try XCTUnwrap((object["visits"] as? [[String: Any]])?.first)
        XCTAssertEqual(item["arrival"] as? String, HealthWireTime.iso(t0, in: zone))
        XCTAssertTrue((item["arrival"] as? String ?? "").hasSuffix("+01:00") || (item["arrival"] as? String ?? "").hasSuffix("+00:00"))
        XCTAssertNil(item["departure"])
        XCTAssertNil(item["address"])
        XCTAssertEqual(item["accuracyM"] as? Double, 35.3)
        XCTAssertEqual(item["name"] as? String, "Jardim")
        let stateless = try XCTUnwrap(JSONSerialization.jsonObject(with: PlacesSyncEngine.body([], zone: "UTC", state: nil)) as? [String: Any])
        XCTAssertNil(stateless["state"])
    }

    func testNameDescription() {
        let park = PlacesNameLookup.describe(name: "1 Rua X", areaOfInterest: "Jardim Botanico", number: "1", street: "Rua X", city: "Lisbon", region: "Lisboa")
        XCTAssertEqual(park.name, "Jardim Botanico")
        XCTAssertEqual(park.address, "1 Rua X, Lisbon, Lisboa")
        let street = PlacesNameLookup.describe(name: "Rua Y", areaOfInterest: nil, number: nil, street: "Rua Y", city: nil, region: nil)
        XCTAssertEqual(street.name, "Rua Y")
        XCTAssertEqual(street.address, "Rua Y")
        let nothing = PlacesNameLookup.describe(name: "", areaOfInterest: "", number: nil, street: nil, city: nil, region: nil)
        XCTAssertNil(nothing.name)
        XCTAssertNil(nothing.address)
    }

    // MARK: - Sync

    private func engine(_ q: PlacesQueueStore, _ t: FakePlacesTransport, state: PlacesPhoneState = .init(enabled: true, access: .always),
                        names: [String: String] = [:], offline: Set<Double> = []) -> PlacesSyncEngine {
        PlacesSyncEngine(store: q, transport: t, env: PlacesSyncEnvironment(
            state: { state }, isPaired: { true }, now: { Date(timeIntervalSince1970: 1_790_100_000) },
            lookUpName: { lat, _ in
                if offline.contains(lat) { return .failed }
                return names["\(lat)"].map { .found(name: $0, address: nil) } ?? .nothing
            }
        ))
    }

    func testAVisitLeavesTheQueueOnlyOnA200ForItsVersion() async {
        let q = PlacesQueueStore(fileURL: nil)
        q.record(event(arrival: t0, departure: nil), now: t0, timeZone: zone)
        let t = FakePlacesTransport()
        t.replies = [.unavailable]
        let e = engine(q, t)
        let down = await e.run(reason: "test")
        XCTAssertEqual(down, .macUnreachable)
        XCTAssertEqual(q.read().visits.filter(\.needsSend).count, 1)
        XCTAssertNil(q.read().sentState)

        t.replies = [.stored]
        let up = await e.run(reason: "test")
        XCTAssertEqual(up, .synced)
        XCTAssertEqual(q.read().visits.filter(\.needsSend).count, 0)
        XCTAssertEqual(q.read().sentState, PlacesPhoneState(enabled: true, access: .always))

        // Nothing new: no call at all.
        let calls = t.bodies.count
        let quiet = await e.run(reason: "test")
        XCTAssertEqual(quiet, .upToDate)
        XCTAssertEqual(t.bodies.count, calls)

        // The departure is a new version: sent again.
        q.record(event(arrival: t0, departure: t0.addingTimeInterval(600)), now: t0, timeZone: zone)
        t.replies = [.stored]
        _ = await e.run(reason: "test")
        XCTAssertEqual(t.bodies.count, calls + 1)
        // Every run's first call says where Places stands, so the Mac knows the phone checked in.
        XCTAssertNotNil(t.bodies.last?["state"])
        XCTAssertNotNil((t.bodies.last?["visits"] as? [[String: Any]])?.first?["departure"])
    }

    func testAStateChangeAloneIsSent() async {
        let q = PlacesQueueStore(fileURL: nil)
        let t = FakePlacesTransport()
        t.replies = [.stored, .stored]
        let on = await engine(q, t).run(reason: "turned-on")
        XCTAssertEqual(on, .synced)
        let off = PlacesPhoneState(enabled: false, access: .always)
        let result = await engine(q, t, state: off).run(reason: "turned-off")
        XCTAssertEqual(result, .synced)
        XCTAssertEqual(t.bodies.count, 2)
        XCTAssertEqual(t.bodies[1]["state"] as? [String: AnyHashable], ["enabled": false, "access": "always"])
        XCTAssertEqual((t.bodies[1]["visits"] as? [Any])?.count, 0)

        // Off, and the Mac knows: no call, not even the daily check-in.
        let later = PlacesSyncEngine(store: q, transport: t, env: PlacesSyncEnvironment(
            state: { off }, isPaired: { true }, now: { Date(timeIntervalSince1970: 1_790_100_000 + 3 * 86_400) },
            lookUpName: { _, _ in .nothing }))
        let quiet = await later.run(reason: "active")
        XCTAssertEqual(quiet, .upToDate)
        XCTAssertEqual(t.bodies.count, 2)
    }

    func testAPhoneThatNeverTurnedPlacesOnSendsNothing() async {
        let q = PlacesQueueStore(fileURL: nil)
        let t = FakePlacesTransport()
        let result = await engine(q, t, state: PlacesPhoneState(enabled: false, access: .notDetermined)).run(reason: "active")
        XCTAssertEqual(result, .upToDate)
        XCTAssertTrue(t.bodies.isEmpty)
    }

    func testDroppedConnectionIsSentOnceMoreAndOldMacKeepsTheQueue() async {
        let q = PlacesQueueStore(fileURL: nil)
        q.record(event(arrival: t0, departure: nil), now: t0, timeZone: zone)
        let t = FakePlacesTransport()
        t.errors = [0: APIError.network(underlying: URLError(.networkConnectionLost))]
        t.replies = [.stored, .stored]
        let result = await engine(q, t).run(reason: "test")
        XCTAssertEqual(result, .synced)
        XCTAssertEqual(t.bodies.count, 2)

        q.record(event(arrival: t0.addingTimeInterval(9000), departure: nil, lat: 40, lon: -8), now: t0, timeZone: zone)
        t.replies = [.notSupported]
        let old = await engine(q, t).run(reason: "test")
        XCTAssertEqual(old, .macTooOld)
        XCTAssertEqual(q.read().visits.filter(\.needsSend).count, 1)
    }

    func testTooLargeSplitsAndEveryVisitArrives() async {
        let q = PlacesQueueStore(fileURL: nil)
        for i in 0..<6 {
            q.record(event(arrival: t0.addingTimeInterval(Double(i) * 7200), departure: nil, lat: 30 + Double(i), lon: -9), now: t0, timeZone: zone)
        }
        let t = FakePlacesTransport()
        t.decide = { body in ((body["visits"] as? [Any])?.count ?? 0) > 2 ? .tooLarge : .stored }
        let result = await engine(q, t).run(reason: "test")
        XCTAssertEqual(result, .synced)
        XCTAssertEqual(q.read().visits.filter(\.needsSend).count, 0)
        let sent = Set(t.bodies.filter { ($0["visits"] as? [Any])?.count ?? 0 <= 2 }
            .flatMap { ($0["visits"] as? [[String: Any]]) ?? [] }.compactMap { $0["id"] as? String })
        XCTAssertEqual(sent.count, 6)
    }

    func testNamesAreLookedUpAndSentAndASpotWithNoNameIsTriedAtMostThreeTimes() async {
        let q = PlacesQueueStore(fileURL: nil)
        q.record(event(arrival: t0, departure: nil, lat: 38.5), now: t0, timeZone: zone)
        q.record(event(arrival: t0.addingTimeInterval(7200), departure: nil, lat: 12.5), now: t0, timeZone: zone)
        let t = FakePlacesTransport()
        t.replies = Array(repeating: .stored, count: 10)
        let e = engine(q, t, names: ["38.5": "Jardim"])
        for _ in 0..<5 { _ = await e.run(reason: "test") }
        let visits = q.read().visits
        XCTAssertEqual(visits.first { $0.latitude == 38.5 }?.name, "Jardim")
        XCTAssertEqual(visits.first { $0.latitude == 12.5 }?.nameAttempts, PlacesSyncEngine.maxNameAttempts)
        let named = t.bodies.flatMap { ($0["visits"] as? [[String: Any]]) ?? [] }.contains { $0["name"] as? String == "Jardim" }
        XCTAssertTrue(named)
    }

    func testALookUpWithNoAnswerIsNotCountedAsATry() async {
        let q = PlacesQueueStore(fileURL: nil)
        q.record(event(arrival: t0, departure: nil, lat: 38.5), now: t0, timeZone: zone)
        let t = FakePlacesTransport()
        t.replies = Array(repeating: .stored, count: 10)
        let offline = engine(q, t, offline: [38.5])
        for _ in 0..<5 { _ = await offline.run(reason: "test") }
        XCTAssertEqual(q.read().visits.first?.nameAttempts, 0)
        _ = await engine(q, t, names: ["38.5": "Jardim"]).run(reason: "test")
        XCTAssertEqual(q.read().visits.first?.name, "Jardim")
    }

    func testGeocoderAnswers() {
        XCTAssertEqual(PlacesNameLookup.answer(placemark: nil, error: CLError(.network)), .failed)
        XCTAssertEqual(PlacesNameLookup.answer(placemark: nil, error: CLError(.geocodeCanceled)), .failed)
        XCTAssertEqual(PlacesNameLookup.answer(placemark: nil, error: CLError(.geocodeFoundNoResult)), .nothing)
        XCTAssertEqual(PlacesNameLookup.answer(placemark: nil, error: nil), .nothing)
    }

    // MARK: - In-chat offer

    func testDecision() {
        let now = Date()
        var s = PlacesAccessDecision.State(available: true, enabled: false, access: .notDetermined, askedAlways: false,
                                           busy: false, quietUntil: nil, lastNudgeAt: nil, now: now)
        XCTAssertEqual(PlacesAccessDecision.decide(s), .offerTurnOn)
        s.quietUntil = now.addingTimeInterval(60)
        XCTAssertEqual(PlacesAccessDecision.decide(s), .nothing)
        s.quietUntil = nil
        s.enabled = true
        XCTAssertEqual(PlacesAccessDecision.decide(s), .askIOS)
        s.access = .whenInUse
        XCTAssertEqual(PlacesAccessDecision.decide(s), .askIOS)
        s.askedAlways = true
        XCTAssertEqual(PlacesAccessDecision.decide(s), .showAccessNote)
        s.access = .denied
        XCTAssertEqual(PlacesAccessDecision.decide(s), .showAccessNote)
        s.access = .always
        XCTAssertEqual(PlacesAccessDecision.decide(s), .syncNow)
        s.lastNudgeAt = now.addingTimeInterval(-10)
        XCTAssertEqual(PlacesAccessDecision.decide(s), .nothing)
        s.available = false
        XCTAssertEqual(PlacesAccessDecision.decide(s), .nothing)
    }

    func testPlacesReadDetection() {
        XCTAssertTrue(PlacesAccessDecision.isPlacesRead(name: "mcp__walnut__places_visits", detail: nil))
        XCTAssertTrue(PlacesAccessDecision.isPlacesRead(name: "Bash", detail: "walnut tools call places_status '{}'"))
        XCTAssertFalse(PlacesAccessDecision.isPlacesRead(name: "Bash", detail: "grep places_visits src"))
        XCTAssertFalse(PlacesAccessDecision.isPlacesRead(name: "mcp__walnut__health_sleep", detail: nil))
    }

    #if DEBUG
    func testDebugVisitSpec() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let e = PlacesDebugVisit.parse("90/5/38.7,-9.1", now: now)!
        XCTAssertEqual(e.arrival, now.addingTimeInterval(-5400))
        XCTAssertEqual(e.departure, now.addingTimeInterval(-300))
        XCTAssertEqual(e.latitude, 38.7)
        let ongoing = PlacesDebugVisit.parse("30/-", now: now)!
        XCTAssertNil(ongoing.departure)
        XCTAssertNil(PlacesDebugVisit.parse("x", now: now))
        let absolute = PlacesDebugVisit.parse("1789990000/-", now: now)!
        XCTAssertEqual(absolute.arrival, Date(timeIntervalSince1970: 1_789_990_000))
    }
    #endif
}

/// A scripted Mac for Places. Records every sync body, decoded.
final class FakePlacesTransport: PlacesTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _bodies: [[String: Any]] = []
    var replies: [PlacesSyncReply] = []
    /// Decides a reply from the body, ahead of `replies`.
    var decide: (([String: Any]) -> PlacesSyncReply)?
    /// Call index → error thrown instead of answering (the body is still recorded).
    var errors: [Int: Error] = [:]

    var bodies: [[String: Any]] { lock.withLock { _bodies } }

    func placesStatus(timeout: TimeInterval) async throws -> PlacesStatusResponse {
        try JSONDecoder().decode(PlacesStatusResponse.self, from: Data("{\"visitCount\":0}".utf8))
    }

    func placesSync(body: Data, timeout: TimeInterval) async throws -> PlacesSyncReply {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let (index, reply): (Int, PlacesSyncReply) = lock.withLock {
            _bodies.append(object)
            let index = _bodies.count - 1
            if let decide { return (index, decide(object)) }
            return (index, replies.isEmpty ? .stored : replies.removeFirst())
        }
        if let error = errors[index] {
            lock.withLock { replies.insert(reply, at: 0) }
            throw error
        }
        return reply
    }

    func placesDeleteData() async throws -> PlacesDeleteResponse {
        try JSONDecoder().decode(PlacesDeleteResponse.self, from: Data("{\"removed\":0}".utf8))
    }
}

extension PlacesSyncReply {
    static let stored = PlacesSyncReply.ok(try! JSONDecoder().decode(PlacesSyncResult.self, from: Data("{\"accepted\":1}".utf8)))
}
