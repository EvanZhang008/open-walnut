import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// Agent-written text reads the same everywhere, and a letter id an agent writes
/// opens that letter where the user is looking.
///
///  - A letter id (`lt-<timestamp36>-<rand>`) becomes a `walnut-letter://` link in
///    the shared inline renderer (`MarkdownParser.inline`) and in the timeline's
///    UIKit fast path (`TimelineTextStyler.inlineText`), with the web's boundaries
///    (web/src/utils/letter-links.ts): linked inside inline code too, never inside a
///    URL, a path or a link that is already there. The web's `[words](letter:<id>)`
///    is the same link.
///  - A tap opens `LetterReaderSheet` over the current screen: from the SwiftUI
///    surfaces through `FilePathLinkHandling`, from the timeline through
///    `TimelineRowAction.openLetter` (hosted content reaches the controller through
///    `TimelineHostedLinkRouting`). Never a tab switch behind a sheet.
///  - Every agent-text field the app draws goes through the shared renderer; the
///    human's own words stay plain text (found by `AgentTextTaint`, not a file list).
///
/// What this layer cannot prove: that a real tap on a link inside a list row reaches
/// `\.openURL` before the row's own selection, and that the sheet shows. That is
/// the device gate's.
@MainActor
final class LetterAgentTextTests: XCTestCase {
    private let id = "lt-m9x2k1-a4f7"

    // MARK: - Link transport

    func testLetterLinkRoundTrips() throws {
        let url = try XCTUnwrap(LetterMentionLink.url(for: id))
        XCTAssertEqual(url.scheme, LetterMentionLink.scheme)
        XCTAssertTrue(LetterMentionLink.isLetterLink(url))
        XCTAssertEqual(LetterMentionLink.letterID(from: url), id)
    }

    func testTheWebsLetterDestinationIsTheSameLink() throws {
        XCTAssertEqual(LetterMentionLink.letterID(from: try XCTUnwrap(URL(string: "letter:\(id)"))), id)
        XCTAssertNil(LetterMentionLink.letterID(from: try XCTUnwrap(URL(string: "letter:lt-a-abc"))))
        XCTAssertNil(LetterMentionLink.letterID(from: try XCTUnwrap(URL(string: "letter://evil/\(id)"))))
    }

    func testOnlyAValidLetterIdMakesOrYieldsALink() {
        for bad in ["", "lt-a-abc", "lt--abcd", "lt-A-ABCD", "task-77", "lt-a-abcd/../secrets"] {
            XCTAssertNil(LetterMentionLink.url(for: bad), "must not link \(bad)")
        }
        XCTAssertNil(LetterMentionLink.letterID(from: URL(string: "walnut-letter://letter/lt-a-abc")!))
        XCTAssertNil(LetterMentionLink.letterID(from: URL(string: "walnut-letter://other/\(id)")!))
        XCTAssertNil(LetterMentionLink.letterID(from: URL(string: "https://example.com/\(id)")!))
        XCTAssertNil(LetterMentionLink.letterID(from: TaskMentionLink.url(for: "mvu0ubnq-a02d")!))
    }

    // MARK: - Linking in the shared inline renderer

    private struct Hit {
        let text: String
        let url: URL
    }

    /// Every run of `attributed` that is a link, with its text and the link.
    private func links(_ attributed: AttributedString) -> [Hit] {
        var out: [Hit] = []
        for run in attributed.runs {
            guard let url = run.link else { continue }
            out.append(Hit(text: String(attributed[run.range].characters), url: url))
        }
        return out
    }

    private func letterLinks(_ markdown: String) -> [String] {
        links(MarkdownParser.inline(markdown)).compactMap { LetterMentionLink.letterID(from: $0.url) }
    }

    func testABareLetterIdBecomesALinkAndKeepsItsText() throws {
        let rendered = MarkdownParser.inline("Answered in \(id) yesterday")
        XCTAssertEqual(String(rendered.characters), "Answered in \(id) yesterday", "the text stays the id")
        let hit = try XCTUnwrap(links(rendered).first)
        XCTAssertEqual(hit.text, id)
        XCTAssertEqual(LetterMentionLink.letterID(from: hit.url), id)
    }

    /// The web's cases (tests/web/markdown/letter-links.test.ts), plus a few more.
    func testLetterIdsInProseCJKAndCodeAreLinked() {
        XCTAssertEqual(letterLinks("The video is in letter \(id)."), [id])
        XCTAssertEqual(letterLinks("(\(id))"), [id])
        // U+89C6 U+9891 ... U+91CC: CJK prose around the id.
        XCTAssertEqual(letterLinks("\u{89C6}\u{9891}\u{5728}\u{4FE1} \(id) \u{91CC}"), [id])
        XCTAssertEqual(letterLinks("\u{4FE1}\u{4EF6}\(id)\u{3002}"), [id])
        XCTAssertEqual(letterLinks("\(id) and lt-a-abcd"), [id, "lt-a-abcd"])
    }

    func testAnIdInInlineCodeIsLinkedInPlaceAndStaysCode() throws {
        let rendered = MarkdownParser.inline("see `\(id)`")
        XCTAssertEqual(String(rendered.characters), "see \(id)")
        let run = try XCTUnwrap(rendered.runs.first { $0.link != nil })
        XCTAssertEqual(run.link.flatMap { LetterMentionLink.letterID(from: $0) }, id)
        XCTAssertEqual(run.inlinePresentationIntent?.contains(.code), true, "the id keeps its code style")
    }

