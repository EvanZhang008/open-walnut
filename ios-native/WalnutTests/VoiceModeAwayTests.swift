import UIKit
import XCTest
@testable import Walnut

/// Voice mode while Walnut is away (the phone locked, another app in front), and words
/// that could not be sent.
///
/// Nothing new starts speaking while Walnut is away: the review notes say so ("Nothing
/// new is read while the app is in the background"), and the provisional row's grace
/// timer once broke it (App Store gate r9, LOW 2: a turn ending in the half second
/// before the person left could have its answer read in the background 4 s later). An
/// answer that becomes due while away is read when Walnut is back.
///
/// Words that could not be sent are never lost without a trace: a session page shows
/// its failed bubble, with Retry, and voice mode keeps the words itself only when the
/// page shows none (a session that cannot be woken takes no message at all).
@MainActor
final class VoiceModeAwayTests: XCTestCase {
    /// Records what voice mode asked it to say (by row id), and says nothing.
    @MainActor
    private final class RecordingSpeaker: VoiceSpeaker {
        private(set) var said: [String] = []
        private(set) var speakingID: String?
        var isSpeaking: Bool { speakingID != nil }
        func speak(_ text: String, language: String, id: String) async {
            said.append(id)
            speakingID = id
        }
        func stop(handoff: Bool) { speakingID = nil }
    }

    /// Walnut's foreground state as the test sets it, and its own notification center:
    /// "back in front" is posted there, so the app's other observers never see it.
    @MainActor
    private final class App {
        var active = true
        let center = NotificationCenter()
        func comeBack() {
            active = true
            center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        }
    }

