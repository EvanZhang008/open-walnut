import XCTest
import UIKit
import WebKit
@testable import Walnut

/// An html-app island keeps its state and hands a result back (`IslandRuntime`,
/// `IslandStateStore`, `IslandResultStrip`): the phone twin of the web console's
/// island-runtime.ts / island-store.ts, held to the same semantics.
///
/// 2026-10-27: halfway through a 15-question quiz island the reader was back on
/// question 1, because every rebuild of the document started it from nothing.
@MainActor
final class IslandStateTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private var clock: Double = 1_000

    override func setUp() {
        super.setUp()
        suiteName = "IslandStateTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        clock = 1_000
        RichHTMLHeightCache.shared.resetForTesting()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        IslandStateStore.shared.removeAll(scope: Self.scope)
        RichHTMLHeightCache.shared.resetForTesting()
        super.tearDown()
    }

    private static let scope = "island-tests"

    private func makeStore() -> IslandStateStore {
        IslandStateStore(defaults: defaults, persistDelay: 60, now: { [unowned self] in
            self.clock += 1
            return self.clock
        })
    }

    // MARK: - Store semantics (island-store.ts)

    func testItemsAreKeptAndAnEmptyStoreWithNoResultRemovesTheRecord() {
        let store = makeStore()
        XCTAssertTrue(store.saveItems(["quiz": "{\"i\":7}"], key: "s|rh1"))
        XCTAssertEqual(store.items("s|rh1"), ["quiz": "{\"i\":7}"])
        XCTAssertTrue(store.saveItems([:], key: "s|rh1"))
        XCTAssertNil(store.record("s|rh1"), "a page that cleared its storage has nothing to keep")
    }

    func testTheSameResultKeepsItsSentMarkAndANewOneResetsIt() {
        let store = makeStore()
        XCTAssertEqual(store.offerResult("3/3", key: "s|rh1"), .init(text: "3/3", sent: false))
        store.markSent(key: "s|rh1", text: "3/3")
        XCTAssertEqual(store.result("s|rh1"), .init(text: "3/3", sent: true))
        // A page that reports again on load must not ask the user to send twice.
        XCTAssertEqual(store.offerResult("3/3", key: "s|rh1"), .init(text: "3/3", sent: true))
        // A retake with another score is a new result.
        XCTAssertEqual(store.offerResult("2/3", key: "s|rh1"), .init(text: "2/3", sent: false))
    }

    func testMarkSentOnlyWhenTheTextStillMatches() {
        let store = makeStore()
        store.offerResult("first", key: "s|rh1")
        store.offerResult("second", key: "s|rh1")
        store.markSent(key: "s|rh1", text: "first")
        XCTAssertEqual(store.result("s|rh1"), .init(text: "second", sent: false),
                       "a send of the old text must not mark the newer result sent")
    }

    func testDismissRemovesTheResultAndKeepsTheState() {
        let store = makeStore()
        store.saveItems(["k": "v"], key: "s|rh1")
        store.offerResult("done", key: "s|rh1")
        store.dismissResult(key: "s|rh1")
        XCTAssertNil(store.result("s|rh1"))
        XCTAssertEqual(store.items("s|rh1"), ["k": "v"])
        // Reported again on the next load: still dismissed. A new result shows again.
        store.offerResult("done", key: "s|rh1")
        XCTAssertNil(store.result("s|rh1"))
        store.offerResult("done again", key: "s|rh1")
        XCTAssertEqual(store.result("s|rh1"), .init(text: "done again", sent: false))
    }

    func testAResultKeepsNoInvisibleCharacterAndACommandIsRecognised() {
        XCTAssertEqual(IslandRuntime.cleanResultText("Score \u{202E}51/11\u{200B}\u{FEFF}"), "Score 51/11")
        XCTAssertEqual(IslandRuntime.cleanResultText("\u{1F469}\u{200D}\u{1F4BB}"), "\u{1F469}\u{200D}\u{1F4BB}")
        // Hidden text cannot ride a result: "hi" in tag characters, bytes as variation
        // selectors, a soft hyphen, ALM, a Hangul filler, NUL and ESC.
        XCTAssertEqual(IslandRuntime.cleanResultText("Score 8/10\u{E0068}\u{E0069}"), "Score 8/10")
        XCTAssertEqual(IslandRuntime.cleanResultText("A\u{FE01}\u{E0101}\u{E01EF}B"), "AB")
        XCTAssertEqual(IslandRuntime.cleanResultText("a\u{00AD}b\u{061C}c\u{3164}d\u{0000}e\u{001B}f"), "abcdef")
        // Newlines, tabs and an emoji's own selector stay; a run of selectors is one.
        XCTAssertEqual(IslandRuntime.cleanResultText("x\n\ty"), "x\n\ty")
        XCTAssertEqual(IslandRuntime.cleanResultText("\u{2764}\u{FE0F}\u{FE0F}\u{FE0E}\u{FE0F} ok"), "\u{2764}\u{FE0F} ok")
        XCTAssertEqual(IslandRuntime.parse(["t": IslandRuntime.resultMessage, "k": "a", "text": "a\u{2066}b"]),
                       .result(token: "a", text: "ab"))
        XCTAssertTrue(IslandRuntime.isCommandLike("  /clear"))
        XCTAssertFalse(IslandRuntime.isCommandLike("Score 3/5"))
    }

    func testAStoreOverTheCapIsRefusedAndTheOldOneKept() {
        let store = makeStore()
        store.saveItems(["k": "small"], key: "s|rh1")
        let huge = String(repeating: "x", count: IslandRuntime.stateMax)
        XCTAssertFalse(store.saveItems(["k": huge], key: "s|rh1"))
        XCTAssertEqual(store.items("s|rh1"), ["k": "small"])
    }

    func testTheLeastRecentlyWrittenIslandIsEvictedPastTheLimit() {
        let store = makeStore()
        for index in 0...IslandStateStore.limit {
            store.saveItems(["n": "\(index)"], key: "s|rh\(index)")
        }
        XCTAssertEqual(store.count, IslandStateStore.limit)
        XCTAssertNil(store.record("s|rh0"), "the oldest island goes first")
        XCTAssertNotNil(store.record("s|rh\(IslandStateStore.limit)"))
        // Writing an old island again makes it recent.
        store.saveItems(["n": "again"], key: "s|rh1")
        store.saveItems(["n": "new"], key: "s|rh-next")
        XCTAssertNotNil(store.record("s|rh1"))
        XCTAssertNil(store.record("s|rh2"))
    }

    func testRecordsSurviveARelaunch() {
        let store = makeStore()
        store.saveItems(["quiz": "{\"i\":8}"], key: "s|rh1")
        store.offerResult("8/15", key: "s|rh1")
        store.markSent(key: "s|rh1", text: "8/15")
        store.persistNow()
        let relaunched = makeStore()
        XCTAssertEqual(relaunched.items("s|rh1"), ["quiz": "{\"i\":8}"])
        XCTAssertEqual(relaunched.result("s|rh1"), .init(text: "8/15", sent: true))
    }

    func testOnlyAResultChangeIsAnnounced() {
        let store = makeStore()
        var keys: [String] = []
        let observer = NotificationCenter.default.addObserver(
            forName: IslandStateStore.resultChanged, object: store, queue: nil
        ) { note in keys.append(note.userInfo?["key"] as? String ?? "?") }
        defer { NotificationCenter.default.removeObserver(observer) }
        store.saveItems(["k": "v"], key: "s|rh1")
        XCTAssertEqual(keys, [], "a state write changes nothing anyone draws")
        store.offerResult("r", key: "s|rh1")
        store.offerResult("r", key: "s|rh1")
        store.markSent(key: "s|rh1", text: "r")
        store.dismissResult(key: "s|rh1")
        XCTAssertEqual(keys, ["s|rh1", "s|rh1", "s|rh1"])
    }

    /// The live row and the settled row of the same reply have different row ids but
    /// one conversation scope, so they are one island.
    func testTheStoreKeyIsTheSameForTheLiveAndTheSettledRow() {
        let live = IslandStateStore.storeKey(rowID: "sess-1|live-tail#2", islandKey: "rhabc-90")
        let settled = IslandStateStore.storeKey(rowID: "sess-1|m14#0", islandKey: "rhabc-90")
        XCTAssertEqual(live, settled)
        XCTAssertEqual(live, "sess-1|rhabc-90")
        XCTAssertNotEqual(live, IslandStateStore.storeKey(rowID: "sess-2|m14#0", islandKey: "rhabc-90"),
                          "the same island in another conversation is another island")
        XCTAssertEqual(IslandStateStore.islandKey(fromStoreKey: live), "rhabc-90")
    }

    // MARK: - The document

    func testTheRuntimeComesBeforeTheModelsContentAndOnlyInAnIsland() throws {
        let seed = IslandRuntime.Seed(token: "tok", items: ["quiz": "{\"i\":3}"])
        let page = RichHTMLDocument.page(body: "<script>MODEL_CODE()</script>", palette: .light,
                                         kind: .island, island: seed)
        let runtime = try XCTUnwrap(page.range(of: IslandRuntime.stateMessage))
        let model = try XCTUnwrap(page.range(of: "MODEL_CODE"))
        XCTAssertLessThan(runtime.lowerBound, model.lowerBound,
                          "the model's first line must be able to read its state")
        XCTAssertTrue(page.contains("localStorage"))
        XCTAssertTrue(page.contains("\"tok\""))
        XCTAssertTrue(page.contains(IslandRuntime.handlerName))

        let content = RichHTMLDocument.page(body: "<div>card</div>", palette: .light, kind: .content,
                                            island: seed)
        XCTAssertFalse(content.contains(IslandRuntime.stateMessage),
                       "a content card has no scripting and gets no runtime")
        // An island built with no seed still gets working storage.
        XCTAssertTrue(RichHTMLDocument.page(body: "<div/>", palette: .dark, kind: .island)
            .contains(IslandRuntime.stateMessage))
    }

    func testTheSeedCannotEndTheScript() {
        let seed = IslandRuntime.Seed(token: "t</script>",
                                      items: ["k": "</script><script>alert(1)</script><!--",
                                              "sep": "a\u{2028}b\u{2029}c"])
        let page = RichHTMLDocument.page(body: "<div>x</div>", palette: .light, kind: .island,
                                         island: seed)
        XCTAssertEqual(page.components(separatedBy: "</script>").count - 1, 1,
                       "only the runtime's own closing tag may appear")
        XCTAssertFalse(page.contains("<!--"))
        XCTAssertFalse(page.contains("\u{2028}"))
        XCTAssertFalse(page.contains("\u{2029}"))
        XCTAssertTrue(page.contains("\\u003c/script>"))
    }

    // MARK: - Messages

    func testMessagesAreShapeChecked() {
        XCTAssertEqual(IslandRuntime.parse(["t": "wn-island-state", "k": "a",
                                            "items": ["x": "1", "n": 2]] as [String: Any]),
                       .state(token: "a", items: ["x": "1"]), "non-string values are dropped")
        XCTAssertEqual(IslandRuntime.parse(["t": "wn-island-result", "k": "a", "text": "3/3"]),
                       .result(token: "a", text: "3/3"))
        XCTAssertNil(IslandRuntime.parse(["t": "wn-island-result", "k": "a", "text": 3] as [String: Any]))
        XCTAssertNil(IslandRuntime.parse(["t": "wn-island-state", "k": "a", "items": ["x"]] as [String: Any]))
        XCTAssertNil(IslandRuntime.parse(["t": "wn-island-state", "items": [String: String]()] as [String: Any]),
                     "a message must name its document")
        XCTAssertNil(IslandRuntime.parse(["t": "other", "k": "a"]))
        XCTAssertNil(IslandRuntime.parse("wn-island-state"))
        XCTAssertNil(IslandRuntime.parse(42))
    }

    // MARK: - The row

    /// The strip under an island is part of the row's height, and it comes and goes
    /// through the re-bank path the coordinator triggers.
    func testTheResultStripIsPartOfTheIslandRowsHeight() throws {
        let text = TimelineRichFixtures.islandQuiz
        let message = ChatMessage(id: "m-quiz", role: "assistant", text: text,
                                  createdAt: "2026-10-27T06:00:00Z", kind: nil)
        let builder = TimelineRowBuilder()
        func islandRow(_ rows: [TimelineRow]) -> TimelineRow? {
            rows.first { if case .richIsland = $0.content { return true }; return false }
        }
        let before = try XCTUnwrap(islandRow(builder.rows(for: message, width: 393, expandedRowIDs: [],
                                                          scope: Self.scope)))
        guard case .richIsland(_, let key, true) = before.content else { return XCTFail("not complete") }
        let storeKey = IslandStateStore.storeKey(rowID: before.id, islandKey: key)
        XCTAssertEqual(storeKey, "\(Self.scope)|\(key)")

        IslandStateStore.shared.offerResult("Quiz result: 3/3 right.", key: storeKey)
        let strip = IslandResultStrip.blockHeight(.init(text: "Quiz result: 3/3 right.", sent: false),
                                                  width: TimelineMetrics.richContentWidth(393))
        XCTAssertGreaterThan(strip, IslandResultStrip.headerMinHeight)
        let rebanked = builder.rebankRichHeights([before], width: 393,
                                                 changed: [RichHTMLHeightCache.documentIdentity(key)])
        XCTAssertEqual(rebanked[0].height, before.height + strip, accuracy: 0.01)
        let rebuilt = try XCTUnwrap(islandRow(builder.rows(for: message, width: 393, expandedRowIDs: [],
                                                           scope: Self.scope)))
        XCTAssertEqual(rebuilt.height, before.height + strip, accuracy: 0.01)

        IslandStateStore.shared.dismissResult(key: storeKey)
        let gone = builder.rebankRichHeights(rebanked, width: 393,
                                             changed: [RichHTMLHeightCache.documentIdentity(key)])
        XCTAssertEqual(gone[0].height, before.height, accuracy: 0.01)
    }

    func testAResultOfManyLinesStillPreviewsTwo() {
        let width = TimelineMetrics.richContentWidth(393)
        let one = IslandResultStrip.previewHeight("Quiz result: 3/3 right.", width: width)
        let many = IslandResultStrip.previewHeight(String(repeating: "Wrong: a long line here.\n", count: 30),
                                                   width: width)
        XCTAssertGreaterThan(many, one)
        XCTAssertLessThanOrEqual(many, ceil(IslandResultStrip.previewFont.lineHeight * 2
                                            + max(0, IslandResultStrip.previewFont.leading)) + 1)
    }

    /// The header keeps the title and the button side by side while both fit, and
    /// stacks them (title wrapping, button under it) when they do not, which is what
    /// the largest text sizes need; the strip's height follows the same layout.
    func testTheStripHeaderStacksWhenTitleAndButtonDoNotFit() {
        let result = IslandStateStore.Result(text: "Quiz result: 2/3 right.", sent: false)
        let wide = IslandResultStrip.header(result, width: TimelineMetrics.richContentWidth(393))
        XCTAssertFalse(wide.stacked)
        XCTAssertEqual(wide.title.minY, wide.button.minY - (wide.height - wide.button.height) / 2, accuracy: 0.5)
        XCTAssertLessThanOrEqual(wide.title.maxX + 8, wide.button.minX + 0.5)

        let narrow = IslandResultStrip.header(result, width: 120)
        XCTAssertTrue(narrow.stacked)
        XCTAssertGreaterThanOrEqual(narrow.button.minY, narrow.title.maxY)
        XCTAssertEqual(narrow.height, narrow.button.maxY, accuracy: 0.5)
        XCTAssertLessThanOrEqual(narrow.button.maxX, 120 - IslandResultStrip.padding * 2 + 0.5)
        XCTAssertGreaterThanOrEqual(narrow.button.height, IslandResultStrip.headerMinHeight)
        XCTAssertGreaterThan(IslandResultStrip.boxHeight(result, width: 120),
                             IslandResultStrip.boxHeight(result, width: TimelineMetrics.richContentWidth(393)))
    }

    /// The cell shows the strip from the store and lays it out inside the row height
    /// the builder reserved, under the document's box.
    func testTheCellShowsTheStripInsideTheRowItWasSizedFor() throws {
        let width = TimelineMetrics.richContentWidth(393)
        let result = IslandStateStore.Result(text: "Quiz result: 2/3 right.", sent: false)
        let rowID = "\(Self.scope)|m-cell#1"
        IslandStateStore.shared.offerResult(result.text, key: IslandStateStore.storeKey(rowID: rowID, islandKey: "rh-cell-1"))
        let height = 120 + TimelineMetrics.richVMargin * 2 + IslandResultStrip.blockHeight(result, width: width)
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: 393, height: height))
        cell.configureIsland(html: "<div>quiz</div>", key: "rh-cell-1", complete: true, rowID: rowID,
                             contentWidth: width, delegate: nil)
        cell.layoutIfNeeded()
        let strip = try XCTUnwrap(cell.resultStripForTesting)
        XCTAssertFalse(strip.isHidden)
        XCTAssertEqual(strip.frame.maxY, height - TimelineMetrics.richVMargin, accuracy: 0.5)
        XCTAssertEqual(strip.frame.height, IslandResultStrip.boxHeight(result, width: width), accuracy: 0.5)
        XCTAssertEqual(strip.accessibilityIdentifier, "chat.islandResult")
        // Dismissed elsewhere (the sheet): the cell follows the store.
        IslandStateStore.shared.dismissResult(key: IslandStateStore.storeKey(rowID: rowID, islandKey: "rh-cell-1"))
        XCTAssertTrue(strip.isHidden)
        // A building island never shows one.
        IslandStateStore.shared.offerResult("x", key: IslandStateStore.storeKey(rowID: rowID, islandKey: "rh-cell-2"))
        cell.configureIsland(html: "<div>half", key: "rh-cell-2", complete: false, rowID: rowID,
                             contentWidth: width, delegate: nil)
        XCTAssertTrue(strip.isHidden)
    }

    /// A reply nobody called answers "not sent", so the sheet never waits for ever on
    /// a page that does not handle the action.
    func testAnUnansweredSendReadsAsNotSent() async {
        var answers: [Bool] = []
        do {
            let reply = IslandSendReply { answers.append($0) }
            _ = reply
        }
        XCTAssertEqual(answers, [false])
        let reply = IslandSendReply { answers.append($0) }
        reply(true)
        reply(false)
        XCTAssertEqual(answers, [false, true], "a reply runs exactly once")
    }

    // MARK: - The runtime in WebKit

    /// The real runtime in a real web view: the seed is readable on the first line,
    /// `localStorage` and `sessionStorage` are one store with property access, a write
    /// posts the whole store, and `walnut.report` posts the text.
    func testTheRuntimeWorksInWebKit() async throws {
        final class Sink: NSObject, WKScriptMessageHandler {
            var messages: [IslandRuntime.Message] = []
            var onMessage: (() -> Void)?
            func userContentController(_ controller: WKUserContentController,
                                       didReceive message: WKScriptMessage) {
                if let parsed = IslandRuntime.parse(message.body) { messages.append(parsed) }
                onMessage?()
            }
        }
        let sink = Sink()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(sink, contentWorld: .page, name: IslandRuntime.handlerName)
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 200), configuration: config)
        let body = """
        <div id="out"></div>
        <script>
          var s = JSON.parse(localStorage.getItem('quiz') || 'null');
          document.getElementById('out').textContent = 'step ' + (s ? s.i : 'none');
        </script>
        """
        let page = RichHTMLDocument.page(body: body, palette: .light, kind: .island,
                                         island: .init(token: "tok-1", items: ["quiz": "{\"i\":7}"]))
        let loaded = expectation(description: "loaded")
        final class Nav: NSObject, WKNavigationDelegate {
            let done: () -> Void
            init(_ done: @escaping () -> Void) { self.done = done }
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
        }
        let nav = Nav { loaded.fulfill() }
        webView.navigationDelegate = nav
        webView.loadHTMLString(page, baseURL: nil)
        await fulfillment(of: [loaded], timeout: 10)

        let shown = try await webView.evaluateJavaScript("document.getElementById('out').textContent")
        XCTAssertEqual(shown as? String, "step 7", "the model's first line must see its saved state")
        let shared = try await webView.evaluateJavaScript(
            "sessionStorage.getItem('quiz') + '|' + localStorage.quiz + '|' + localStorage.length")
        XCTAssertEqual(shared as? String, "{\"i\":7}|{\"i\":7}|1")

        let posted = expectation(description: "state posted")
        sink.onMessage = { posted.fulfill() }
        _ = try await webView.evaluateJavaScript("localStorage.setItem('quiz','{\"i\":8}'); localStorage.extra = 'y'; 1")
        await fulfillment(of: [posted], timeout: 5)
        XCTAssertEqual(sink.messages.last, .state(token: "tok-1", items: ["quiz": "{\"i\":8}", "extra": "y"]),
                       "two writes inside the window post once, the whole store")

        let reported = expectation(description: "result posted")
        sink.onMessage = { reported.fulfill() }
        _ = try await webView.evaluateJavaScript("walnut.report({score: 3}); 1")
        await fulfillment(of: [reported], timeout: 5)
        XCTAssertEqual(sink.messages.last, .result(token: "tok-1", text: "{\n  \"score\": 3\n}"))
        withExtendedLifetime((nav, sink)) {}
    }
}