    func testTheMarkdownLetterLinkKeepsItsWords() throws {
        let hit = try XCTUnwrap(links(MarkdownParser.inline("[the letter](letter:\(id))")).first)
        XCTAssertEqual(hit.text, "the letter")
        XCTAssertEqual(LetterMentionLink.letterID(from: hit.url), id,
                       "parsed link \(hit.url.absoluteString) scheme \(hit.url.scheme ?? "nil")")
    }

    func testIdsInsideURLsPathsLinksAndLongerTokensAreNotLetterLinks() {
        let cases = [
            "https://example.com/inbox/\(id)",
            "open /tmp/\(id)/report.md now",
            "salt-lt-abc-defg and lt-abc-defgh-x",
            "\(id)-extra",
            "LT-M9X2K1-A4F7",
            "lt-a-abc",
            "lt-m9x2k1-abcdefghijklm",
            "[\(id)](https://example.com/x)",
        ]
        for text in cases {
            XCTAssertEqual(letterLinks(text), [], "must not letter-link: \(text)")
        }
        // The URL and the markdown link keep their own links.
        XCTAssertEqual(links(MarkdownParser.inline("https://example.com/inbox/\(id)")).map { $0.url.scheme }, ["https"])
        XCTAssertEqual(links(MarkdownParser.inline("[\(id)](https://example.com/x)")).map { $0.url.absoluteString },
                       ["https://example.com/x"])
    }

    func testTheTimelineFastPathLinksLetterIdsToo() {
        let out = TimelineTextStyler.inlineText("Letter \(id) is waiting, see `\(id)`")
        var found: [URL] = []
        out.enumerateAttribute(.link, in: NSRange(location: 0, length: out.length)) { value, _, _ in
            if let url = value as? URL { found.append(url) }
        }
        XCTAssertEqual(found.compactMap { LetterMentionLink.letterID(from: $0) }, [id, id])
    }

    func testAnAgentMarkdownTurnCarriesTheLetterLink() {
        let blocks = LetterMarkdownBody.blocks(for: "Done. See \(id) for the details.")
        let linked = blocks.flatMap { block -> [String] in
            guard case .paragraph(let text) = block.kind else { return [] }
            return links(text).compactMap { LetterMentionLink.letterID(from: $0.url) }
        }
        XCTAssertEqual(linked, [id])
    }

    func testTheEnvelopePreviewUsesTheSharedRenderer() {
        let preview = LetterEnvelopeRow.preview("Reply to \(id): **ready**")
        XCTAssertEqual(links(preview).compactMap { LetterMentionLink.letterID(from: $0.url) }, [id])
        XCTAssertEqual(String(preview.characters), "Reply to \(id): ready", "markdown is drawn, not shown")
    }

    // MARK: - Code shown as written

    private let codeTaskID = "mvu0ubnq-a02d"

    private func codeResolver() -> TaskMentionResolver {
        let resolver = TaskMentionResolver()
        resolver.update([codeTaskID: "Login fix"])
        return resolver
    }

    func testLiteralCodeKeepsEveryCharacter() {
        // U+4FE1 U+4EF6 U+3002: CJK prose beside a path, which must stay as written too.
        let code = [
            "`raw` *stars* **bold** _under_ ~~gone~~ <u>u</u> line<br>break [[Note|alias]]",
            "<task-ref id=\"\(codeTaskID)\" label=\"Phone\"/> [\(codeTaskID)|Phone] \(codeTaskID)",
            "cat /tmp/run/report.md:42\u{4FE1}\u{4EF6}\u{3002} https://example.com/a?b=1 \(id)",
            "    indented\ttab\\back\n",
        ].joined(separator: "\n")
        let rendered = MarkdownParser.literalCode(code, resolver: codeResolver())
        XCTAssertEqual(String(rendered.characters), code, "a code block drew other characters than it holds")
        XCTAssertFalse(rendered.runs.contains { $0.inlinePresentationIntent != nil }, "code was styled as markdown")
    }

    func testLiteralCodeLinksWhatTheInlineRendererLinks() {
        let line = "see /tmp/run/report.md:42 and https://example.com/a then \(id) for \(codeTaskID)"
        let resolver = codeResolver()
        var inline = AttributedString(line)
        TaskMentions.apply(&inline, resolver: resolver)
        MarkdownParser.linkifyBareURLs(&inline)
        MarkdownParser.linkifyPreviewableFilePaths(&inline)
        MarkdownParser.linkifyLetterIDs(&inline)
        let literal = MarkdownParser.literalCode(line, resolver: resolver)
        XCTAssertEqual(links(literal).map(\.url), links(inline).map(\.url), "code links differ from prose links")
        XCTAssertEqual(links(literal).map(\.text),
                       ["/tmp/run/report.md:42", "https://example.com/a", id, codeTaskID])
        let task = links(literal).last
        XCTAssertEqual(task.flatMap { TaskMentionLink.taskID(from: $0.url) }, codeTaskID)
    }

