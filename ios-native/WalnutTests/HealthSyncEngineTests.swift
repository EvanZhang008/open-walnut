import XCTest
@testable import Walnut

/// The sync engine against a scripted Health store and a scripted Mac: when an
/// anchor may move, what stops a run, and what each server answer does.
final class HealthSyncEngineTests: XCTestCase {
    private var source: FakeHealthSource!
    private var transport: FakeHealthTransport!
    private var state: HealthSyncStateStore!
    private var clock: FakeHealthClock!
    private var salt: MemoryHealthSalt!
    private let now = Date(timeIntervalSince1970: 1_790_478_000)

    override func setUp() {
        source = FakeHealthSource()
        transport = FakeHealthTransport()
        state = HealthSyncStateStore(fileURL: nil)
        clock = FakeHealthClock(now)
        salt = MemoryHealthSalt()
    }

    private func engine(_ catalog: [HealthTypeSpec], demo: Bool = false, enabled: Bool = true) -> HealthSyncEngine {
        HealthSyncEngine(source: source, transport: transport, state: state,
                         environment: .test(clock: clock, enabled: enabled, demo: demo), salt: salt,
                         catalog: catalog)
    }

    private func uuids(_ body: [String: Any]) -> [String] {
        ((body["samples"] as? [[String: Any]]) ?? []).compactMap { $0["uuid"] as? String }
    }

    // MARK: - First sync

    func testFirstSyncSendsTheLastSevenDaysNewestFirstThenTheWholeHistory() async {
        source.add("sleep", start: now.addingTimeInterval(-30 * 86_400), uuid: "old1")
        source.add("sleep", start: now.addingTimeInterval(-20 * 86_400), uuid: "old2")
        source.add("sleep", start: now.addingTimeInterval(-2 * 86_400), uuid: "recent1")
        source.add("sleep", start: now.addingTimeInterval(-1 * 86_400), uuid: "recent2")
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)

        XCTAssertEqual(outcome, .synced)
        let bodies = transport.bodies(for: "sleep")
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(uuids(bodies[0]), ["recent2", "recent1"], "last 7 days first, newest first")
        XCTAssertEqual(uuids(bodies[1]), ["old1", "old2", "recent1", "recent2"], "then the whole history")
        XCTAssertEqual(bodies[0]["tz"] as? String, "America/New_York")
        XCTAssertEqual(bodies[0]["storeId"] as? String, "hs-1")
        XCTAssertEqual((bodies[0]["device"] as? [String: Any])?["model"] as? String, "iPhone17,1")
        XCTAssertNotNil(state.read().anchors["sleep"])
        XCTAssertTrue(state.read().completed.contains("sleep"))

        // Nothing new: the next run sends nothing for the type.
        await engine([.testRaw("sleep")]).run(reason: "again", budget: 60)
        XCTAssertEqual(transport.bodies(for: "sleep").count, 2)

