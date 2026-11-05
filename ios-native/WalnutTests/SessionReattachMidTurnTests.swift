import XCTest
@testable import Walnut

/// The app is closed and opened again while a turn runs (2026-11-04, live review): the page reads the
/// saved rows so far, the stream attaches with a snapshot of the turn, and the turn then finishes.
/// The saved turn must stand once, in order, and the page must stop saying the turn runs.
@MainActor
final class SessionReattachMidTurnTests: XCTestCase {
    private typealias Message = SessionTranscript.Message

    private func event(_ name: String, _ json: String = "{}") -> SSEEvent {
        SSEEvent(id: nil, event: name, data: json)
    }

    private func at(_ second: Int) -> String { String(format: "2026-11-04T10:00:%02dZ", second) }

    private func shape(_ messages: [ChatMessage]) -> [String] {
        messages.map { m in
            switch m.kind {
            case .tool: return "tool:\(m.text)"
            case .thinking: return "thinking"
            default: return "\(m.role):\(m.text)"
            }
        }
    }

    private func snapshot(_ blocks: [ScriptedSSE.Block]) throws -> SSEEvent {
        let snap = ScriptedSSE.Snapshot(blocks: blocks)
        return event("snapshot", String(data: try JSONEncoder().encode(snap), encoding: .utf8)!)
    }

