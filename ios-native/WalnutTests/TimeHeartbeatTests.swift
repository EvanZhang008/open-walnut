import XCTest
import SwiftUI
@testable import Walnut

/// Every rule the in-app attention clock is built on: when a window closes and
/// what it earns, what the wire body looks like, what the disk queue keeps and
/// drops, and — the part that matters most — that a failed POST never loses a
/// sample while a 204 always drops exactly the samples that were accepted.
///
/// No network and no simulator UI: the window machine and the queue state are
/// pure, the store takes a temp file, and the reporter takes an injected clock +
/// sender. Every `await` is hoisted out of the XCTAssert autoclosures (they are
/// synchronous, so an `await` inside one does not compile).
final class TimeHeartbeatTests: XCTestCase {

    // MARK: - Fixtures

    /// Fixed clock so "48 hours old" is a property of the fixture, not of the day
    /// the suite happens to run. 1_756_000_000 = 2025-08-24T01:46:40Z.
    private static let t0 = Date(timeIntervalSince1970: 1_756_000_000)
    private static var t0Ms: Int64 { Int64(t0.timeIntervalSince1970 * 1000) }

    private func tempFileURL() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("walnut-time-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("queue.json")
    }

    private func sample(
        startMs: Int64, durationMs: Int = 30_000, kind: AttentionKind = .triage,
        taskId: String? = nil, sessionId: String? = nil
    ) -> AttentionSample {
        AttentionSample(
            startMs: startMs, durationMs: durationMs, kind: kind, taskId: taskId, sessionId: sessionId
        )
    }

    private func serverError(_ status: Int, _ code: String) -> APIError {
        .server(status: status, code: code, message: "test", serverHash: nil, serverContent: nil)
    }

    // MARK: - Window machine

    func testWindowClosesIntoASampleOnContextSwitch() {
        let window = AttentionWindowMachine.Window(
            target: .session(id: "claude-abc", taskId: "t_42"), startedAt: Self.t0
        )
        let banked = AttentionWindowMachine.bank(window, endingAt: Self.t0.addingTimeInterval(31.4))
        XCTAssertEqual(banked?.kind, .session)
        XCTAssertEqual(banked?.sessionId, "claude-abc")
        XCTAssertEqual(banked?.taskId, "t_42")
        XCTAssertEqual(banked?.durationMs, 31_400)
        // The START of the window — the server assigns the local day from it.
        XCTAssertEqual(banked?.startMs, Self.t0Ms)
    }

    func testSubSecondWindowIsNotAttention() {
        let window = AttentionWindowMachine.Window(target: .chat, startedAt: Self.t0)
        XCTAssertNil(AttentionWindowMachine.bank(window, endingAt: Self.t0.addingTimeInterval(0.4)))
        // Exactly at the floor still counts.
        let atFloor = AttentionWindowMachine.bank(window, endingAt: Self.t0.addingTimeInterval(1.0))
        XCTAssertEqual(atFloor?.durationMs, 1_000)
    }

    func testBackwardsClockIsDroppedRatherThanFabricated() {
        let window = AttentionWindowMachine.Window(target: .chat, startedAt: Self.t0)
        XCTAssertNil(AttentionWindowMachine.bank(window, endingAt: Self.t0.addingTimeInterval(-90)))
    }

    /// The server clamps a sample at 10 minutes silently; clamp here instead so
    /// the number we send is the number that lands.
    func testWindowCeilingMatchesTheServerCap() {
        let window = AttentionWindowMachine.Window(target: .triage, startedAt: Self.t0)
        let banked = AttentionWindowMachine.bank(window, endingAt: Self.t0.addingTimeInterval(3600))
        XCTAssertEqual(banked?.durationMs, AttentionWindowMachine.maxSampleMs)
        XCTAssertEqual(banked?.durationMs, 600_000)
    }

    // MARK: - Wire shape

    func testWireSampleCarriesSourceIosAndAnISOStart() throws {
        let wire = sample(
            startMs: 1_756_000_000_123, durationMs: 45_000, kind: .session,
            taskId: "t_1", sessionId: "s_1"
        ).wire(id: "install-1")
        XCTAssertEqual(wire.id, "install-1")
        XCTAssertEqual(wire.source, "ios")
        XCTAssertEqual(wire.kind, "session")
        XCTAssertEqual(wire.durationMs, 45_000)
        XCTAssertEqual(wire.ts, "2025-08-24T01:46:40.123Z")
        // Must be parseable by `new Date(ts)` server-side; ISO8601DateFormatter
        // with fractional seconds is the closest local equivalent.
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = try XCTUnwrap(parser.date(from: wire.ts))
        XCTAssertEqual(parsed.timeIntervalSince1970, 1_756_000_000.123, accuracy: 0.002)
    }

