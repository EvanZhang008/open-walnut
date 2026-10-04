import XCTest
@testable import Walnut

/// The session page's stream storm and flicker (2026-09-26 field evidence: a
/// heavy session open on the phone, 140-147 `fresh=1&rich=1` transcript reads
/// within 1-3 s six times in eleven minutes, each burst followed by a bridge
/// teardown; and an "unreachable" banner plus a locked composer on every ~1.3 s
/// bridge redial). See SessionStreamGate.swift for the design.
///
/// Every timer runs on `ManualStreamClock`, so a 5-minute outage takes
/// milliseconds and every threshold is asserted on both sides.
final class SessionStreamStormTests: XCTestCase {

    // MARK: - Fixtures

    /// One SSE frame as SSEClient delivers it.
    private static func frame(
        _ id: Int?, _ event: String, _ data: String = "{}",
        conn: UInt64 = 1, resumed: Bool = false, reconnect: Bool = false
    ) -> SSEEvent {
        var e = SSEEvent(id: id.map(String.init), event: event, data: data)
        e.connection = conn
        e.resumed = resumed
        e.reconnect = reconnect
        return e
    }

    private static func restamp(_ e: SSEEvent, conn: UInt64, resumed: Bool, reconnect: Bool = false) -> SSEEvent {
        var copy = e
        copy.connection = conn
        copy.resumed = resumed
        copy.reconnect = reconnect
        return copy
    }

    /// The replica's never-reset ring, shaped like the field one: turn-ends,
    /// bridge offline/online pairs from a flapping bridge, status and deltas.
    /// `endsOffline` makes its LAST bridge event an offline whose online was
    /// never recorded (the stale state the attach frame contradicts).
    private static func replicaRing(from base: Int, count: Int = 512, endsOffline: Bool = false) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for i in 0..<count {
            let id = base + i
            let kind: (String, String)
            switch i % 7 {
            case 0: kind = ("status", #"{"processStatus":"running"}"#)
            case 1: kind = ("text-delta", #"{"delta":"Checking the rollout. "}"#)
            case 2: kind = ("turn-end", "{}")
            case 3: kind = ("status", #"{"processStatus":"idle"}"#)
            case 4: kind = ("bridge-offline", "{}")
            case 5: kind = ("bridge-online", "{}")
            default: kind = ("turn-end", "{}")
            }
            out.append(frame(id, kind.0, kind.1))
        }
        // Keep the pairs balanced unless asked: drop a trailing unmatched offline.
        if !endsOffline, out.last?.event == "bridge-offline" { out.removeLast() }
        if endsOffline { out.append(frame(base + count, "bridge-offline")) }
        return out
    }

    /// A field-density transcript (6:2:2 assistant/tool/user, CJK prose,
    /// tables, code), the shape the heavy session's page reconciles.
    private static func denseTranscript(rows: Int = 400, extra: [SessionTranscript.Message] = []) -> SessionTranscript {
        let base = TranscriptFixtures.transcript(count: rows, profile: .mixed).enumerated().map { i, m in
            SessionTranscript.Message(
                role: m.role, text: m.text,
                timestamp: String(format: "2026-09-26T10:%02d:%02d.000Z", (i / 60) % 60, i % 60),
                kind: m.kind
            )
        }
        return SessionTranscript(sessionId: "storm", exportedAt: "2026-09-26T11:00:00Z",
                                 truncated: false, messages: base + extra)
    }

    @MainActor
    private func openedStore(
        _ id: String, dense: Bool = true, resumeIDs: SessionStreamResumeIDs? = nil
    ) async -> (SessionConversationStore, MockSessionSendTransport, ManualStreamClock) {
        let transport = MockSessionSendTransport()
        if dense { transport.transcript = Self.denseTranscript() }
        let clock = ManualStreamClock()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: id), transport: transport, clock: clock,
            resumeIDs: resumeIDs ?? SessionStreamResumeIDs(defaults: nil)
        )
        await store.open()
        return (store, transport, clock)
    }

