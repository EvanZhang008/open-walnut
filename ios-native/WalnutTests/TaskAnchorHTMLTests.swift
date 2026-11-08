import UIKit
import XCTest
@testable import Walnut

/// Cases: tests/fixtures/task-anchor-refs.json.
@MainActor
final class TaskAnchorHTMLTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let expect: String
            let id: String?
            let label: String?
            let input: String
            enum CodingKeys: String, CodingKey { case name, expect, id, label, input = "in" }
        }
        let tasks: [String: String]
        let cases: [Case]
    }

    private let resolver = TaskMentionResolver.shared
    private static let leaks = ["<a ", "<A ", "</a>", "&lt;", "href", "task-link", "data-task-id", "onclick", "<task-ref"]

    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func fixture() throws -> Fixture {
        let data = try Data(contentsOf: Self.repoRoot.appendingPathComponent("tests/fixtures/task-anchor-refs.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        resolver.resetForTesting()
    }

    override func tearDown() {
        resolver.resetForTesting()
        MarkdownParser.resetCacheForTesting()
        super.tearDown()
    }

    private func links(_ s: AttributedString) -> [String] {
        s.runs.compactMap { $0.link.flatMap(TaskMentionLink.taskID(from:)) }
    }

    func testEveryCaseOnTheNativePaths() throws {
        let f = try fixture()
        resolver.update(f.tasks)
        XCTAssertGreaterThan(f.cases.count, 15)
        for c in f.cases {
            let shown = MarkdownParser.inline(c.input)
            let text = String(shown.characters)
            let timeline = TimelineTextStyler.inlineText(c.input)
            switch c.expect {
            case "pill":
                let id = try XCTUnwrap(c.id, c.name)
                XCTAssertTrue(links(shown).contains(id), "\(c.name): \(text)")
                XCTAssertTrue(text.contains(try XCTUnwrap(f.tasks[id])), "\(c.name) shows the current title: \(text)")
                XCTAssertFalse(text.contains("Old title"), "\(c.name): \(text)")
                XCTAssertEqual(timeline.string, text, c.name)
            case "label":
                XCTAssertTrue(links(shown).isEmpty, "\(c.name) links nothing: \(text)")
                XCTAssertTrue(text.contains(try XCTUnwrap(c.label)), "\(c.name): \(text)")
                XCTAssertEqual(timeline.string, text, c.name)
            default:
                XCTAssertEqual(TaskAnchorHTML.canonicalizeMarkdown(c.input), c.input, c.name)
                XCTAssertEqual(TaskMentions.rewriteRefs(c.input), c.input, c.name)
                continue
            }
            for leak in Self.leaks {
                XCTAssertFalse(text.contains(leak), "\(c.name) shows \(leak): \(text)")
                XCTAssertFalse(timeline.string.contains(leak), "\(c.name) timeline shows \(leak)")
            }
            if !c.input.contains("`") {
                XCTAssertFalse(RichHTMLSegments.isRich(c.input), "\(c.name) leaves the native path")
            }
        }
    }

    func testALegacyIdTheStoreKnowsStillLinks() {
        resolver.update(["pw-task-001": "Legacy board task"])
        let shown = MarkdownParser.inline(#"See <a href="/tasks/pw-task-001" class="task-link">old</a>."#)
        XCTAssertEqual(String(shown.characters), "See Legacy board task.")
        XCTAssertEqual(links(shown), ["pw-task-001"])
    }

    func testAnUnknownTaskWithAScriptLabelIsEscapedText() {
        let source = #"See <a href="/tasks/mzzzzzzz-ffff" class="task-link">&lt;script&gt;x()&lt;/script&gt;</a> now."#
        XCTAssertEqual(String(MarkdownParser.inline(source).characters), "See <script>x()</script> now.")
        let card = RichHTMLDocument.page(body: "<div>\(source)</div>", palette: .light, kind: .content)
        XCTAssertTrue(card.contains("<div>See &lt;script&gt;x()&lt;/script&gt; now.</div>"), card)
        XCTAssertFalse(card.contains("/tasks/"))
    }

    func testARichCardLinksTheTaskWithItsCurrentTitle() {
        resolver.update(["mpwidref-7c2e": "Quarterly <invoice> reconciliation"])
        let body = #"<div>Owner: <a href="/tasks/mpwidref-7c2e" class="task-link" onclick="x()"><b>Old</b></a></div>"#
            + #"<p>cited `<task-ref id="mpwidref-7c2e" label="Old"/>`</p><p>sample `send <task-ref id="mpwidref-7c2e"/>`</p>"#
            + #"<pre><a href="/tasks/mpwidref-7c2e" class="task-link">Sample <b>run</b></a></pre>"#
            + #"<pre><a href="/tasks/mzzgone0-0000" class="task-link">Gone sample</a></pre>"#
            + #"<p><code>x <a href="/tasks/mpwidref-7c2e" class="task-link">inline</a></code></p>"#
        let card = RichHTMLDocument.page(body: body, palette: .light, kind: .content)
        let link = #"<a href="walnut-task://task/mpwidref-7c2e">Quarterly &lt;invoice&gt; reconciliation</a>"#
        XCTAssertEqual(card.components(separatedBy: link).count - 1, 2, card)
        XCTAssertTrue(card.contains("<code>send &lt;task-ref id=&quot;mpwidref-7c2e&quot;/&gt;</code>"), card)
        // A sample keeps its author's text; a known task opens, an unknown one is no dead link.
        XCTAssertTrue(card.contains(#"<pre><a href="walnut-task://task/mpwidref-7c2e">Sample <b>run</b></a></pre>"#), card)
        XCTAssertTrue(card.contains("<pre>Gone sample</pre>"), card)
        XCTAssertTrue(card.contains(#"<code>x <a href="walnut-task://task/mpwidref-7c2e">inline</a></code>"#), card)
        XCTAssertFalse(card.contains("/tasks/"), card)
        XCTAssertFalse(card.contains("onclick"))
    }

    func testARichCardUpdatesWhenTaskLabelsArriveAndChange() throws {
        let id = "mpwidref-7c2e"
        let body = "<div>Owner: <a href=\"/tasks/\(id)\" class=\"task-link\">Old title</a></div>"
        let message = ChatMessage(id: "rich-label-arrival", role: "assistant", text: body,
                                  createdAt: "2026-11-01T00:00:00Z", kind: nil)
        func row() throws -> TimelineRow {
            try XCTUnwrap(TimelineRowBuilder().assistantRows(message, width: 393)
                .first { $0.content.reuseKind == "richHTML" })
        }
        func key(_ row: TimelineRow) throws -> String {
            guard case .richHTML(_, let key, _) = row.content else {
                throw NSError(domain: "TaskAnchorTest", code: 1)
            }
            return key
        }
        let first = try row()
        let cell = TimelineRichHTMLCell(frame: .zero)
        cell.configureContent(html: body, key: try key(first), streaming: false,
                              rowID: first.id, contentWidth: 320, delegate: nil)
        XCTAssertFalse(try XCTUnwrap(cell.loadedDocumentForTesting).contains("walnut-task://"))
        resolver.update([id: "Arrived task"])
        let arrived = try row()
        XCTAssertEqual(arrived.id, first.id)
        XCTAssertNotEqual(arrived.revision, first.revision)
        cell.configureContent(html: body, key: try key(arrived), streaming: false,
                              rowID: arrived.id, contentWidth: 320, delegate: nil)
        XCTAssertTrue(try XCTUnwrap(cell.loadedDocumentForTesting).contains(">Arrived task</a>"))
        resolver.update([id: "Renamed task", "mvu0ubnq-a02d": "Other task"])
        let renamed = try row()
        XCTAssertNotEqual(try key(renamed), try key(arrived))
        resolver.update([id: "Renamed task", "mvu0ubnq-a02d": "Other task renamed"])
        XCTAssertEqual(try key(row()), try key(renamed))
        let sample = "<pre>\(body)</pre>"
        let sampleKey = RichHTMLDocument.contentKey(body: sample, key: "sample")
        resolver.update([id: "Another title"])
        XCTAssertEqual(RichHTMLDocument.contentKey(body: sample, key: "sample"), sampleKey)
        XCTAssertEqual(RichHTMLDocument.contentKey(body: "<div>Plain card</div>", key: "plain"), "plain")
    }

    func testATaskAnchorKeepsAReplyNativeAndARichReplyWhole() {
        let anchor = #"See <a href="/tasks/mpwidref-7c2e" class="task-link"><b>Old</b></a> today."#
        XCTAssertFalse(RichHTMLSegments.isRich(anchor))
        XCTAssertEqual(RichHTMLSegments.segments(anchor, streaming: false), [.markdown(anchor)])
        let rich = "<div>card</div>\n\n" + anchor + "\n\n<p>end</p>"
        XCTAssertTrue(RichHTMLSegments.isRich(rich))
        XCTAssertEqual(RichHTMLSegments.sourceTexts(rich, streaming: false).joined(), rich)
    }

    func testAStreamingAnchorIsHeldUntilItCloses() {
        let reply = "<div>card</div>\n\nSee <a href=\"/tasks/mpwidref-7c2e\" class=\"task-link\"><b>Old</b></a>.\n\n<p>end</p>"
        let units = Array(reply.utf16)
        var released = 0
        var earlier: [String] = []
        for n in 1...units.count {
            let prefix = String(utf16CodeUnits: units, count: n)
            let split = RichHTMLSegments.splitPending(prefix)
            XCTAssertEqual(split.safe + split.pending, prefix)
            XCTAssertGreaterThanOrEqual((split.safe as NSString).length, released, "at \(n)")
            released = (split.safe as NSString).length
            if split.safe.contains("<a ") { XCTAssertTrue(split.safe.contains("</a>"), "half an anchor at \(n)") }
            let texts = RichHTMLSegments.sourceTexts(prefix, streaming: true)
            for (i, text) in earlier.enumerated().dropLast() where i < texts.count - 1 {
                XCTAssertEqual(texts[i], text, "segment \(i) moved at \(n)")
            }
            earlier = texts
        }
    }

    // MARK: - Guard: every surface that draws model text takes the same pipeline

    func testEverySurfaceThatParsesMarkdownRewritesMentionsFirst() throws {
        let root = Self.repoRoot.appendingPathComponent("ios-native/Walnut")
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        let parse = try NSRegularExpression(pattern: #"AttributedString\(\s*markdown:"#)
        var parsing: [String] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            let all = NSRange(location: 0, length: (text as NSString).length)
            guard parse.firstMatch(in: text, range: all) != nil else { continue }
            parsing.append(url.lastPathComponent)
            XCTAssertTrue(text.contains("TaskMentions.rewriteRefs("), "\(url.lastPathComponent) parses model text without it")
        }
        XCTAssertEqual(Set(parsing), ["MarkdownParser.swift", "TimelineTextStyler.swift", "MessageRow.swift"],
                       "a new markdown surface: route it through TaskMentions.rewriteRefs and list it here")
        let mentions = try String(contentsOf: root.appendingPathComponent("Markdown/TaskMentions.swift"), encoding: .utf8)
        XCTAssertTrue(mentions.contains("var out = TaskAnchorHTML.canonicalizeMarkdown(text)\n"
            + "        out = TaskTitleAbsorb.absorbWrittenTitles(out, resolver: resolver)"))
        let document = try String(contentsOf: root.appendingPathComponent("Markdown/RichHTMLDocument.swift"), encoding: .utf8)
        XCTAssertTrue(document.contains("TaskAnchorHTML.rewriteHTML(RichHTMLSegments.inlineMarkdown(body), render: taskMentionHTML,\n"
            + "                                         sample: taskSampleHTML)"))
        let cell = try String(contentsOf: root.appendingPathComponent("Timeline/TimelineRichHTMLCell.swift"), encoding: .utf8)
        XCTAssertTrue(cell.contains("url.scheme == TaskMentionLink.scheme"), "a card's task link must reach the task sheet")
    }
}
