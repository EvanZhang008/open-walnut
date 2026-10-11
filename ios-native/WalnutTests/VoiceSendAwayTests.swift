import XCTest
@testable import Walnut

/// Words spoken in voice mode whose transcription lands while their page is away (the
/// phone locked or another app in front right after the person tapped send, or the page
/// closed) are sent, and show once when the page is back (App Store gate r9, finding 1).
///
/// They used to go nowhere: the store's `send` returned before any bubble existed while
/// the page was away, voice mode on a session page keeps no copy of its own, and the
/// recording is deleted once its words are in hand. The recorder holds background time
/// exactly so the transcription can finish after a lock, and then the words were thrown
/// away. Chat's Talk to Walnut takes the same path from its second take on: those takes
/// go to the ask's session page.
///
/// A live take ends in `VoiceModeController.deliver`, the same call `deliverRecovered`
/// makes, so these tests hand the transcribed words over with it. The mock server's
/// transcript holds exactly what was posted to it.
@MainActor
final class VoiceSendAwayTests: XCTestCase {
    private let words = "Remind me to call the plumber on Thursday"
    private static let before = [("user", "Run the tests"), ("assistant", "All green.")]

    private func transcript(_ rows: [(String, String)]) -> SessionTranscript {
        SessionTranscript(
            sessionId: "voice-away", exportedAt: "2026-10-06T16:40:00Z", truncated: false,
            messages: rows.enumerated().map { i, row in
                SessionTranscript.Message(role: row.0, text: row.1,
                                          timestamp: String(format: "2026-10-06T16:%02d:00Z", i), kind: nil)
            }
        )
    }

    /// The server's transcript after the posts it took: what was there, then each posted
    /// message with its answer.
    private func served(_ rows: [(String, String)], _ transport: MockSessionSendTransport) -> SessionTranscript {
        transcript(rows + transport.sendCalls.flatMap { [("user", $0.text), ("assistant", "Noted: \($0.text).")] })
    }

