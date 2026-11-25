import SwiftUI
import XCTest
@testable import Walnut

/// The developer switch `ui.show_hidden_lines` (2026-11-25, the user: a developer setting that
/// shows what Walnut hides, on by default for him, folded when shown): a reply's `hidden` lines
/// draw as one closed "Hidden by Walnut" row under it only while the switch is on, open on a tap,
/// and Settings › Advanced writes the switch back to the server.
@MainActor
final class HiddenLinesFoldTests: XCTestCase {
    private let builder = TimelineRowBuilder()

    private func reply(_ text: String = "The fix is live.", hidden: String? = "FOR_USER_STATE: answered") -> ChatMessage {
        var message = ChatMessage(id: "a1", role: "assistant", text: text, createdAt: "2026-11-25T01:00:00Z", kind: nil)
        message.hidden = hidden
        return message
    }

    private func foldIDs(_ rows: [TimelineRow]) -> [String] {
        rows.map(\.id).filter { $0.contains("#hidden") }
    }

    func testTheRowDecodesItsHiddenLinesAndAnOlderRowHasNone() throws {
        let json = #"[{"id":"m0","role":"assistant","text":"Done.","createdAt":"2026-11-25T01:00:00Z","hidden":"FOR_USER_STATE: working"},{"id":"m1","role":"assistant","text":"Done.","createdAt":"2026-11-25T01:00:00Z"}]"#
        let rows = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        XCTAssertEqual(rows[0].hidden, "FOR_USER_STATE: working")
        XCTAssertNil(rows[1].hidden)
    }

    func testTheServerResolvesTheSwitchAndAnOlderServerSaysNothing() throws {
        let on = try JSONDecoder().decode(ServerConfigInfo.UI.self, from: Data(#"{"show_walnut_additions":false,"show_hidden_lines":true}"#.utf8))
        XCTAssertEqual(on.showHiddenLines, true)
        let older = try JSONDecoder().decode(ServerConfigInfo.UI.self, from: Data(#"{"show_walnut_additions":true}"#.utf8))
        XCTAssertNil(older.showHiddenLines)
    }

    /// The real path: the transcript's JSON decodes into `SessionTranscript.Message`, and the
    /// store turns it into the timeline's row. A field only `ChatMessage` had would never reach it.
    func testATranscriptRowCarriesItsHiddenLinesThroughTheStore() async throws {
        let json = #"{"sessionId":"hid","exportedAt":"2026-11-25T00:00:00Z","truncated":false,"messages":[{"role":"user","text":"Go","timestamp":"2026-11-25T00:00:00Z"},{"role":"assistant","text":"Done.","timestamp":"2026-11-25T00:00:01Z","hidden":"FOR_USER_STATE: done"}]}"#
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertEqual(transcript.messages.last?.hidden, "FOR_USER_STATE: done")
        let transport = MockSessionSendTransport()
        transport.transcript = transcript
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "hid-store"), transport: transport)
        await store.open()
        defer { store.close() }
        let reply = try XCTUnwrap(store.messages.last { $0.role == "assistant" })
        XCTAssertEqual(reply.hidden, "FOR_USER_STATE: done")
        XCTAssertEqual(reply.replacingText("x").hidden, "FOR_USER_STATE: done", "a fold's copy keeps it")
    }

    func testOffDrawsNothingOnOneClosedRowOpenTheLines() {
        let off = builder.rows(for: reply(), width: 390, expandedRowIDs: [])
        XCTAssertEqual(foldIDs(off), [], "off: the reply reads as before")

        let closed = builder.rows(for: reply(), width: 390, expandedRowIDs: [], showHiddenLines: true)
        XCTAssertEqual(foldIDs(closed).count, 1, "on: one row under the words")
        guard case .toolRun(let phrase, _, _, let expanded, _)? = closed.last?.content else { return XCTFail("not a fold row") }
        XCTAssertEqual(phrase, "Hidden by Walnut")
        XCTAssertFalse(expanded, "closed until tapped")

        let id = foldIDs(closed)[0]
        let open = builder.rows(for: reply(), width: 390, expandedRowIDs: [id], showHiddenLines: true)
        XCTAssertEqual(foldIDs(open), [id, "\(id)#0"], "open: the lines under the row")
        guard case .text(let text)? = open.last?.content else { return XCTFail("the lines are not a text row") }
        XCTAssertTrue(text.string.contains("FOR_USER_STATE: answered"))
    }

    /// Through the real layout actor, one instance, as the screen rebuilds: the open row's lines
    /// appear on the next build (its memo once kept the closed rows: the tap did nothing).
    func testTheLayoutOpensAndClosesTheRowAcrossBuilds() async {
        let actor = TimelineLayoutActor()
        func build(_ expanded: Set<String>, on: Bool = true) async -> [String] {
            var input = TimelineInput(messages: [reply()], streaming: false, liveText: "", liveTextTruncated: false,
                                      activity: nil, showLoadEarlier: false, width: 390, expandedRowIDs: expanded)
            input.showHiddenLines = on
            return await actor.buildSnapshot(input).rows.map(\.id).filter { $0.contains("#hidden") }
        }
        let closed = await build([])
        XCTAssertEqual(closed.count, 1)
        let open = await build([closed[0]])
        XCTAssertEqual(open, [closed[0], "\(closed[0])#0"], "the open row's lines show on the next build")
        let shut = await build([])
        XCTAssertEqual(shut, closed, "and go again when it closes")
        let off = await build([], on: false)
        XCTAssertEqual(off, [], "the switch turned off takes the row away")
    }

    func testAReplyWithNothingHiddenHasNoRowAndTheAckLineCounts() {
        XCTAssertEqual(foldIDs(builder.rows(for: reply(hidden: nil), width: 390, expandedRowIDs: [], showHiddenLines: true)), [])
        let acked = reply("Nothing to do.\n\(TimelineTurnMarker.tag)", hidden: nil)
        XCTAssertEqual(TimelineRowBuilder.hiddenLines(of: acked), TimelineTurnMarker.tag)
        XCTAssertEqual(TimelineRowBuilder.hiddenLines(of: reply()), "FOR_USER_STATE: answered")
    }

    /// The web's `hiddenLinesOf` and this port run the same cases (tests/fixtures/hidden-lines).
    func testThePortAnswersEverySharedCaseAsTheServerDoes() throws {
        struct Cases: Decodable { struct Case: Decodable { let name, raw, shown, hidden: String }; let cases: [Case] }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tests/fixtures/hidden-lines/cases.json")
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url)).cases
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for c in cases { XCTAssertEqual(HiddenLines.of(raw: c.raw, shown: c.shown), c.hidden, c.name) }
    }