    private func row(_ id: String, _ role: String, _ text: String) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: "2026-10-10T10:00:00Z", kind: nil)
    }

    private lazy var before = [row("u1", "user", "Run the tests"), row("a1", "assistant", "All green.")]
    private lazy var asked = row("u2", "user", "And the release notes?")
    private lazy var answer = row("assistant|t2|#0", "assistant", "The draft is ready for you.")

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(150))
    }

    private func controller(_ speaker: RecordingSpeaker, _ app: App) -> VoiceModeController {
        VoiceModeController(sessionID: "away-speech", rows: before, speaker: speaker,
                            isAppActive: { app.active }, notifications: app.center) { _ in true }
    }

    // MARK: - Nothing new is read while away

    /// The turn's answer lands while Walnut is away: not read then, read on its return.
    func testANewAnswerIsNotReadWhileWalnutIsAwayAndIsReadOnItsReturn() async {
        let speaker = RecordingSpeaker()
        let app = App()
        let voice = controller(speaker, app)
        defer { voice.shutDown() }
        app.active = false
        voice.observe(rows: before + [asked, answer], streaming: false)
        await settle()
        XCTAssertEqual(speaker.said, [], "a new answer was read while Walnut was away")
        app.comeBack()
        await settle()
        XCTAssertEqual(speaker.said, [answer.id], "the answer that came while Walnut was away is not read on its return")
    }

    /// The gate's case: the turn ends with a provisional row while Walnut is on screen,
    /// the person leaves inside the grace, and the grace runs out while away. Not read
    /// then; read on return, with nothing on the page changed (no canonical row yet).
    func testAProvisionalAnswerWhoseGraceEndsWhileAwayIsReadOnReturn() async throws {
        let speaker = RecordingSpeaker()
        let app = App()
        let voice = controller(speaker, app)
        defer { voice.shutDown() }
        let provisional = row("provisional-77", "assistant", "The draft is ready for you.")
        voice.observe(rows: before + [asked, provisional], streaming: false)
        await settle()
        XCTAssertEqual(speaker.said, [], "a provisional row waits for its canonical one")
        app.active = false
        try await Task.sleep(for: .seconds(VoiceModeController.provisionalGrace + 0.7))
        XCTAssertEqual(speaker.said, [], "the grace ran out while Walnut was away and the answer was read in the background")
        app.comeBack()
        await settle()
        XCTAssertEqual(speaker.said, [provisional.id], "the answer is not read when Walnut is back")
    }

    /// "It needs your answer on the screen" is not said while Walnut is away either.
    func testTheCardLineIsNotSaidWhileAway() async {
        let speaker = RecordingSpeaker()
        let app = App()
        let voice = controller(speaker, app)
        defer { voice.shutDown() }
        app.active = false
        await voice.announceWaitingOnYou(requestIDs: ["rq-away"])
        XCTAssertEqual(speaker.said, [], "the card line was said while Walnut was away")
        app.active = true
        await voice.announceWaitingOnYou(requestIDs: ["rq-here"])
        XCTAssertEqual(speaker.said, ["needs-answer-rq-here"], "and is said for a card while Walnut is on screen")
    }

    /// An answer being read when the person leaves is read to its end: leaving stops
    /// nothing, and an answer that lands meanwhile is not read over it.
    func testAnAnswerBeingReadWhenWalnutLeavesIsNotStopped() async {
        let speaker = RecordingSpeaker()
        let app = App()
        let voice = controller(speaker, app)
        defer { voice.shutDown() }
        voice.observe(rows: before + [asked, answer], streaming: false)
        await settle()
        XCTAssertEqual(speaker.said, [answer.id])
        app.active = false
        let later = row("assistant|t3|#0", "assistant", "One more thing came in.")
        voice.observe(rows: before + [asked, answer, row("n3", "user", "<walnut-message kind=\"notification\">done</walnut-message>"), later],
                      streaming: false)
        await settle()
        XCTAssertEqual(speaker.speakingID, answer.id, "the answer being read was stopped when Walnut left")
        XCTAssertEqual(speaker.said, [answer.id], "a new answer was read while Walnut was away")
    }

    /// Control: on screen, the answer is read as soon as the turn is over.
    func testAnAnswerIsReadAtOnceWhileWalnutIsOnScreen() async {
        let speaker = RecordingSpeaker()
        let app = App()
        let voice = controller(speaker, app)
        defer { voice.shutDown() }
        voice.observe(rows: before + [asked, answer], streaming: false)
        await settle()
        XCTAssertEqual(speaker.said, [answer.id])
        app.comeBack()
        await settle()
        XCTAssertEqual(speaker.said, [answer.id], "coming back does not read it twice")
    }

    // MARK: - Words that could not be sent

    private func transcript(_ rows: [(String, String)]) -> SessionTranscript {
        SessionTranscript(
            sessionId: "away-unsent", exportedAt: "2026-10-06T16:40:00Z", truncated: false,
            messages: rows.enumerated().map { i, row in
                SessionTranscript.Message(role: row.0, text: row.1,
                                          timestamp: String(format: "2026-10-06T16:%02d:00Z", i), kind: nil)
            }
        )
    }

    private let words = "Remind me to call the plumber on Thursday"

    /// A session page, with voice mode built the way the page builds it.
    private func sessionPage(_ tag: String) async -> (SessionConversationStore, MockSessionSendTransport, VoiceModeController) {
        let transport = MockSessionSendTransport()
        transport.transcript = transcript([("user", "Run the tests"), ("assistant", "All green.")])
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "away-unsent-\(tag)"), transport: transport)
        await store.open()
        let voice = VoiceModeController.sessionPage(store, sessionID: "away-unsent-\(tag)", awaitingAnswer: false,
                                                    speaker: RecordingSpeaker(), isAppActive: { true },
                                                    notifications: NotificationCenter())
        return (store, transport, voice)
    }

    /// A send that fails while the page is away leaves its failed bubble, and voice mode
    /// keeps no second copy ("Not sent" twice on one page).
    func testAFailedSendThePageShowsIsNotKeptTwice() async {
        let (store, transport, voice) = await sessionPage("bubble")
        defer { store.close(); voice.shutDown() }
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        store.suspend()
        await voice.deliverRecovered(words)
        store.resume()
        XCTAssertEqual(store.messages.filter { $0.text == words && $0.failed == true }.count, 1,
                       "the failed bubble is the words' copy on the page")
        XCTAssertNil(voice.unsentText, "the words show twice: the failed bubble and Not sent in the voice bar")
    }

    /// A session that cannot be woken takes no message, so the page shows no bubble:
    /// voice mode keeps the words, with Send again and Discard.
    func testWordsASessionThatCannotBeWokenDidNotTakeAreKept() async {
        let (store, transport, voice) = await sessionPage("dead")
        defer { store.close(); voice.shutDown() }
        transport.permanentError = APIError.server(status: 409, code: "session_dead", message: "gone",
                                                   serverHash: nil, serverContent: nil)
        _ = await store.send("Typed before")
        XCTAssertTrue(store.dead, "the session said it cannot be woken")
        XCTAssertEqual(transport.sendCallCount, 1)
        await voice.deliverRecovered(words)
        XCTAssertEqual(transport.sendCallCount, 1, "nothing more was posted to a session that cannot be woken")
        XCTAssertFalse(store.messages.contains { $0.text == words }, "the page shows no copy of the words")
        XCTAssertEqual(voice.unsentText, words, "the words were lost without a trace")
        XCTAssertFalse(voice.awaitingAnswer)
    }
}