    private func waitUntil(_ what: String, timeout: Double = 3, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(100))
    }

    /// A session page in voice mode, built the way `SessionConversationView` builds it.
    private func sessionPage(_ tag: String) async -> (SessionConversationStore, MockSessionSendTransport, VoiceModeController) {
        let transport = MockSessionSendTransport()
        transport.transcript = transcript(Self.before)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "voice-away-\(tag)"), transport: transport)
        await store.open()
        let voice = VoiceModeController(sessionID: "voice-away-\(tag)", rows: store.messages) { text in
            await store.send(text, voice: true)
        }
        return (store, transport, voice)
    }

    private func copies(_ text: String, _ store: SessionConversationStore) -> Int {
        store.messages.filter { $0.text == text }.count
    }

    // MARK: - The session page

    /// The phone locked (or another app came to the front) right after the person tapped
    /// send; the words are in hand while the page is away. They go out then, once, and
    /// show once when the page is back.
    func testWordsTranscribedWhileTheAppIsInTheBackgroundAreSentAndShowOnce() async {
        let (store, transport, voice) = await sessionPage("bg")
        defer { store.close() }
        store.suspend()
        await voice.deliverRecovered(words)
        XCTAssertEqual(transport.sendCallCount, 1, "the words did not go out while the page was away")
        XCTAssertEqual(transport.voiceFlags, [true], "they go out as spoken words")
        transport.transcript = served(Self.before, transport)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == words }
        }
        await settle()
        XCTAssertEqual(copies(words, store), 1, "the words do not show once on the page that came back")
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
        XCTAssertNil(voice.unsentText, "nothing is left to send again")
    }

    /// The same, with the person back on the page while the POST is still out: the
    /// resume's own read and the acceptance meet, and the words still show once.
    func testWordsTranscribedWhileAwayWhosePostEndsAfterThePageIsBackShowOnce() async {
        let (store, transport, voice) = await sessionPage("mid")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        store.suspend()
        let take = Task { await voice.deliverRecovered(words) }
        await waitUntil("the POST is out while the page is away") { transport.sendCallCount == 1 }
        store.resume()
        transport.transcript = served(Self.before, transport)
        gate.open()
        await take.value
        transport.gate = nil
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(transport.sendCallCount, 1)
        XCTAssertEqual(copies(words, store), 1)
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }

    /// The person left the page (Back) while their words were being turned into text.
    /// They are sent, and the page shows them once when it is opened again.
    func testWordsTranscribedAfterThePageClosedAreSentAndShowOnceWhenItOpensAgain() async {
        let (store, transport, voice) = await sessionPage("closed")
        defer { store.close() }
        store.close()
        await voice.deliverRecovered(words)
        XCTAssertEqual(transport.sendCallCount, 1, "the words did not go out after the page closed")
        transport.transcript = served(Self.before, transport)
        await store.open()
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(copies(words, store), 1, "the words do not show once on the page opened again")
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }

    /// Words that cannot go out while the page is away (the server refused them) stay on
    /// the page as a failed bubble the person can retry when they are back, under the
    /// same message id.
    func testWordsThatCannotGoOutWhileAwayStayAFailedBubbleToRetry() async {
        let (store, transport, voice) = await sessionPage("fail")
        defer { store.close() }
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        store.suspend()
        await voice.deliverRecovered(words)
        transport.permanentError = nil
        store.resume()
        await settle()
        let failed = store.messages.filter { $0.text == words && $0.failed == true }
        XCTAssertEqual(failed.count, 1, "the words are not on the page to retry")
        XCTAssertFalse(store.messages.contains { $0.pending == true })
        XCTAssertFalse(voice.awaitingAnswer, "voice mode does not wait for an answer to words that did not go out")
        guard let bubble = failed.first else { return }
        await store.retry(bubble)
        XCTAssertEqual(transport.sendCallCount, 2, "the retry went out")
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1, "under the same id")
        XCTAssertEqual(transport.voiceFlags, [true, true], "still as spoken words")
    }

    // MARK: - Chat's Talk to Walnut

    /// From the second take on, Talk to Walnut talks to the ask's session page, which
    /// `VoiceAskPage` opens in voice mode waiting for the first answer. A take whose words
    /// land while the app is away is sent and shows once, and so does the first message.
    func testTheAsksNextWordsTranscribedWhileAwayAreSentAndShowOnce() async {
        let sid = "voice-away-ask"
        let first = "What is open today"
        let transport = MockSessionSendTransport()
        transport.transcript = transcript([])
        SessionLaunchContext.stash(sessionId: sid, message: first)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: sid), transport: transport)
        defer { store.close() }
        // The page turns voice mode on before it opens (`SessionConversationView.task`).
        let voice = VoiceModeController(sessionID: sid, rows: store.messages, awaitingAnswer: true) { text in
            await store.send(text, voice: true)
        }
        await store.open()
        let firstTurn = [("user", first), ("assistant", "Two tasks are open.")]
        transport.transcript = transcript(firstTurn)
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(copies(first, store), 1, "the launch message shows once before the take")
        store.suspend()
        await voice.deliverRecovered(words)
        XCTAssertEqual(transport.sendCallCount, 1, "the ask's next words did not go out while the app was away")
        XCTAssertEqual(transport.voiceFlags, [true])
        transport.transcript = served(firstTurn, transport)
        store.resume()
        await waitUntil("the resume's read put the row on the page") {
            store.historyMessages.contains { $0.text == words }
        }
        await settle()
        XCTAssertEqual(copies(words, store), 1, "the words do not show once on the ask's page")
        XCTAssertEqual(copies(first, store), 1, "the launch message does not show once")
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }

    // MARK: - Control

    /// The same words with the page on screen: one POST, one copy.
    func testWordsTranscribedWhileThePageIsActiveAreSentOnce() async {
        let (store, transport, voice) = await sessionPage("active")
        defer { store.close() }
        await voice.deliverRecovered(words)
        XCTAssertEqual(transport.sendCallCount, 1)
        transport.transcript = served(Self.before, transport)
        store.reconcile(transport.transcript)
        await settle()
        XCTAssertEqual(copies(words, store), 1)
        XCTAssertFalse(store.messages.contains { $0.pending == true || $0.failed == true })
    }
}