        // A new sample and a deletion go out together, deletions first.
        source.add("sleep", start: now, uuid: "new1")
        source.delete("sleep", uuid: "old1")
        await engine([.testRaw("sleep")]).run(reason: "change", budget: 60)
        let last = transport.bodies(for: "sleep").last ?? [:]
        XCTAssertEqual(uuids(last), ["new1"])
        XCTAssertEqual(last["deleted"] as? [String], ["old1"])
    }

    // MARK: - Access turned on after Don't Allow

    /// 2026-10-03: Don't Allow on Apple's sheet, runs while access was off, then
    /// access turned on: the history recorded before must still go out.
    func testHistoryReadWhileAccessWasOffGoesOutOnceAccessIsOn() async {
        source.add("sleep", start: now.addingTimeInterval(-30 * 86_400), uuid: "old1")
        source.add("sleep", start: now.addingTimeInterval(-1 * 86_400), uuid: "recent1")
        source.add("steps", start: now.addingTimeInterval(-3 * 86_400))
        source.deniedTypes = ["sleep", "steps"]
        transport.status = FakeHealthTransport.status(held: ["sleep": nil, "steps": nil])
        let catalog: [HealthTypeSpec] = [.testRaw("sleep"), .testBuckets("steps")]

        let off = await engine(catalog).run(reason: "turned-on", budget: 60)
        XCTAssertEqual(off, .synced)
        XCTAssertTrue(transport.bodies.isEmpty, "nothing readable, nothing sent")
        XCTAssertNil(state.read().anchors["sleep"], "an empty page keeps the anchor it started from")

        source.deniedTypes = []
        await engine(catalog).run(reason: "active", budget: 60)
        XCTAssertEqual(Set(transport.bodies(for: "sleep").flatMap(uuids)), ["old1", "recent1"])
        XCTAssertFalse(transport.bodies(for: "steps").isEmpty, "the bucket type is recomputed too")
    }

    /// 2026-10-04, the real phone: after access was turned on, a step recorded
    /// that day went out, so the Mac held steps, and every older day stayed on the
    /// phone. The anchor never moved while access was off, so all of it goes.
    func testHistoryGoesOutEvenOnceTheMacHoldsTheTypesNewestSamples() async {
        source.add("sleep", start: now.addingTimeInterval(-90 * 86_400), uuid: "old1")
        source.add("steps", start: now.addingTimeInterval(-90 * 86_400))
        source.deniedTypes = ["sleep", "steps"]
        transport.status = FakeHealthTransport.status(held: ["sleep": nil, "steps": nil])
        let catalog: [HealthTypeSpec] = [.testRaw("sleep"), .testBuckets("steps")]
        await engine(catalog).run(reason: "while-off", budget: 60)

        source.deniedTypes = []
        source.add("sleep", start: now, uuid: "today1")
        source.add("steps", start: now)
        transport.status = FakeHealthTransport.status(held: ["sleep": "2026-10-04T07:00:00Z", "steps": "2026-10-04T07:00:00Z"])
        await engine(catalog).run(reason: "observer", budget: 60)
        XCTAssertEqual(Set(transport.bodies(for: "sleep").flatMap(uuids)), ["old1", "today1"])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let oldDay = calendar.startOfDay(for: now.addingTimeInterval(-90 * 86_400))
        XCTAssertTrue(source.statisticsCalls.contains { $0.type == "steps" && $0.interval == 86_400 && $0.from == oldDay },
                      "day buckets are recomputed from the oldest step")
    }

    func testSamplesRecordedWhileAccessWasOffGoOutOnceItIsBack() async {
        source.add("sleep", start: now.addingTimeInterval(-10 * 86_400), uuid: "before")
        transport.status = FakeHealthTransport.status(held: ["sleep": "2026-09-20T08:00:00Z"])
        await engine([.testRaw("sleep")]).run(reason: "on", budget: 60)

        source.deniedTypes = ["sleep"]
        source.add("sleep", start: now.addingTimeInterval(-3 * 86_400), uuid: "while-off")
        await engine([.testRaw("sleep")]).run(reason: "off", budget: 60)
        let sent = transport.bodies(for: "sleep").count

        source.deniedTypes = []
        await engine([.testRaw("sleep")]).run(reason: "back-on", budget: 60)
        let again = transport.bodies(for: "sleep").dropFirst(sent)
        XCTAssertEqual(Set(again.flatMap(uuids)), ["while-off"])
    }

    /// Progress from a build that moved anchors on empty pages is read again once.
    func testProgressFromAnEarlierEpochIsReadAgainOnce() async {
        source.add("sleep", start: now.addingTimeInterval(-90 * 86_400), uuid: "old1")
        source.add("sleep", start: now, uuid: "today1")
        state.update { snapshot in
            snapshot.anchors["sleep"] = Data("2".utf8)
            snapshot.primed = ["sleep"]
            snapshot.completed = ["sleep"]
        }
        transport.status = FakeHealthTransport.status(held: ["sleep": "2026-10-04T07:00:00Z"])
        await engine([.testRaw("sleep")]).run(reason: "upgrade", budget: 60)
        XCTAssertEqual(Set(transport.bodies(for: "sleep").flatMap(uuids)), ["old1", "today1"])
        XCTAssertEqual(state.read().historyEpoch, HealthSyncEngine.historyEpoch)

        let sent = transport.bodies(for: "sleep").count
        await engine([.testRaw("sleep")]).run(reason: "again", budget: 60)
        XCTAssertEqual(transport.bodies(for: "sleep").count, sent, "only once")
    }

    func testTypesTheMacHoldsKeepTheirAnchors() async {
        source.add("sleep", start: now.addingTimeInterval(-2 * 86_400), uuid: "s1")
        await engine([.testRaw("sleep")]).run(reason: "first", budget: 60)
        let sent = transport.bodies(for: "sleep").count
        XCTAssertGreaterThan(sent, 0)

        transport.status = FakeHealthTransport.status(held: ["sleep": "2026-09-30T08:00:00Z"])
        await engine([.testRaw("sleep")]).run(reason: "again", budget: 60)
        XCTAssertEqual(transport.bodies(for: "sleep").count, sent, "nothing new, nothing sent again")
    }

    func testATypeTheMacLostIsReadFromTheBeginning() async {
        source.add("sleep", start: now.addingTimeInterval(-40 * 86_400), uuid: "s1")
        await engine([.testRaw("sleep")]).run(reason: "first", budget: 60)
        let before = transport.bodies(for: "sleep").count

        transport.status = FakeHealthTransport.status(held: ["sleep": nil])
        await engine([.testRaw("sleep")]).run(reason: "again", budget: 60)
        let again = transport.bodies(for: "sleep").dropFirst(before)
        XCTAssertEqual(Set(again.flatMap(uuids)), ["s1"])
    }

    // MARK: - The commit rule

    func testAnchorMovesOnlyAfterEveryPartIsStored() async {
        for i in 0..<1200 { source.add("sleep", start: now.addingTimeInterval(-Double(40 + i) * 86_400), uuid: "S\(i)") }
        // Third call of the backfill (parts 1 and 2 were stored) fails.
        transport.reply = { _, index in index == 2 ? .unavailable : .ok(FakeHealthTransport.stored) }
        let first = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(first, .macUnreachable)
        XCTAssertNil(state.read().anchors["sleep"], "a page counts only when all its parts were stored")
        XCTAssertEqual(transport.bodies.count, 3)

        transport.reply = { _, _ in .ok(FakeHealthTransport.stored) }
        let second = await engine([.testRaw("sleep")]).run(reason: "retry", budget: 60)
        XCTAssertEqual(second, .synced)
        XCTAssertEqual(transport.bodies.count, 6, "the whole page went again: 3 parts")
        XCTAssertEqual(Set(transport.bodies.suffix(3).flatMap(uuids)).count, 1200)
        XCTAssertNotNil(state.read().anchors["sleep"])
    }

    // MARK: - Recent days while the history is still being read

    /// A long backfill reads oldest first: a sample recorded since it began must
    /// not wait behind years of history (2026-10-04: the Mac had no step after
    /// midnight and not last night's sleep while the phone was mid-backfill).
    func testWhatWasRecordedLatelyGoesOutWhileTheHistoryIsStillBeingRead() async {
        for i in 0..<9000 { source.add("sleep", start: now.addingTimeInterval(-Double(60 + i) * 3600), uuid: "S\(i)") }
        transport.onCall = { [clock] in clock?.advance(1) }
        let shared = engine([.testRaw("sleep")])
        let first = await shared.run(reason: "active", budget: 8)
        XCTAssertEqual(first, .budget)
        XCTAssertFalse(state.read().completed.contains("sleep"))

        source.add("sleep", start: clock.now.addingTimeInterval(-3600), uuid: "last-night")
        clock.advance(HealthSyncEngine.catchUpInterval)
        let sent = transport.bodies(for: "sleep").count
        await shared.run(reason: "active+more", budget: 8)
        let again = transport.bodies(for: "sleep").dropFirst(sent)
        XCTAssertEqual(again.first.map(uuids), ["last-night"], "the last two days go first")
        XCTAssertFalse(state.read().completed.contains("sleep"), "the history is still being read")
    }

    func testRecentDaysGoOutAgainAtMostEveryFewMinutesUnlessADeliveryNamesTheType() async {
        for i in 0..<9000 { source.add("sleep", start: now.addingTimeInterval(-Double(60 + i) * 3600), uuid: "S\(i)") }
        transport.onCall = { [clock] in clock?.advance(1) }
        // One engine across runs, as the app has (HealthSync.engine).
        let shared = engine([.testRaw("sleep")])
        await shared.run(reason: "active", budget: 8)
        source.add("sleep", start: clock.now.addingTimeInterval(-60), uuid: "new1")

        var sent = transport.bodies(for: "sleep").count
        await shared.run(reason: "active+more", budget: 8)
        XCTAssertFalse(transport.bodies(for: "sleep").dropFirst(sent).flatMap(uuids).contains("new1"),
                       "a minute later, the backfill goes on")

        sent = transport.bodies(for: "sleep").count
        await shared.run(reason: "observer", budget: 8, only: ["sleep"])
        XCTAssertEqual(transport.bodies(for: "sleep").dropFirst(sent).first.map(uuids), ["new1"],
                       "HealthKit said sleep changed: its last two days go now")
    }

    func testABucketTypeMidBackfillSendsItsLastTwoDays() async {
        for i in 0..<25_000 { source.add("steps", start: now.addingTimeInterval(-Double(30 + i) * 600)) }
        transport.onCall = { [clock] in clock?.advance(1) }
        source.onAnchoredQuery = { [clock] in clock?.advance(1) }
        let shared = engine([.testBuckets("steps")])
        await shared.run(reason: "active", budget: 8)
        XCTAssertFalse(state.read().completed.contains("steps"), "still paging")

        clock.advance(HealthSyncEngine.catchUpInterval)
        let calls = source.statisticsCalls.count
        await shared.run(reason: "active+more", budget: 8)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let twoDays = calendar.startOfDay(for: clock.now.addingTimeInterval(-HealthSyncEngine.lateWindow))
        let newCalls = source.statisticsCalls.dropFirst(calls)
        XCTAssertTrue(newCalls.contains { $0.interval == 86_400 && abs($0.from.timeIntervalSince(twoDays)) < 86_400 },
                      "day buckets of the last two days")
    }

    /// 2026-10-04, the real phone: the first call after coming back to Walnut
    /// failed with "connection lost" (-1005) and ended the history read each time.
    func testADroppedConnectionSendsTheBatchAgainAndGoesOn() async {
        source.add("sleep", start: now.addingTimeInterval(-30 * 86_400), uuid: "old1")
        source.add("sleep", start: now.addingTimeInterval(-1 * 86_400), uuid: "recent1")
        let lost = APIError.network(underlying: URLError(.networkConnectionLost))
        transport.syncError = { index in index == 0 ? lost : nil }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "active", budget: 60)
        XCTAssertEqual(outcome, .synced)
        let bodies = transport.bodies(for: "sleep")
        XCTAssertEqual(bodies.count, 3, "the dropped batch went once more, then the backfill")
        XCTAssertEqual(uuids(bodies[0]), uuids(bodies[1]))
        XCTAssertTrue(state.read().completed.contains("sleep"))
    }

    func testAConnectionDroppedTwiceStopsWithTheAnchorKept() async {
        source.add("sleep", start: now.addingTimeInterval(-30 * 86_400), uuid: "old1")
        let lost = APIError.network(underlying: URLError(.networkConnectionLost))
        transport.syncError = { _ in lost }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "active", budget: 60)
        XCTAssertEqual(outcome, .macUnreachable)
        XCTAssertEqual(transport.bodies.count, 2, "one more try, not a loop")
        XCTAssertNil(state.read().anchors["sleep"])
    }

    func testOtherNetworkErrorsAreNotSentAgain() async {
        source.add("sleep", start: now.addingTimeInterval(-30 * 86_400), uuid: "old1")
        transport.syncError = { _ in APIError.network(underlying: URLError(.timedOut)) }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "active", budget: 60)
        XCTAssertEqual(outcome, .macUnreachable)
        XCTAssertEqual(transport.bodies.count, 1, "a timeout already took its time; the next run resends")
    }

    func testTheForegroundLoopGoesOnAfterAMacItCouldNotReach() {
        XCTAssertEqual(HealthBackground.foregroundNext(after: .budget, misses: 0), 0)
        XCTAssertEqual(HealthBackground.foregroundNext(after: .macUnreachable, misses: 0), 3)
        XCTAssertEqual(HealthBackground.foregroundNext(after: .macUnreachable, misses: 2), 30)
        XCTAssertNil(HealthBackground.foregroundNext(after: .macUnreachable, misses: 3), "then it stops")
        XCTAssertNil(HealthBackground.foregroundNext(after: .synced, misses: 0))
        XCTAssertNil(HealthBackground.foregroundNext(after: .locked, misses: 0))
    }

    func testMacUnreachableKeepsTheAnchorAndTheNextRunResends() async {
        source.add("sleep", start: now.addingTimeInterval(-60 * 86_400), uuid: "A")
        transport.reply = { _, _ in .unavailable }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .macUnreachable)
        XCTAssertNil(state.read().anchors["sleep"])

        transport.reply = { _, _ in .ok(FakeHealthTransport.stored) }
        await engine([.testRaw("sleep")]).run(reason: "retry", budget: 60)
        XCTAssertEqual(uuids(transport.bodies.last ?? [:]), ["A"])
        XCTAssertNotNil(state.read().anchors["sleep"])
    }

    func testStatusOfflineStopsBeforeAnyRead() async {
        transport.statusError = APIError.network(underlying: URLError(.notConnectedToInternet))
        source.add("sleep", start: now, uuid: "A")
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .macUnreachable)
        XCTAssertTrue(source.queried.isEmpty)
    }

    func testStoreMismatchResetsEveryAnchorAndStartsOverOnce() async {
        source.add("sleep", start: now.addingTimeInterval(-60 * 86_400), uuid: "A")
        source.add("other", start: now.addingTimeInterval(-60 * 86_400), uuid: "B")
        await engine([.testRaw("sleep"), .testRaw("other")]).run(reason: "test", budget: 60)
        XCTAssertNotNil(state.read().anchors["other"])

        source.add("sleep", start: now, uuid: "C")
        var mismatched = false
        transport.reply = { [transport] body, _ in
            if !mismatched {
                mismatched = true
                // As on a real Mac: after the delete, status names the new store.
                transport?.status = FakeHealthTransport.status(storeId: "hs-2")
                return .storeMismatch(storeId: "hs-2")
            }
            XCTAssertEqual(body["storeId"] as? String, "hs-2", "the restart sends under the new store")
            return .ok(FakeHealthTransport.stored)
        }
        let before = transport.bodies.count
        let outcome = await engine([.testRaw("sleep"), .testRaw("other")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .synced)
        XCTAssertEqual(state.read().storeId, "hs-2")
        let resent = transport.bodies.dropFirst(before + 1).flatMap(uuids)
        XCTAssertTrue(resent.contains("A") && resent.contains("B") && resent.contains("C"), "everything again: \(resent)")
    }

    func testANewStoreIdInStatusVoidsTheAnchors() async {
        source.add("sleep", start: now.addingTimeInterval(-60 * 86_400), uuid: "A")
        await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        transport.status = FakeHealthTransport.status(storeId: "hs-9")
        await engine([.testRaw("sleep")]).run(reason: "after-delete", budget: 60)
        XCTAssertEqual(state.read().storeId, "hs-9")
        XCTAssertEqual(uuids(transport.bodies.last ?? [:]), ["A"], "sent again into the new store")
    }

    func testUnsupportedAndUnitMismatchKeepTheAnchor() async {
        source.add("q.BodyMass", start: now.addingTimeInterval(-60 * 86_400), uuid: "M")
        source.add("q.Height", start: now.addingTimeInterval(-60 * 86_400), uuid: "H")
        transport.reply = { body, _ in
            switch body["type"] as? String {
            case "q.BodyMass": return .ok(FakeHealthTransport.result(unsupported: true))
            default: return .ok(FakeHealthTransport.result(unitMismatch: true))
            }
        }
        let specs: [HealthTypeSpec] = [.testRaw("q.BodyMass", generic: true, unit: "kg"),
                                       .testRaw("q.Height", generic: true, unit: "m")]
        let progressBox = ProgressBox()
        let engine = HealthSyncEngine(source: source, transport: transport, state: state,
                                      environment: .test(clock: clock), salt: salt, catalog: specs,
                                      onProgress: { progressBox.set($0) })
        let outcome = await engine.run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .synced, "a declined type does not fail the run")
        XCTAssertNil(state.read().anchors["q.BodyMass"])
        XCTAssertNil(state.read().anchors["q.Height"])
        XCTAssertEqual(transport.bodies(for: "q.BodyMass").first?["unit"] as? String, "kg")
        let last = progressBox.value
        XCTAssertEqual(last?.typesDone, last?.typesTotal, "declined types do not leave history syncing forever")
    }

    func testPausedStopsTheRun() async {
        source.add("sleep", start: now, uuid: "A")
        transport.status = FakeHealthTransport.status(paused: true)
        let paused = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(paused, .paused)
        XCTAssertTrue(transport.bodies.isEmpty)
        XCTAssertTrue(source.queried.isEmpty)

        // Paused between status and sync: stop, keep the anchor.
        transport.status = FakeHealthTransport.status()
        transport.reply = { _, _ in .ok(FakeHealthTransport.result(paused: true)) }
        let mid = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(mid, .paused)
        XCTAssertNil(state.read().anchors["sleep"])
    }

    func testAnOldServerGetsCatalogTypesAndGenericOnesAreNeverRead() async {
        source.add("sleep", start: now, uuid: "A")
        source.add("q.BodyMass", start: now, uuid: "M")
        source.characteristicValues = [HealthCharacteristicValue(name: "BiologicalSex", code: 2)]
        transport.status = FakeHealthTransport.status(generic: false, raw: ["sleep"])
        let specs: [HealthTypeSpec] = [.testRaw("sleep"), .testRaw("q.BodyMass", generic: true, unit: "kg")]
        await engine(specs).run(reason: "test", budget: 60)
        XCTAssertFalse(source.queried.contains("q.BodyMass"))
        XCTAssertFalse(source.queried.contains("characteristics"))
        XCTAssertTrue(transport.bodies(for: "q.BodyMass").isEmpty)
        XCTAssertFalse(transport.bodies(for: "sleep").isEmpty)

        transport.status = FakeHealthTransport.status(generic: true)
        await engine(specs).run(reason: "new-server", budget: 60)
        XCTAssertTrue(source.queried.contains("q.BodyMass"))
        XCTAssertFalse(transport.bodies(for: "q.BodyMass").isEmpty)
    }

    func testATypeTheServerDoesNotListIsNotSent() async {
        source.add("sleep", start: now, uuid: "A")
        source.add("vo2max", start: now, uuid: "V")
        transport.status = FakeHealthTransport.status(raw: ["sleep"])
        await engine([.testRaw("sleep"), .testRaw("vo2max")]).run(reason: "test", budget: 60)
        XCTAssertFalse(source.queried.contains("vo2max"))
    }

    func testALockedPhoneStopsQuietlyAndKeepsAnchors() async {
        source.add("sleep", start: now.addingTimeInterval(-60 * 86_400), uuid: "A")
        source.add("heart_rate", start: now.addingTimeInterval(-60 * 86_400), uuid: "H")
        source.lockedTypes = ["heart_rate"]
        let outcome = await engine([.testRaw("sleep"), .testRaw("heart_rate")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .locked)
        XCTAssertNil(state.read().anchors["heart_rate"])
        XCTAssertTrue(transport.bodies(for: "heart_rate").isEmpty)
    }

    func testTheBudgetStopsCleanlyAndTheNextRunContinues() async {
        for i in 0..<9000 { source.add("sleep", start: now.addingTimeInterval(-Double(60 + i) * 3600), uuid: "S\(i)") }
        transport.onCall = { [clock] in clock?.advance(1) }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 8)
        XCTAssertEqual(outcome, .budget)
        let anchor = state.read().anchors["sleep"].flatMap { Int(String(decoding: $0, as: UTF8.self)) }
        XCTAssertNotNil(anchor, "pages stored before the budget ran out keep their anchor")
        XCTAssertLessThan(anchor ?? 0, 9000)
        XCTAssertFalse(state.read().completed.contains("sleep"))

        transport.onCall = {}
        let next = await engine([.testRaw("sleep")]).run(reason: "next", budget: 600)
        XCTAssertEqual(next, .synced)
        XCTAssertTrue(state.read().completed.contains("sleep"))
    }

    func testTooLargeHalvesUntilTheMacTakesIt() async {
        for i in 0..<400 { source.add("sleep", start: now.addingTimeInterval(-Double(60 + i) * 3600), uuid: "S\(i)") }
        transport.reply = { body, _ in
            ((body["samples"] as? [Any])?.count ?? 0) > 100 ? .tooLarge : .ok(FakeHealthTransport.stored)
        }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .synced)
        let stored = transport.bodies.filter { (($0["samples"] as? [Any])?.count ?? 0) <= 100 }.flatMap(uuids)
        XCTAssertEqual(Set(stored).count, 400)
        XCTAssertNotNil(state.read().anchors["sleep"])
    }

    // MARK: - Characteristics

    func testAChangedCharacteristicSendsTheOldUUIDAsDeleted() async {
        source.characteristicValues = [HealthCharacteristicValue(name: "BiologicalSex", code: 2)]
        await engine([]).run(reason: "test", budget: 60)
        var calls = transport.bodies(for: "x.BiologicalSex")
        XCTAssertEqual(calls.count, 1)
        let first = uuids(calls[0]).first ?? ""
        XCTAssertTrue(first.hasPrefix("char-biologicalsex-h"), first)
        XCTAssertFalse(HealthCharacteristicKey.isLegacy(first, name: "BiologicalSex"), "the uuid carries no value")
        XCTAssertNil(calls[0]["deleted"])
        let sample = (calls[0]["samples"] as? [[String: Any]])?.first
        XCTAssertEqual(sample?["code"] as? Int, 2)
        XCTAssertEqual(sample?["start"] as? String, sample?["end"] as? String)

        await engine([]).run(reason: "same", budget: 60)
        XCTAssertEqual(transport.bodies(for: "x.BiologicalSex").count, 1, "unchanged: not sent again")

        source.characteristicValues = [HealthCharacteristicValue(name: "BiologicalSex", code: 1)]
        await engine([]).run(reason: "changed", budget: 60)
        calls = transport.bodies(for: "x.BiologicalSex")
        XCTAssertEqual(calls.count, 2)
        let second = uuids(calls[1]).first ?? ""
        XCTAssertNotEqual(second, first)
        XCTAssertEqual(calls[1]["deleted"] as? [String], [first])
        XCTAssertEqual(state.read().characteristicUUIDs["BiologicalSex"], second)
    }

    /// F2 (2026-10-07 gate): an r6 phone kept `char-dateofbirth-19800412`, the
    /// date of birth in the clear, in its sync progress. After the update the
    /// first send deletes the Mac's row under that old uuid, rebuilt from the value
    /// read then, and nothing the phone keeps carries the value.
    func testAnUpdatedPhoneDeletesThePreR7RowAndKeepsNoValue() async throws {
        state.update {
            $0.characteristicUUIDs["DateOfBirth"] = "char-dateofbirth-19800412"
            $0.characteristicUUIDs["BloodType"] = "char-bloodtype-2"
            $0.migrateLegacyCharacteristics()
        }
        XCTAssertEqual(state.read().legacyCharacteristicNames, ["DateOfBirth", "BloodType"])
        source.characteristicValues = [HealthCharacteristicValue(name: "DateOfBirth", code: 19_800_412)]
        await engine([]).run(reason: "updated", budget: 60)

        let calls = transport.bodies(for: "x.DateOfBirth")
        XCTAssertEqual(calls.count, 1)
        let uuid = uuids(calls[0]).first ?? ""
        XCTAssertTrue(uuid.hasPrefix("char-dateofbirth-h"), uuid)
        XCTAssertFalse(uuid.contains("19800412"))
        XCTAssertEqual(calls[0]["deleted"] as? [String], ["char-dateofbirth-19800412"], "the Mac's old row goes")
        XCTAssertEqual((calls[0]["samples"] as? [[String: Any]])?.first?["code"] as? Int, 19_800_412,
                       "the value itself still reaches the Mac: that is the data")
        XCTAssertTrue(transport.bodies(for: "x.BloodType").isEmpty, "no blood type now: nothing to rebuild, nothing sent")

        let kept = state.read()
        XCTAssertNil(kept.legacyCharacteristicNames, "both marks settled")
        let file = String(decoding: try JSONEncoder().encode(kept), as: UTF8.self)
        XCTAssertFalse(file.contains("19800412"), file)
        XCTAssertFalse(file.contains("char-bloodtype-2"), file)

        await engine([]).run(reason: "again", budget: 60)
        XCTAssertEqual(transport.bodies(for: "x.DateOfBirth").count, 1, "the new uuid is stable")
    }

    /// r7b: the salt is in the Keychain. When it is lost (the Keychain item was
    /// removed, or could not be kept), the next run makes a new one: every
    /// characteristic is sent once more, each with its old uuid as `deleted`,
    /// and after that nothing is sent again while the values stay.
    func testALostSaltSendsEachCharacteristicOnceMore() async {
        source.characteristicValues = [HealthCharacteristicValue(name: "BiologicalSex", code: 2),
                                       HealthCharacteristicValue(name: "DateOfBirth", code: 19_800_412)]
        await engine([]).run(reason: "first", budget: 60)
        let firstSex = uuids(transport.bodies(for: "x.BiologicalSex")[0]).first ?? ""
        let firstBirth = uuids(transport.bodies(for: "x.DateOfBirth")[0]).first ?? ""
        XCTAssertEqual(salt.made, 1)

        salt.delete()
        await engine([]).run(reason: "salt lost", budget: 60)
        let sex = transport.bodies(for: "x.BiologicalSex")
        let birth = transport.bodies(for: "x.DateOfBirth")
        XCTAssertEqual(sex.count, 2, "sent once more")
        XCTAssertEqual(birth.count, 2, "sent once more")
        XCTAssertEqual(salt.made, 2, "a new salt")
        XCTAssertEqual(sex[1]["deleted"] as? [String], [firstSex], "the old row goes in the same call")
        XCTAssertEqual(birth[1]["deleted"] as? [String], [firstBirth])
        XCTAssertNotEqual(uuids(sex[1]).first, firstSex)
        XCTAssertEqual((birth[1]["samples"] as? [[String: Any]])?.first?["code"] as? Int, 19_800_412)
        XCTAssertEqual(state.read().characteristicUUIDs["BiologicalSex"], uuids(sex[1]).first)

        await engine([]).run(reason: "after", budget: 60)
        XCTAssertEqual(transport.bodies(for: "x.BiologicalSex").count, 2, "stable again: not sent")
        XCTAssertEqual(transport.bodies(for: "x.DateOfBirth").count, 2)
    }

    /// r7b: what the sync state keeps never includes the salt, so the file alone
    /// cannot be tried against every birth date.
    func testTheSyncStateNeverHoldsTheSalt() async throws {
        source.characteristicValues = [HealthCharacteristicValue(name: "DateOfBirth", code: 19_800_412)]
        await engine([]).run(reason: "first", budget: 60)
        XCTAssertNotNil(state.read().characteristicUUIDs["DateOfBirth"])
        let data = try JSONEncoder().encode(state.read())
        let file = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(HealthSyncStateStore.hasSaltKey(data), file)
        XCTAssertFalse(file.contains(salt.salt().base64EncodedString()), "the salt's bytes are in the state")
        XCTAssertFalse(file.contains("19800412"))
    }

    func testTheCharacteristicKeyIsSaltedPerInstallAndHidesTheValue() {
        let a = Data(repeating: 1, count: 32), b = Data(repeating: 2, count: 32)
        let one = HealthCharacteristicKey.uuid(name: "DateOfBirth", code: 19_800_412, salt: a)
        XCTAssertEqual(one, HealthCharacteristicKey.uuid(name: "DateOfBirth", code: 19_800_412, salt: a))
        XCTAssertNotEqual(one, HealthCharacteristicKey.uuid(name: "DateOfBirth", code: 19_800_412, salt: b))
        XCTAssertNotEqual(one, HealthCharacteristicKey.uuid(name: "DateOfBirth", code: 19_800_413, salt: a))
        XCTAssertEqual(one.count, "char-dateofbirth-h".count + 32)
        XCTAssertTrue(HealthCharacteristicKey.isLegacy("char-dateofbirth-19800412", name: "DateOfBirth"))
        XCTAssertFalse(HealthCharacteristicKey.isLegacy(one, name: "DateOfBirth"))
        XCTAssertFalse(HealthCharacteristicKey.isLegacy("char-bloodtype-2", name: "DateOfBirth"))
        XCTAssertNotEqual(HealthCharacteristicKey.newSalt(), HealthCharacteristicKey.newSalt())
    }

    // MARK: - Buckets

    func testBucketsRecomputeFromTheEarliestChangeAndNeverSendSamples() async throws {
        let zone = TimeZone(identifier: "America/New_York")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        source.add("steps", start: now.addingTimeInterval(-40 * 86_400), uuid: "old")
        source.add("steps", start: now.addingTimeInterval(-3600), uuid: "today")
        await engine([.testBuckets("steps")]).run(reason: "test", budget: 60)

        let calls = source.statisticsCalls
        // Priming: 7 days of day and hour buckets, then the full recompute.
        XCTAssertEqual(calls.count, 4)
        let primeFrom = calendar.startOfDay(for: now.addingTimeInterval(-7 * 86_400))
        XCTAssertEqual(calls[0], .init(type: "steps", interval: 86_400, from: primeFrom, to: now, includeEmpty: false))
        XCTAssertEqual(calls[1].interval, 3600)
        let dayFrom = calendar.startOfDay(for: now.addingTimeInterval(-40 * 86_400))
        XCTAssertEqual(calls[2], .init(type: "steps", interval: 86_400, from: dayFrom, to: now, includeEmpty: false))
        let hourFrom = try XCTUnwrap(calendar.dateInterval(of: .hour, for: now.addingTimeInterval(-30 * 86_400))?.start)
        XCTAssertEqual(calls[3].from, hourFrom, "hour buckets for at most 30 days")
        for body in transport.bodies(for: "steps") {
            XCTAssertEqual(body["kind"] as? String, "buckets")
            XCTAssertNil(body["samples"], "bucket types never send their samples")
            XCTAssertNotNil(body["buckets"])
        }
        XCTAssertNil(state.read().bucketPendingFrom["steps"])

        // Nothing new: no recompute at all.
        await engine([.testBuckets("steps")]).run(reason: "quiet", budget: 60)
        XCTAssertEqual(source.statisticsCalls.count, 4)

        // A late sample from yesterday: recompute from the start of 2 days ago.
        source.add("steps", start: now.addingTimeInterval(-86_400), uuid: "late")
        await engine([.testBuckets("steps")]).run(reason: "late", budget: 60)
        let late = Array(source.statisticsCalls.dropFirst(4))
        XCTAssertEqual(late.count, 2)
        XCTAssertEqual(late[0].from, calendar.startOfDay(for: now.addingTimeInterval(-2 * 86_400)))
        XCTAssertEqual(late[1].from, late[0].from)

        // A deletion has no date: everything since the earliest sample, with
        // empty buckets so a now-empty day reads zero.
        source.delete("steps", uuid: "today")
        await engine([.testBuckets("steps")]).run(reason: "delete", budget: 60)
        let afterDelete = Array(source.statisticsCalls.dropFirst(6))
        XCTAssertEqual(afterDelete.first?.from, dayFrom)
        XCTAssertEqual(afterDelete.first?.includeEmpty, true)
    }

    func testABucketRecomputeThatFailsIsDoneAgain() async {
        source.add("steps", start: now.addingTimeInterval(-10 * 86_400), uuid: "a")
        var calls = 0
        transport.reply = { _, _ in
            calls += 1
            return calls == 2 ? .unavailable : .ok(FakeHealthTransport.stored)
        }
        let first = await engine([.testBuckets("steps")]).run(reason: "test", budget: 60)
        XCTAssertEqual(first, .macUnreachable)
        XCTAssertNotNil(state.read().bucketPendingFrom["steps"], "still owed")
        let second = await engine([.testBuckets("steps")]).run(reason: "retry", budget: 60)
        XCTAssertEqual(second, .synced)
        XCTAssertNil(state.read().bucketPendingFrom["steps"])
    }

    // MARK: - Guards and demo

    func testGuardsStopBeforeAnyCall() async {
        let off = await engine([.testRaw("sleep")], enabled: false).run(reason: "test", budget: 60)
        XCTAssertEqual(off, .off)
        source.isAvailable = false
        let none = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(none, .unavailable)
        XCTAssertTrue(transport.bodies.isEmpty)
    }

    func testTheDemoNeverReadsHealthKit() async {
        source.failIfTouched = true
        source.add("sleep", start: now, uuid: "A")
        let outcome = await engine([.testRaw("sleep")], demo: true).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .synced)
        XCTAssertEqual(source.forbiddenTouches, 0)
        XCTAssertTrue(transport.bodies.isEmpty)
    }

    func testAnEraseDuringARunIsNotUndone() async {
        for i in 0..<5000 { source.add("sleep", start: now.addingTimeInterval(-Double(60 + i) * 3600), uuid: "S\(i)") }
        var erased = false
        transport.reply = { [state] _, index in
            if index == 1, !erased {
                erased = true
                state?.eraseAll()
            }
            return .ok(FakeHealthTransport.stored)
        }
        let outcome = await engine([.testRaw("sleep")]).run(reason: "test", budget: 60)
        XCTAssertEqual(outcome, .off)
        XCTAssertNil(state.read().anchors["sleep"], "the erased state stays erased")
        XCTAssertNil(state.read().lastOutcome, "not even the run's outcome is written back")
        XCTAssertNil(state.read().storeId)
    }
}

private final class ProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var last: HealthSyncProgress?
    var value: HealthSyncProgress? { lock.withLock { last } }
    func set(_ progress: HealthSyncProgress) { lock.withLock { last = progress } }
}