    /// A reply read without `hidden` (a transcript a replica built, a live tail) still folds the
    /// lines the screen takes out: a status report, an Org chat's tasks line, an older marker.
    func testLinesTheScreenTakesOutFoldWithoutTheServersField() {
        let raw = "Done, the fix is live.\n\nFOR_USER_STATE: working\nFOR_USER_NOW: tests run"
        XCTAssertEqual(TimelineRowBuilder.hiddenLines(of: reply(raw, hidden: nil)), "FOR_USER_STATE: working\nFOR_USER_NOW: tests run")
        let about = reply("Two tasks moved.\n<walnut-about tasks=\"t1-aaa,t2-bbb\"/>", hidden: nil)
        XCTAssertEqual(TimelineRowBuilder.hiddenLines(of: about), "<walnut-about tasks=\"t1-aaa,t2-bbb\"/>")
        let rows = builder.rows(for: reply(raw, hidden: nil), width: 390, expandedRowIDs: [], showHiddenLines: true)
        XCTAssertEqual(foldIDs(rows).count, 1)
    }

    /// While the reply streams, its hidden lines fold under it too, as the saved reply will show them.
    func testAStreamingReplyFoldsItsHiddenLines() {
        let text = "Working on it.\n\nFOR_USER_STATE: working"
        let off = builder.liveRows(liveText: text, storeTruncated: false, activity: nil, width: 390,
                                   tailRevision: 0, cachedHead: nil)
        XCTAssertEqual(foldIDs(off.rows), [])
        let on = builder.liveRows(liveText: text, storeTruncated: false, activity: nil, width: 390,
                                  tailRevision: 0, cachedHead: nil, showHiddenLines: true)
        XCTAssertEqual(foldIDs(on.rows).count, 1)
        let open = builder.liveRows(liveText: text, storeTruncated: false, activity: nil, width: 390,
                                    tailRevision: 0, cachedHead: nil, expandedRowIDs: [foldIDs(on.rows)[0]],
                                    showHiddenLines: true)
        XCTAssertEqual(foldIDs(open.rows).count, 2, "open, the lines show under it")
        let plain = builder.liveRows(liveText: "Just words.", storeTruncated: false, activity: nil, width: 390,
                                     tailRevision: 0, cachedHead: nil, showHiddenLines: true)
        XCTAssertEqual(foldIDs(plain.rows), [], "nothing hidden, no row")
    }