    func testLiteralCodeNeverOverridesALinkAlreadyThere() {
        let resolver = codeResolver()
        let url = MarkdownParser.literalCode("curl https://example.com/inbox/\(id)/\(codeTaskID)", resolver: resolver)
        XCTAssertEqual(links(url).map { $0.url.scheme }, ["https"], "an id inside a URL took the URL's link")
        let path = MarkdownParser.literalCode("ls /tmp/\(id)/report.md", resolver: resolver)
        XCTAssertEqual(links(path).count, 1)
        XCTAssertEqual(links(path).first?.text, "/tmp/\(id)/report.md", "an id inside a path split the path's link")
        XCTAssertNil(links(path).first.flatMap { LetterMentionLink.letterID(from: $0.url) })
    }

    /// The real timeline cell: the code is drawn as written, in the code font, and a tap on its
    /// link reaches the controller; a reused cell sends nothing to the row it drew before.
    func testTheTimelineCodeCellDrawsTheCodeAndRoutesItsLinks() throws {
        let code = "`raw` *stars* cat /tmp/run/report.md:42 then \(id)\n" + String(repeating: "wide ", count: 60)
        let cell = TimelineCodeCell(frame: CGRect(x: 0, y: 0, width: 390, height: 120))
        let spy = SpyDelegate()
        let colored = NSAttributedString(string: code, attributes: [.font: TimelineTextStyler.codeFont, .foregroundColor: UIColor.label])
        cell.configure(TimelineCodeBlock(text: code, attributed: colored, label: "Text",
                                         contentSize: CGSize(width: 1_400, height: 40), wrapped: false), delegate: spy)
        cell.layoutIfNeeded()
        let textView = try XCTUnwrap(descendants(of: cell).compactMap { $0 as? TimelineTextView }.first)
        let scroll = try XCTUnwrap(descendants(of: cell).first { $0 is UIScrollView && !($0 is UITextView) } as? UIScrollView)
        XCTAssertEqual(textView.attributedText.string, code)
        XCTAssertGreaterThan(scroll.contentSize.width, scroll.bounds.width, "a long line must scroll, not wrap")
        var found: [(URL, NSRange)] = []
        let all = NSRange(location: 0, length: textView.attributedText.length)
        textView.attributedText.enumerateAttribute(.link, in: all) { value, range, _ in
            if let url = value as? URL { found.append((url, range)) }
        }
        textView.attributedText.enumerateAttribute(.font, in: all) { value, _, _ in
            XCTAssertEqual((value as? UIFont)?.fontName, TimelineTextStyler.codeFont.fontName, "the code font changed")
        }
        XCTAssertEqual(found.count, 2)
        let file = try XCTUnwrap(found.first)
        _ = textView.delegate?.textView?(textView, shouldInteractWith: file.0, in: file.1, interaction: .invokeDefaultAction)
        guard case .openURL(let opened)? = spy.actions.last else { return XCTFail("the code link never reached the controller") }
        XCTAssertEqual(opened, file.0)
        guard case .previewFile? = routed(opened).first else { return XCTFail("the code's path is not a file link") }
        scroll.contentOffset = CGPoint(x: 300, y: 0)
        cell.prepareForReuse()
        XCTAssertEqual(scroll.contentOffset, .zero, "a reused cell kept the last row's scroll")
        _ = textView.delegate?.textView?(textView, shouldInteractWith: file.0, in: file.1, interaction: .invokeDefaultAction)
        XCTAssertEqual(spy.actions.count, 1, "a reused cell sent a tap to the row it drew before")
    }