    private func freshReads(_ t: MockSessionSendTransport) -> [MockSessionSendTransport.TranscriptRead] {
        t.transcriptReads.filter(\.fresh)
    }

    // MARK: - SSEClient: Last-Event-ID

    func testTheStreamRequestCarriesLastEventIDOnlyWhenThereIsOne() throws {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:9/api/v1/sessions/s-1/stream"))
        let resumed = SSEClient.streamRequest(url: url, token: "t", resumeFrom: "4211")
        XCTAssertEqual(resumed.value(forHTTPHeaderField: "Last-Event-ID"), "4211")
        XCTAssertEqual(resumed.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        let fresh = SSEClient.streamRequest(url: url, token: "t", resumeFrom: nil)
        XCTAssertNil(fresh.value(forHTTPHeaderField: "Last-Event-ID"))
    }

    func testASeededClientResumesItsFirstConnectionFromTheSeed() throws {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:9/api/v1/sessions/s-1/stream"))
        let seeded = SSEClient(url: url, token: "t", lastEventID: "77",
                               onEvent: { _ in }, onConnectionChange: { _ in })
        XCTAssertEqual(seeded.resumeEventID, "77",
                       "a client built for a page re-open must not ask for the whole ring")
        let unseeded = SSEClient(url: url, token: "t", onEvent: { _ in }, onConnectionChange: { _ in })
        XCTAssertNil(unseeded.resumeEventID)
    }

    // MARK: - Replay gate (pure)

    func testAReplayThatReachesTheAnchorIsDroppedAndNewerFramesApply() {
        var gate = SessionStreamReplayGate(lastAppliedID: 100)
        var applied: [SSEEvent] = []
        for id in 60...100 {
            applied += gate.admit(Self.frame(id, "turn-end", conn: 2, resumed: true), now: 0)
        }
        XCTAssertTrue(applied.isEmpty, "a server that ignored Last-Event-ID replayed \(applied.count) old frames into the page")
        XCTAssertTrue(gate.held.isEmpty, "reaching the anchor proves the held frames were replay")
        applied += gate.admit(Self.frame(101, "turn-end", conn: 2, resumed: true), now: 0.1)
        applied += gate.admit(Self.frame(102, "status", conn: 2, resumed: true), now: 0.1)
        XCTAssertEqual(applied.compactMap(\.id), ["101", "102"])
        XCTAssertEqual(gate.lastAppliedID, 102)
    }

    func testARestartedServersFramesAreReleasedInOrderAfterTheWindow() {
        var gate = SessionStreamReplayGate(lastAppliedID: 90_000)
        var applied: [SSEEvent] = []
        applied += gate.admit(Self.frame(nil, "bridge-online", conn: 2, resumed: true), now: 0)
        for id in [3, 5, 8] {
            applied += gate.admit(Self.frame(id, "turn-end", conn: 2, resumed: true), now: 0.1)
        }
        XCTAssertEqual(applied.map(\.event), ["bridge-online"], "held, not dropped, not yet applied")
        XCTAssertTrue(gate.expire(now: 0.1 + SessionStreamReplayGate.restartWindow - 0.01).isEmpty)
        let released = gate.expire(now: 0.1 + SessionStreamReplayGate.restartWindow)
        XCTAssertEqual(released.compactMap(\.id), ["3", "5", "8"], "a restart must not silence the page")
        XCTAssertEqual(gate.lastAppliedID, 8, "the anchor rebases onto the new id space")
        XCTAssertEqual(gate.admit(Self.frame(9, "turn-end", conn: 2, resumed: true), now: 3).compactMap(\.id), ["9"])
    }

    func testAFullRingBelowTheAnchorIsARestartWithoutWaiting() {
        var gate = SessionStreamReplayGate(lastAppliedID: 1_000_000)
        var applied: [SSEEvent] = []
        for id in 1...SessionStreamReplayGate.ringMax {
            applied += gate.admit(Self.frame(id, "status", conn: 2, resumed: true), now: 0)
        }
        XCTAssertEqual(applied.count, SessionStreamReplayGate.ringMax,
                       "a replay holds at most one ring below the anchor; a full ring without it is new")
    }

    func testHeldFramesAreReleasedWhenTheirConnectionEnds() {
        var gate = SessionStreamReplayGate(lastAppliedID: 50_000)
        _ = gate.admit(Self.frame(4, "turn-end", conn: 2, resumed: true), now: 0)
        let next = gate.admit(Self.frame(nil, "bridge-online", conn: 3, resumed: true), now: 0.5)
        XCTAssertEqual(next.map(\.event), ["turn-end", "bridge-online"], "held first, in order")
    }

    func testAPrimaryStreamPassesThroughUntouched() {
        var gate = SessionStreamReplayGate(lastAppliedID: 500)
        var applied = gate.admit(Self.frame(nil, "snapshot", conn: 1), now: 0)
        for id in [120, 121, 122] { applied += gate.admit(Self.frame(id, "text-delta", conn: 1), now: 0) }
        XCTAssertEqual(applied.count, 4, "the primary's snapshot + turn replay is already exact")
        XCTAssertNil(gate.lastAppliedID, "a primary id must never become a cloud resume point")
    }

    func testAFirstConnectionsStaleOfflineIsDroppedButALateOneApplies() {
        var gate = SessionStreamReplayGate()
        var applied = gate.admit(Self.frame(nil, "bridge-online", conn: 1, resumed: false), now: 0)
        applied += gate.admit(Self.frame(40, "bridge-offline", conn: 1, resumed: false), now: 0.2)
        XCTAssertEqual(applied.map(\.event), ["bridge-online"],
                       "an old offline replayed after an attach that said online is stale")
        applied += gate.admit(Self.frame(41, "bridge-online", conn: 1, resumed: false), now: 0.2)
        applied += gate.admit(Self.frame(50, "bridge-offline", conn: 1, resumed: false),
                              now: SessionStreamReplayGate.attachBurstWindow + 1)
        XCTAssertEqual(applied.compactMap(\.id), ["41", "50"], "a real outage later on is real")
    }

    func testAnAttachThatSaidOfflineKeepsALiveOffline() {
        var gate = SessionStreamReplayGate()
        var applied = gate.admit(Self.frame(nil, "bridge-offline", conn: 1), now: 0)
        applied += gate.admit(Self.frame(7, "bridge-offline", conn: 1), now: 0.1)
        XCTAssertEqual(applied.count, 2)
    }

    // MARK: - Coalescing

    /// Problem 1, the field shape: the phone applied a ring of 512 frames, the
    /// stream dropped, and on reconnect the replica replayed the whole ring.
    @MainActor
    func testAReplayOfTheWholeRingAfterAReconnectCostsAtMostOneRead() async {
        let (store, transport, clock) = await openedStore("storm-replay")
        XCTAssertEqual(freshReads(transport).count, 1, "open: one fresh read")
        let ring = Self.replicaRing(from: 1_000)
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        for f in ring { store.handle(f) }
        await clock.advance(by: 15)
        let afterLive = freshReads(transport).count
        XCTAssertLessThanOrEqual(afterLive - 1, 2,
                                 "\(ring.count) live frames with \(ring.filter { $0.event == "turn-end" }.count) turn-ends must cost one read plus at most one follow-up")

        // Reconnect: an OLD server that ignores Last-Event-ID replays everything.
        store.handle(Self.frame(nil, "bridge-online", conn: 2, resumed: true, reconnect: true))
        for f in ring {
            store.handle(Self.restamp(f, conn: 2, resumed: true, reconnect: true))
            XCTAssertEqual(store.connectionNotice, .none, "a replayed offline flipped the UI")
        }
        await clock.advance(by: 15)
        let replayReads = freshReads(transport).count - afterLive
        XCTAssertLessThanOrEqual(replayReads, 1, "a 512-frame replay cost \(replayReads) transcript reads")
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertFalse(store.bridgeDown)
        XCTAssertTrue(store.canSend)
        XCTAssertEqual(store.resumeIDForNextConnection(), 1_000 + ring.count - 1,
                       "the next connection resumes after the newest applied frame")
        store.close()
    }

    /// A first-ever open (no id to resume from): the whole ring arrives while
    /// open() is still reading. Its triggers fold into open's read, and its
    /// stale trailing offline never raises a notice.
    @MainActor
    func testAFirstOpenWithAFullRingReplayCostsAtMostOneExtraRead() async {
        let transport = MockSessionSendTransport()
        transport.transcript = Self.denseTranscript()
        let clock = ManualStreamClock()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "storm-first-open"), transport: transport, clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let hold = CheckedContinuationGate()
        transport.transcriptGate = hold
        let opening = Task { @MainActor in await store.open() }
        for _ in 0..<200 where transport.transcriptReads.isEmpty { await clock.settle() }
        XCTAssertEqual(transport.transcriptReads.count, 1, "open's cached read is in flight")

        store.handle(Self.frame(nil, "bridge-online", conn: 1, resumed: false))
        for f in Self.replicaRing(from: 7_000, endsOffline: true) { store.handle(f) }
        transport.transcriptGate = nil
        hold.open()
        await opening.value
        await clock.advance(by: 15)
        XCTAssertLessThanOrEqual(freshReads(transport).count, 2,
                                 "open's own read plus at most one for the replay: \(freshReads(transport).count)")
        XCTAssertEqual(store.connectionNotice, .none, "the ring's stale last offline raised a notice")
        XCTAssertFalse(store.bridgeDown)
        store.close()
    }

