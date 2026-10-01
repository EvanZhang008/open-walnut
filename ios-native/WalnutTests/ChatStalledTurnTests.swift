import Foundation
import XCTest
@testable import Walnut

/// A chat turn that stalls while its lane keeps running, and its answer arriving
/// late (docs/reference/api-v1.md, "A turn that stalls while its lane keeps
/// running"). The frames are the server's exact sequences, fed to the store's real
/// SSE handler.
///
/// Two field reports: the red stall notice stayed up after the late answer had
/// arrived (it was cleared only by a send or a conversation switch), and a late
/// answer arriving during the next turn finalized THAT turn, whose repeated
/// `message-start` then wiped its live text.
@MainActor
final class ChatStalledTurnTests: XCTestCase {

    private let conv = "conv-stalled-turn"
    private let stall = "The main AI has gone quiet for 15 minutes. It is still working: its answer will appear here if it arrives."
    private var stores: [ChatStore] = []

    override func setUp() async throws {
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
    }

    override func tearDown() async throws {
        for store in stores { store.closeStream() }
        stores = []
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
    }

    private var stamp: String { ISO8601DateFormatter().string(from: Date()) }

    private func row(_ id: String, _ role: String, _ text: String) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: stamp, kind: nil)
    }

    private func makeStore(history: [ChatMessage]) -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport) {
        let reads = MockChatMessagesTransport()
        reads.rows[conv] = history
        let writes = MockChatSendTransport()
        let store = ChatStore(transport: reads, sendTransport: writes)
        store.activeID = conv
        store.messages = history
        stores.append(store)
        return (store, reads, writes)
    }

    private func json(_ fields: [String: Any]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8)!
    }

    private func frame(_ store: ChatStore, _ event: String, _ fields: [String: Any] = [:]) {
        store.handleForTesting(SSEEvent(id: nil, event: event, data: json(fields)), conversationID: conv)
    }

    private func poll(_ label: String, line: UInt = #line, until condition: () -> Bool) async {
        for _ in 0..<500 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(label)", line: line)
    }

    private func assistantTexts(_ store: ChatStore) -> [String] {
        store.messages.filter { $0.role == "assistant" && $0.kind == nil }.map(\.text)
    }

    // MARK: - The notice

    /// message-start t1, error t1 laneStillRunning, message-late t1, message-end t1.
    func testTheStallNoticeGoesWhenTheLateAnswerArrives() async {
        let (store, reads, _) = makeStore(history: [row("u1", "user", "first question")])
        frame(store, "message-start", ["turnId": "t1"])
        XCTAssertTrue(store.streaming)

        frame(store, "error", ["message": stall, "turnId": "t1", "laneStillRunning": true])
        XCTAssertEqual(store.errorMessage, stall, "the stall notice did not show")
        XCTAssertFalse(store.streaming, "the composer stays locked on a turn whose guard the server released")
        XCTAssertTrue(store.acceptsNewTurn, "the next message cannot be sent")

        reads.rows[conv] = [row("u1", "user", "first question"), row("a1", "assistant", "The late answer.")]
        frame(store, "message-late", ["turnId": "t1", "fullText": "The late answer."])
        XCTAssertNil(store.errorMessage, "the notice stayed up after the answer arrived")

        frame(store, "message-end", ["turnId": "t1", "fullText": "The late answer."])
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(assistantTexts(store), ["The late answer."], "the late answer did not land")
        XCTAssertFalse(store.streaming)
        await poll("the canonical rows") { store.messages.map(\.id) == ["u1", "a1"] }
    }

    /// A client that ignores `message-late` still ends the notice at the
    /// `message-end` after it, and only its own notice: another banner stays.
    func testTheTurnEndAloneRetractsTheNoticeAndOnlyThatNotice() async {
        let (store, _, _) = makeStore(history: [row("u1", "user", "first question")])
        frame(store, "message-start", ["turnId": "t1"])
        frame(store, "error", ["message": stall, "turnId": "t1", "laneStillRunning": true])
        frame(store, "message-end", ["turnId": "t1", "fullText": "The late answer."])
        XCTAssertNil(store.errorMessage, "the notice stayed up after the answer arrived")

        frame(store, "message-start", ["turnId": "t3"])
        frame(store, "error", ["message": stall, "turnId": "t3", "laneStillRunning": true])
        store.errorMessage = "Still replying, retry when the turn finishes."
        frame(store, "message-late", ["turnId": "t3", "fullText": "Another late answer."])
        frame(store, "message-end", ["turnId": "t3", "fullText": "Another late answer."])
        XCTAssertEqual(store.errorMessage, "Still replying, retry when the turn finishes.",
                       "a banner that is not the stall notice went with it")

        // An ordinary error is still a failed turn, and its banner stays.
        frame(store, "message-start", ["turnId": "t4"])
        frame(store, "error", ["message": "The turn failed badly.", "turnId": "t4"])
        XCTAssertEqual(store.errorMessage, "The turn failed badly.")
        XCTAssertFalse(store.streaming)
    }

    // MARK: - A later turn

    /// message-start t1, error t1, message-start t2, queued t2, message-late t1,
    /// message-end t1, message-start t2, then t2 deltas, then message-end t2.
    func testALateAnswerDuringTheNextTurnLandsInItsOwnRowAndLeavesThatTurnStreaming() async {
        let (store, reads, writes) = makeStore(history: [row("u1", "user", "first question")])
        writes.script(.success("t2"))
        frame(store, "message-start", ["turnId": "t1"])
        frame(store, "error", ["message": stall, "turnId": "t1", "laneStillRunning": true])

        let sent = await store.sendReportingOutcome("second question")
        XCTAssertEqual(sent, .started(accepted: true), "the next message was not sent after the notice")
        XCTAssertEqual(writes.requestedTexts, ["second question"])
        frame(store, "message-start", ["turnId": "t2"])
        frame(store, "queued", ["turnId": "t2", "position": 1])
        XCTAssertTrue(store.streaming)
        XCTAssertEqual(store.activity, "Waiting for another task")

        reads.rows[conv] = [
            row("u1", "user", "first question"), row("a1", "assistant", "The late answer."),
            row("u2", "user", "second question"),
        ]
        frame(store, "message-late", ["turnId": "t1", "fullText": "The late answer."])
        frame(store, "message-end", ["turnId": "t1", "fullText": "The late answer."])
        XCTAssertNil(store.errorMessage, "the notice stayed up after the answer arrived")
        XCTAssertTrue(store.streaming, "the earlier turn's end finalized the turn that is streaming")
        XCTAssertEqual(assistantTexts(store), ["The late answer."], "the late answer is not its own row")
        let late = store.messages.firstIndex { $0.text == "The late answer." }
        let question = store.messages.lastIndex { $0.role == "user" && $0.text == "second question" }
        XCTAssertNotNil(late)
        XCTAssertNotNil(question)
        if let late, let question {
            XCTAssertLessThan(late, question, "the late answer sits under the next question: \(store.messages.map(\.text))")
        }

        frame(store, "message-start", ["turnId": "t2"])
        XCTAssertTrue(store.streaming)
        // The start ends the wait: the row reads Thinking (a nil activity), as
        // after an ordinary start, not "Waiting for another task" all turn.
        XCTAssertNil(store.activity, "the queued label outlived the turn's start")
        var seen: [String] = []
        for delta in ["Second ", "answer, ", "streaming."] {
            frame(store, "text-delta", ["delta": delta])
            let expected = seen.joined() + delta
            await poll("the delta \"\(delta)\"") { store.streamText == expected }
            seen.append(delta)
            XCTAssertNil(store.activity, "the queued label came back with a delta")
        }
        XCTAssertTrue(store.streaming)

        reads.rows[conv] = [
            row("u1", "user", "first question"), row("a1", "assistant", "The late answer."),
            row("u2", "user", "second question"), row("a2", "assistant", "Second answer, streaming."),
        ]
        frame(store, "message-end", ["turnId": "t2", "fullText": "Second answer, streaming."])
        XCTAssertFalse(store.streaming)
        XCTAssertEqual(assistantTexts(store).filter { $0 == "Second answer, streaming." }.count, 1)
        XCTAssertTrue(assistantTexts(store).contains("The late answer."), "the late answer's row went with the next turn's end")
        await poll("the canonical rows") { store.messages.map(\.id) == ["u1", "a1", "u2", "a2"] }
    }

    /// The refetch after the late end can come back with the late answer flagged
    /// in flight: while the next turn runs and its question is not in the lane
    /// transcript yet, the server flags every row after the last user row. The
    /// mid-turn install leaves that row out, so the local row has to stay: it
    /// was retired against the whole fetch and the answer showed for one frame,
    /// then was gone until the next turn ended (build 84 gate, P2).
    func testALateAnswerTheRefetchFlagsInFlightStaysOnScreenOnce() async {
        let (store, reads, writes) = makeStore(history: [row("u1", "user", "first question")])
        writes.script(.success("t2"))
        frame(store, "message-start", ["turnId": "t1"])
        frame(store, "error", ["message": stall, "turnId": "t1", "laneStillRunning": true])
        let sent = await store.sendReportingOutcome("second question")
        XCTAssertEqual(sent, .started(accepted: true))
        frame(store, "message-start", ["turnId": "t2"])
        frame(store, "queued", ["turnId": "t2", "position": 1])

        reads.rows[conv] = [
            row("u1", "user", "first question"),
            ChatMessage(id: "a1", role: "assistant", text: "The late answer.", createdAt: stamp,
                        kind: nil, inFlight: true),
        ]
        let fetchesBefore = reads.requestedConversations.count
        frame(store, "message-late", ["turnId": "t1", "fullText": "The late answer."])
        frame(store, "message-end", ["turnId": "t1", "fullText": "The late answer."])
        XCTAssertEqual(assistantTexts(store), ["The late answer."])
        // The refetch the late end starts, asked for AND applied.
        await poll("the refetch after the late end") {
            let asked = reads.requestedConversations.count
            return asked > fetchesBefore && reads.answeredConversations.count == asked && !store.loadingMessages
        }
        XCTAssertTrue(store.streaming)
        XCTAssertEqual(assistantTexts(store), ["The late answer."],
                       "the refetch that flags the answer in flight took it off screen: \(store.messages.map(\.id))")
        XCTAssertEqual(store.messages.first { $0.text == "The late answer." }?.id, "turn-late-t1")
        let late = store.messages.firstIndex { $0.text == "The late answer." }
        let question = store.messages.lastIndex { $0.role == "user" && $0.text == "second question" }
        if let late, let question {
            XCTAssertLessThan(late, question, "the late answer moved under the next question")
        } else {
            XCTFail("rows missing: \(store.messages.map(\.text))")
        }

        // The next read has the question on record, so the answer is no longer
        // in flight and the install carries it: the local row goes, one row left.
        reads.rows[conv] = [
            row("u1", "user", "first question"), row("a1", "assistant", "The late answer."),
            row("u2", "user", "second question"),
        ]
        await store.loadMessages(conv)
        XCTAssertEqual(store.messages.map(\.id), ["u1", "a1", "u2"])
        XCTAssertTrue(store.streaming)

        frame(store, "message-start", ["turnId": "t2"])
        XCTAssertNil(store.activity)
        frame(store, "text-delta", ["delta": "Second answer."])
        await poll("the next turn's text") { store.streamText == "Second answer." }
        reads.rows[conv] = [
            row("u1", "user", "first question"), row("a1", "assistant", "The late answer."),
            row("u2", "user", "second question"), row("a2", "assistant", "Second answer."),
        ]
        frame(store, "message-end", ["turnId": "t2", "fullText": "Second answer."])
        await poll("the canonical rows") { store.messages.map(\.id) == ["u1", "a1", "u2", "a2"] }
    }

    /// The carry rule itself: a late answer's row is judged by what is installed,
    /// with entity refs normalized, and it takes nothing from the retirement of
    /// the provisional reply of the turn that just ended.
    func testALateAnswersRowIsJudgedByTheRowsInstalled() {
        let u1 = row("u1", "user", "first question")
        let late = row("turn-late-t1", "assistant", "Filed <task-ref id=\"t9\" label=\"Build fix\"/>.")
        let canonical = row("a1", "assistant", "Filed Build fix.")
        let flagged = ChatMessage(id: "a1", role: "assistant", text: "Filed Build fix.", createdAt: stamp,
                                  kind: nil, inFlight: true)
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [u1, late], fetched: [u1, flagged], installed: [u1]).map(\.id),
            ["turn-late-t1"], "the late row went for a row that is not installed"
        )
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [u1, late], fetched: [u1, canonical], installed: [u1, canonical]).map(\.id),
            [], "the late row stayed beside its canonical row"
        )
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [u1, late], fetched: [u1, canonical]).map(\.id),
            [], "with no install given, the whole fetch is what shows"
        )
        let provisional = row("turn-1", "assistant", "Second answer.")
        let u2 = row("u2", "user", "second question")
        let full = [u1, canonical, u2, row("a2", "assistant", "Second answer.")]
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [u1, late, u2, provisional], fetched: full, installed: full).map(\.id),
            [], "one of the two local answers outlived its canonical row"
        )
    }

    /// The streaming turn's `message-start` sent again, as the server does after
    /// a late end: its text, reasoning and tools stay, and the deltas after it
    /// continue the same reply. A start for ANOTHER turn still begins afresh.
    func testARepeatedStartForTheTurnInProgressKeepsItsText() async {
        let (store, _, _) = makeStore(history: [row("u1", "user", "a question")])
        frame(store, "message-start", ["turnId": "t2"])
        frame(store, "text-delta", ["delta": "Half of "])
        await poll("the first delta") { store.streamText == "Half of " }
        frame(store, "tool", ["name": "Read", "toolUseId": "tool-1", "detail": "notes.md"])
        XCTAssertEqual(store.liveTools.count, 1)
        let toolActivity = store.activity
        XCTAssertNotNil(toolActivity, "a running tool shows no activity")

        frame(store, "message-end", ["turnId": "t1", "fullText": "An earlier turn's answer."])
        frame(store, "message-start", ["turnId": "t2"])
        XCTAssertTrue(store.streaming, "the earlier turn's end finalized this one")
        XCTAssertEqual(store.streamText, "Half of ", "the repeated start wiped the live text")
        XCTAssertEqual(store.liveTools.count, 1, "the repeated start dropped the running tool")
        XCTAssertEqual(store.activity, toolActivity, "the repeated start dropped the running tool's activity")
        frame(store, "text-delta", ["delta": "the reply."])
        await poll("the text after the repeated start") { store.streamText == "Half of the reply." }

        frame(store, "message-end", ["turnId": "t2", "fullText": "Half of the reply."])
        XCTAssertFalse(store.streaming)
        XCTAssertEqual(assistantTexts(store).suffix(2), ["An earlier turn's answer.", "Half of the reply."])

        frame(store, "message-start", ["turnId": "t5"])
        XCTAssertEqual(store.streamText, "", "a new turn kept the previous turn's text")
        XCTAssertTrue(store.liveTools.isEmpty)
    }

    /// A start that names no turn (and an error that names none, as older
    /// servers send): every frame keeps its old meaning.
    func testFramesWithoutATurnToCompareKeepTheirOldMeaning() {
        let (store, _, _) = makeStore(history: [row("u1", "user", "a question")])
        frame(store, "message-start")
        XCTAssertTrue(store.streaming)
        frame(store, "message-end", ["turnId": "t", "fullText": "An answer."])
        XCTAssertFalse(store.streaming)
        XCTAssertEqual(assistantTexts(store), ["An answer."])
        frame(store, "message-start")
        frame(store, "error", ["message": "Failed."])
        XCTAssertFalse(store.streaming)
        XCTAssertEqual(store.errorMessage, "Failed.")
    }
}