    func testWireSampleOmitsAbsentIds() throws {
        let json = try JSONEncoder().encode(sample(startMs: Self.t0Ms, kind: .triage).wire(id: "install-7"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertNil(object["taskId"])
        XCTAssertNil(object["sessionId"])
        XCTAssertEqual(object["kind"] as? String, "triage")
        XCTAssertEqual(object["source"] as? String, "ios")
        // The dedupe key is never optional — a sample without one would be
        // re-banked on every re-send.
        XCTAssertEqual(object["id"] as? String, "install-7")
    }

    /// The idempotency key: `<installId>-<seq>`, and it must FIT. An id the server
    /// truncates or rejects is worse than none, because it would collapse
    /// different samples onto one key and silently drop real attention.
    func testSampleIdPairsInstallAndSeqWithinTheLengthLimit() {
        let install = UUID().uuidString
        XCTAssertEqual(
            TimeSampleFormat.sampleId(installId: install, seq: 42), "\(install)-42"
        )
        XCTAssertLessThanOrEqual(
            TimeSampleFormat.sampleId(installId: install, seq: 42).count,
            TimeSampleFormat.maxIdLength
        )
        // A pathological install id is trimmed, not allowed to blow the limit.
        let long = String(repeating: "x", count: 400)
        let id = TimeSampleFormat.sampleId(installId: long, seq: Int64.max)
        XCTAssertLessThanOrEqual(id.count, TimeSampleFormat.maxIdLength)
        XCTAssertTrue(id.hasSuffix("-\(Int64.max)"))
        // Distinct seqs stay distinct even after trimming.
        XCTAssertNotEqual(
            TimeSampleFormat.sampleId(installId: long, seq: 1),
            TimeSampleFormat.sampleId(installId: long, seq: 2)
        )
        // The server's own rule (`SAMPLE_ID_RE` in core/time-tracking/ingest.ts):
        // an id it can't parse is treated as ABSENT, i.e. silently not deduped —
        // so a real UUID has to satisfy it.
        let allowed = try? NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$")
        let candidate = TimeSampleFormat.sampleId(installId: install, seq: 7)
        XCTAssertEqual(
            allowed?.numberOfMatches(
                in: candidate, range: NSRange(candidate.startIndex..., in: candidate)
            ), 1, "the server would drop this id as unparseable and skip dedupe"
        )
    }

    // MARK: - Queue state (pure)

    func testAppendAssignsMonotonicSequenceNumbers() {
        var state = TimeSampleQueueState()
        state.append([sample(startMs: Self.t0Ms), sample(startMs: Self.t0Ms + 1000)], now: Self.t0Ms + 2000)
        state.append([sample(startMs: Self.t0Ms + 1500)], now: Self.t0Ms + 2000)
        XCTAssertEqual(state.samples.map(\.seq), [1, 2, 3])
        XCTAssertEqual(state.nextSeq, 4)
    }

    func testPruneDropsSamplesOlderThan48Hours() {
        let now = Self.t0Ms
        var state = TimeSampleQueueState()
        let old = now - TimeSampleQueueState.maxAgeMs - 1
        let fresh = now - 60_000
        let dropped = state.append([sample(startMs: old), sample(startMs: fresh)], now: now)
        XCTAssertEqual(dropped, 1)
        XCTAssertEqual(state.samples.map(\.sample.startMs), [fresh])
    }

    func testCountCapShedsOldestFirst() {
        let now = Self.t0Ms
        var state = TimeSampleQueueState()
        let overflow = TimeSampleQueueState.maxSamples + 10
        let incoming = (0..<overflow).map { sample(startMs: now - Int64(overflow - $0) * 1000) }
        let dropped = state.append(incoming, now: now)
        XCTAssertEqual(dropped, 10)
        XCTAssertEqual(state.count, TimeSampleQueueState.maxSamples)
        // The newest survived; the ten oldest are the ones gone.
        XCTAssertEqual(state.samples.last?.sample.startMs, now - 1000)
        XCTAssertEqual(state.samples.first?.seq, 11)
    }

    func testBatchIsCappedAtTheServersRequestLimit() {
        let now = Self.t0Ms
        var state = TimeSampleQueueState()
        state.append((0..<250).map { sample(startMs: now - Int64(250 - $0) * 1000) }, now: now)
        XCTAssertEqual(
            TimeSampleQueueState.maxBatch, 200,
            "the server slices the array at 200 and still answers 204 — over-sending loses the tail"
        )
        XCTAssertEqual(state.batch().count, 200)
    }

    func testCommitRemovesOnlyWhatWasAccepted() {
        let now = Self.t0Ms
        var state = TimeSampleQueueState()
        state.append((0..<5).map { sample(startMs: now - Int64(5 - $0) * 1000) }, now: now)
        state.commit(throughSeq: 3)
        XCTAssertEqual(state.samples.map(\.seq), [4, 5])
    }

    /// Why commit is keyed on a seq and not on an index: a prune between take and
    /// commit shifts every index, and an index-based commit would then delete
    /// samples that were never sent.
    func testCommitStaysCorrectAfterAHeadPrune() throws {
        let now = Self.t0Ms
        var state = TimeSampleQueueState()
        state.append(
            [sample(startMs: now - 3000), sample(startMs: now - 2000), sample(startMs: now - 1000)],
            now: now
        )
        let batch = state.batch()
        XCTAssertEqual(batch.count, 3)
        // Two days pass: everything ages out and is pruned from the HEAD.
        state.prune(now: now + TimeSampleQueueState.maxAgeMs + 1)
        XCTAssertEqual(state.count, 0)
        // Committing the old batch must not throw or resurrect anything.
        let lastSeq = try XCTUnwrap(batch.last?.seq)
        state.commit(throughSeq: lastSeq)
        XCTAssertEqual(state.count, 0)
    }

    // MARK: - Store (disk + send/commit)

    func testQueueSurvivesRelaunch() async throws {
        let url = tempFileURL()
        let first = TimeSampleStore(fileURL: url)
        await first.enqueue([
            sample(startMs: Self.t0Ms, kind: .session, sessionId: "s_9"),
            sample(startMs: Self.t0Ms + 30_000, kind: .chat),
        ], now: Self.t0)

        // A brand-new store over the same file = the next app launch.
        let reopened = TimeSampleStore(fileURL: url)
        let state = await reopened.snapshot()
        XCTAssertEqual(state.count, 2)
        XCTAssertEqual(state.samples.map(\.sample.kind), [.session, .chat])
        XCTAssertEqual(state.samples.first?.sample.sessionId, "s_9")
        // Sequence numbers continue rather than restarting.
        XCTAssertEqual(state.nextSeq, 3)
    }

    func test204ClearsExactlyWhatWasSent() async throws {
        let url = tempFileURL()
        let store = TimeSampleStore(fileURL: url)
        await store.enqueue([sample(startMs: Self.t0Ms), sample(startMs: Self.t0Ms + 30_000)], now: Self.t0)
        let captured = SampleRecorder()
        let outcome = await store.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(outcome, .sent(count: 2, remaining: 0))

        let remaining = await store.queuedCount
        XCTAssertEqual(remaining, 0)
        let batches = await captured.batches
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(batches.first?.count, 2)
        XCTAssertEqual(batches.first?.allSatisfy({ $0.source == "ios" }), true)
        // Cleared on DISK too, not just in memory.
        let afterRelaunch = await TimeSampleStore(fileURL: url).snapshot()
        XCTAssertEqual(afterRelaunch.count, 0)
    }

    func test503KeepsTheSamplesForALaterRetry() async throws {
        let url = tempFileURL()
        let store = TimeSampleStore(fileURL: url)
        await store.enqueue([sample(startMs: Self.t0Ms)], now: Self.t0)

        let unavailable = serverError(503, "unavailable")
        let outcome = await store.flush(using: { _ in throw unavailable }, now: Self.t0)
        XCTAssertEqual(outcome, .kept(retryable: true))
        let kept = await store.queuedCount
        XCTAssertEqual(kept, 1)
        // Still on disk for the next launch, not just in memory.
        let onDisk = await TimeSampleStore(fileURL: url).snapshot()
        XCTAssertEqual(onDisk.count, 1)

        // The retry then succeeds and the sample goes out exactly once.
        let captured = SampleRecorder()
        let retried = await store.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(retried, .sent(count: 1, remaining: 0))
        let batches = await captured.batches
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(batches.first?.count, 1)
    }

    func testUnknownFailuresAlsoKeepTheSamples() async throws {
        let store = TimeSampleStore(fileURL: tempFileURL())
        await store.enqueue([sample(startMs: Self.t0Ms)], now: Self.t0)
        let outcome = await store.flush(
            using: { _ in throw APIError.network(underlying: URLError(.timedOut)) }, now: Self.t0
        )
        XCTAssertEqual(outcome, .kept(retryable: true))
        let kept = await store.queuedCount
        XCTAssertEqual(kept, 1)
    }

    /// A permanent refusal keeps the data (it can still go out after a re-pair)
    /// but is reported as not worth a retry timer.
    func testPermanentRefusalKeepsDataButStopsTheTimer() async throws {
        let store = TimeSampleStore(fileURL: tempFileURL())
        await store.enqueue([sample(startMs: Self.t0Ms)], now: Self.t0)
        let outcome = await store.flush(using: { _ in throw APIError.unauthorized }, now: Self.t0)
        XCTAssertEqual(outcome, .kept(retryable: false))
        let kept = await store.queuedCount
        XCTAssertEqual(kept, 1)
    }

    func testRetryClassification() {
        XCTAssertTrue(TimeSampleStore.isRetryable(serverError(503, "unavailable")))
        XCTAssertTrue(TimeSampleStore.isRetryable(serverError(500, "boom")))
        XCTAssertTrue(TimeSampleStore.isRetryable(APIError.rateLimited))
        XCTAssertTrue(TimeSampleStore.isRetryable(APIError.network(underlying: URLError(.notConnectedToInternet))))
        XCTAssertFalse(TimeSampleStore.isRetryable(APIError.unauthorized))
        XCTAssertFalse(TimeSampleStore.isRetryable(APIError.notConfigured))
        XCTAssertFalse(TimeSampleStore.isRetryable(serverError(400, "bad_request")))
    }

    func testBatchingSendsTheOldest200AndKeepsTheRest() async throws {
        let store = TimeSampleStore(fileURL: tempFileURL())
        let base = Self.t0Ms
        await store.enqueue((0..<210).map { sample(startMs: base + Int64($0) * 1000) }, now: Self.t0)
        let captured = SampleRecorder()
        let outcome = await store.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(outcome, .sent(count: 200, remaining: 10))
        let batches = await captured.batches
        XCTAssertEqual(batches.first?.count, 200)
        // Oldest first — shipping newest-first would strand the tail forever.
        XCTAssertEqual(batches.first?.first?.ts, TimeSampleFormat.iso8601(epochMs: base))
        let second = await store.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(second, .sent(count: 10, remaining: 0))
    }

    func testEmptyQueueSendsNothing() async throws {
        let store = TimeSampleStore(fileURL: tempFileURL())
        let captured = SampleRecorder()
        let outcome = await store.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(outcome, .empty)
        let batches = await captured.batches
        XCTAssertEqual(batches.count, 0)
    }

    // MARK: - Idempotency (the lost-ack case)

    /// THE double-count scenario: the server banks the batch and the 204 never
    /// arrives (suspension mid-POST, a replica losing the relay ack, the 20s
    /// timeout under load). The queue is right to re-send — so the re-send must
    /// present the SAME ids, which is the only thing that lets the server tell a
    /// duplicate from a second window that happens to look alike.
    func testLostAckResendCarriesTheIdenticalIdempotencyIds() async throws {
        let url = tempFileURL()
        let store = TimeSampleStore(fileURL: url)
        await store.enqueue([
            sample(startMs: Self.t0Ms, kind: .session, sessionId: "s_1"),
            sample(startMs: Self.t0Ms + 30_000, kind: .triage),
        ], now: Self.t0)

        // Attempt 1: the server received it, we never learn that.
        let captured = SampleRecorder()
        let lost = await store.flush(
            using: { batch in
                await captured.record(batch)
                throw APIError.network(underlying: URLError(.timedOut))
            }, now: Self.t0
        )
        XCTAssertEqual(lost, .kept(retryable: true))

        // Attempt 2, from a fresh store over the same file — i.e. after the
        // process was killed, which is exactly when a naive id would change.
        let relaunched = TimeSampleStore(fileURL: url)
        let resent = await relaunched.flush(using: { await captured.record($0) }, now: Self.t0)
        XCTAssertEqual(resent, .sent(count: 2, remaining: 0))

        let batches = await captured.batches
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches[0].map(\.id), batches[1].map(\.id))
        // And they are distinct within the batch, or the server would dedupe one
        // real window away.
        XCTAssertEqual(Set(batches[0].map(\.id)).count, 2)
    }

    func testInstallIdIsMintedOnceAndSurvivesRelaunch() async throws {
        let url = tempFileURL()
        let store = TimeSampleStore(fileURL: url)
        let first = await store.installId()
        let again = await store.installId()
        XCTAssertEqual(first, again)
        XCTAssertFalse(first.isEmpty)
        let relaunched = await TimeSampleStore(fileURL: url).installId()
        XCTAssertEqual(relaunched, first)
        // A different install is a different namespace.
        let other = await TimeSampleStore(fileURL: tempFileURL()).installId()
        XCTAssertNotEqual(other, first)
    }

    /// A flush runs at least once a minute for as long as the app is on screen and
    /// the usual answer is "nothing to send". That must not be a disk write.
    func testIdleFlushDoesNotTouchTheDisk() async throws {
        let url = tempFileURL()
        let store = TimeSampleStore(fileURL: url)
        let idle = await store.flush(using: { _ in }, now: Self.t0)
        XCTAssertEqual(idle, .empty)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: url.path),
            "an empty flush created a queue file"
        )

