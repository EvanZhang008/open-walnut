import XCTest
import UIKit
@testable import Walnut

/// The tasks a reply in Main's, a VP's or a lead's chat is about (`MessageAboutTag`),
/// case for case with the server's `tests/core/org/message-about.test.ts`: the line,
/// its ids, the streaming hold-back, how it sits with the agent-ack line, the wire
/// fields, and the pills under the reply. The last group is the guard for the whole
/// class: no timeline text path may show a raw `<walnut-about` line.
final class MessageAboutTagTests: XCTestCase {
    private let ack = TimelineTurnMarker.tag
    private let builder = TimelineRowBuilder()

    override func setUp() {
        super.setUp()
        TaskMentionResolver.shared.resetForTesting()
    }

    override func tearDown() {
        TaskMentionResolver.shared.resetForTesting()
        super.tearDown()
    }

    // MARK: - The line (readAboutTag)

    func testIsReadOffTheEndOutsideACodeBlockAndLeavesTheText() {
        XCTAssertEqual(MessageAboutTag.read("Done.\n\n<walnut-about tasks=\"mt-a-1,mt-b-2\"/>"),
                       .init(text: "Done.", ids: ["mt-a-1", "mt-b-2"], tagged: true))
        // Before the agent-ack line, or with spaces between the ids.
        XCTAssertEqual(MessageAboutTag.read("Ok\n<walnut-about tasks=\"mt-a-1 mt-b-2\"/>\n\(ack)").ids,
                       ["mt-a-1", "mt-b-2"])
        // In a code block, in a sentence, or far up the message: text.
        let fenced = "Use this:\n```\n<walnut-about tasks=\"mt-a-1\"/>\n```"
        XCTAssertEqual(MessageAboutTag.read(fenced), .init(text: fenced, ids: [], tagged: false))
        XCTAssertFalse(MessageAboutTag.read("Write <walnut-about tasks=\"mt-a-1\"/> at the end.").tagged)
        XCTAssertFalse(MessageAboutTag.read("<walnut-about tasks=\"mt-a-1\"/>\none\ntwo\nthree\nfour").tagged)
    }

    func testAFenceClosesOnlyOnItsOwnMarkAndALineOfItsOwnIndentedAtMostThree() {
        // ```` is not closed by ```, ~~~ not by ```.
        XCTAssertFalse(MessageAboutTag.read("````\n```\n<walnut-about tasks=\"mt-a-1\"/>").tagged)
        XCTAssertFalse(MessageAboutTag.read("~~~\n```\n<walnut-about tasks=\"mt-a-1\"/>").tagged)
        XCTAssertTrue(MessageAboutTag.read("```js\ncode\n```\n<walnut-about tasks=\"mt-a-1\"/>").tagged)
        // "```js" inside a block closes nothing.
        XCTAssertFalse(MessageAboutTag.read("```\ncode\n```js\n<walnut-about tasks=\"mt-a-1\"/>").tagged)
        XCTAssertTrue(MessageAboutTag.read("Done.\n   <walnut-about tasks=\"mt-a-1\"/>  ").tagged)
        XCTAssertFalse(MessageAboutTag.read("Done.\n    <walnut-about tasks=\"mt-a-1\"/>").tagged)
    }

    func testATagNamingNoTaskStillLeavesTheText() {
        XCTAssertEqual(MessageAboutTag.read("Done.\n<walnut-about tasks=\"\"/>"),
                       .init(text: "Done.", ids: [], tagged: true))
        XCTAssertEqual(MessageAboutTag.read(nil), .init(text: "", ids: [], tagged: false))
    }

    func testNamesEachIdOnceAtMostSixAndNothingThatIsNotAnId() {
        XCTAssertEqual(MessageAboutTag.ids("a1b, a1b ,x,\"y\", mt-c-3"), ["a1b", "mt-c-3"])
        XCTAssertEqual(MessageAboutTag.ids((0..<9).map { "mt-\($0)-x" }.joined(separator: ",")).count, 6)
        XCTAssertEqual(MessageAboutTag.ids("30165ed6-c7c4-5e68-a412-51d284b5c895"),
                       ["30165ed6-c7c4-5e68-a412-51d284b5c895"])
    }

    // MARK: - The streaming hold-back (stripAboutTag)