    func testAPageOpenedMidTurnShowsTheSavedTurnOnceWhenItEnds() async throws {
        let id = "reattach-mid"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: id), transport: transport)

        // What the session had saved when the app came back: step 1 done, step 2 running.
        let early: [Message] = [
            Message(role: "user", text: "Run the steps", timestamp: at(0), kind: nil),
            Message(role: "assistant", text: "thinking", timestamp: at(1), kind: "thinking", thinkingText: "plan"),
            Message(role: "assistant", text: "Running step 1.", timestamp: at(2), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(3), kind: "tool", detail: "step 1", resultPreview: "one"),
            Message(role: "assistant", text: "Step 1 complete.\n\nRunning step 2.", timestamp: at(4), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(5), kind: "tool", detail: "step 2"),
        ]
        transport.transcript = SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: early)
        _ = await store.open()

        // The stream attaches: the snapshot holds the whole running turn.
        store.handle(try snapshot([
            .init(type: "thinking", content: "plan"),
            .init(type: "text", content: "Running step 1."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 1 complete.\n\nRunning step 2."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "calling"),
        ]))
        XCTAssertTrue(store.streaming)

        // The turn goes on and ends.
        store.handle(event("tool-result", #"{"toolUseId":"t2","resultPreview":"two"}"#))
        store.handle(event("text-delta", #"{"delta":"Step 2 complete.\n\nRunning step 3."}"#))
        store.handle(event("tool", #"{"name":"Bash","toolUseId":"tool-three","detail":"step 3"}"#))
        store.handle(event("tool-result", #"{"toolUseId":"tool-three","resultPreview":"three"}"#))
        store.handle(event("text-delta", #"{"delta":"Step 3 complete. All done."}"#))
        store.flushPendingDelta()
        store.handle(event("turn-end"))
        XCTAssertFalse(store.streaming, "the turn ended")
        // The server follows a turn end with the session's status: running for an instant, then idle.
        store.handle(event("status", #"{"processStatus":"running"}"#))
        store.handle(event("status", #"{"processStatus":"idle"}"#))

        // The read that follows the turn end has the whole saved turn.
        let full = early + [
            Message(role: "assistant", text: "Step 2 complete.\n\nRunning step 3.", timestamp: at(6), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(7), kind: "tool", detail: "step 3", resultPreview: "three"),
            Message(role: "assistant", text: "Step 3 complete. All done.", timestamp: at(8), kind: nil),
        ]
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: full))

        XCTAssertEqual(shape(store.messages), [
            "user:Run the steps", "thinking", "assistant:Running step 1.", "tool:Bash",
            "assistant:Step 1 complete.\n\nRunning step 2.", "tool:Bash",
            "assistant:Step 2 complete.\n\nRunning step 3.", "tool:Bash", "assistant:Step 3 complete. All done.",
        ])
        XCTAssertEqual(store.liveText, "")
        XCTAssertTrue(store.liveTools.isEmpty)
        XCTAssertFalse(store.streaming)
    }

    /// The stream can attach before the first read of the saved rows has answered.
    func testASnapshotThatBeatsTheFirstReadStillLeavesTheSavedTurnOnce() async throws {
        let id = "reattach-race"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: id), transport: transport)
        let early: [Message] = [
            Message(role: "user", text: "Run the steps", timestamp: at(0), kind: nil),
            Message(role: "assistant", text: "Running step 1.", timestamp: at(2), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(3), kind: "tool", detail: "step 1", resultPreview: "one"),
            Message(role: "assistant", text: "Step 1 complete.\n\nRunning step 2.", timestamp: at(4), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(5), kind: "tool", detail: "step 2"),
        ]
        // The snapshot first, while the page knows no saved rows.
        store.handle(try snapshot([
            .init(type: "text", content: "Running step 1."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 1 complete.\n\nRunning step 2."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "calling"),
        ]))
        transport.transcript = SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: early)
        _ = await store.open()
        store.handle(event("tool-result", #"{"toolUseId":"t2","resultPreview":"two"}"#))
        store.handle(event("text-delta", #"{"delta":"Step 2 complete. All done."}"#))
        store.flushPendingDelta()
        store.handle(event("turn-end"))
        store.handle(event("status", #"{"processStatus":"running"}"#))
        store.handle(event("status", #"{"processStatus":"idle"}"#))
        let full = early + [
            Message(role: "assistant", text: "Step 2 complete. All done.", timestamp: at(8), kind: nil),
        ]
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: full))
        XCTAssertEqual(shape(store.messages), [
            "user:Run the steps", "assistant:Running step 1.", "tool:Bash",
            "assistant:Step 1 complete.\n\nRunning step 2.", "tool:Bash", "assistant:Step 2 complete. All done.",
        ])
        XCTAssertEqual(store.liveText, "")
        XCTAssertFalse(store.streaming)
    }

    /// The saved rows are read twice on opening, and the second read has a step the first did not: the
    /// snapshot's text for it must not stay on the page beside the saved row.
    func testASavedRowThatArrivesAfterTheSnapshotLeavesNoCopyInTheLiveText() async throws {
        let id = "reattach-second-read"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: id), transport: transport)
        let first: [Message] = [
            Message(role: "user", text: "Run the steps", timestamp: at(0), kind: nil),
            Message(role: "assistant", text: "I'll run each step.", timestamp: at(2), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(3), kind: "tool", detail: "step 1"),
            Message(role: "assistant", text: "Step 1 complete: **one**", timestamp: at(4), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(5), kind: "tool", detail: "step 2"),
        ]
        let second = first + [
            Message(role: "assistant", text: "Step 2 complete: **two**", timestamp: at(6), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(7), kind: "tool", detail: "step 3"),
        ]
        transport.transcript = SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: first)
        _ = await store.open()
        store.handle(try snapshot([
            .init(type: "text", content: "I'll run each step."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 1 complete: **one**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 2 complete: **two**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "calling"),
        ]))
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: second))
        XCTAssertEqual(shape(store.messages), [
            "user:Run the steps", "assistant:I'll run each step.", "tool:Bash",
            "assistant:Step 1 complete: **one**", "tool:Bash", "assistant:Step 2 complete: **two**", "tool:Bash",
        ])
        XCTAssertEqual(store.liveText, "", "everything the snapshot told is a saved row now")
        XCTAssertTrue(store.liveTools.isEmpty, "and so are its calls")
    }

    /// The first read of the saved rows is behind (a cached copy with only the turn's first words), the
    /// snapshot has the turn so far, and the fresh read that follows has it all.
    func testAFirstReadThatIsBehindTheSnapshotDoesNotLeaveCopiesOnThePage() async throws {
        let id = "reattach-stale-first"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: id), transport: transport)
        let stale: [Message] = [
            Message(role: "user", text: "Run the steps", timestamp: at(0), kind: nil),
            Message(role: "assistant", text: "I'll run each step.", timestamp: at(2), kind: nil),
        ]
        let fresh = stale + [
            Message(role: "assistant", text: "Bash", timestamp: at(3), kind: "tool", detail: "step 1"),
            Message(role: "assistant", text: "Step 1 complete: **one**", timestamp: at(4), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(5), kind: "tool", detail: "step 2"),
            Message(role: "assistant", text: "Step 2 complete: **two**", timestamp: at(6), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(7), kind: "tool", detail: "step 3"),
        ]
        transport.transcript = SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: stale)
        _ = await store.open()
        store.handle(try snapshot([
            .init(type: "text", content: "I'll run each step."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 1 complete: **one**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 2 complete: **two**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "calling"),
        ]))
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: fresh))
        XCTAssertEqual(shape(store.messages), [
            "user:Run the steps", "assistant:I'll run each step.", "tool:Bash",
            "assistant:Step 1 complete: **one**", "tool:Bash", "assistant:Step 2 complete: **two**", "tool:Bash",
        ])
        XCTAssertEqual(store.liveText, "", "everything the snapshot told is a saved row now")
        XCTAssertTrue(store.liveTools.isEmpty, "and so are its calls")
    }

    /// What the phone does on reopening a running session (live log, 2026-11-04): the stream's snapshot lands
    /// before either read of the saved rows. Once the rows are in, the page holds each step once.
    func testASnapshotBeforeAnySavedRowsLeavesNoCopiesOnceTheRowsAreIn() async throws {
        let id = "reattach-snapshot-first"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: id), transport: transport)
        let saved: [Message] = [
            Message(role: "user", text: "Run the steps", timestamp: at(0), kind: nil),
            Message(role: "assistant", text: "thinking", timestamp: at(1), kind: "thinking", thinkingText: "plan"),
            Message(role: "assistant", text: "I'll run each step.", timestamp: at(2), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(3), kind: "tool", detail: "step 1", resultPreview: "one"),
            Message(role: "assistant", text: "Step 1 complete: **one**", timestamp: at(4), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(5), kind: "tool", detail: "step 2", resultPreview: "two"),
            Message(role: "assistant", text: "Step 2 complete: **two**", timestamp: at(6), kind: nil),
            Message(role: "assistant", text: "Bash", timestamp: at(7), kind: "tool", detail: "step 3"),
        ]
        // The page opens: the stream attaches first.
        store.handle(event("turn-start"))
        store.handle(try snapshot([
            .init(type: "thinking", content: "plan"),
            .init(type: "text", content: "I'll run each step."),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 1 complete: **one**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "done"),
            .init(type: "text", content: "Step 2 complete: **two**"),
            .init(type: "tool_call", content: nil, name: "Bash", status: "calling"),
        ]))
        // Then the cached read, then the fresh one.
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: Array(saved.prefix(5))))
        store.reconcile(SessionTranscript(sessionId: id, exportedAt: "x", truncated: false, messages: saved))
        XCTAssertEqual(shape(store.messages), [
            "user:Run the steps", "thinking", "assistant:I'll run each step.", "tool:Bash",
            "assistant:Step 1 complete: **one**", "tool:Bash", "assistant:Step 2 complete: **two**", "tool:Bash",
        ])
        XCTAssertEqual(store.liveText, "", "every step the snapshot told is a saved row")
        XCTAssertTrue(store.liveTools.isEmpty, "and every call")
        XCTAssertTrue(store.streaming)
    }
}