    @MainActor
    func testRapidTurnEndsCostOneReadAndOneFollowUpAtMost() async {
        let (store, transport, clock) = await openedStore("storm-rapid")
        let base = freshReads(transport).count
        for i in 0..<20 { store.handle(Self.frame(2_000 + i, "turn-end")) }
        XCTAssertEqual(freshReads(transport).count, base, "debounced: no read yet")
        let hold = CheckedContinuationGate()
        transport.transcriptGate = hold
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds)
        XCTAssertEqual(freshReads(transport).count, base + 1, "one read for the burst")
        XCTAssertTrue(store.transcriptRefreshPending, "the read is in flight")
        for i in 20..<25 { store.handle(Self.frame(2_000 + i, "turn-end")) }
        XCTAssertEqual(freshReads(transport).count, base + 1, "single flight: no parallel read")
        transport.transcriptGate = nil
        hold.open()
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds)
        XCTAssertEqual(freshReads(transport).count, base + 2, "exactly one follow-up for the dirty flag")
        await clock.advance(by: 10)
        XCTAssertEqual(freshReads(transport).count, base + 2)
        XCTAssertTrue(freshReads(transport).dropFirst(base).allSatisfy(\.rich),
                      "turn-end reads carry the rich fields")
        store.close()
    }

    @MainActor
    func testAGenuinelyNewTurnEndStillRefreshes() async {
        let (store, transport, clock) = await openedStore("storm-new-turn")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        store.handle(Self.frame(300, "status", #"{"processStatus":"idle"}"#))
        await clock.advance(by: 5)
        let base = freshReads(transport).count
        store.handle(Self.frame(301, "turn-start"))
        store.handle(Self.frame(302, "text-delta", #"{"delta":"All green."}"#))
        store.handle(Self.frame(303, "turn-end"))
        XCTAssertEqual(store.historyMessages.last?.text, "All green.", "provisional row at once")
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds - 0.01)
        XCTAssertEqual(freshReads(transport).count, base)
        await clock.advance(by: 0.01)
        XCTAssertEqual(freshReads(transport).count, base + 1, "a new turn-end must still refresh")
        store.close()
    }

    /// The Mac finished a turn while the bridge blipped: the turn's frames land
    /// right after bridge-online. One read covers both triggers, and the turn is
    /// on screen at once (provisional row) and after it (canonical row).
    @MainActor
    func testARealNewTurnDuringABlipLandsWithOneRead() async {
        let (store, transport, clock) = await openedStore("turn-in-blip")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        let base = freshReads(transport).count
        store.handle(Self.frame(90, "bridge-offline"))
        await clock.advance(by: 0.8)
        store.handle(Self.frame(91, "bridge-online"))
        store.handle(Self.frame(92, "turn-start"))
        store.handle(Self.frame(93, "text-delta", #"{"delta":"Canary is healthy."}"#))
        store.handle(Self.frame(94, "turn-end"))
        XCTAssertEqual(store.historyMessages.last?.text, "Canary is healthy.")
        transport.transcript = Self.denseTranscript(extra: [
            SessionTranscript.Message(role: "assistant", text: "Canary is healthy.",
                                      timestamp: "2026-09-26T11:06:00.000Z", kind: nil),
        ])
        await clock.advance(by: 10)
        XCTAssertEqual(freshReads(transport).count, base + 1, "bridge-online and turn-end share one read")
        XCTAssertEqual(store.historyMessages.last?.text, "Canary is healthy.")
        XCTAssertEqual(store.historyMessages.filter { $0.text == "Canary is healthy." }.count, 1,
                       "the canonical row replaced the provisional one")
        XCTAssertEqual(store.connectionNotice, .none)
        store.close()
    }

    // MARK: - Grace timers

    @MainActor
    func testABridgeBlipOfOnePointThreeSecondsNeverShowsAnything() async {
        let (store, transport, clock) = await openedStore("blip")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        let base = transport.transcriptReads.count
        store.handle(Self.frame(40, "bridge-offline"))
        XCTAssertTrue(store.bridgeDown)
        for _ in 0..<13 {
            await clock.advance(by: 0.1)
            XCTAssertEqual(store.connectionNotice, .none)
            XCTAssertTrue(store.canSend, "the composer stays enabled through a blip")
        }
        store.handle(Self.frame(41, "bridge-online"))
        await clock.advance(by: 20)
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertFalse(store.bridgeDown)
        let reads = Array(transport.transcriptReads.dropFirst(base))
        XCTAssertEqual(reads.count, 1, "one catch-up read per blip, no poll: \(reads)")
        store.close()
    }

    @MainActor
    func testATwelveSecondOutageShowsTheChipThenTheBannerThenClears() async {
        let (store, transport, clock) = await openedStore("outage-12s")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        let base = transport.transcriptReads.count
        store.handle(Self.frame(50, "bridge-offline"))
        await clock.advance(by: SessionConnectionNotice.reconnectingAfter - 0.01)
        XCTAssertEqual(store.connectionNotice, .none)
        await clock.advance(by: 0.01)
        XCTAssertEqual(store.connectionNotice, .reconnecting)
        XCTAssertFalse(store.offline, "the chip is not the banner")
        let polled = Array(transport.transcriptReads.dropFirst(base))
        XCTAssertEqual(polled.count, 1, "polling starts with the chip")
        XCTAssertTrue(polled.allSatisfy { $0.fresh && !$0.rich })
        await clock.advance(by: SessionConnectionNotice.unreachableAfter - SessionConnectionNotice.reconnectingAfter - 0.01)
        XCTAssertEqual(store.connectionNotice, .reconnecting)
        await clock.advance(by: 0.01)
        XCTAssertEqual(store.connectionNotice, .unreachable)
        XCTAssertTrue(store.offline)
        XCTAssertTrue(store.canSend, "the composer stays enabled during an outage")
        await clock.advance(by: 2)
        store.handle(Self.frame(51, "bridge-online"))
        XCTAssertEqual(store.connectionNotice, .none, "back at once, no grace on the way up")
        let beforeCatchUp = transport.transcriptReads.count
        await clock.advance(by: 30)
        let after = Array(transport.transcriptReads.dropFirst(beforeCatchUp))
        XCTAssertEqual(after.count, 1, "one catch-up read and the poll stopped: \(after)")
        XCTAssertTrue(after.allSatisfy(\.rich))
        store.close()
    }

    @MainActor
    func testAFiveMinuteOutageKeepsTheBannerAndPollsWithoutAStorm() async {
        let (store, transport, clock) = await openedStore("outage-5m")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        let base = transport.transcriptReads.count
        store.handle(Self.frame(60, "bridge-offline"))
        for _ in 0..<60 {
            await clock.advance(by: 5)
            XCTAssertNotEqual(store.connectionNotice, .none)
        }
        XCTAssertEqual(store.connectionNotice, .unreachable)
        let polled = Array(transport.transcriptReads.dropFirst(base))
        XCTAssertTrue((57...61).contains(polled.count), "one poll per 5 s over 297 s, got \(polled.count)")
        XCTAssertTrue(polled.allSatisfy { $0.fresh && !$0.rich }, "the degraded poll never pays for the rich fields")
        store.handle(Self.frame(61, "bridge-online"))
        XCTAssertEqual(store.connectionNotice, .none)
        store.close()
    }

    /// A reconnect replays old offline/online pairs (ids at or below the anchor):
    /// the page never flips.
    @MainActor
    func testReplayedOfflineOnlinePairsNeverFlipTheUI() async {
        let (store, transport, clock) = await openedStore("replayed-pairs")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        // Twenty real blips, applied live: each one is absorbed by the grace.
        var pairs: [SSEEvent] = []
        for i in 0..<20 {
            let off = Self.frame(900 + 2 * i, "bridge-offline")
            let on = Self.frame(901 + 2 * i, "bridge-online")
            pairs += [off, on]
            store.handle(off)
            await clock.advance(by: 1.3)
            XCTAssertEqual(store.connectionNotice, .none)
            store.handle(on)
        }
        await clock.advance(by: 15)
        XCTAssertEqual(store.connectionNotice, .none)
        let base = transport.transcriptReads.count

        // A reconnect to a server that ignores Last-Event-ID replays all forty.
        store.handle(Self.frame(nil, "bridge-online", conn: 2, resumed: true, reconnect: true))
        for f in pairs {
            store.handle(Self.restamp(f, conn: 2, resumed: true, reconnect: true))
            XCTAssertFalse(store.bridgeDown, "a replayed \(f.event) \(f.id ?? "-") was applied")
        }
        await clock.advance(by: 15)
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertLessThanOrEqual(transport.transcriptReads.count - base, 1,
                                 "the replayed pairs started reads")
        store.close()
    }

    // MARK: - Sends during an outage

    @MainActor
    func testASendWhileReconnectingIsAcceptedBankedAndLandsOnce() async {
        let (store, transport, clock) = await openedStore("send-reconnecting")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        store.handle(Self.frame(70, "bridge-offline"))
        await clock.advance(by: SessionConnectionNotice.reconnectingAfter)
        XCTAssertEqual(store.connectionNotice, .reconnecting)
        XCTAssertTrue(store.canSend)
        transport.answerQueued = true // the replica banks it: bridge down
        let accepted = await store.send("Ship the canary after the smoke test")
        XCTAssertTrue(accepted)
        XCTAssertEqual(transport.sendCallCount, 1, "exactly one POST")
        let bubble = store.messages.last
        XCTAssertEqual(bubble?.text, "Ship the canary after the smoke test")
        XCTAssertNotEqual(bubble?.failed, true, "a banked send is accepted, not failed")
        XCTAssertTrue(store.bridgeDown, "a BANKED 202 is not proof the bridge is back")
        await clock.advance(by: SessionConnectionNotice.unreachableAfter)
        XCTAssertEqual(store.connectionNotice, .unreachable, "the outage still shows after a banked send")

        // The bridge returns; the replica delivers the banked send; the refresh
        // brings the transcript row, which absorbs the bubble (no duplicate).
        transport.transcript = Self.denseTranscript(extra: [
            SessionTranscript.Message(role: "user", text: "Ship the canary after the smoke test",
                                      timestamp: "2026-09-26T11:05:00.000Z", kind: nil),
        ])
        store.handle(Self.frame(71, "bridge-online"))
        await clock.advance(by: 5)
        let copies = store.messages.filter { $0.text == "Ship the canary after the smoke test" }
        XCTAssertEqual(copies.count, 1, "delivered exactly once on screen")
        XCTAssertNil(copies.first?.pending, "the transcript row replaced the bubble")
        XCTAssertEqual(transport.sendCallCount, 1, "nothing was re-sent")
        store.close()
    }

    @MainActor
    func testA503RecordsTheOutageButTheBannerStillWaits() async {
        let (store, transport, clock) = await openedStore("send-503")
        transport.permanentError = APIError.server(
            status: 503, code: "bridge_offline", message: "No live bridge to this session's host",
            serverHash: nil, serverContent: nil
        )
        _ = await store.send("an image send, say")
        XCTAssertTrue(store.bridgeDown)
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertTrue(store.canSend)
        await clock.advance(by: SessionConnectionNotice.unreachableAfter)
        XCTAssertEqual(store.connectionNotice, .unreachable)
        store.close()
    }

    // MARK: - Resume id across connections

    @MainActor
    func testReturningFromTheBackgroundResumesFromTheLastAppliedID() async {
        let resumeIDs = SessionStreamResumeIDs(defaults: nil)
        let (store, transport, clock) = await openedStore("resume-id", resumeIDs: resumeIDs)
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        for id in 700...777 { store.handle(Self.frame(id, "status", #"{"processStatus":"idle"}"#)) }
        await clock.advance(by: 5)
        store.suspend()
        XCTAssertEqual(store.resumeIDForNextConnection(), 777)

        // While backgrounded, 512 NEW frames pile up; the resumed connection
        // gets exactly those (a current server honours the header).
        store.resume()
        XCTAssertEqual(store.currentStreamResumeID, "777", "the new stream sends Last-Event-ID")
        let base = freshReads(transport).count
        store.handle(Self.frame(nil, "bridge-online", conn: 3, resumed: true))
        for f in Self.replicaRing(from: 778) { store.handle(Self.restamp(f, conn: 3, resumed: true)) }
        await clock.advance(by: 15)
        let reads = freshReads(transport).count - base
        XCTAssertLessThanOrEqual(reads, 2, "resume's own read plus at most one for the 512 missed frames: \(reads)")
        XCTAssertEqual(store.connectionNotice, .none)
        store.close()

        // A NEW page for the same session (re-open) resumes too.
        let reopened = SessionConversationStore(
            session: ScriptedSSE.session(id: "resume-id"), transport: transport, clock: clock,
            resumeIDs: resumeIDs
        )
        await reopened.open()
        XCTAssertEqual(reopened.currentStreamResumeID, store.resumeIDForNextConnection().map(String.init),
                       "a page re-open must not ask for the whole ring")
        XCTAssertNotNil(reopened.currentStreamResumeID)
        reopened.close()
    }

    @MainActor
    func testAPrimaryStreamNeverResumesFromAnID() async {
        let resumeIDs = SessionStreamResumeIDs(defaults: nil)
        let (store, _, _) = await openedStore("primary-no-resume", resumeIDs: resumeIDs)
        store.handle(ScriptedSSE.snapshotEvent(megabytes: 0))
        for id in 10...20 { store.handle(Self.frame(id, "status", #"{"processStatus":"running"}"#)) }
        store.suspend()
        XCTAssertEqual(store.streamKind, .primary)
        XCTAssertNil(store.resumeIDForNextConnection(),
                     "the primary's snapshot + turn replay is exact; resuming would double the missed deltas")
        store.close()
    }

    @MainActor
    func testARestartedReplicaIsNotSilenced() async {
        let (store, transport, clock) = await openedStore("restart")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        store.handle(Self.frame(5_000, "status", #"{"processStatus":"idle"}"#))
        await clock.advance(by: 5)
        let base = freshReads(transport).count
        // The replica restarted: its ids begin again near zero.
        store.handle(Self.frame(nil, "bridge-online", conn: 2, resumed: true, reconnect: true))
        store.handle(Self.frame(3, "turn-start", conn: 2, resumed: true, reconnect: true))
        store.handle(Self.frame(4, "text-delta", #"{"delta":"Rollout finished."}"#, conn: 2, resumed: true, reconnect: true))
        store.handle(Self.frame(5, "turn-end", conn: 2, resumed: true, reconnect: true))
        XCTAssertNotEqual(store.historyMessages.last?.text, "Rollout finished.", "held until proven new")
        await clock.advance(by: SessionStreamReplayGate.restartWindow + 0.01)
        XCTAssertEqual(store.historyMessages.last?.text, "Rollout finished.",
                       "the restarted server's turn reached the page (provisional row)")
        transport.transcript = Self.denseTranscript(extra: [
            SessionTranscript.Message(role: "assistant", text: "Rollout finished.",
                                      timestamp: "2026-09-26T11:07:00.000Z", kind: nil),
        ])
        await clock.advance(by: 1)
        XCTAssertGreaterThanOrEqual(freshReads(transport).count, base + 1, "its turn-end refreshed")
        XCTAssertEqual(store.historyMessages.last?.text, "Rollout finished.", "and the canonical row landed")
        XCTAssertEqual(store.resumeIDForNextConnection(), 5, "resumes in the new id space")
        store.close()
    }

    @MainActor
    func testAnOutageOnScreenSurvivesABackgroundTrip() async {
        let (store, _, clock) = await openedStore("outage-background")
        store.handle(Self.frame(nil, "bridge-online", conn: 1))
        await clock.advance(by: 5)
        store.handle(Self.frame(80, "bridge-offline"))
        await clock.advance(by: 5)
        XCTAssertEqual(store.connectionNotice, .reconnecting)
        store.suspend()
        await clock.advance(by: 10)
        store.resume()
        await clock.settle()
        XCTAssertEqual(store.connectionNotice, .unreachable,
                       "measured from the outage's start, not from the return")
        store.handle(Self.frame(nil, "bridge-online", conn: 2, resumed: true))
        XCTAssertEqual(store.connectionNotice, .none, "the new connection's attach frame settles it")
        store.close()
    }
}

/// A `SessionStreamClock` a test moves by hand. `advance` wakes sleepers in
/// deadline order and lets the woken main-actor work run before the next one,
/// so chained timers (chip at 3 s, banner at 10 s) fire at the right instants.
final class ManualStreamClock: SessionStreamClock, @unchecked Sendable {
    private struct Sleeper {
        let id: UUID
        let deadline: TimeInterval
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: TimeInterval = 10_000
    private var sleepers: [Sleeper] = []

    func now() -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func sleep(seconds: TimeInterval) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                sleepers.append(Sleeper(id: id, deadline: current + max(0, seconds), continuation: continuation))
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            let index = sleepers.firstIndex { $0.id == id }
            let sleeper = index.map { sleepers.remove(at: $0) }
            lock.unlock()
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    @MainActor
    func advance(by seconds: TimeInterval) async {
        await settle()
        let target = now() + seconds
        while let sleeper = popDue(until: target) {
            sleeper.continuation.resume()
            await settle()
        }
        await settle()
    }

    /// The earliest sleeper due by `target` (time moves to its deadline), or nil
    /// once none is left (time moves to `target`). Synchronous: NSLock is
    /// unavailable from async contexts.
    private func popDue(until target: TimeInterval) -> Sleeper? {
        lock.lock()
        defer { lock.unlock() }
        let due = sleepers.indices
            .filter { sleepers[$0].deadline <= target + 1e-9 }
            .min { sleepers[$0].deadline < sleepers[$1].deadline }
        guard let index = due else {
            current = max(current, target)
            return nil
        }
        let sleeper = sleepers.remove(at: index)
        current = max(current, sleeper.deadline)
        return sleeper
    }

    /// Let queued main-actor work and the mock transport's hops finish.
    @MainActor
    func settle() async {
        for _ in 0..<6 {
            for _ in 0..<8 { await Task.yield() }
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
}
