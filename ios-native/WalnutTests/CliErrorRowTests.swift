import XCTest
import UIKit
@testable import Walnut

/// Claude Code's own error reply ("Claude Code: Prompt is too long", "Claude Code: API Error: ...")
/// is how its turn ended, never the model's answer. 2026-11-06: the web console drew it as its
/// grey error line with an amber "!", while the phone still drew it as the assistant's bubble: the
/// v1 transcript keeps such a row `role: "assistant"` (task_history and notices read it as the
/// turn's last words) and now marks it `cliError: true`, the live stream sends it as `cli-error`,
/// and a lane chat row arrives as a `cli-error` notification. Every one of those draws the same
/// notice row, on its own, never a reply and never folded away with the turn's steps.
@MainActor
final class CliErrorRowTests: XCTestCase {
    private typealias Message = SessionTranscript.Message
    private let words = "Claude Code: Prompt is too long"
    private let pageWidth: CGFloat = 393

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    // MARK: - Fixtures

    private func transcript(_ rows: [Message], id: String = "cli-error") -> SessionTranscript {
        SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: rows)
    }

    /// A turn the person started that ran two commands and ended on the CLI's error reply.
    private func turnRows() -> [Message] {
        [
            Message(role: "user", text: "Please go on", timestamp: "2026-11-06T09:00:00Z", kind: nil, sentBy: "person"),
            Message(role: "assistant", text: "Bash", timestamp: "2026-11-06T09:00:01Z", kind: "tool",
                    detail: "ls", resultPreview: "a.md"),
            Message(role: "assistant", text: "Bash", timestamp: "2026-11-06T09:00:02Z", kind: "tool",
                    detail: "pwd", resultPreview: "/tmp"),
            Message(role: "assistant", text: words, timestamp: "2026-11-06T09:00:03Z", kind: nil, cliError: true),
        ]
    }

    private func layout(_ messages: [ChatMessage], streaming: Bool = false) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: messages, streaming: streaming, liveText: "", liveTextTruncated: false,
            liveTools: [], activity: nil, showLoadEarlier: false, width: pageWidth,
            expandedRowIDs: [], scope: "s")).rows
    }

    /// The rows that draw the error's words, with what each draws them as.
    private func drawers(_ rows: [TimelineRow]) -> [(kind: String, content: TimelineRowContent)] {
        rows.compactMap { row in
            let text: String
            switch row.content {
            case .text(let s): text = s.string
            case .userBubble(let s, _, _, _, _): text = s.string
            case .notification(_, _, _, let body, let line, _, _, _): text = body.string + line
            case .richHTML(let html, _, _), .richIsland(let html, _, _): text = html
            case .chip(_, let t): text = t
            default: return nil
            }
            return text.contains("Prompt is too long") ? (row.content.reuseKind, row.content) : nil
        }
    }

    /// The one row the error draws: Walnut's notice in its warning tone, nothing else.
    private func assertNotice(_ rows: [TimelineRow], _ context: String,
                              file: StaticString = #filePath, line: UInt = #line) {
        let found = drawers(rows)
        XCTAssertEqual(found.map(\.kind), ["notification"], context, file: file, line: line)
        guard case .notification(let badge, let icon, let tone, let body, _, _, _, _)? = found.first?.content else { return }
        XCTAssertEqual(tone, .warning, context, file: file, line: line)
        XCTAssertEqual(icon, "exclamationmark.circle", context, file: file, line: line)
        XCTAssertEqual(badge, "Error", context, file: file, line: line)
        XCTAssertEqual(body.string, words, context, file: file, line: line)
    }

    // MARK: - Decode

    func testTheTranscriptDecodesTheMarkAndAnOlderServerSendsNone() throws {
        let json = """
        {"sessionId":"s","exportedAt":"x","truncated":false,"messages":[
          {"role":"assistant","text":"Claude Code: Prompt is too long","timestamp":"2026-11-06T09:00:03Z","cliError":true},
          {"role":"assistant","text":"Hello.","timestamp":"2026-11-06T09:00:04Z"}
        ]}
        """
        let decoded = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.messages.map(\.cliError), [true, nil])
    }

    func testATranscriptRowMarkedCliErrorBecomesTheNoticeNeverAReply() {
        let rows = SessionConversationStore.keepingWholeText(turnRows(), held: [])
        let last = rows.last!
        XCTAssertTrue(last.isCliError)
        XCTAssertEqual(last.kind, .notification)
        XCTAssertEqual(last.role, "assistant")
        XCTAssertEqual(last.text, words)
        // The same words without the mark are a reply, as an older server sends them.
        let plain = SessionConversationStore.keepingWholeText(
            [Message(role: "assistant", text: words, timestamp: "2026-11-06T09:00:03Z", kind: nil)], held: [])
        XCTAssertNil(plain.first?.kind)
    }

    // MARK: - Rows

    func testTheBuilderDrawsTheNoticeInItsWarningTone() {
        let builder = TimelineRowBuilder()
        let rows = builder.rows(for: ChatMessage.cliErrorNotice(text: words, createdAt: "2026-11-06T09:00:03Z", id: "e1"),
                                width: pageWidth, expandedRowIDs: [])
        assertNotice(rows, "builder")
        let styled = NotificationStyling(message: ChatMessage.cliErrorNotice(text: words, createdAt: "x"))
        XCTAssertTrue(styled.isError, "the turn ended on an error, not an answer")
    }

    func testTheNoticeStaysOnItsOwnRowAfterTheTurnsFoldedSteps() async {
        let messages = SessionConversationStore.keepingWholeText(turnRows(), held: [])
        let rows = await layout(messages)
        assertNotice(rows, "a finished turn")
        // The two commands fold into one row above it; the notice is not among the fold's steps.
        let foldIndex = rows.firstIndex { if case .toolRun = $0.content { return true }; return false }
        let noticeIndex = rows.firstIndex { if case .notification = $0.content { return true }; return false }
        XCTAssertNotNil(foldIndex)
        XCTAssertNotNil(noticeIndex)
        if let foldIndex, let noticeIndex { XCTAssertLessThan(foldIndex, noticeIndex) }
        // A turn ending on it is no answered turn: nothing above folds away as "before the answer".
        let shapes = TimelineTurnShape.shape(messages, streaming: false)
        XCTAssertEqual(shapes.last?.kind, .open)
    }

    func testTheFoldRuleNeverCountsTheNoticeAsAStep() {
        // After an answer the turn's quiet rows (a call, a notice the runtime wrote) fold;
        // Claude Code's error reply reads.
        let said = ChatMessage(id: "a1", role: "assistant", text: "Working on it.", createdAt: "2026-11-06T09:00:01Z", kind: nil)
        var person = ChatMessage(id: "u1", role: "user", text: "Go", createdAt: "2026-11-06T09:00:00Z", kind: nil)
        person.sentBy = "person"
        // A call right before it: a quiet step the notice would otherwise join in one fold.
        let call = ChatMessage(id: "t1", role: "assistant", text: "Read", createdAt: "2026-11-06T09:00:02Z", kind: .tool,
                               detail: "notes.md", resultPreview: "ok")
        let messages = [person, said, call, ChatMessage.cliErrorNotice(text: words, createdAt: "2026-11-06T09:00:03Z", id: "e1")]
        let parts = TimelineTurnFold.plan(messages, turns: TimelineTurnShape.shape(messages, streaming: false))
        let folded = parts.contains { part in
            if case .fold(let f) = part { return f.members.contains { if case .message(let m) = $0 { return m.isCliError }; return false } }
            return false
        }
        XCTAssertFalse(folded)
        XCTAssertTrue(parts.contains { if case .message(let m) = $0 { return m.isCliError }; return false })
    }

    // MARK: - Live and history draw the same row

    func testTheLiveFrameShowsTheNoticeAtOnceAndTheReadReplacesItInPlace() async {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "cli-error-live"),
                                             transport: MockSessionSendTransport())
        store.reconcile(transcript(Array(turnRows().prefix(3)), id: "cli-error-live"))
        store.handle(SSEEvent(id: nil, event: "turn-start", data: "{}"))
        store.handle(SSEEvent(id: nil, event: "cli-error", data: #"{"message":"Claude Code: Prompt is too long"}"#))
        let live = store.messages.filter(\.isCliError)
        XCTAssertEqual(live.map(\.text), [words])
        // A repeat of the frame (a replay) adds nothing.
        store.handle(SSEEvent(id: nil, event: "cli-error", data: #"{"message":"Claude Code: Prompt is too long"}"#))
        XCTAssertEqual(store.messages.filter(\.isCliError).count, 1)
        let liveRows = await layout(store.messages, streaming: true)
        assertNotice(liveRows, "live")

        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        store.reconcile(transcript(turnRows(), id: "cli-error-live"))
        let settled = store.messages.filter(\.isCliError)
        XCTAssertEqual(settled.count, 1, "the read replaces the live notice, never adds a second")
        XCTAssertFalse(settled[0].id.hasPrefix("provisional-"))
        let historyRows = await layout(store.messages)
        assertNotice(historyRows, "history")
        // The same notice, drawn the same.
        let liveNotice = drawers(liveRows).first?.content.contentKey
        let historyNotice = drawers(historyRows).first?.content.contentKey
        XCTAssertNotNil(liveNotice)
        XCTAssertEqual(liveNotice, historyNotice)
    }

    // MARK: - Guard: every way the reply reaches the phone draws the notice

    /// The class: Claude Code's error reply drawn as the assistant's words. Each way it can reach
    /// a timeline is listed and drawn here; a new way to map transcript rows into chat messages
    /// fails `testEveryTranscriptMapperIsListed` until it is listed and draws the notice.
    func testEveryWayTheReplyArrivesDrawsTheNoticeNeverABubble() async throws {
        // 1. A session transcript row, whole and as a clipped slim-poll copy of a held row.
        let whole = SessionConversationStore.keepingWholeText(turnRows(), held: [])
        assertNotice(await layout(whole), "transcript row")
        var clippedRows = turnRows()
        clippedRows[3] = Message(role: "assistant", text: "Claude Code: Prompt is too\u{2026}",
                                 timestamp: "2026-11-06T09:00:03Z", kind: nil, cliError: true)
        let clipped = SessionConversationStore.keepingWholeText(clippedRows, held: whole)
        XCTAssertTrue(clipped.last?.isCliError == true, "a clipped copy of the row is the notice too")
        // 2. A lane chat row (`/conversations/:id/messages`), which the server sends as the notice.
        let chatJSON = #"{"id":"m3","role":"assistant","text":"Claude Code: Prompt is too long","createdAt":"2026-11-06T09:00:03Z","kind":"notification","source":"cli-error"}"#
        let chat = try JSONDecoder().decode(ChatMessage.self, from: Data(chatJSON.utf8))
        XCTAssertTrue(chat.isCliError)
        assertNotice(await layout([chat]), "chat row")
        // 3. The live frame (testTheLiveFrameShowsTheNoticeAtOnceAndTheReadReplacesItInPlace).
        // 4. A chat message persisted to the disk cache and read back.
        let cached = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(chat))
        XCTAssertTrue(cached.isCliError)
    }

    /// Every function that turns transcript rows into chat messages, read from the source. Each one
    /// is listed with what proves it keeps the mark; a new one fails until it is.
    func testEveryTranscriptMapperIsListed() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        let known: [String: [String]] = [
            "Stores/SessionConversationStore.swift": ["if m.cliError == true", "ChatMessage.cliErrorNotice("],
        ]
        let signature = try NSRegularExpression(
            pattern: #"func\s+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?(?:throws\s*)?->\s*([^{]+)\{"#)
        var mappers: [String] = []
        var files: Set<String> = []
        let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        for case let url as URL in walk where url.pathExtension == "swift" {
            let rel = String(url.path.dropFirst(root.path.count + 1))
            if rel.hasPrefix("Demo/") { continue } // the demo server writes transcripts, it maps none
            let source = try String(contentsOf: url, encoding: .utf8)
            guard source.contains("SessionTranscript.Message") || source.contains("SessionTranscript)") else { continue }
            let range = NSRange(source.startIndex..., in: source)
            for match in signature.matches(in: source, range: range) {
                let params = String(source[Range(match.range(at: 2), in: source)!])
                let returns = String(source[Range(match.range(at: 3), in: source)!])
                guard params.contains("SessionTranscript"), returns.contains("ChatMessage") else { continue }
                mappers.append("\(rel):\(source[Range(match.range(at: 1), in: source)!])")
                files.insert(rel)
            }
            if source.contains("SessionTranscript.Message"), source.contains("ChatMessage("),
               !rel.hasPrefix("API/") {
                files.insert(rel)
            }
        }
        for rel in files {
            XCTAssertNotNil(known[rel], "\(rel) maps transcript rows into chat messages: draw a cliError row as ChatMessage.cliErrorNotice and list it here")
            let source = try String(contentsOf: root.appendingPathComponent(rel), encoding: .utf8)
            for mark in known[rel] ?? [] { XCTAssertTrue(source.contains(mark), "\(rel): \(mark)") }
        }
        XCTAssertEqual(files, Set(known.keys))
        // Today's mappers: the row itself and the two clip-keeping passes that call it.
        XCTAssertEqual(Set(mappers), [
            "Stores/SessionConversationStore.swift:row",
            "Stores/SessionConversationStore.swift:keepingWholeText",
            "Stores/SessionConversationStore.swift:keepingWholeRowText",
        ])
    }
}
