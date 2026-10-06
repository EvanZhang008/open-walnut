import XCTest
@testable import Walnut

/// Load earlier on a session page, and the merge rules that keep paged rows.
///
/// The 2026-10-04 report: the page folds a turn's tool calls into one line, so a
/// busy session's ~100-entry tail, cut again to 150 rows, was a few lines, and
/// scrolling up ended at a folded run with the user's own messages nowhere
/// above it. Nothing could reach them. These cases drive the REAL store against
/// a fake server that pages one conversation the way the route does.
@MainActor
final class SessionTranscriptPagingTests: XCTestCase {
    typealias Message = SessionTranscript.Message

    // MARK: - Fixtures

    private static let base = Date(timeIntervalSince1970: 1_791_100_000)
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func iso(_ second: Int) -> String {
        Self.formatter.string(from: Self.base.addingTimeInterval(TimeInterval(second)))
    }

    /// The reported shape: one ask, then turns of `calls` tool calls closed by a
    /// line of prose. One row per second, so a row's index is its time.
    private func conversation(turns: Int, calls: Int, from start: Int = 0) -> [Message] {
        var rows: [Message] = []
        var t = start
        if start == 0 {
            rows.append(Message(role: "user", text: "Clean up the orphaned records.", timestamp: iso(t), kind: nil))
            t += 1
        }
        for turn in 0..<turns {
            for call in 0..<calls {
                rows.append(Message(role: "assistant", text: "Bash", timestamp: iso(t), kind: "tool",
                                    detail: "step \(t) of turn \(turn).\(call)"))
                t += 1
            }
            rows.append(Message(role: "assistant", text: "Turn ending at \(t).", timestamp: iso(t), kind: nil))
            t += 1
        }
        return rows
    }

    /// A server over one conversation, answering page reads like the route:
    /// the newest 100 rows, reaching back for `visible` text rows or to `since`,
    /// never past 600, and only rows strictly older than `before`.
    final class FakeServer {
        var rows: [Message]
        var pageable: Bool? = true
        /// What a rich answer says about its rows; `false` is a replica's fallback read.
        var rich: Bool? = nil
        init(_ rows: [Message]) { self.rows = rows }

        func answer(_ read: MockSessionSendTransport.PageRead) -> SessionTranscript {
            var end = rows.count
            if let before = read.before { while end > 0, rows[end - 1].timestamp >= before { end -= 1 } }
            var start = max(0, end - 100)
            let floor = max(0, end - 600)
            if read.visible > 0 {
                var seen = 0
                var i = end - 1
                while i >= floor {
                    if rows[i].kind == nil { seen += 1 }
                    if seen >= read.visible { break }
                    i -= 1
                }
                start = min(start, max(i, floor))
            }
            if let since = read.since { while start > floor, rows[start - 1].timestamp >= since { start -= 1 } }
            return SessionTranscript(sessionId: "paging", exportedAt: "x", truncated: start > 0,
                                     messages: Array(rows[start..<end]), pageable: pageable, rich: rich)
        }

        /// The cached first-phase read: the exported newest tail, slim, unpageable.
        var exported: SessionTranscript {
            SessionTranscript(sessionId: "paging", exportedAt: "x", truncated: rows.count > 100,
                              messages: Array(rows.suffix(100)))
        }
    }