    /// A slim poll (no `hidden`) keeps what a rich read delivered for the same reply, and its row id.
    func testASlimPollKeepsTheHiddenLinesARichReadGave() async throws {
        func transcript(_ hidden: String?) -> SessionTranscript {
            SessionTranscript(sessionId: "hid", exportedAt: "2026-11-25T00:00:02Z", truncated: false, messages: [
                .init(role: "user", text: "Go", timestamp: "2026-11-25T00:00:00Z", kind: nil),
                .init(role: "assistant", text: "Done.", timestamp: "2026-11-25T00:00:01Z", kind: nil, hidden: hidden),
            ])
        }
        let transport = MockSessionSendTransport()
        transport.transcript = transcript("FOR_USER_STATE: done")
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "hid-slim"), transport: transport)
        await store.open()
        defer { store.close() }
        let rich = try XCTUnwrap(store.messages.last { $0.role == "assistant" })
        XCTAssertEqual(rich.hidden, "FOR_USER_STATE: done")
        store.reconcile(transcript(nil))
        let slim = try XCTUnwrap(store.messages.last { $0.role == "assistant" })
        XCTAssertEqual(slim.hidden, "FOR_USER_STATE: done", "the slim copy keeps the lines")
        XCTAssertEqual(slim.id, rich.id, "and the row keeps its id, so an open fold stays open")
    }

    /// A read that does not name the switch (an older server, a replica while it is unset) keeps
    /// what the phone had, and Settings offers the switch only once a server named it.
    func testAReadWithoutTheSwitchKeepsTheValueAndOffersNothing() async throws {
        let suite = "hidden-lines-unnamed-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var answer: Bool? = nil
        let settings = ServerClientSettings(
            defaults: defaults,
            fetch: { .init(showWalnutAdditions: false, experimental: [:], showHiddenLines: answer) },
            currentServer: { "http://a.example" }, writeHiddenLines: { _ in })
        await settings.refresh()
        XCTAssertFalse(settings.offersHiddenLines, "an older server: no switch")
        XCTAssertFalse(settings.showHiddenLines)
        answer = true
        await settings.refresh()
        XCTAssertTrue(settings.offersHiddenLines)
        XCTAssertTrue(settings.showHiddenLines)
        answer = nil
        await settings.refresh()
        XCTAssertTrue(settings.showHiddenLines, "the Mac away: the replica leaves it out, the phone keeps it")
        XCTAssertTrue(settings.offersHiddenLines)
        let relaunched = ServerClientSettings(defaults: defaults, fetch: { throw URLError(.timedOut) },
                                              currentServer: { "http://a.example" }, writeHiddenLines: { _ in })
        XCTAssertTrue(relaunched.offersHiddenLines, "kept across a relaunch")
    }

    /// A read that crossed a write out, and an older write's refusal, never undo the newest tap.
    func testOnlyTheNewestWriteDecides() async throws {
        let suite = "hidden-lines-race-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var release: CheckedContinuation<Void, Never>?
        var firstCall = true
        let settings = ServerClientSettings(
            defaults: defaults,
            fetch: { .init(showWalnutAdditions: false, experimental: [:], showHiddenLines: true) },
            currentServer: { "http://a.example" },
            writeHiddenLines: { _ in
                if firstCall {
                    firstCall = false
                    await withCheckedContinuation { release = $0 }
                    throw URLError(.timedOut)
                }
            })
        await settings.refresh()
        XCTAssertTrue(settings.showHiddenLines)
        let first = Task { try await settings.setShowHiddenLines(false) }
        while release == nil { await Task.yield() }
        await settings.refresh()
        XCTAssertFalse(settings.showHiddenLines, "a read while the write is out keeps the tap")
        try await settings.setShowHiddenLines(true)
        try await settings.setShowHiddenLines(false)
        release?.resume()
        _ = try? await first.value
        XCTAssertFalse(settings.showHiddenLines, "the first write's late refusal does not put back its old value")
    }

    func testTheSwitchWritesTheServerKeepsItAndARefusalPutsItBack() async throws {
        let suite = "hidden-lines-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var written: [Bool] = []
        var refuse = false
        let settings = ServerClientSettings(
            defaults: defaults,
            fetch: { .init(showWalnutAdditions: false, experimental: [:], showHiddenLines: true) },
            currentServer: { "http://a.example" },
            writeHiddenLines: { on in
                if refuse { throw URLError(.notConnectedToInternet) }
                written.append(on)
            })
        XCTAssertFalse(settings.showHiddenLines, "off until the server says")
        await settings.refresh()
        XCTAssertTrue(settings.showHiddenLines, "the server's resolved value (a developer's default)")
        try await settings.setShowHiddenLines(false)
        XCTAssertFalse(settings.showHiddenLines)
        XCTAssertEqual(written, [false])
        // A relaunch draws it as chosen before the read answers.
        let relaunched = ServerClientSettings(defaults: defaults, fetch: { throw URLError(.timedOut) },
                                              currentServer: { "http://a.example" }, writeHiddenLines: { _ in })
        XCTAssertFalse(relaunched.showHiddenLines)
        refuse = true
        do {
            try await settings.setShowHiddenLines(true)
            XCTFail("a refused write must throw")
        } catch {}
        XCTAssertFalse(settings.showHiddenLines, "a refused write puts the value back")
    }

    /// The Advanced section as Settings draws it, switch on, attached for review.
    func testTheAdvancedSectionDrawsItsSwitch() async throws {
        let settings = ServerClientSettings(
            defaults: try XCTUnwrap(UserDefaults(suiteName: "hidden-lines-shot-\(UUID().uuidString)")),
            fetch: { .init(showWalnutAdditions: false, experimental: [:], showHiddenLines: true) },
            currentServer: { "http://a.example" }, writeHiddenLines: { _ in })
        await settings.refresh()
        let root = NavigationStack { List { AdvancedSettingsSection(settings: settings) }.navigationTitle("Settings") }
        let host = UIHostingController(rootView: root)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 500)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        for _ in 0..<10 { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
            host.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let shot = XCTAttachment(image: image)
        shot.name = "settings-advanced-show-hidden-lines"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(settings.showHiddenLines)
    }
}