    func testNeverFlashesWhileItStreamsIn() {
        XCTAssertEqual(MessageAboutTag.strip("Done.\n<walnut-ab", streaming: true), "Done.")
        XCTAssertEqual(MessageAboutTag.strip("Done.\n<walnut-about tasks=\"mt-a", streaming: true), "Done.")
        XCTAssertEqual(MessageAboutTag.strip("Done.\n<walnut-ab", streaming: false), "Done.\n<walnut-ab")
        XCTAssertEqual(MessageAboutTag.strip("a < b", streaming: true), "a < b")
        // A whole line goes either way; a reply that is nothing yet but the line's start shows nothing.
        XCTAssertEqual(MessageAboutTag.strip("Done.\n<walnut-about tasks=\"mt-a-1\"/>"), "Done.")
        XCTAssertEqual(MessageAboutTag.strip("<walnut-ab", streaming: true), "")
    }

    // MARK: - Beside the agent-ack line

    func testTheAckLineIsReadWhereverTheTasksLineSits() {
        XCTAssertEqual(TimelineTurnMarker.read("Done.\n<walnut-about tasks=\"mt-a-1\"/>\n\(ack)"),
                       .init(text: "Done.", ack: true))
        XCTAssertEqual(TimelineTurnMarker.read("Done.\n\(ack)\n<walnut-about tasks=\"mt-a-1\"/>"),
                       .init(text: "Done.", ack: true))
        // The ack alone plus the tasks line is still an ack-only turn: it hides.
        XCTAssertEqual(TimelineTurnMarker.read("\(ack)\n<walnut-about tasks=\"mt-a-1\"/>"),
                       .init(text: "", ack: true))
        XCTAssertEqual(TimelineTurnMarker.strip("Done.\n\n<walnut-about tasks=\"mt-a-1\"/>"), "Done.")
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n<walnut-about tasks=\"mt-a-1\"/>\n<walnut-tu"), "Done.")
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n\n<walnut-abo"), "Done.\n")
    }

    func testACRLFReplyReadsAsTheServerReadsIt() {
        // "```\r" is no fence to the server's regex, and a CRLF line break still cuts.
        XCTAssertTrue(MessageAboutTag.read("```\r\nx\r\n<walnut-about tasks=\"mt-a-1\"/>\r").tagged)
        XCTAssertEqual(MessageAboutTag.strip("Done.\r\n<walnut-ab", streaming: true), "Done.\r")
        XCTAssertEqual(MessageAboutTag.read("Done.\r\n<walnut-about tasks=\"mt-a-1\"/>\r\n").text, "Done.")
    }

    @MainActor
    func testTheTurnEndReplyMatchesTheCanonicalRow() {
        let (text, about) = SessionConversationStore.provisionalReply(
            "The movers are booked.\n\n<walnut-about tasks=\"mt-move-1\"/>", truncated: false)
        XCTAssertEqual(text, "The movers are booked.")
        XCTAssertEqual(about, ["mt-move-1"])
        XCTAssertNil(SessionConversationStore.provisionalReply("Plain.", truncated: false).about)
        XCTAssertEqual(SessionConversationStore.provisionalReply("x", truncated: true).text, "")
    }

    // MARK: - The wire

    func testDecodesAboutFromATranscriptRowAndAChatRow() throws {
        let json = #"{"role":"assistant","text":"Done.","timestamp":"2026-10-31T10:00:05Z","about":["mt-move-1","mt-vp-2"],"aboutTagged":true}"#
        let row = try JSONDecoder().decode(SessionTranscript.Message.self, from: Data(json.utf8))
        XCTAssertEqual(row.about, ["mt-move-1", "mt-vp-2"])
        XCTAssertEqual(row.aboutTagged, true)
        let old = #"{"role":"assistant","text":"Done.","timestamp":"2026-10-31T10:00:05Z"}"#
        XCTAssertNil(try JSONDecoder().decode(SessionTranscript.Message.self, from: Data(old.utf8)).about)
        let chat = #"{"id":"m1","role":"assistant","text":"Done.","createdAt":"2026-10-31T10:00:05Z","about":["mt-a-1"]}"#
        XCTAssertEqual(try JSONDecoder().decode(ChatMessage.self, from: Data(chat.utf8)).about, ["mt-a-1"])
        var message = ChatMessage(id: "m1", role: "assistant", text: "x", createdAt: "t", kind: nil)
        message.about = ["mt-a-1"]
        XCTAssertEqual(message.replacingText("y").about, ["mt-a-1"])
    }

    // MARK: - The pills

    private func reply(_ text: String, about: [String]? = nil) -> ChatMessage {
        var m = ChatMessage(id: "r1", role: "assistant", text: text, createdAt: "2026-10-31T10:00:05Z", kind: nil)
        m.about = about
        return m
    }

    private func aboutText(_ rows: [TimelineRow]) -> NSAttributedString? {
        for row in rows where row.id.hasSuffix("#about") {
            if case .text(let text) = row.content { return text }
        }
        return nil
    }

    private func links(_ text: NSAttributedString) -> [URL] {
        var out: [URL] = []
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if let url = value as? URL, out.last != url { out.append(url) }
        }
        return out
    }

    func testDrawsTheTasksUnderAReplyInAnOrgChatWithLiveTitlesAndStates() throws {
        TaskMentionResolver.shared.update(["mt-move-1": "Plan the move", "mt-vp-2": "Home VP"],
                                          states: ["mt-move-1": UserState.working.rawValue])
        let rows = builder.rows(for: reply("The movers are booked.", about: ["mt-move-1", "mt-vp-2"]),
                                width: 390, expandedRowIDs: [], showAbout: true)
        let pills = try XCTUnwrap(aboutText(rows))
        XCTAssertEqual(pills.string, "About   \u{25CF}\u{00A0}Plan the move    \u{25CF}\u{00A0}Home VP")
        // VoiceOver hears the states as words, and a tap on the dot opens the task too.
        XCTAssertEqual(pills.attribute(.timelineSpoken, at: 0, effectiveRange: nil) as? String,
                       "About: Plan the move, Working. Home VP")
        let dotAt = (pills.string as NSString).range(of: "\u{25CF}").location
        XCTAssertEqual(pills.attribute(.link, at: dotAt, effectiveRange: nil) as? URL, TaskMentionLink.url(for: "mt-move-1"))
        // Each line is a full tap target, and a wrapped line starts under the first pill.
        let paragraph = pills.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertGreaterThanOrEqual(paragraph?.minimumLineHeight ?? 0, TimelineMetrics.aboutLineHeight)
        XCTAssertGreaterThan(paragraph?.headIndent ?? 0, 0)
        XCTAssertEqual(links(pills), ["mt-move-1", "mt-vp-2"].compactMap(TaskMentionLink.url(for:)))
        XCTAssertEqual(links(pills).compactMap(TaskMentionLink.taskID(from:)), ["mt-move-1", "mt-vp-2"])
        // The dot wears the task's state; one the phone does not know is grey.
        let dots = (pills.string as NSString)
        let first = dots.range(of: "\u{25CF}")
        XCTAssertEqual(pills.attribute(.foregroundColor, at: first.location, effectiveRange: nil) as? UIColor,
                       TimelineRowBuilder.aboutDotColor(.working))
        let second = dots.range(of: "\u{25CF}", range: NSRange(location: first.location + 1,
                                                                  length: dots.length - first.location - 1))
        XCTAssertEqual(pills.attribute(.foregroundColor, at: second.location, effectiveRange: nil) as? UIColor,
                       TimelineRowBuilder.aboutDotColor(nil))
        // A moved task redraws its dot: same characters, so the state rides the revision.
        let before = try XCTUnwrap(rows.last)
        TaskMentionResolver.shared.update(["mt-move-1": "Plan the move", "mt-vp-2": "Home VP"],
                                          states: ["mt-move-1": UserState.needs.rawValue])
        let after = try XCTUnwrap(builder.rows(for: reply("The movers are booked.", about: ["mt-move-1", "mt-vp-2"]),
                                               width: 390, expandedRowIDs: [], showAbout: true).last)
        XCTAssertEqual(before.id, after.id)
        XCTAssertEqual(before.contentKey, after.contentKey)
        XCTAssertNotEqual(before.revision, after.revision)
        // The pills come after the reply's own text, as their own row.
        XCTAssertEqual(rows.last?.id.hasSuffix("#about"), true)
        XCTAssertGreaterThan(rows.last?.height ?? 0, 0)
    }

    func testAFreshRowReadsItsOwnLineAndAnUnknownTaskShowsItsId() throws {
        let rows = builder.rows(for: reply("Done.\n<walnut-about tasks=\"mt-x-9\"/>"),
                                width: 390, expandedRowIDs: [], showAbout: true)
        XCTAssertEqual(try XCTUnwrap(aboutText(rows)).string, "About   \u{25CF}\u{00A0}mt-x-9")
    }

    func testOnlyAnOrgChatAndOnlyAReplyWithWordsShowsThem() {
        let tagged = reply("Done.\n<walnut-about tasks=\"mt-x-9\"/>", about: ["mt-x-9"])
        XCTAssertNil(aboutText(builder.rows(for: tagged, width: 390, expandedRowIDs: [])))
        XCTAssertNil(aboutText(builder.rows(for: reply("Done."), width: 390, expandedRowIDs: [], showAbout: true)))
        XCTAssertNil(aboutText(builder.rows(for: reply("<walnut-about tasks=\"mt-x-9\"/>"),
                                            width: 390, expandedRowIDs: [], showAbout: true)))
        var person = ChatMessage(id: "u1", role: "user", text: "Hi", createdAt: "t", kind: nil)
        person.about = ["mt-x-9"]
        XCTAssertNil(aboutText(builder.rows(for: person, width: 390, expandedRowIDs: [], showAbout: true)))
    }

    func testAPillRedrawsWhenItsTaskMovesAndAPlainMentionDoesNot() {
        let resolver = TaskMentionResolver.shared
        resolver.update(["mt-a-1": "A", "mt-b-2": "B"], states: ["mt-a-1": "working", "mt-b-2": "working"])
        _ = resolver.title(for: "mt-b-2") // a mention: title only
        _ = resolver.state(for: "mt-a-1") // a pill
        let version = resolver.version
        var statesVersion = resolver.statesVersion
        XCTAssertFalse(resolver.update(["mt-a-1": "A", "mt-b-2": "B"], states: ["mt-a-1": "working", "mt-b-2": "needs"]))
        XCTAssertEqual(resolver.statesVersion, statesVersion)
        XCTAssertTrue(resolver.update(["mt-a-1": "A", "mt-b-2": "B"], states: ["mt-a-1": "needs", "mt-b-2": "needs"]))
        XCTAssertNotEqual(resolver.statesVersion, statesVersion)
        // A state move never drops the parsed and measured text rows a rename would.
        XCTAssertEqual(resolver.version, version)
        statesVersion = resolver.statesVersion
        // A title-only update keeps the states it had.
        XCTAssertFalse(resolver.update(["mt-a-1": "A", "mt-b-2": "B"]))
        XCTAssertEqual(resolver.state(for: "mt-a-1"), "needs")
        XCTAssertEqual(resolver.statesVersion, statesVersion)
    }

    func testTheLayoutDrawsThePillsOnlyWhileTheChatIsAnOrgChat() async {
        let actor = TimelineLayoutActor()
        func input(_ on: Bool) -> TimelineInput {
            var i = TimelineInput(messages: [reply("Done.", about: ["mt-a-1"])], streaming: false,
                                  liveText: "", liveTextTruncated: false, activity: nil,
                                  showLoadEarlier: false, width: 390, expandedRowIDs: [])
            i.showMessageAbout = on
            return i
        }
        let on = await actor.buildSnapshot(input(true))
        XCTAssertTrue(on.rows.contains { $0.id.hasSuffix("#about") })
        let off = await actor.buildSnapshot(input(false))
        XCTAssertFalse(off.rows.contains { $0.id.hasSuffix("#about") })
        // A state move reaches the memoized pill row, and only it.
        TaskMentionResolver.shared.update(["mt-a-1": "A"], states: ["mt-a-1": "working"])
        let first = await actor.buildSnapshot(input(true)).rows.first { $0.id.hasSuffix("#about") }
        TaskMentionResolver.shared.update(["mt-a-1": "A"], states: ["mt-a-1": "needs"])
        let moved = await actor.buildSnapshot(input(true)).rows.first { $0.id.hasSuffix("#about") }
        XCTAssertNotNil(first)
        XCTAssertNotEqual(first?.revision, moved?.revision)
    }

    // MARK: - Guard: no timeline text path shows the raw line

    /// Every shape the line arrives in: alone, after the ack line, before it, in a rich
    /// reply, in a block-markdown reply, fresh with its ids, and half written.
    private let tagged: [String] = [
        "Done.\n\n<walnut-about tasks=\"mt-a-1,mt-b-2\"/>",
        "Done.\n<walnut-about tasks=\"mt-a-1\"/>\n<walnut-turn status=\"agent-ack\"/>",
        "Done.\n<walnut-turn status=\"agent-ack\"/>\n<walnut-about tasks=\"mt-a-1\"/>",
        "# Status\n\n- one\n- two\n\n<walnut-about tasks=\"mt-a-1\"/>",
        "Here:\n\n<div style=\"color:red\">card</div>\n\n<walnut-about tasks=\"mt-a-1\"/>",
        "| a | b |\n|---|---|\n| 1 | 2 |\n\n<walnut-about tasks=\"mt-a-1\"/>",
    ]
    private let partial: [String] = [
        "Done.\n<walnut-ab", "Done.\n<walnut-about tasks=\"mt-a", "Done.\n<walnut-about tasks=\"mt-a-1\"/>\n<walnut-t",
    ]

    private func shown(_ rows: [TimelineRow]) -> String {
        rows.map { row -> String in
            if case .text(let text) = row.content { return text.string }
            return String(describing: row.content)
        }.joined(separator: "\n")
    }

    func testNoTimelineTextPathShowsTheRawLine() async {
        for text in tagged {
            for showAbout in [false, true] {
                let rows = builder.rows(for: reply(text), width: 390, expandedRowIDs: [], showAbout: showAbout)
                XCTAssertFalse(shown(rows).contains("walnut-about"), "rows(for:) showAbout=\(showAbout): \(text)")
            }
            // Through the layout actor, turn shaping and folds included: a turn a person
            // started, and one a peer's message started (it folds to its answer).
            for sender in ["person", "agent"] {
                let actor = TimelineLayoutActor()
                var opener = ChatMessage(id: "u0", role: "user", text: "Status?", createdAt: "2026-10-31T10:00:00Z", kind: nil)
                opener.sentBy = sender
                let tool = ChatMessage(id: "t0", role: "assistant", text: "Bash", createdAt: "2026-10-31T10:00:01Z",
                                       kind: .tool, resultPreview: "ok")
                var input = TimelineInput(messages: [opener, tool, reply(text)], streaming: false, liveText: "",
                                          liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                                          width: 390, expandedRowIDs: [])
                input.showMessageAbout = true
                let snapshot = await actor.buildSnapshot(input)
                XCTAssertFalse(shown(snapshot.rows).contains("walnut-about"), "layout \(sender): \(text)")
            }
        }
        for text in tagged + partial {
            let live = builder.liveRows(liveText: text, storeTruncated: false, activity: nil, width: 390,
                                        tailRevision: 0, cachedHead: nil)
            XCTAssertFalse(shown(live.rows).contains("<walnut-ab"), "liveRows: \(text)")
            XCTAssertFalse(shown(live.rows).contains("walnut-about"), "liveRows: \(text)")
        }
    }

    @MainActor
    func testASearchSnippetDropsTheLine() {
        XCTAssertEqual(GlobalSearchSection.plainSnippet("…booked. <walnut-about tasks=\"mt-a-1\"/>"), "…booked. ")
    }

    /// The class, read from the source: every place that turns an assistant reply into
    /// drawn text is listed here with the strip it runs. A new one fails until it is.
    func testEveryPlaceThatDrawsAReplyStripsTheLine() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        // A reply's text reaching something that draws or speaks it.
        let sinks = ["assistantRows(", ".liveRows(", "LiveMarkdownBody(text:", "ChatMarkdownBody(text: message.text",
                     "ChatMarkdownBody(text: TimelineTurnMarker", "SpokenText.prepare("]
        // Each file, and the call that proves it strips (the layout actor hands the live
        // text to the builder, whose entry strips: asserted below).
        let known: [String: [String]] = [
            "Timeline/TimelineRowBuilder.swift": ["let shown = TimelineTurnMarker.strip(message.text)"],
            "Timeline/TimelineLayoutActor.swift": [],
            "Views/Chat/MessageRow.swift": ["LiveMarkdownBody(text: TimelineTurnMarker.stripLive(message.text)",
                                            "ChatMarkdownBody(text: TimelineTurnMarker.strip(message.text))"],
            "Stores/VoiceModeController.swift": ["SpokenText.prepare(TimelineTurnMarker.strip(row.text))"],
        ]
        var found: Set<String> = []
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        for case let url as URL in files where url.pathExtension == "swift" {
            let source = try String(contentsOf: url, encoding: .utf8)
            let lines = source.components(separatedBy: "\n")
                .filter { line in sinks.contains { line.contains($0) } && !line.contains("func ") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            guard !lines.isEmpty else { continue }
            let rel = String(url.path.dropFirst(root.path.count + 1))
            found.insert(rel)
            XCTAssertNotNil(known[rel], "\(rel) draws a reply: strip the agent-ack and tasks lines (TimelineTurnMarker) and list it here")
            for mark in known[rel] ?? [] { XCTAssertTrue(source.contains(mark), "\(rel): \(mark)") }
            // A reply's raw text never goes straight into a markdown body.
            XCTAssertFalse(source.contains("ChatMarkdownBody(text: message.text"), rel)
        }
        XCTAssertEqual(found, Set(known.keys))
        // The two builder entry points strip before they draw.
        let builderSource = try String(contentsOf: root.appendingPathComponent("Timeline/TimelineRowBuilder.swift"), encoding: .utf8)
        XCTAssertTrue(builderSource.contains("let shown = TimelineTurnMarker.strip(message.text)"))
        XCTAssertTrue(builderSource.contains("let liveText = TimelineTurnMarker.stripLive(liveText)"))
    }
}