        // Same once there IS a file and the queue has drained.
        await store.enqueue([sample(startMs: Self.t0Ms)], now: Self.t0)
        _ = await store.flush(using: { _ in }, now: Self.t0)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let before = try XCTUnwrap(attributes[.modificationDate] as? Date)
        try await Task.sleep(nanoseconds: 60_000_000)
        _ = await store.flush(using: { _ in }, now: Self.t0)
        let after = try XCTUnwrap(
            try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        )
        XCTAssertEqual(before, after, "an idle flush rewrote the queue file")
    }

    // MARK: - Attention context

    @MainActor
    func testClaimBeatsBaseAndReleaseRestoresIt() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }

        var seen: [AttentionTarget] = []
        context.onChange = { seen.append($0) }

        context.setBase(.chat)
        XCTAssertEqual(context.current, .chat)
        let token = context.claim(.session(id: "s_1", taskId: "t_1"))
        XCTAssertEqual(context.current.kind, .session)
        context.release(token)
        XCTAssertEqual(context.current, .chat)
        XCTAssertEqual(seen.map(\.kind), [.chat, .session, .chat])
    }

    /// SwiftUI runs the incoming view's onAppear BEFORE the outgoing view's
    /// onDisappear. A single slot would let the departing screen erase the one
    /// that just arrived; a token release removes its own entry only.
    @MainActor
    func testAppearBeforeDisappearOrderingKeepsTheNewClaim() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }

        context.setBase(.triage)
        let first = context.claim(.session(id: "s_1"))
        let second = context.claim(.session(id: "s_2"))
        context.release(first) // the OLD screen's disappear arrives late
        XCTAssertEqual(context.current.sessionId, "s_2")
        context.release(second)
        XCTAssertEqual(context.current, .triage)
        // A double release is a no-op, not a crash or an underflow.
        context.release(second)
        XCTAssertEqual(context.current, .triage)
    }

    @MainActor
    func testOnChangeFiresOnlyWhenTheEarningContextActuallyChanges() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }

        var changes = 0
        context.onChange = { _ in changes += 1 }
        context.setBase(.triage) // already the default
        XCTAssertEqual(changes, 0)
        let token = context.claim(.session(id: "s_1"))
        XCTAssertEqual(changes, 1)
        // A base change UNDER a claim earns nothing new — the claim still wins.
        context.setBase(.chat)
        XCTAssertEqual(changes, 1)
        context.release(token)
        XCTAssertEqual(changes, 2)
        XCTAssertEqual(context.current, .chat)
    }

    /// Re-pointing a claim must not flicker through the base. Release + claim
    /// would, and the reporter would hear two switches: one banking the session's
    /// seconds against the tab underneath, one opening a fresh window.
    @MainActor
    func testUpdatingAClaimMovesItInPlace() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }
        context.setBase(.chat)

        var seen: [AttentionTarget] = []
        let token = context.claim(.session(id: "claude-1"))
        context.onChange = { seen.append($0) }

        context.update(token, to: .session(id: "claude-1", taskId: "t_late"))
        XCTAssertEqual(seen.map(\.kind), [.session], "the base must never be visible in between")
        XCTAssertEqual(context.current.taskId, "t_late")

        // Idempotent, and a claim on top still wins.
        context.update(token, to: .session(id: "claude-1", taskId: "t_late"))
        XCTAssertEqual(seen.count, 1)
        let top = context.claim(.triage)
        context.update(token, to: .session(id: "claude-1", taskId: "t_later"))
        XCTAssertEqual(context.current, .triage, "an under-claim update must not steal the top")
        context.release(top)
        XCTAssertEqual(context.current.taskId, "t_later")
        // An unknown token is ignored rather than corrupting the stack.
        context.update(UUID(), to: .chat)
        XCTAssertEqual(context.current.taskId, "t_later")
    }

    /// The modifier half of the same rule, hosted: a screen that learns its task
    /// AFTER it is already on screen must re-point its claim, or the whole visit
    /// is filed with `taskId: nil` and the time never reaches the task.
    @MainActor
    func testClaimFollowsIdsThatArriveAfterTheScreenIsUp() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }
        context.setBase(.chat)

        let box = AttentionTargetBox()
        let host = UIHostingController(rootView: AttentionRefreshProbe(box: box))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        XCTAssertEqual(context.current.sessionId, "claude-refresh")
        XCTAssertNil(context.current.taskId)

        box.taskId = "t_resolved"
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        XCTAssertEqual(context.current.taskId, "t_resolved")
        XCTAssertEqual(context.current.kind, .session)

        window.rootViewController = nil
        window.isHidden = true
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        XCTAssertEqual(context.current, .chat, "the claim was still released exactly once")
    }

    @MainActor
    func testTabsMapToLanes() {
        XCTAssertEqual(MainTabView.attentionTarget(for: .chat), .chat)
        for tab in [MainTabView.Tab.inbox, .notes, .tasks, .settings] {
            XCTAssertEqual(MainTabView.attentionTarget(for: tab), .triage)
        }
    }

    // MARK: - The session screen's own claim (hosted, real view)

    /// The one link the pure tests can't reach: that the REAL session page claims
    /// the session lane with the ids the server needs. Mounted through
    /// `UIHostingController` like FirstPaintFreezeTests does, so the assertion is
    /// against the actual `.attentionContext(...)` call site rather than a copy of
    /// it — a page that claimed `.triage`, or dropped the taskId, would file phone
    /// time under the wrong task and no unit test of the reporter would notice.
    @MainActor
    func testSessionPageClaimsItsSessionAndTaskWhileOnScreen() {
        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }
        context.setBase(.chat)

        let session = WalnutSession(
            id: "claude-session-e2e", title: "Attention", taskId: "t_attention",
            taskTitle: "Attention", project: nil, host: "", processStatus: "idle",
            model: nil, mode: nil, startedAt: "2026-08-29T00:00:00Z",
            lastActiveAt: "2026-08-29T00:00:00Z", messageCount: 0, cwd: nil,
            pinned: nil, focusTier: nil, description: nil
        )
        let store = SessionConversationStore(session: session)
        let host = UIHostingController(rootView: NavigationStack {
            SessionConversationView(session: session, store: store)
        })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        // onAppear lands on a later run-loop turn than layout.
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        XCTAssertEqual(context.current.kind, .session)
        XCTAssertEqual(context.current.sessionId, "claude-session-e2e",
                       "the CLAUDE session id is what the server resolves a task from")
        XCTAssertEqual(context.current.taskId, "t_attention",
                       "the page knows the task — sending it skips the server's lookup entirely")

        // Leaving the page hands attention back to the tab underneath.
        window.rootViewController = nil
        window.isHidden = true
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        XCTAssertEqual(context.current, .chat)
    }

    // MARK: - Reporter (window bookkeeping end to end, no network)

    @MainActor
    func testReporterBanksOneSamplePerContextAndFlushesOnBackground() async {
        AttentionContext.shared.resetForTesting()
        defer { AttentionContext.shared.resetForTesting() }
        let clock = TestClock(now: Self.t0)
        let captured = SampleRecorder()
        let reporter = TimeHeartbeatReporter(
            store: TimeSampleStore(fileURL: tempFileURL()),
            sender: { await captured.record($0) },
            clock: { clock.now }
        )

        reporter.setActive(true)          // launched into the default (triage) lane
        XCTAssertTrue(reporter.hasOpenWindow)
        clock.advance(30)
        reporter.contextChanged(to: .session(id: "claude-1", taskId: "t_7"))
        clock.advance(40)
        reporter.contextChanged(to: .chat)
        clock.advance(20)
        reporter.setActive(false)         // backgrounded
        XCTAssertFalse(reporter.hasOpenWindow)
        await reporter.drainForTesting()

        let sent = await captured.allSamples
        XCTAssertEqual(sent.map(\.kind), ["triage", "session", "chat"])
        XCTAssertEqual(sent.map(\.durationMs), [30_000, 40_000, 20_000])
        XCTAssertEqual(sent.count > 1 ? sent[1].sessionId : nil, "claude-1")
        XCTAssertEqual(sent.count > 1 ? sent[1].taskId : nil, "t_7")
        XCTAssertTrue(sent.allSatisfy { $0.source == "ios" })
        let leftover = await reporter.queuedSampleCount()
        XCTAssertEqual(leftover, 0)
    }

    /// Nothing may be counted while the app is not in front of the user.
    @MainActor
    func testNoTimeIsEarnedWhileBackgrounded() async {
        AttentionContext.shared.resetForTesting()
        defer { AttentionContext.shared.resetForTesting() }
        let clock = TestClock(now: Self.t0)
        let captured = SampleRecorder()
        let reporter = TimeHeartbeatReporter(
            store: TimeSampleStore(fileURL: tempFileURL()),
            sender: { await captured.record($0) },
            clock: { clock.now }
        )

        reporter.setActive(true)
        clock.advance(10)
        reporter.setActive(false)
        clock.advance(3600)                // an hour in the user's pocket
        reporter.contextChanged(to: .chat)  // a stray signal while suspended
        XCTAssertFalse(reporter.hasOpenWindow)
        reporter.setActive(true)
        clock.advance(5)
        reporter.setActive(false)
        await reporter.drainForTesting()

        let sent = await captured.allSamples
        XCTAssertEqual(
            sent.map(\.durationMs), [10_000, 5_000],
            "the backgrounded hour must not be counted"
        )
    }

    /// Settings → Disconnect → re-pair, all in the FOREGROUND.
    ///
    /// `ConnectionStore.disconnect()` fans `suspendForBackground` out through
    /// `LifecycleHub.teardownAll()` while the scene never leaves `.active`, so no
    /// `.active` transition is coming to undo it. An earlier version of this file
    /// latched `isActive = false` there and the clock stayed dead for the rest of
    /// the foreground session, including after a successful re-pair. Presence is
    /// owned by `scenePhase` alone; the hub's edges only gate the network.
    @MainActor
    func testForegroundTeardownDoesNotStopTheClock() async {
        AttentionContext.shared.resetForTesting()
        defer { AttentionContext.shared.resetForTesting() }
        let clock = TestClock(now: Self.t0)
        let captured = SampleRecorder()
        let reporter = TimeHeartbeatReporter(
            store: TimeSampleStore(fileURL: tempFileURL()),
            sender: { await captured.record($0) },
            clock: { clock.now }
        )

        reporter.setActive(true)
        clock.advance(20)

        // The disconnect fan-out, and then the re-pair's. The scene stayed active
        // throughout — `setActive` is never called again.
        reporter.suspendForBackground()
        XCTAssertTrue(reporter.isCounting, "a foreground teardown must not stop the clock")
        XCTAssertTrue(reporter.hasOpenWindow, "the open window survives a teardown")
        clock.advance(15)
        reporter.resumeForForeground()
        clock.advance(25)

        // Everything since `setActive(true)` is still one continuous window.
        reporter.contextChanged(to: .chat)
        clock.advance(10)
        reporter.setActive(false)
        await reporter.drainForTesting()

        let sent = await captured.allSamples
        XCTAssertEqual(
            sent.map(\.durationMs), [60_000, 10_000],
            "attention after the teardown was lost"
        )
        XCTAssertEqual(sent.map(\.kind), ["triage", "chat"])
    }

    /// A failed flush must leave the samples queued, and the NEXT flush must ship
    /// them — the "phone was offline for hours" path.
    @MainActor
    func testSamplesSurviveAFailedFlushAndGoOutOnTheNextOne() async {
        AttentionContext.shared.resetForTesting()
        defer { AttentionContext.shared.resetForTesting() }
        let clock = TestClock(now: Self.t0)
        let gate = FailureGate()
        let captured = SampleRecorder()
        let reporter = TimeHeartbeatReporter(
            store: TimeSampleStore(fileURL: tempFileURL()),
            sender: { samples in
                if await gate.failing {
                    throw APIError.server(
                        status: 503, code: "unavailable", message: "replica offline",
                        serverHash: nil, serverContent: nil
                    )
                }
                await captured.record(samples)
            },
            clock: { clock.now }
        )

        reporter.setActive(true)
        clock.advance(25)
        reporter.setActive(false)
        await reporter.drainForTesting()
        let nothingSent = await captured.batches
        XCTAssertEqual(nothingSent.count, 0)
        let queued = await reporter.queuedSampleCount()
        XCTAssertEqual(queued, 1)

        await gate.recover()
        clock.advance(60)
        reporter.setActive(true)           // foreground → drain the backlog
        await reporter.drainForTesting()

        let sent = await captured.allSamples
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.durationMs, 25_000)
        let afterDrain = await reporter.queuedSampleCount()
        XCTAssertEqual(afterDrain, 0)
    }
}