    private func openedStore(_ server: FakeServer, pinned: Bool = true)
        async -> (SessionConversationStore, MockSessionSendTransport, ManualStreamClock) {
        let transport = MockSessionSendTransport()
        transport.transcript = server.exported
        transport.pages = { server.answer($0) }
        let clock = ManualStreamClock()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "paging-\(UUID().uuidString)"), transport: transport,
            clock: clock, resumeIDs: SessionStreamResumeIDs(defaults: nil))
        await store.open()
        store.bottomPinned = pinned
        return (store, transport, clock)
    }

    private func key(_ m: ChatMessage) -> String { "\(m.createdAt)|\(m.text)|\(m.detail ?? "")" }
    private func key(_ m: Message) -> String { "\(m.timestamp)|\(m.text)|\(m.detail ?? "")" }

    // MARK: - The path

    func testThePagePathCarriesItsCursorsAndEscapesAnOffset() {
        XCTAssertEqual(WalnutAPI.sessionTranscriptPagePath(id: "s-1", before: nil, since: nil, visible: 20),
                       "/sessions/s-1/transcript?fresh=1&rich=1&visible=20")
        let older = WalnutAPI.sessionTranscriptPagePath(
            id: "s-1", before: "2026-10-04T10:00:00.000+02:00", since: nil, visible: 20)
        XCTAssertTrue(older.hasSuffix("&before=2026-10-04T10%3A00%3A00.000%2B02%3A00"), older)
        XCTAssertEqual(WalnutAPI.sessionTranscriptPagePath(id: "s-1", before: nil,
                                                           since: "2026-10-04T10:00:00Z", visible: 0),
                       "/sessions/s-1/transcript?fresh=1&rich=1&since=2026-10-04T10%3A00%3A00Z")
    }

    func testAnOlderServerDecodesWithoutTheFlag() throws {
        let json = #"{"sessionId":"s","exportedAt":"x","truncated":true,"messages":[]}"#
        let t = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertNil(t.pageable)
        let paged = try JSONDecoder().decode(SessionTranscript.self, from: Data(
            #"{"sessionId":"s","exportedAt":"x","truncated":true,"messages":[],"pageable":true}"#.utf8))
        XCTAssertEqual(paged.pageable, true)
    }

    // MARK: - Opening

    func testABusySessionOpensWithTwentyLinesOfTextAndOffersMore() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, _) = await openedStore(server)
        XCTAssertEqual(transport.pageReads.first,
                       MockSessionSendTransport.PageRead(before: nil, since: nil, visible: 20))
        let text = store.messages.filter { $0.kind == nil }
        XCTAssertEqual(text.count, 20, "the first page reaches back to twenty lines a reader sees")
        // 20 turns of 20 calls is 400 rows but only 39 timeline parts: the old
        // 150-row cap would have cut it back to seven turns.
        XCTAssertGreaterThan(store.messages.count, 150)
        XCTAssertTrue(store.showsLoadEarlier)
        XCTAssertEqual(store.loadEarlierState, .ready)
        store.close()
    }

    func testAServerThatDoesNotPageShowsNoRow() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        server.pageable = nil
        let (store, _, _) = await openedStore(server)
        XCTAssertTrue(store.olderExists, "older rows exist")
        XCTAssertFalse(store.showsLoadEarlier, "an older server or a replica offers no row")
        store.close()
    }

    func testAReplicaFallbackKeepsTheRowAndARichAnswerWithoutTheFlagDropsIt() async {
        // The phone on the cloud companion: its reads are relayed to the Mac, and
        // when one cannot reach it the companion answers from its own copy
        // (`rich: false`, no `pageable`). That says nothing about paging.
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, clock) = await openedStore(server, pinned: false)
        XCTAssertTrue(store.showsLoadEarlier)
        server.pageable = nil
        server.rich = false
        let reads = transport.pageReads.count
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        await clock.advance(by: 2)
        XCTAssertGreaterThan(transport.pageReads.count, reads, "the turn end refetched")
        XCTAssertTrue(store.showsLoadEarlier, "a fallback read keeps the row")
        // A rich answer without the flag is a server that does not page.
        server.rich = true
        let again = transport.pageReads.count
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        await clock.advance(by: 2)
        XCTAssertGreaterThan(transport.pageReads.count, again)
        XCTAssertFalse(store.showsLoadEarlier)
        store.close()
    }

    func testAConversationThatFitsShowsNoRow() async {
        let server = FakeServer(conversation(turns: 3, calls: 5))
        let (store, _, _) = await openedStore(server)
        XCTAssertEqual(store.messages.first?.text, "Clean up the orphaned records.")
        XCTAssertFalse(store.showsLoadEarlier)
        store.close()
    }

    // MARK: - Load earlier

    func testLoadEarlierWalksBackToTheOpeningAskWithNothingTwice() async {
        let all = conversation(turns: 60, calls: 20)
        let server = FakeServer(all)
        let (store, transport, _) = await openedStore(server, pinned: false)
        var cursors: [String] = []
        for _ in 0..<20 where store.showsLoadEarlier {
            cursors.append(store.historyMessages.first!.createdAt)
            await store.loadEarlier()
        }
        XCTAssertFalse(store.showsLoadEarlier, "the row goes away at the start")
        XCTAssertEqual(store.messages.first?.text, "Clean up the orphaned records.")
        XCTAssertEqual(store.messages.map { key($0) }, all.map { key($0) },
                       "every row once, in order")
        XCTAssertEqual(Set(store.messages.map(\.id)).count, store.messages.count)
        XCTAssertEqual(transport.pageReads.dropFirst().map(\.before), cursors.map { Optional($0) },
                       "each page asks for what is older than the oldest row held")
        XCTAssertEqual(Set(transport.pageReads.dropFirst().map(\.visible)),
                       [SessionConversationStore.pageVisibleRows], "a page is a bigger read than the open")
        store.close()
    }

    func testLoadEarlierIsOneReadAtATime() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, _) = await openedStore(server, pinned: false)
        let gate = CheckedContinuationGate()
        transport.pageGate = gate
        let first = Task { await store.loadEarlier() }
        for _ in 0..<20 where !store.loadingEarlier { await Task.yield() }
        XCTAssertEqual(store.loadEarlierState, .loading)
        await store.loadEarlier() // a second tap while the first is in flight
        XCTAssertEqual(transport.pageReads.filter { $0.before != nil }.count, 1)
        gate.open()
        await first.value
        XCTAssertEqual(store.loadEarlierState, .ready)
        store.close()
    }

    func testAFailedPageLeavesARetryThatWorks() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, _) = await openedStore(server, pinned: false)
        let before = store.messages.count
        transport.pageError = APIError.server(status: 503, code: "page_unavailable",
                                              message: "The session could not be read right now",
                                              serverHash: nil, serverContent: nil)
        await store.loadEarlier()
        XCTAssertEqual(store.loadEarlierState, .failed)
        XCTAssertTrue(store.showsLoadEarlier, "a failure keeps the row, as a retry")
        XCTAssertEqual(store.messages.count, before)
        transport.pageError = nil
        await store.loadEarlier()
        XCTAssertEqual(store.loadEarlierState, .ready)
        XCTAssertGreaterThan(store.messages.count, before)
        store.close()
    }

    func testAServerThatStopsPagingRemovesTheRow() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, _) = await openedStore(server, pinned: false)
        transport.pageError = APIError.server(status: 409, code: "page_unavailable",
                                              message: "Older pages are served by the Mac only",
                                              serverHash: nil, serverContent: nil)
        await store.loadEarlier()
        XCTAssertFalse(store.showsLoadEarlier)
        XCTAssertEqual(store.loadEarlierState, .ready)
        store.close()
    }

    func testAPageForAHeadThatMovedIsDropped() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, _) = await openedStore(server, pinned: false)
        let gate = CheckedContinuationGate()
        transport.pageGate = gate
        let load = Task { await store.loadEarlier() }
        for _ in 0..<20 where !store.loadingEarlier { await Task.yield() }
        // A reconcile replaced the head while the page was in flight: a window
        // that does not reach what is held replaces it.
        let later = conversation(turns: 1, calls: 5, from: server.rows.count)
        store.reconcile(SessionTranscript(sessionId: "paging", exportedAt: "x", truncated: true,
                                          messages: later, pageable: true))
        let head = store.historyMessages.first?.createdAt
        XCTAssertEqual(head, later.first?.timestamp)
        gate.open()
        await load.value
        XCTAssertEqual(store.historyMessages.first?.createdAt, head, "the stale page was not prepended")
        store.close()
    }

    // MARK: - Refetches keep what was paged

    func testATurnEndAfterPagingRefetchesFromTheNewestRowAndLeavesNoHole() async {
        let server = FakeServer(conversation(turns: 60, calls: 20))
        let (store, transport, clock) = await openedStore(server, pinned: false)
        await store.loadEarlier()
        let oldest = store.historyMessages.first!.createdAt
        let newestHeld = store.historyMessages.last!.createdAt
        // A turn of 150 calls lands: longer than the default tail, so a plain
        // tail would start inside it and its head would be a hole.
        server.rows += conversation(turns: 1, calls: 150, from: server.rows.count)
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        await clock.advance(by: 2)
        XCTAssertEqual(transport.pageReads.last?.since, newestHeld)
        let expected = server.rows.filter { $0.timestamp >= oldest }
        XCTAssertEqual(store.messages.map { key($0) }, expected.map { key($0) },
                       "the paged rows stay, the new turn is whole, nothing in between is lost")
        XCTAssertTrue(store.showsLoadEarlier)
        store.close()
    }

    func testRowsTheReaderLoadedStayWhileTheyReadThemPastTheCap() async {
        // 401 turns of one call and a line: 803 parts, twice the unpinned cap.
        let all = conversation(turns: 401, calls: 1)
        let server = FakeServer(all)
        let (store, _, clock) = await openedStore(server, pinned: false)
        for _ in 0..<60 where store.showsLoadEarlier { await store.loadEarlier() }
        XCTAssertEqual(store.messages.count, all.count)
        // A turn ends while they read the opening ask at the top.
        server.rows += conversation(turns: 1, calls: 3, from: server.rows.count)
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        await clock.advance(by: 2)
        XCTAssertEqual(store.messages.first?.text, "Clean up the orphaned records.",
                       "the rows on screen were not trimmed away")
        XCTAssertEqual(store.messages.count, server.rows.count)
        // Back at the bottom, the next refetch trims to the usual cap.
        store.bottomPinned = true
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        await clock.advance(by: 2)
        XCTAssertLessThan(store.messages.count, all.count)
        XCTAssertTrue(store.showsLoadEarlier, "and what it cut is one Load earlier away")
        store.close()
    }

    func testAWindowThatDoesNotReachWhatIsHeldReplacesIt() {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "paging-gap"),
                                             transport: MockSessionSendTransport())
        let all = conversation(turns: 4, calls: 100)
        store.reconcile(SessionTranscript(sessionId: "p", exportedAt: "x", truncated: true,
                                          messages: Array(all[0..<50]), pageable: true))
        // Starts long after the newest held row: stitching would hide the gap.
        let late = Array(all[300...])
        store.reconcile(SessionTranscript(sessionId: "p", exportedAt: "x", truncated: true,
                                          messages: late, pageable: true))
        XCTAssertEqual(store.messages.map { key($0) }, late.map { key($0) })
        XCTAssertTrue(store.olderExists)
    }

    // MARK: - Pure rules

    func testRowsAtTheWindowsFirstTimestampThatItCutOffSurvive() {
        let t = iso(5)
        func row(_ text: String, _ ts: String, kind: ChatMessage.Kind? = nil) -> ChatMessage {
            ChatMessage(id: "", role: "assistant", text: text, createdAt: ts, kind: kind)
        }
        let held = [row("a", iso(4)), row("b", t), row("c", t, kind: .tool), row("d", t)]
        // The window starts at the run's last row; a slim/rich payload difference
        // must not make a covered row look cut off.
        let covered = ChatMessage(id: "", role: "assistant", text: "d", createdAt: t, kind: nil,
                                  thinkingText: "rich payload")
        let kept = SessionConversationStore.rowsBefore(t, held: held, incoming: [covered, row("e", iso(6))])
        XCTAssertEqual(kept.map(\.text), ["a", "b", "c"])
    }

    func testTheRenderCapCountsWhatTheReaderSees() {
        let runs = conversation(turns: 10, calls: 80).map {
            ChatMessage(id: "", role: $0.role, text: $0.text, createdAt: $0.timestamp,
                        kind: $0.kind == "tool" ? .tool : nil, detail: $0.detail)
        }
        // 811 rows, 21 parts: nothing to cut.
        XCTAssertEqual(SessionConversationStore.renderStart(runs, maxParts: 150, maxRows: 1_500), 0)
        // 300 lines of prose are 300 parts: keep the newest 150.
        let prose = (0..<300).map { ChatMessage(id: "", role: "assistant", text: "line \($0)",
                                                createdAt: iso($0), kind: nil) }
        XCTAssertEqual(SessionConversationStore.renderStart(prose, maxParts: 150, maxRows: 1_500), 150)
        // A cut never lands inside a run: the newest two parts are the last run
        // and its prose, and the run is kept whole.
        let start = SessionConversationStore.renderStart(runs, maxParts: 2, maxRows: 1_500)
        XCTAssertEqual(runs[start].kind, .tool)
        XCTAssertNotEqual(runs[start - 1].kind, .tool)
        // The row ceiling holds however few parts there are.
        XCTAssertEqual(SessionConversationStore.renderStart(runs, maxParts: 150, maxRows: 100), runs.count - 100)
    }

    func testTheRenderCapDoesNotSplitASharedTimestamp() {
        let rows = (0..<200).map { i in
            ChatMessage(id: "", role: "assistant", text: "line \(i)",
                        createdAt: iso(i >= 48 && i <= 52 ? 50 : i), kind: nil)
        }
        // The plain cut (index 50) sits inside the run 48...52; move past it.
        XCTAssertEqual(SessionConversationStore.renderStart(rows, maxParts: 150, maxRows: 1_500), 53)
    }

    func testAPinnedReaderIsTrimmedAndTheRowComesBack() {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "paging-trim"),
                                             transport: MockSessionSendTransport())
        let prose = (0..<300).map { Message(role: "assistant", text: "line \($0)", timestamp: iso($0), kind: nil) }
        store.reconcile(SessionTranscript(sessionId: "p", exportedAt: "x", truncated: false,
                                          messages: prose, pageable: true))
        XCTAssertEqual(store.messages.count, SessionConversationStore.pinnedRenderParts)
        XCTAssertTrue(store.olderExists, "what the cap cut is one Load earlier away")
    }
}