    private func descendants(of view: UIView) -> [UIView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    // MARK: - Routing a tap

    private func routed(_ url: URL) -> [TimelineRowAction] {
        let controller = TimelineCollectionController()
        var actions: [TimelineRowAction] = []
        controller.onAction = { actions.append($0) }
        controller.timelineCell(didRequest: .openURL(url))
        return actions
    }

    func testTheTimelineOpensALetterLinkInItsSheet() throws {
        for url in [try XCTUnwrap(LetterMentionLink.url(for: id)), try XCTUnwrap(URL(string: "letter:\(id)"))] {
            let actions = routed(url)
            guard case .openLetter(let opened)? = actions.first, actions.count == 1 else {
                return XCTFail("\(url) did not become openLetter: \(actions)")
            }
            XCTAssertEqual(opened, id)
        }
    }

    func testOtherLinksKeepTheirOwnRoutes() {
        let task = routed(TaskMentionLink.url(for: "mvu0ubnq-a02d")!)
        guard case .openTask? = task.first else { return XCTFail("a task link: \(task)") }
        let file = routed(FilePreviewLink.url(for: FilePathRef(path: "/tmp/run/report.md"))!)
        guard case .previewFile? = file.first else { return XCTFail("a file link: \(file)") }
    }

    func testALetterLinkNeverArmsTheTabMailbox() throws {
        LetterDeepLink.shared.clear()
        _ = routed(try XCTUnwrap(LetterMentionLink.url(for: id)))
        XCTAssertNil(LetterDeepLink.shared.pending, "a link tap must open here, not switch tabs")
    }

    private final class SpyDelegate: TimelineCellActionDelegate {
        var actions: [TimelineRowAction] = []
        func timelineCell(didRequest action: TimelineRowAction) { actions.append(action) }
    }

    /// Hosted timeline content hands a letter link to the controller like any other.
    func testHostedTimelineContentHandsALetterLinkToTheController() throws {
        let spy = SpyDelegate()
        let url = try XCTUnwrap(LetterMentionLink.url(for: id))
        XCTAssertTrue(TimelineHostedCell.handleHostedLink(url, delegate: spy))
        guard case .openURL(let routed)? = spy.actions.first else {
            return XCTFail("a letter link in hosted content never reached the delegate")
        }
        XCTAssertEqual(LetterMentionLink.letterID(from: routed), id)
    }

    // MARK: - Source ratchets

    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// The code lines of `source` (comments dropped) from the first line containing
    /// `start` up to the first one after it containing `end`.
    private func section(_ source: String, from start: String, to end: String) throws -> String {
        let lines = source.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        let first = try XCTUnwrap(lines.firstIndex { $0.contains(start) }, "no \(start)")
        let last = try XCTUnwrap(lines[(first + 1)...].firstIndex { $0.contains(end) }, "no \(end) after \(start)")
        return lines[first..<last].joined(separator: "\n")
    }

    /// A plain-text thread turn: the human's words stay `Text`, an agent's go through
    /// the shared letter renderer, each with its own identifier.
    func testAPlainThreadTurnRendersHumanTextAndAgentMarkdownApart() throws {
        let branch = try section(try source("Views/Inbox/LetterThreadView.swift"),
                                 from: "else if let text = entry.text", to: "else if entry.bodyFile")
        let human = try section(branch, from: "if entry.isPersonWritten", to: "} else {")
        XCTAssertTrue(human.contains("Text(text)"), "the human's words must stay plain text:\n\(human)")
        XCTAssertTrue(human.contains("\"inbox.letter.humanTurn\""))
        XCTAssertFalse(human.contains("LetterMarkdownBody"))
        let agent = try XCTUnwrap(branch.components(separatedBy: "} else {").dropFirst().first,
                                  "no agent branch:\n\(branch)")
        XCTAssertTrue(agent.contains("LetterMarkdownBody(markdown: text)"),
                      "an agent's plain turn must take the shared renderer:\n\(agent)")
        XCTAssertTrue(agent.contains("\"inbox.letter.agentTurn\""))
        XCTAssertFalse(agent.contains("Text(text)"), "an agent's turn drawn as plain text again")
    }

    /// Every Swift file of the app, relative to `Walnut/`, in a fixed order.
    private func appSources() throws -> [(rel: String, source: String)] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        var out: [(rel: String, source: String)] = []
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        for case let url as URL in files where url.pathExtension == "swift" {
            out.append((String(url.path.dropFirst(root.path.count + 1)), try String(contentsOf: url, encoding: .utf8)))
        }
        return out.sorted { $0.rel < $1.rel }
    }

    /// Agent words never reach a plain `Text`/`Label`/`Button` title (`AgentTextTaint`); each exception says why,
    /// and one that no longer matches anything fails too.
    func testAgentTextFieldsNeverDrawAsPlainText() throws {
        let allowed: [String: String] = [
            "Views/Inbox/LetterReaderView.swift|displayBody":
                "bodyMissing: the body is Walnut's own missing-body note (missingBodyNote), not the agent's document",
            "Views/Inbox/LetterThreadView.swift|text":
                "the human's own turn; the agent branch is pinned by testAPlainThreadTurnRendersHumanTextAndAgentMarkdownApart",
            "Views/Settings/VoiceHistoryView.swift|entry.text": "the user's own voice transcript",
            "Views/Settings/VoiceHistoryDetailView.swift|text": "the user's own voice transcript (model.entry.text)",
            "Talk/TalkSetupView.swift|entry.text": "only tests entry.text; draws Walnut's own status and button words",
            "Talk/TalkSetupView.swift|text": "the user's own unsent voice words (talk.outbox entry.text)",
        ]
        let hits = AgentTextTaint().plainSites(try appSources())
        for hit in hits where allowed[hit.key] == nil {
            XCTFail("\(hit.key) (line \(hit.line)) draws agent text as plain Text: use MarkdownParser.inline + .handlingFilePathLinks() or LetterMarkdownBody, or list it here with why:\n\(hit.code)")
        }
        let found = Set(hits.map(\.key))
        for key in allowed.keys where !found.contains(key) {
            XCTFail("stale exception, nothing matches it any more: \(key)")
        }
    }