// MARK: - Live E2E (opt-in)

/// The whole chain with NOTHING mocked: the real session page claims the lane, the
/// real reporter banks the window, the real `WalnutAPI` POSTs it to a real server,
/// and the queue is only cleared if that server answered 204.
///
/// Opt-in because it needs a server. Point it at an EPHEMERAL one (never :3456):
///
/// ```
/// xcodebuild test -only-testing:WalnutTests/TimeHeartbeatLiveTests \
///   -destination "platform=iOS Simulator,id=<udid>" \
///   TEST_RUNNER_WALNUT_TIME_E2E_URL=http://localhost:<port> \
///   TEST_RUNNER_WALNUT_TIME_E2E_TASK=<taskId>
/// ```
///
/// `xcodebuild` strips the `TEST_RUNNER_` prefix and hands the rest to the app
/// process, which is why the values arrive as plain environment variables here.
final class TimeHeartbeatLiveTests: XCTestCase {

    @MainActor
    func testAttentionOnASessionPageReachesTheServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["WALNUT_TIME_E2E_URL"], !base.isEmpty else {
            throw XCTSkip("set WALNUT_TIME_E2E_URL to an ephemeral server to run the live heartbeat E2E")
        }
        let taskId = env["WALNUT_TIME_E2E_TASK"] ?? "t_live_e2e"
        let sessionId = env["WALNUT_TIME_E2E_SESSION"] ?? "claude-live-e2e"