    /// Each fixture reaches a `Text`, `Label` or `Button` title in a way an earlier pass missed; `NewRendered` stays clean.
    func testTheTaintPassFindsNewAgentTextAndPassesRenderedText() {
        let sources: [(rel: String, source: String)] = [
            ("New/Words.swift", #"""
            struct NewCard: View {
                let task: WalnutTask
                var body: some View {
                    let words = task.userStatus?.ask ?? ""
                    Text(words)
                }
            }
            """#),
            ("New/Helper.swift", #"""
            enum NewModel {
                static func line(_ t: WalnutTask) -> String? {
                    t.userStatus?.waitingOn
                }
            }
            struct NewRow: View {
                let task: WalnutTask
                var body: some View {
                    if let l = NewModel.line(task) { Text(l) }
                }
            }
            """#),
            ("New/Prop.swift", #"""
            struct NewDetailRow: View {
                var detail: String? = nil
                var body: some View {
                    if let detail { Text(detail) }
                }
            }
            struct NewList: View {
                let task: WalnutTask
                var body: some View { NewDetailRow(detail: task.resultReport?.result) }
            }
            """#),
            ("New/TopLevel.swift", #"""
            func newTopLine(_ t: WalnutTask) -> String {
                t.userStatus?.ask ?? ""
            }
            struct NewTopRow: View {
                let task: WalnutTask
                var body: some View { Text(newTopLine(task)) }
            }
            """#),
            ("New/Computed.swift", #"""
            struct NewComputed: View {
                let task: WalnutTask
                private var words: String { task.userStatus?.now ?? "" }
                var body: some View { Text(words) }
            }
            """#),
            ("New/Multiline.swift", #"""
            struct NewMultiline: View {
                let task: WalnutTask
                var body: some View {
                    Text(
                        task.userStatus?.ask ?? ""
                    )
                }
            }
            """#),
            ("New/Attributed.swift", #"""
            struct NewAttributed: View {
                let task: WalnutTask
                static func highlighted(_ s: String) -> AttributedString {
                    var a = AttributedString(s)
                    a.foregroundColor = .red
                    return a
                }
                var body: some View {
                    Text(AttributedString(task.userStatus?.ask ?? ""))
                    Text(Self.highlighted(task.userStatus?.next ?? ""))
                    Text(Self.boldAsk(task))
                }
                static func boldAsk(_ t: WalnutTask) -> AttributedString {
                    AttributedString(t.userStatus?.ask ?? "")
                }
            }
            """#),
            // The team brief's shape: only a map closure's result flows; `titles()`'s `lines` stays clean.
            ("New/Brief.swift", #"""
            enum NewBriefModel {
                static func clause(_ text: String) -> String {
                    var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    while t.hasSuffix(".") { t.removeLast() }
                    return t
                }
            }
            struct NewBrief: View {
                let b: TeamStatusBoard
                private func brief() -> some View {
                    let lines = b.needs.map { r -> String in
                        let ask = NewBriefModel.clause(r.status?.ask ?? "")
                        let title = NewBriefModel.clause(r.task.title)
                        return ask.isEmpty ? title : "\(title) (\(ask))"
                    }
                    return (Text("\(b.needs.count) need you: ").bold()
                        + Text(lines.joined(separator: "; ") + "."))
                }
                private func titles() -> some View {
                    let lines = b.needs.map { r -> String in
                        print(r.status?.ask ?? "")
                        return NewBriefModel.clause(r.task.title)
                    }
                    return Text(lines.joined(separator: "; "))
                }
            }
            """#),
            ("New/Controls.swift", #"""
            struct NewControls: View {
                let task: WalnutTask
                var body: some View {
                    Label(task.userStatus?.ask ?? "", systemImage: "questionmark")
                    Button(task.userStatus?.waitingOn ?? "") { open() }
                    Button("Open") { share(task.userStatus?.ask ?? "") }
                }
            }
            """#),
            ("New/Rendered.swift", #"""
            struct NewRendered: View {
                let task: WalnutTask
                let text: String
                static func linked(_ s: String) -> AttributedString {
                    MarkdownParser.inline(s)
                }
                func other() {
                    let line = task.userStatus?.ask ?? ""
                    print(line)
                }
                var body: some View {
                    let words = task.userStatus?.ask ?? ""
                    Text(MarkdownParser.inline(words)).handlingFilePathLinks()
                    Text(Self.linked(task.userStatus?.now ?? ""))
                    let line = "Saved"
                    Text(line)
                    Text(text)
                    if let l = NewModel.line(task) { Text(MarkdownParser.inline(l)) }
                    Text("\(TeamStatusModel.state(of: task).label)")
                }
            }
            """#),
        ]
        let hits = AgentTextTaint().plainSites(sources).map { "\($0.key):\($0.line)" }
        XCTAssertEqual(hits, [
            "New/Words.swift|words:5", "New/Helper.swift|l:9", "New/Prop.swift|detail:4",
            "New/TopLevel.swift|newTopLine:6", "New/Computed.swift|words:4", "New/Multiline.swift|ask:4",
            "New/Attributed.swift|ask:9", "New/Attributed.swift|next:10", "New/Attributed.swift|boldAsk:11",
            "New/Brief.swift|lines:17", "New/Controls.swift|ask:4", "New/Controls.swift|waitingOn:5",
        ])
    }

    /// The three converted rows are found again if drawn plain: the guard reads the source, not a file list.
    func testTheConvertedRowsWouldBeFoundIfDrawnPlainAgain() throws {
        let reverted = try appSources().map { file -> (rel: String, source: String) in
            guard file.rel == "Views/Org/OrgNodeTasksView.swift" || file.rel == "Views/Tasks/TeamStatusViews.swift" else { return file }
            return (file.rel, file.source
                .replacingOccurrences(of: "Text(MarkdownParser.inline(line))", with: "Text(line)")
                .replacingOccurrences(of: "Text(MarkdownParser.inline(detail))", with: "Text(detail)"))
        }
        let keys = Set(AgentTextTaint().plainSites(reverted).map(\.key))
        for key in ["Views/Org/OrgNodeTasksView.swift|line", "Views/Tasks/TeamStatusViews.swift|detail",
                    "Views/Tasks/TeamStatusViews.swift|line"] {
            XCTAssertTrue(keys.contains(key), "the taint pass misses \(key) drawn as plain Text: \(keys.sorted())")
        }
    }

    /// A tuple helper's String element carries words across files and wrappers; its other elements,
    /// a String element built from no source and a mapping that reads no element do not.
    func testTheTaintPassFollowsATuplesTextElement() {
        let sources: [(rel: String, source: String)] = [
            ("Tuple/Model.swift", #"""
            enum TupleModel {
                static func lineWithField(_ t: WalnutTask) -> (text: String, field: LinkSource.TaskTextField)? {
                    let s = t.userStatus
                    if let now = s?.now?.trimmingCharacters(in: .whitespacesAndNewlines), !now.isEmpty { return (now, .now) }
                    return nil
                }
                static func line(_ t: WalnutTask) -> String? { lineWithField(t)?.text }
                static func pair(_ t: WalnutTask) -> (String, String) { ("Walnut", t.userStatus?.ask ?? "") }
                static func fixed(_ t: WalnutTask) -> (title: String, id: String) { (t.title, t.id) }
                static func kind(_ t: WalnutTask) -> String? { lineWithField(t).map { "\($0.field)" } }
            }
            """#),
            ("Tuple/Wrapper.swift", #"""
            extension TupleModel {
                static func wrapped(_ t: WalnutTask) -> (text: String, field: LinkSource.TaskTextField)? { lineWithField(t) }
                static func relay(_ t: WalnutTask) -> String? { wrapped(t)?.text }
                static func relayField(_ t: WalnutTask) -> String? { wrapped(t).map(\.field).map { "\($0)" } }
            }
            """#),
            ("Tuple/View.swift", #"""
            struct TupleRow: View {
                let task: WalnutTask
                var body: some View {
                    if let line = TupleModel.line(task) { Text(line) }
                    Text(TupleModel.lineWithField(task)?.text ?? "")
                    Text(TupleModel.wrapped(task).map { $0.text } ?? "")
                    if let again = TupleModel.relay(task) { Text(again) }
                    Text(TupleModel.pair(task).1)
                    Text(TupleModel.pair(task).0)
                    Text("\(TupleModel.lineWithField(task)?.field ?? .now)")
                    Text(TupleModel.kind(task) ?? "")
                    Text(TupleModel.relayField(task) ?? "")
                    Text(TupleModel.fixed(task).title)
                    if let line = TupleModel.line(task) { Text(MarkdownParser.inline(line)).handlingFilePathLinks() }
                }
            }
            """#),
        ]
        let hits = AgentTextTaint().plainSites(sources).map { "\($0.key):\($0.line)" }
        XCTAssertEqual(hits, [
            "Tuple/View.swift|line:4", "Tuple/View.swift|TupleModel.lineWithField.text:5",
            "Tuple/View.swift|TupleModel.wrapped.text:6", "Tuple/View.swift|again:7", "Tuple/View.swift|TupleModel.pair.1:8",
        ])
    }

    /// A tuple return read whole across lines and per element through a mapping closure; the text
    /// element read through any mapping closure form and String transform, never `.field` or an
    /// element built from no source.
    func testTheTaintPassReadsTupleReturnsAndMappedProjections() {
        let sources: [(rel: String, source: String)] = [
            ("Mapped/Model.swift", #"""
            enum MappedModel {
                static func lineWithField(_ t: WalnutTask) -> (text: String, field: LinkSource.TaskTextField)? {
                    let ask = t.userStatus?.ask ?? ""
                    return ask.isEmpty
                        ? nil
                        : (ask, .needs)
                }
                static func pick(_ ts: [WalnutTask]) -> (title: String, words: String)? {
                    ts.first.map { (title: $0.title, words: $0.userStatus?.ask ?? "") }
                }
            }
            """#),
            ("Mapped/View.swift", #"""
            struct MappedRow: View {
                let task: WalnutTask
                let tasks: [WalnutTask]
                var body: some View {
                    Text(MappedModel.lineWithField(task).map { $0.text.uppercased() } ?? "")
                    Text(MappedModel.lineWithField(task).map({ $0.text }) ?? "")
                    Text(MappedModel.lineWithField(task).map { r in r.text } ?? "")
                    Text(MappedModel.lineWithField(task).map { r in r.field.rawValue } ?? "")
                    Text(MappedModel.pick(tasks)?.words ?? "")
                    Text(MappedModel.pick(tasks)?.title ?? "")
                }
            }
            """#),
        ]
        let hits = AgentTextTaint().plainSites(sources).map { "\($0.key):\($0.line)" }
        XCTAssertEqual(hits, [
            "Mapped/View.swift|MappedModel.lineWithField.text:5", "Mapped/View.swift|MappedModel.lineWithField.text:6",
            "Mapped/View.swift|MappedModel.lineWithField.text:7", "Mapped/View.swift|MappedModel.pick.words:9",
        ])
    }

    /// The Org and team rows' shape, a String line read off a tuple helper: clean while rendered,
    /// found again in both files once drawn plain.
    func testTheTupleLineRowsAreFoundOnlyWhenDrawnPlain() {
        let rendered: [(rel: String, source: String)] = [
            ("Probe/Model.swift", #"""
            enum ProbeTasksModel {
                static func line(_ t: WalnutTask) -> String? { lineWithField(t)?.text }
                static func lineSource(_ t: WalnutTask) -> LinkSource {
                    lineWithField(t).map { LinkSource.forTaskText(t, $0.field) } ?? .unknown
                }
                static func lineWithField(_ t: WalnutTask) -> (text: String, field: LinkSource.TaskTextField)? {
                    let state = TeamStatusModel.state(of: t)
                    let s = t.userStatus
                    if state == .done { return nil }
                    if state == .needs, let need = TeamStatusModel.needLine(s) { return ("\(need.category.label): \(need.text)", .needs) }
                    return nil
                }
            }
            """#),
            ("Probe/OrgView.swift", #"""
            struct ProbeOrgRow: View {
                let task: WalnutTask
                var body: some View {
                    if let line = ProbeTasksModel.line(task) {
                        Text(MarkdownParser.inline(line))
                            .handlingFilePathLinks(source: ProbeTasksModel.lineSource(task))
                    }
                }
            }
            """#),
            ("Probe/TeamView.swift", #"""
            struct ProbeTeamRow: View {
                let row: TeamStatusRow
                var body: some View {
                    if row.task.title.isEmpty {
                        Text("Untitled")
                    } else if let line = ProbeTasksModel.line(row.task) {
                        Text(MarkdownParser.inline(line))
                            .handlingFilePathLinks(task: row.task)
                    }
                }
            }
            """#),
        ]
        XCTAssertEqual(AgentTextTaint().plainSites(rendered).map(\.key), [])
        let plain = rendered.map { ($0.rel, $0.source.replacingOccurrences(of: "Text(MarkdownParser.inline(line))", with: "Text(line)")) }
        XCTAssertEqual(AgentTextTaint().plainSites(plain).map { "\($0.key):\($0.line)" },
                       ["Probe/OrgView.swift|line:5", "Probe/TeamView.swift|line:7"])
    }

    /// The agent-text sites moved to the shared renderer route their links in place.
    func testConvertedAgentTextSitesRouteTheirLinks() throws {
        // Each site routes against the place its words were written, never the primary by default.
        let sites = [
            ("Views/Inbox/LetterReaderView.swift", "MarkdownParser.inline(letter.previewLine)",
             ".handlingFilePathLinks(source: letter.linkSource)"),
            ("Views/Tasks/TaskDetailSheet.swift", "MarkdownParser.inline(summary)", ".handlingFilePathLinks(task: current, field: .summary)"),
            ("Views/Inbox/EmailItemCard.swift", "MarkdownParser.inline(item.summary)",
             ".handlingFilePathLinks(source: linkSource)"),
            ("Views/Sessions/SessionExtrasSheets.swift", "MarkdownParser.inline(question.answer)",
             ".handlingFilePathLinks(sessionID: sessionId)"),
            ("Views/Inbox/LetterEnvelopeRow.swift", "Text(Self.preview(letter.previewLine))",
             ".handlingFilePathLinks(source: letter.linkSource)"),
        ]
        for (file, call, routing) in sites {
            let lines = try source(file).components(separatedBy: "\n")
            let at = try XCTUnwrap(lines.firstIndex { $0.contains(call) }, "\(file): no \(call)")
            let after = lines[at..<min(lines.count, at + 7)].joined(separator: "\n")
            XCTAssertTrue(after.contains(routing), "\(file): \(call) without \(routing):\n\(after)")
        }
        // The Org task row and the team row: the binding, the shared renderer, then its link routing.
        let rows = [
            ("Views/Org/OrgNodeTasksView.swift", "if let line = OrgNodeTasksModel.line(task) {", "Text(MarkdownParser.inline(line))"),
            ("Views/Tasks/TeamStatusViews.swift", "} else if let detail, !detail.isEmpty {", "Text(MarkdownParser.inline(detail))"),
            ("Views/Tasks/TeamStatusViews.swift", "} else if let line = OrgNodeTasksModel.line(row.task) {", "Text(MarkdownParser.inline(line))"),
        ]
        for (file, binding, call) in rows {
            let lines = try source(file).components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            let at = try XCTUnwrap(lines.firstIndex(of: binding), "\(file): no \(binding)")
            XCTAssertEqual(lines[at + 1], call, "\(file): \(binding) must draw through \(call)")
            // The handler may name the task or host it resolves paths against, but it must close the
            // Text's modifier chain, after every colour (LinkSheetStyleTests): a sheet it opens inherits them.
            let chain = Array(lines[(at + 2)...].prefix { $0.hasPrefix(".") || $0.hasPrefix("//") })
            XCTAssertTrue(chain.contains { $0.hasPrefix(".handlingFilePathLinks(") }, "\(file): \(call) routes no links: \(chain)")
        }
        // The status card: every line of the session's words renders, one handler for the card.
        let card = try section(try source("Views/Tasks/TeamStatusViews.swift"),
                               from: "struct TaskStatusCard: View", to: "struct CheckedCaption: View")
        for call in ["MarkdownParser.inline(need.text)", "MarkdownParser.inline(now)", "MarkdownParser.inline(next)",
                     "MarkdownParser.inline((report.notDone"] {
            XCTAssertTrue(card.contains(call), "TaskStatusCard: no \(call)")
        }
        XCTAssertTrue(card.contains(".handlingFilePathLinks("), "TaskStatusCard routes no links")
    }

    /// The View types of `source`, each as its name and its code lines (comments dropped), split at top-level declarations.
    private func viewTypes(_ source: String) -> [(name: String, code: String)] {
        let decl = try! NSRegularExpression(pattern: #"^(?:@\w+ )*(?:private |fileprivate )?struct (\w+)[^{]*:\s*[^{]*\bView\b"#)
        var out: [(name: String, code: String)] = []
        var name: String?
        var body: [String] = []
        for line in source.components(separatedBy: "\n") {
            if let first = line.first, !first.isWhitespace, first != "}", first != "/" {
                if let name { out.append((name, body.joined(separator: "\n"))) }
                body = []
                let range = NSRange(line.startIndex..., in: line)
                name = decl.firstMatch(in: line, range: range).flatMap { Range($0.range(at: 1), in: line) }.map { String(line[$0]) }
            }
            if !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { body.append(line) }
        }
        if let name { out.append((name, body.joined(separator: "\n"))) }
        return out
    }

    /// The class: a View that knows where its words came from (it holds a session id, or it is an
    /// Inbox view, where every agent word rides a letter) never routes their paths with no source,
    /// which would open them against the primary by guess.
    func testViewsThatKnowTheirSourceNeverRouteLinksWithout() throws {
        var checked = 0
        var bare: [String] = []
        for file in try appSources() {
            for view in viewTypes(file.source) {
                let holdsSession = view.code.contains("let sessionId: String") || view.code.contains("let sessionID: String")
                guard holdsSession || file.rel.hasPrefix("Views/Inbox/") else { continue }
                checked += 1
                if view.code.contains(".handlingFilePathLinks()") { bare.append("\(file.rel) \(view.name)") }
            }
        }
        XCTAssertGreaterThan(checked, 5, "the scan found almost no views: the split is broken")
        XCTAssertEqual(bare, [], "these views know their source but route links with none: pass it")
        // The scan sees a reverted site again.
        let reverted = try source("Views/Sessions/SessionExtrasSheets.swift")
            .replacingOccurrences(of: ".handlingFilePathLinks(sessionID: sessionId)", with: ".handlingFilePathLinks()")
        let sheet = try XCTUnwrap(viewTypes(reverted).first { $0.name == "SideQuestionsSheet" }, "no SideQuestionsSheet")
        XCTAssertTrue(sheet.code.contains(".handlingFilePathLinks()"))
    }

    /// An email item's summary opens its paths from the letter or the thread turn that carried it.
    func testEmailItemsCarryTheirLettersSource() throws {
        let card = try source("Views/Inbox/EmailItemCard.swift")
        // Required, with no default, so a new caller cannot forget it.
        XCTAssertTrue(card.contains("    let linkSource: LinkSource\n"), "EmailItemCard must require its linkSource")
        XCTAssertTrue(card.contains(".handlingFilePathLinks(source: linkSource)"))
        let list = try source("Views/Inbox/EmailItemsView.swift")
        XCTAssertTrue(list.contains("    let linkSource: LinkSource\n"), "EmailItemsView must require its linkSource")
        XCTAssertTrue(list.contains("EmailItemCard(letterId: letterId, item: item, linkSource: linkSource"))
        let flat = { (s: String) in s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ") }
        XCTAssertTrue(flat(try source("Views/Inbox/LetterReaderView.swift"))
            .contains("EmailItemsView(letterId: letterId, items: letter.items ?? [], linkSource: letter.linkSource,"),
                      "the letter's own items: the letter's source")
        XCTAssertTrue(flat(try source("Views/Inbox/LetterThreadView.swift"))
            .contains("EmailItemsView(letterId: letter.id, items: entry.items ?? [], linkSource: letter.linkSource(for: entry),"),
                      "a thread turn's items: that turn's source")
        // Every construction in the app names a source.
        for file in try appSources() {
            let text = flat(file.source)
            for call in ["EmailItemsView(", "EmailItemCard("] {
                for part in text.components(separatedBy: call).dropFirst() where !part.hasPrefix(")") {
                    let args = part.prefix { $0 != ")" }
                    guard args.contains("letterId:") else { continue }
                    XCTAssertTrue(args.contains("linkSource:"), "\(file.rel): \(call)\(args)) names no source")
                }
            }
        }
    }

    /// Both real tap paths open a letter link in the sheet over the current screen.
    func testBothTapPathsOpenTheLetterSheetInPlace() throws {
        let handling = try section(try source("Views/Sessions/FileSourceLinesView.swift"),
                                   from: "struct FilePathLinkHandling", to: "extension View {")
        XCTAssertTrue(handling.contains("LetterMentionLink.letterID(from: url)"))
        XCTAssertTrue(handling.contains(".letterReaderSheet($letterTarget)"))
        let uiKit = try section(try source("Timeline/TimelineCollectionController.swift"),
                                from: "case .openURL(let url):", to: "UIApplication.shared.open(url)")
        let letter = try XCTUnwrap(uiKit.range(of: "onAction(.openLetter(id: letterID))"), "timeline: no letter routing")
        let task = try XCTUnwrap(uiKit.range(of: "TaskMentionLink.taskID(from: url)"))
        XCTAssertLessThan(letter.lowerBound, task.lowerBound)
        for body in ["Timeline/ChatTimelineBody.swift", "Timeline/SessionTimelineBody.swift"] {
            let text = try source(body)
            XCTAssertTrue(text.contains("case .openLetter(let id):"), "\(body) drops openLetter")
            XCTAssertTrue(text.contains(".letterReaderSheet($openedLetter)"), "\(body) has no letter sheet")
        }
        XCTAssertTrue(try source("Timeline/TimelineTextStyler.swift").contains("MarkdownParser.linkifyLetterIDs(&attributed)"))
        // No link path arms the tab mailbox: that is for a tapped push only.
        XCTAssertFalse(handling.contains("LetterDeepLink"))
        XCTAssertFalse(uiKit.contains("LetterDeepLink"))
    }
}