        // Configure the REAL client. AppConfig reads the URL from UserDefaults and
        // (in DEBUG) the token from the same place, which is the documented
        // harness hook — see AppConfig.token.
        let defaults = UserDefaults.standard
        let previousURL = defaults.string(forKey: "walnut.serverUrl")
        defaults.set(base, forKey: "walnut.serverUrl")
        defaults.set("e2e-heartbeat-token", forKey: "walnut.deviceToken")
        AppConfig.resetTokenCacheForTesting()
        defer {
            if let previousURL { defaults.set(previousURL, forKey: "walnut.serverUrl") }
            else { defaults.removeObject(forKey: "walnut.serverUrl") }
            defaults.removeObject(forKey: "walnut.deviceToken")
            AppConfig.resetTokenCacheForTesting()
        }

        let context = AttentionContext.shared
        context.resetForTesting()
        defer { context.resetForTesting() }
        context.setBase(.triage)

        // No injected sender: this goes out over HTTP through WalnutAPI.
        let queueURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("walnut-time-live-\(UUID().uuidString).json")
        let reporter = TimeHeartbeatReporter(store: TimeSampleStore(fileURL: queueURL))

        // The claim comes from the product view, not from the test.
        let session = WalnutSession(
            id: sessionId, title: "Live E2E", taskId: taskId, taskTitle: nil, project: nil,
            host: "", processStatus: "idle", model: nil, mode: nil,
            startedAt: "2026-08-29T00:00:00Z", lastActiveAt: "2026-08-29T00:00:00Z",
            messageCount: 0, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
        let host = UIHostingController(rootView: NavigationStack {
            SessionConversationView(session: session, store: SessionConversationStore(session: session))
        })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(context.current.sessionId, sessionId, "the page must own attention before the clock starts")

        reporter.setActive(true)
        // Earn a window comfortably over the 1s floor.
        RunLoop.current.run(until: Date().addingTimeInterval(2.5))
        reporter.setActive(false) // = backgrounding: close the window and flush
        await reporter.drainForTesting()

        // Cleared only on a 204 — a 503 or any other answer keeps them queued.
        let leftover = await reporter.queuedSampleCount()
        XCTAssertEqual(leftover, 0, "the server did not accept the batch (samples were kept, as designed)")
        print("[time-e2e] banked session attention for task \(taskId) via \(base)")

        window.rootViewController = nil
        window.isHidden = true
    }
}

// MARK: - Test doubles

/// Records what the transport was handed. An actor because the sender is called
/// from inside the store actor.
private actor SampleRecorder {
    var batches: [[TimeHeartbeatSample]] = []
    var allSamples: [TimeHeartbeatSample] { batches.flatMap { $0 } }
    func record(_ batch: [TimeHeartbeatSample]) { batches.append(batch) }
}

/// Flips a sender from failing to succeeding.
private actor FailureGate {
    var failing = true
    func recover() { failing = false }
}

/// Drives a hosted `.attentionContext(...)` whose ids change while it is on
/// screen — the "the task id arrived late" case.
@MainActor
private final class AttentionTargetBox: ObservableObject {
    @Published var taskId: String?
}

private struct AttentionRefreshProbe: View {
    @ObservedObject var box: AttentionTargetBox

    var body: some View {
        Color.clear
            .attentionContext(.session(id: "claude-refresh", taskId: box.taskId))
    }
}

/// Injected clock — a test must never race the wall clock.
private final class TestClock: @unchecked Sendable {
    private(set) var now: Date
    init(now: Date) { self.now = now }
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}
