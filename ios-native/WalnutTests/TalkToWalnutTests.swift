import XCTest
import AppIntents
@testable import Walnut

// Talk to Walnut (the Action Button shortcut to the CEO chat): the take's state
// machine, the pause detector, the unsent list, the CEO chat route, and the
// bundle facts iOS needs to offer the shortcut and show its Live Activity.

/// What the take asked for, in order, across the recorder and the Live Activity.
@MainActor
private final class CallOrder {
    var calls: [String] = []
}

@MainActor
private final class FakeTalkRecorder: TalkRecording {
    var order: CallOrder?
    var beginFailure: String?
    /// Holds `begin` open until released, to press during start-up.
    var holdBegin = false
    var levels: [Float?] = []
    var finishResult: TalkTake = .words("hello", recordingID: "rec-1")
    var transcribeResult: TalkTake = .words("again", recordingID: "rec-1")
    var kept: [String] = []
    private(set) var began = 0
    private(set) var discarded = 0
    private(set) var finished = 0
    private(set) var transcribed: [String] = []
    private(set) var forgotten: [String] = []
    private var levelIndex = 0
    private var recording = false
    private var beginGate: CheckedContinuation<Void, Never>?

    var keptAudio: [String: TalkKeptAudio] = [:]
    func keptAudio(recordingID: String) -> TalkKeptAudio? { keptAudio[recordingID] }

    func begin() async -> String? {
        began += 1
        order?.calls.append("microphone")
        if holdBegin { await withCheckedContinuation { beginGate = $0 } }
        if beginFailure == nil { recording = true }
        return beginFailure
    }

    func releaseBegin() {
        holdBegin = false
        beginGate?.resume()
        beginGate = nil
    }

    func level() -> Float? {
        guard recording else { return nil }
        defer { levelIndex += 1 }
        return levelIndex < levels.count ? levels[levelIndex] : (levels.last ?? -60)
    }

    func finish() async -> TalkTake {
        recording = false
        finished += 1
        return finishResult
    }

    func discard() {
        recording = false
        discarded += 1
    }

    func transcribe(recordingID: String) async -> TalkTake {
        transcribed.append(recordingID)
        return transcribeResult
    }

    func forget(recordingID: String) { forgotten.append(recordingID) }

    func keptTakeIDs() -> [String] { kept }
}

/// Like `URLSession`, it fails at once in a cancelled task: the pause path once
/// sent from inside the cancelled monitor and lost every take.
private final class FakeTalkSender: TalkSending, @unchecked Sendable {
    var failures: [Error] = []
    /// The CEO chat has no session: the send starts it (`beforeStart` runs first).
    var startsChat = false
    /// Holds a send that starts the chat until released (Walnut ended mid-start).
    var holdStart = false
    private(set) var sent: [(text: String, messageId: String)] = []
    private var startGate: CheckedContinuation<Void, Never>?

    func send(text: String, messageId: String, beforeStart: @escaping @Sendable () async -> Void) async throws {
        try Task.checkCancellation()
        if startsChat {
            await beforeStart()
            if holdStart { await withCheckedContinuation { startGate = $0 } }
        }
        if !failures.isEmpty { throw failures.removeFirst() }
        sent.append((text, messageId))
    }
}

@MainActor
private final class FakeTalkActivity: TalkActivityPresenting {
    var order: CallOrder?
    var allow = true
    var canShow: Bool { allow }
    private(set) var started: [TalkActivityAttributes.ContentState] = []
    private(set) var updates: [TalkActivityAttributes.ContentState] = []
    private(set) var ended: [(state: TalkActivityAttributes.ContentState, linger: TimeInterval)] = []
    private(set) var leftoversEnded = 0
    /// The takes still listed when the cards of the others were last told to go.
    private(set) var lastKeeping: Set<String>?

    func start(_ state: TalkActivityAttributes.ContentState) -> Bool {
        started.append(state)
        order?.calls.append("live-activity")
        return allow
    }

    func update(_ state: TalkActivityAttributes.ContentState) { updates.append(state) }

    func end(_ state: TalkActivityAttributes.ContentState, linger: TimeInterval) { ended.append((state, linger)) }

    func endLeftovers(keeping kept: Set<String>) {
        leftoversEnded += 1
        lastKeeping = kept
    }
}

private final class FakeMainTransport: TalkMainTransport, @unchecked Sendable {
    var sessionIds: [String?] = ["sess-main"]
    var launchError: Error?
    var sendError: Error?
    private(set) var calls: [String] = []

    func orgMain() async throws -> String {
        calls.append("orgMain")
        return "task-main"
    }

    func talkCurrentSession(taskId: String) async throws -> String? {
        calls.append("detail:\(taskId)")
        return sessionIds.isEmpty ? nil : sessionIds.removeFirst()
    }

    func talkSend(sessionId: String, text: String, messageId: String) async throws {
        calls.append("send:\(sessionId):\(text):\(messageId)")
        if let sendError { throw sendError }
    }

    func talkLaunch(taskId: String, message: String) async throws {
        calls.append("launch:\(taskId):\(message)")
        if let launchError { throw launchError }
    }
}

@MainActor
final class TalkSessionTests: XCTestCase {
    private var recorder: FakeTalkRecorder!
    private var sender: FakeTalkSender!
    private var activity: FakeTalkActivity!
    private var outbox: TalkOutbox!
    private var mic: TalkSession.MicAccess = .granted
    /// In front unless a test says otherwise (a press from behind the app on screen).
    private var ceoChatsOpened = 0
    private var foreground = true
    private var paired = true
    private var cues: [TalkCue] = []
    private let key = "talk-outbox-test-\(UUID().uuidString)"
    /// The clipboard of the dictation tests: what was copied, and whether iOS takes it.
    private var copied: [String] = []
    private var copyTakes = true
    /// How many times the dictation's page was brought up.
    private var pagesShown = 0
    private let prefsSuite = "talk-prefs-test-\(UUID().uuidString)"
    private var prefs: UserDefaults!

    override func setUp() async throws {
        recorder = FakeTalkRecorder()
        sender = FakeTalkSender()
        activity = FakeTalkActivity()
        outbox = TalkOutbox(key: key)
        mic = .granted
        foreground = true
        paired = true
        copied = []
        copyTakes = true
        pagesShown = 0
        prefs = UserDefaults(suiteName: prefsSuite)
    }

    override func tearDown() async throws {
        DurableStore.remove(key: key)
        prefs.removePersistentDomain(forName: prefsSuite)
    }

    private func session(sender custom: TalkSending? = nil) -> TalkSession {
        let session = TalkSession(
            recorder: recorder, sender: custom ?? sender, activity: activity, outbox: outbox,
            micAccess: { [unowned self] in self.mic },
            isForeground: { [unowned self] in self.foreground },
            isPaired: { [unowned self] in self.paired },
            prefs: prefs
        )
        session.tick = .milliseconds(5)
        session.cue = { [unowned self] in self.cues.append($0) }
        session.copier = { [unowned self] text in
            guard self.copyTakes else { return false }
            self.copied.append(text)
            return true
        }
        session.presentReview = { [unowned self] in self.pagesShown += 1 }
        session.openCEOChat = { [unowned self] in self.ceoChatsOpened += 1 }
        return session
    }

    /// A press that could not record from behind opens Walnut: the intent waits until it is
    /// in front, and says so when it never comes.
    func testThePressWaitsForWalnutInFrontAndSaysWhenItNeverCame() async {
        let session = session()
        foreground = false
        let never = await session.waitUntilInFront(timeout: 0.2)
        XCTAssertFalse(never, "a Walnut that never came forward reads as in front")
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(100))
            self.foreground = true
        }
        let came = await session.waitUntilInFront(timeout: 5)
        XCTAssertTrue(came, "Walnut came forward, but the wait did not see it")
    }

    /// Press, press: the words reach the CEO chat once.
    @discardableResult
    private func keep(_ text: String, minutesAgo: Double, attempts: Int = 1) -> TalkOutbox.Entry {
        let entry = TalkOutbox.Entry(
            id: "kept-\(text)", messageId: SendRetryPolicy.newMessageId(), createdAt: Date(timeIntervalSinceNow: -minutesAgo * 60),
            text: text, recordingID: nil, reason: "Walnut server unavailable.", attempts: attempts, updatedAt: Date()
        )
        outbox.begin(entry)
        return entry
    }

    func testATakeTheServerMissedIsSavedForLaterNotAnAlarm() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await pressTwice(talk)
        let ending = try XCTUnwrap(activity.ended.last?.state)
        XCTAssertEqual(ending.title, "Waiting to send")
        XCTAssertEqual(ending.subtitle, "Walnut server unavailable. It sends the next time you open Walnut.")
        XCTAssertFalse(ending.needsAttention, "a take that goes out by itself makes no alarm")
    }

    /// One rule says whether a kept take waits calmly or needs the person, so
    /// the island, Settings, the sheet and its offer never disagree.
    func testAKeptTakeWaitsOnlyWhileWalnutStillSendsItByItself() {
        let waiting = keep("waiting", minutesAgo: 1)
        XCTAssertTrue(TalkSession.waits(waiting))
        let tiredOut = keep("tired", minutesAgo: 2, attempts: TalkSession.autoResendLimit)
        XCTAssertFalse(TalkSession.waits(tiredOut), "no tries left: it needs the person")
        var refused = waiting
        refused.reason = "Your Walnut server did not accept this iPhone. Open Walnut to check its connection."
        XCTAssertFalse(TalkSession.waits(refused), "a failure the next try cannot fix needs the person")
    }

    func testATakeThatWillNotGoByItselfIsAnAlarm() async throws {
        sender.failures = [APIError.unauthorized]
        let talk = session()
        try await pressTwice(talk)
        let ending = try XCTUnwrap(activity.ended.last?.state)
        XCTAssertEqual(ending.title, "Not sent")
        XCTAssertTrue(ending.needsAttention)
    }

    func testATakeTapsWhenListeningStartsAndWhenItIsSent() async throws {
        let talk = session()
        try await pressTwice(talk)
        XCTAssertEqual(cues, [.started, .sent])
    }

    func testAFailedTakeGivesNoSentTap() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await pressTwice(talk)
        XCTAssertEqual(cues, [.started], "a failure has the island's alert sound instead")
    }

    func testKeptTakesGoOutBySelfOldestFirst() async throws {
        let older = keep("first words", minutesAgo: 30)
        let newer = keep("second words", minutesAgo: 5)
        let talk = session()
        await talk.resendKept(source: "test")
        XCTAssertEqual(sender.sent.map(\.text), ["first words", "second words"])
        XCTAssertEqual(sender.sent.map(\.messageId), [older.messageId, newer.messageId], "each keeps its own message id")
        XCTAssertTrue(outbox.unsent.isEmpty)
    }

    /// Every automatic send (Walnut opened, the network back, another take sent) goes
    /// through `resendKept`, and it sends only what `waits` says goes out by itself: one
    /// shown as needing the person never leaves without them.
    func testAKeptTakeThatNeedsThePersonNeverGoesOutBySelf() async throws {
        let needsPerson = [
            TalkSession.stoppedAtCap, TalkSendError.startOutcomeUnknown.localizedDescription,
            "Walnut closed before this was sent.", "Your Walnut server did not accept this iPhone. Open Walnut to check its connection.",
        ]
        for (n, reason) in needsPerson.enumerated() {
            outbox.begin(TalkOutbox.Entry(
                id: "person-\(n)", messageId: SendRetryPolicy.newMessageId(), createdAt: Date(timeIntervalSinceNow: -60),
                text: "words \(n)", recordingID: nil, reason: reason, attempts: 1, updatedAt: Date()
            ))
        }
        keep("goes by itself", minutesAgo: 1)
        let talk = session()
        for source in ["app-active", "network-back", "after-send"] { await talk.resendKept(source: source) }
        XCTAssertEqual(sender.sent.map(\.text), ["goes by itself"])
        XCTAssertEqual(outbox.unsent.count, needsPerson.count)
    }

    func testAnAutomaticResendStopsAtTheFirstFailure() async throws {
        keep("first words", minutesAgo: 30)
        keep("second words", minutesAgo: 5)
        sender.failures = [APIError.network(underlying: URLError(.timedOut))]
        let talk = session()
        await talk.resendKept(source: "test")
        XCTAssertTrue(sender.sent.isEmpty, "the server is still away: nothing more is tried")
        XCTAssertEqual(outbox.unsent.count, 2)
    }

    func testATakeTriedTooOftenWaitsForThePerson() async throws {
        keep("stubborn", minutesAgo: 30, attempts: TalkSession.autoResendLimit)
        let talk = session()
        await talk.resendKept(source: "test")
        XCTAssertTrue(sender.sent.isEmpty)
        let sent = await talk.resend("kept-stubborn")
        XCTAssertTrue(sent, "the person's Resend still sends it")
    }

    func testATakeThatGoesOutTakesTheKeptOnesWithIt() async throws {
        keep("from the lift", minutesAgo: 20)
        let talk = session()
        try await pressTwice(talk)
        try await waitUntil { self.outbox.unsent.isEmpty }
        XCTAssertEqual(Set(sender.sent.map(\.text)), ["hello", "from the lift"])
    }

    private func pressTwice(_ talk: TalkSession) async throws {
        try await talk.toggle(source: "test")
        try await talk.toggle(source: "test")
        await talk.finishing?.value
    }

    func testPressListensThenSecondPressSendsTheWordsToTheCEO() async throws {
        let talk = session()
        let first = try await talk.toggle(source: "test")
        XCTAssertEqual(first, .listening)
        XCTAssertEqual(talk.phase, .listening)
        XCTAssertEqual(activity.started.first?.phase, .listening, "in front too, the take shows its Live Activity")

        let second = try await talk.toggle(source: "test")
        XCTAssertEqual(second, .finishing, "the second press returns before the send")
        await talk.finishing?.value
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertTrue(SendRetryPolicy.isValidMessageId(sender.sent[0].messageId))
        XCTAssertEqual(talk.phase, .sent("hello"))
        XCTAssertTrue(outbox.entries.isEmpty, "a delivered take leaves nothing behind")
        XCTAssertEqual(activity.ended.last?.state.phase, .sent)
        XCTAssertEqual(activity.updates.map(\.phase), [.transcribing, .sending])
    }

    /// A pause never sends by itself (the user, 2026-11-07: it "adds stress"): the take
    /// listens on, the screen off or not, until Send or a second press.
    func testAPauseAfterSpeechSendsNothingUntilThePersonSends() async throws {
        var detector = TalkPauseDetector()
        detector.pauseToSend = 0.05
        detector.minSpeech = 0.01
        // The silence timeout stays at its default: readings are timed by the wall clock,
        // and on a loaded CI runner the three quiet readings before the speech outlasted a
        // 0.05 s timeout, so the take was dropped as silent before it heard a word.
        recorder.levels = Array(repeating: -60, count: 3) + Array(repeating: -15, count: 20) + Array(repeating: -60, count: 400)
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(talk.phase, .listening, "a pause ended the take")
        XCTAssertTrue(sender.sent.isEmpty)
        try await talk.toggle(source: "test")
        await talk.finishing?.value
        XCTAssertEqual(talk.phase, .sent("hello"))
        XCTAssertEqual(recorder.discarded, 0)
    }

    /// With `sendsOnPause` the pause still ends it, in a task of its own: the send must not
    /// run in the monitor it cancels.
    func testAPauseSendsOnlyWhenAskedTo() async throws {
        var detector = TalkPauseDetector()
        detector.sendsOnPause = true
        detector.pauseToSend = 0.05
        detector.minSpeech = 0.01
        recorder.levels = Array(repeating: -60, count: 3) + Array(repeating: -15, count: 20) + Array(repeating: -60, count: 400)
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await waitUntil { if case .sent = talk.phase { return true }; return talk.phase != .listening && talk.phase != .transcribing && talk.phase != .sending }
        XCTAssertEqual(talk.phase, .sent("hello"), "the send must not run in the cancelled monitor")
        XCTAssertEqual(sender.sent.count, 1)
    }

    /// Five minutes and nobody said to send it (a press in a pocket): the words wait for
    /// the person, never go to the CEO by themselves.
    func testATakeTheCapEndsWaitsForThePerson() async throws {
        var detector = TalkPauseDetector()
        detector.maxDuration = 0.05
        recorder.levels = [-15]
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await waitUntil { if case .notSent = talk.phase { return true }; return false }
        await talk.finishing?.value
        XCTAssertTrue(sender.sent.isEmpty, "the cap sent the take")
        let kept = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(kept.text, "hello")
        XCTAssertEqual(kept.reason, TalkSession.stoppedAtCap)
        XCTAssertFalse(TalkSession.waits(kept), "it would go out by itself")
        let sent = await talk.resend(kept.id)
        XCTAssertTrue(sent, "the person's Send")
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
    }

    func testSilenceCancelsAndSendsNothing() async throws {
        var detector = TalkPauseDetector()
        detector.noSpeechTimeout = 0.05
        recorder.levels = [-70]
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await waitUntil { talk.phase != .listening }
        XCTAssertEqual(talk.phase, .notSent("Didn't hear anything, so nothing was sent.", kept: false))
        XCTAssertFalse(try XCTUnwrap(activity.ended.last?.state.subtitle).contains("resend"), "nothing was kept to resend")
        XCTAssertEqual(activity.ended.last?.state.title, "Nothing heard")
        XCTAssertEqual(activity.ended.last?.state.needsAttention, false, "silence is no alarm")
        XCTAssertEqual(recorder.discarded, 1)
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    func testSoundThatNeverCountedAsSpeechListensOnAndIsNeverDeletedUnheard() async throws {
        var detector = TalkPauseDetector()
        detector.noSpeechTimeout = 0.05
        detector.minSpeech = 10
        recorder.levels = [-35]
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(talk.phase, .listening, "soft speech was given up on as silence")
        try await talk.toggle(source: "test")
        try await waitUntil { talk.phase == .sent("hello") }
        XCTAssertEqual(recorder.discarded, 0, "audio with sound in it is never deleted unheard")
    }

    func testATakeCutOffUnderTheRecorderIsKeptForAResend() async throws {
        recorder.levels = [-20, -20, nil]
        recorder.finishResult = .failed("The recording was cut off (a call, or another app took the microphone).", recordingID: "rec-live")
        let talk = session()
        try await talk.toggle(source: "test")
        try await waitUntil { if case .notSent = talk.phase { return true }; return false }
        XCTAssertEqual(outbox.unsent.first?.recordingID, "rec-live")
        XCTAssertNil(outbox.unsent.first?.text)
        XCTAssertEqual(activity.ended.last?.state.phase, .failed)
    }

    func testAFailedSendIsKeptWithItsReasonAndAResendUsesTheSameMessageId() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await pressTwice(talk)
        guard case .notSent(let reason, let kept) = talk.phase else { return XCTFail("phase \(talk.phase)") }
        XCTAssertTrue(kept)
        XCTAssertEqual(reason, "Walnut server unavailable.")
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.text, "hello")
        XCTAssertEqual(entry.reason, reason)
        XCTAssertEqual(activity.ended.last?.state.phase, .failed)

        // The words survive the process: a new outbox over the same key reads them.
        XCTAssertEqual(TalkOutbox(key: key).unsent.map(\.text), ["hello"])

        let resend = Task { await talk.resend(entry.id) }
        XCTAssertEqual(outbox.unsent.count, 1, "the row stays on the list while it is resent")
        let sent = await resend.value
        XCTAssertTrue(sent)
        XCTAssertEqual(sender.sent.map(\.messageId), [entry.messageId], "a resend is the same message to the server")
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertEqual(talk.lastResent, "hello", "the list says which words went out")
        talk.clearResentNotice()
        XCTAssertNil(talk.lastResent)
    }

    func testAFailedTranscriptionKeepsTheRecordingAndAResendTranscribesItFirst() async throws {
        recorder.finishResult = .failed("Voice unavailable: the Mac is asleep.", recordingID: "rec-9")
        recorder.transcribeResult = .words("later words", recordingID: "rec-9")
        let talk = session()
        try await pressTwice(talk)
        XCTAssertEqual(talk.phase, .notSent("Voice unavailable: the Mac is asleep.", kept: true))
        XCTAssertEqual(activity.ended.last?.state.subtitle, "Voice unavailable: the Mac is asleep. Open Walnut to resend it.")
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertNil(entry.text)
        XCTAssertEqual(entry.recordingID, "rec-9")
        XCTAssertTrue(sender.sent.isEmpty)
        // The row can play it back and say how long it is.
        let audio = TalkKeptAudio(url: URL(fileURLWithPath: "/tmp/rec-9.caf"), seconds: 6)
        recorder.keptAudio["rec-9"] = audio
        XCTAssertEqual(talk.keptAudio(entry), audio)

        let sent = await talk.resend(entry.id)
        XCTAssertTrue(sent)
        XCTAssertEqual(recorder.transcribed, ["rec-9"])
        XCTAssertEqual(sender.sent.map(\.text), ["later words"])
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertEqual(talk.phase, .idle, "the old failure no longer shows once nothing is kept")
    }

    func testDeletingTheLastKeptTakeClearsItsNotice() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await pressTwice(talk)
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        talk.discard(id)
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertEqual(talk.phase, .idle)
    }

    func testAResendThatFailsAgainStaysWithTheNewReason() async throws {
        sender.failures = [APIError.unauthorized, APIError.server(status: 501, code: "primary_only", message: "", serverHash: nil, serverContent: nil)]
        let talk = session()
        try await pressTwice(talk)
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        let sent = await talk.resend(id)
        XCTAssertFalse(sent)
        XCTAssertEqual(outbox.unsent.first?.reason, "The CEO can start only while your Mac is online.")
        XCTAssertEqual(outbox.unsent.first?.attempts, 2, "the row says it was tried again")
        XCTAssertNil(talk.lastResent, "a failed resend says nothing went out")
    }

    func testNoWordsSendsNothingKeepsNothingAndDeletesTheTake() async throws {
        recorder.finishResult = .noWords(recordingID: "rec-cough")
        let talk = session()
        try await pressTwice(talk)
        XCTAssertEqual(talk.phase, .notSent("Didn't catch any words, so nothing was sent.", kept: false))
        XCTAssertFalse(try XCTUnwrap(activity.ended.last?.state.subtitle).contains("resend"), "nothing was kept to resend")
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertEqual(recorder.forgotten, ["rec-cough"])
    }

    func testStartRefusalsSayWhatToDo() async throws {
        paired = false
        await assertThrows(session(), .notPaired)
        paired = true
        mic = .denied
        await assertThrows(session(), .micDenied)
        mic = .undetermined
        foreground = false
        await assertThrows(session(), .micNotAsked)
        XCTAssertEqual(recorder.began, 0, "a refused start never opens the microphone")
        foreground = true
        let talk = session()
        try await talk.toggle(source: "test")
        XCTAssertEqual(talk.phase, .listening, "in the app the system asks for the microphone itself")
    }

    /// Build 160 opened the microphone from behind the app on screen BEFORE the take's
    /// Live Activity, and a phone refused every press ('!int'). iOS records there only
    /// while that Live Activity shows, so it comes first.
    func testFromBehindTheLiveActivityStartsBeforeTheMicrophone() async throws {
        let order = CallOrder()
        recorder.order = order
        activity.order = order
        foreground = false
        let talk = session()
        try await talk.toggle(source: "test")
        XCTAssertEqual(order.calls, ["live-activity", "microphone"])
        XCTAssertEqual(talk.phase, .listening)
        XCTAssertEqual(activity.started.first?.phase, .listening)
        try await talk.toggle(source: "test")
        await talk.finishing?.value
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertEqual(talk.phase, .sent("hello"))
        XCTAssertEqual(activity.ended.last?.state.phase, .sent, "the bar says Sent, then goes")
        XCTAssertEqual(activity.ended.last?.linger, talk.sentLinger)
    }

    /// Live Activities off: nothing can record from behind, so the press opens Walnut.
    func testFromBehindWithLiveActivitiesOffTheTakeMovesToWalnut() async throws {
        activity.allow = false
        foreground = false
        let talk = session()
        await assertThrows(talk, .needsFront("Live Activities are off for Walnut, so it opened to listen."))
        XCTAssertEqual(recorder.began, 0, "the microphone was asked for with no Live Activity up")
        XCTAssertEqual(talk.phase, .idle)
        XCTAssertTrue(TalkToWalnutIntent.opensWalnut(for: .needsFront("x")))
    }

    /// iOS refused the microphone from behind anyway: the bar goes at once and the press
    /// opens Walnut, where the take starts again.
    func testFromBehindAMicrophoneRefusalEndsTheBarAndMovesToWalnut() async throws {
        recorder.beginFailure = "Audio is in use by another app."
        foreground = false
        let talk = session()
        await assertThrows(talk, .needsFront("Audio is in use by another app."))
        XCTAssertEqual(activity.ended.last?.linger, 0, "a bar left saying Listening")
        XCTAssertEqual(talk.phase, .idle)
        recorder.beginFailure = nil
        foreground = true
        try await talk.toggle(source: "test")
        XCTAssertEqual(talk.phase, .listening, "the take in Walnut starts")
        XCTAssertEqual(activity.started.count, 2, "the take in Walnut shows its own Live Activity: AppIntents ends a recording run with none")
    }

    /// Only an unpaired iPhone and a microphone turned off in Settings stay a refusal:
    /// opening Walnut fixes neither.
    func testTheRefusalsThatOpenWalnut() {
        XCTAssertTrue(TalkToWalnutIntent.opensWalnut(for: .micNotAsked))
        XCTAssertFalse(TalkToWalnutIntent.opensWalnut(for: .notPaired))
        XCTAssertFalse(TalkToWalnutIntent.opensWalnut(for: .micDenied))
        XCTAssertFalse(TalkToWalnutIntent.opensWalnut(for: .busy))
    }

    /// In front the Talk screen shows the take: no Live Activity, Live Activities on or off.
    /// In front a take with Live Activities off still records (the Talk screen shows it);
    /// the intent starts such a take only after its run (see `TalkToWalnutIntent`).
    func testInFrontATakeWithLiveActivitiesOffStillRecords() async throws {
        activity.allow = false
        let talk = session()
        XCTAssertFalse(talk.showsLiveActivity)
        try await pressTwice(talk)
        XCTAssertEqual(talk.phase, .sent("hello"))
        XCTAssertEqual(activity.started.count, 1, "it was asked for, and refused")
    }

    /// An AudioRecordingIntent that returns with the microphone on and no Live Activity
    /// is a fatal error in AppIntents: every take starts its Live Activity, in front too.
    func testInFrontATakeStartsItsLiveActivityBeforeTheMicrophone() async throws {
        let order = CallOrder()
        recorder.order = order
        activity.order = order
        let talk = session()
        try await talk.toggle(source: "test")
        XCTAssertEqual(order.calls, ["live-activity", "microphone"])
        XCTAssertEqual(activity.started.first?.phase, .listening)
    }

    func testAMicrophoneThatWillNotStartIsReportedAndNothingIsLeftListening() async throws {
        recorder.beginFailure = "Another app is using audio (a call?)."
        let talk = session()
        await assertThrows(talk, .couldNotStart("Another app is using audio (a call?)."))
        XCTAssertEqual(activity.ended.last?.linger, 0, "no bar left saying Listening")
        XCTAssertEqual(talk.phase, .idle)
    }

    func testAPressWhileTheMicrophoneOpensIsBusyNotAStop() async throws {
        recorder.holdBegin = true
        let talk = session()
        let first = Task { try await talk.toggle(source: "test") }
        try await waitUntil { talk.phase == .starting }
        do {
            try await talk.toggle(source: "test")
            XCTFail("expected busy")
        } catch let error as TalkSession.StartError {
            XCTAssertEqual(error, .busy)
        }
        recorder.releaseBegin()
        _ = try await first.value
        XCTAssertEqual(talk.phase, .listening)
        XCTAssertEqual(recorder.finished, 0)
        XCTAssertEqual(recorder.began, 1)
    }

    /// The Live Activity shows its Send and Cancel as soon as it is up, before the
    /// microphone opens: a tap then is done once it listens, not dropped.
    func testASendOrCancelTappedWhileTheMicrophoneOpensIsDoneOnceItListens() async throws {
        foreground = false
        recorder.holdBegin = true
        let talk = session()
        let first = Task { try await talk.toggle(source: "test") }
        try await waitUntil { talk.phase == .starting }
        talk.finishSoon(source: "activity-send")
        recorder.releaseBegin()
        _ = try await first.value
        await talk.finishing?.value
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])

        recorder.holdBegin = true
        let second = Task { try await talk.toggle(source: "test") }
        try await waitUntil { talk.phase == .starting }
        await talk.cancel(source: "activity-cancel")
        recorder.releaseBegin()
        _ = try await second.value
        XCTAssertEqual(talk.phase, .idle)
        XCTAssertEqual(recorder.discarded, 1)
        XCTAssertEqual(sender.sent.count, 1)
    }

    func testCancelDropsTheTake() async throws {
        let talk = session()
        try await talk.toggle(source: "test")
        await talk.cancel(source: "test")
        XCTAssertEqual(talk.phase, .idle)
        XCTAssertEqual(recorder.discarded, 1)
        XCTAssertEqual(recorder.finished, 0)
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertEqual(activity.ended.last?.linger, 0)
    }

    func testAPressWhileSendingDoesNotSendTwice() async throws {
        let gate = GatedSender()
        let talk = session(sender: gate)
        try await talk.toggle(source: "test")
        try await talk.toggle(source: "test")
        try await waitUntil { talk.phase == .sending }
        do {
            try await talk.toggle(source: "test")
            XCTFail("expected busy")
        } catch let error as TalkSession.StartError {
            XCTAssertEqual(error, .busy)
        }
        gate.open()
        await talk.finishing?.value
        XCTAssertEqual(gate.count, 1)
        XCTAssertEqual(recorder.began, 1)
    }

    func testANewProcessListsWhatTheLastOneLeftAndClearsItsLiveActivity() async throws {
        outbox.begin(TalkOutbox.Entry(
            id: "e1", messageId: SendRetryPolicy.newMessageId(), createdAt: Date(),
            text: "half sent", recordingID: "rec-listed", reason: nil, attempts: 0, updatedAt: Date()
        ))
        XCTAssertTrue(outbox.unsent.isEmpty, "a send in flight is not shown as failed")
        recorder.kept = ["rec-listed", "rec-orphan"]
        let recorded = Date(timeIntervalSinceNow: -3_000)
        recorder.keptAudio["rec-orphan"] = TalkKeptAudio(url: URL(fileURLWithPath: "/tmp/rec-orphan.caf"), seconds: 4, recordedAt: recorded)
        _ = session()
        XCTAssertEqual(outbox.entry("e1")?.reason, TalkReason.closedMidSend)
        let orphan = try XCTUnwrap(outbox.unsent.first { $0.recordingID == "rec-orphan" })
        XCTAssertNil(orphan.text)
        XCTAssertEqual(orphan.createdAt, recorded, "a recovered take keeps the time it was recorded")
        XCTAssertEqual(outbox.entries.count, 2, "a take already listed is not listed twice")
        XCTAssertEqual(activity.leftoversEnded, 1)
    }

    /// The person tapped Send and left Walnut, and iOS ended it before the send finished:
    /// the next open sends the words by itself, under the same message id, with no tap.
    func testASendIOSCutOffGoesOutByItselfOnTheNextOpen() async throws {
        let messageId = SendRetryPolicy.newMessageId()
        outbox.begin(TalkOutbox.Entry(
            id: "e1", messageId: messageId, createdAt: Date(),
            text: "left mid send", recordingID: nil, reason: nil, attempts: 0, updatedAt: Date()
        ))
        let talk = session()
        let kept = try XCTUnwrap(outbox.entry("e1"))
        XCTAssertTrue(TalkSession.waits(kept), "it asks for the person instead of going out by itself")
        await talk.resendKept(source: "app-active")
        XCTAssertEqual(sender.sent.map(\.text), ["left mid send"])
        XCTAssertEqual(sender.sent.first?.messageId, messageId, "a new id would let the server take it twice")
        XCTAssertNil(outbox.entry("e1"))
    }

    /// Walnut ended while the send was starting the CEO chat (a request with no message
    /// id): the words may have arrived, so the next open asks the person, never resends.
    func testASendEndedWhileStartingTheCEOChatIsNeverResentByItself() async throws {
        sender.startsChat = true
        sender.holdStart = true
        let talk = session()
        try await talk.toggle(source: "test")
        try await talk.toggle(source: "test")
        try await waitUntil { self.outbox.entries.first?.startingChat == true }
        // A new process (Walnut ended there), on the same outbox.
        let after = FakeTalkSender()
        let next = session(sender: after)
        let entry = try XCTUnwrap(outbox.entries.first)
        XCTAssertEqual(entry.reason, TalkSendError.startOutcomeUnknown.localizedDescription)
        XCTAssertFalse(TalkSession.waits(entry), "a start that may have arrived goes out again by itself")
        await next.resendKept(source: "app-active")
        XCTAssertTrue(after.sent.isEmpty, "sent twice")
    }

    /// Builds 160 and 161 wrote "Walnut closed before this was sent." for any cut-off send,
    /// starts included, possibly days ago: those still wait for the person.
    func testAnOlderBuildsCutOffSendStillWaitsForThePerson() {
        let old = TalkOutbox.Entry(
            id: "old", messageId: SendRetryPolicy.newMessageId(), createdAt: Date(timeIntervalSinceNow: -86_400 * 3),
            text: "old words", recordingID: nil, reason: "Walnut closed before this was sent.", attempts: 0, updatedAt: Date()
        )
        XCTAssertFalse(TalkSession.waits(old))
    }

    /// A "Waiting to send" card on the Lock Screen speaks of one take: once that
    /// take is sent (by itself, Send Now or Resend) or deleted, the card goes
    /// instead of saying it still waits for an hour.
    func testAFailedCardLeavesTheLockScreenOnceItsTakeIsSentOrDeleted() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await pressTwice(talk)
        let sentLater = try XCTUnwrap(outbox.unsent.first)
        let card = try XCTUnwrap(activity.ended.last?.state)
        XCTAssertEqual(card.take, sentLater.id, "the card names the take it waits for")
        XCTAssertFalse(TalkLiveActivity.endsNow(card, keeping: Set(outbox.entries.map(\.id))), "it stays while the take waits")

        let sent = await talk.resend(sentLater.id)
        XCTAssertTrue(sent)
        let afterSend = try XCTUnwrap(activity.lastKeeping)
        XCTAssertFalse(afterSend.contains(sentLater.id))
        XCTAssertTrue(TalkLiveActivity.endsNow(card, keeping: afterSend), "a sent take's card goes")

        recorder.finishResult = .failed("No engine.", recordingID: "rec-4")
        try await pressTwice(talk)
        let deleted = try XCTUnwrap(outbox.unsent.first)
        let deletedCard = try XCTUnwrap(activity.ended.last?.state)
        XCTAssertEqual(deletedCard.take, deleted.id)
        talk.discard(deleted.id)
        XCTAssertTrue(TalkLiveActivity.endsNow(deletedCard, keeping: try XCTUnwrap(activity.lastKeeping)), "a deleted take's card goes")
    }

    func testOnlyACardWhoseTakeLeftTheListEndsEarly() {
        func card(_ phase: TalkActivityAttributes.ContentState.Phase, take: String?) -> TalkActivityAttributes.ContentState {
            var state = TalkActivityAttributes.ContentState(phase: phase, startedAt: Date(), words: nil, reason: "Why.", kept: true)
            state.take = take
            return state
        }
        XCTAssertTrue(TalkLiveActivity.endsNow(card(.listening, take: nil), keeping: []), "a dead process's Listening goes")
        XCTAssertFalse(TalkLiveActivity.endsNow(card(.sent, take: nil), keeping: []), "Sent shows its own few seconds")
        XCTAssertFalse(TalkLiveActivity.endsNow(card(.failed, take: "a"), keeping: ["a"]), "a take still listed keeps its card")
        XCTAssertTrue(TalkLiveActivity.endsNow(card(.failed, take: "a"), keeping: ["b"]))
        XCTAssertFalse(TalkLiveActivity.endsNow(card(.failed, take: nil), keeping: []), "a card an older build wrote names no take")
    }

    /// Every way a take leaves the list goes through `drop`, which also takes its
    /// card off the Lock Screen: a new `outbox.remove` elsewhere fails here.
    func testATakeLeavesTheListOnlyThroughTheOneStepThatEndsItsCard() throws {
        let talk = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut", isDirectory: true)
        let files = FileManager.default.enumerator(at: talk, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertFalse(files.isEmpty)
        var removes: [String] = []
        for file in files where file.lastPathComponent != "TalkOutbox.swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in text.split(separator: "\n") where line.contains("outbox.remove(") {
                removes.append("\(file.lastPathComponent): \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(removes, ["TalkSession.swift: outbox.remove(id)"], "remove a take with TalkSession.drop")
    }

    func testDiscardingAWordlessEntryDeletesItsRecording() async throws {
        recorder.finishResult = .failed("No engine.", recordingID: "rec-3")
        let talk = session()
        try await pressTwice(talk)
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        talk.discard(id)
        XCTAssertEqual(recorder.forgotten, ["rec-3"])
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    // MARK: - Helpers

    private func assertThrows(_ talk: TalkSession, _ expected: TalkSession.StartError, line: UInt = #line) async {
        do {
            try await talk.toggle(source: "test")
            XCTFail("expected \(expected)", line: line)
        } catch let error as TalkSession.StartError {
            XCTAssertEqual(error, expected, line: line)
        } catch {
            XCTFail("unexpected \(error)", line: line)
        }
        XCTAssertEqual(talk.phase, .idle, line: line)
    }

    private func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out waiting") }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    // MARK: - Dictate: one page with Send and Copy

    /// Listen, then end the take: its words open on the page.
    private func dictate(_ talk: TalkSession) async throws {
        try await talk.toggle(source: "test", to: .dictation)
        try await talk.toggle(source: "test", to: .dictation)
        await talk.finishing?.value
    }

    /// The user, 2026-11-11: "just one page that can send and can copy". The words open on
    /// the page exactly as heard, and nothing is sent or copied before the person picks.
    func testADictationOpensItsPageWithTheWordsAsHeardAndSendsOrCopiesNothingByItself() async throws {
        let said = "  Ship it Friday,\nthen tell Chen.  \u{1F680} "
        recorder.finishResult = .words(said, recordingID: "rec-d")
        let talk = session()
        try await talk.toggle(source: "test", to: .dictation)
        XCTAssertEqual(talk.destination, .dictation)
        XCTAssertEqual(activity.started.first?.copy, true, "the Live Activity offers Done, not Send")
        XCTAssertEqual(activity.started.first?.subtitle, "Tap Done, or press the Action Button again")
        XCTAssertTrue(prefs.bool(forKey: TalkSession.clipboardTakeKey), "a dying process would list it as a send")
        try await talk.toggle(source: "test", to: .dictation)
        await talk.finishing?.value
        XCTAssertEqual(talk.phase, .review(said), "the words were changed on the way to the page")
        XCTAssertTrue(talk.isReviewing)
        XCTAssertFalse(talk.isBusy, "the page would block the next press")
        XCTAssertEqual(pagesShown, 1, "the page was not brought up")
        XCTAssertTrue(copied.isEmpty, "the words were copied before the person picked Copy")
        XCTAssertTrue(sender.sent.isEmpty, "the words reached the CEO before the person picked Send")
        XCTAssertEqual(activity.updates.map(\.phase), [.transcribing], "a dictation is never sending by itself")
        XCTAssertEqual(activity.ended.last?.linger, 0, "the card lingered over the page Walnut shows")
        // On disk while the page shows: a process that dies there leaves the words listed.
        let kept = try XCTUnwrap(outbox.entries.first)
        XCTAssertEqual(kept.text, said)
        XCTAssertEqual(kept.copy, true)
        XCTAssertEqual(kept.reason, TalkReason.notChosen)
        XCTAssertNil(kept.recordingID, "the audio stays referenced after its words are safe")
        XCTAssertFalse(TalkSession.waits(kept), "a dictation would be sent by itself")
        XCTAssertEqual(recorder.forgotten, ["rec-d"], "the audio was left on the phone after its words were saved")
        XCTAssertFalse(prefs.bool(forKey: TalkSession.clipboardTakeKey))
        XCTAssertEqual(cues, [.started, .sent])
    }

    func testThePagesCopyPutsTheWordsAsLeftOnTheClipboardAndSendsNothing() async throws {
        let talk = session()
        try await dictate(talk)
        XCTAssertTrue(talk.copyReview("hello, edited"))
        XCTAssertEqual(copied, ["hello, edited"], "Copy did not take the words as the person left them")
        XCTAssertTrue(sender.sent.isEmpty, "Copy reached the CEO chat")
        XCTAssertEqual(talk.phase, .copied("hello, edited"))
        XCTAssertTrue(outbox.entries.isEmpty, "a copied dictation stays in the list")
        XCTAssertNil(talk.reviewTake)
        XCTAssertEqual(cues, [.started, .sent, .sent])
    }

    func testThePagesSendDeliversTheWordsAsLeftToTheCEOAndCopiesNothing() async throws {
        let talk = session()
        try await dictate(talk)
        let messageId = try XCTUnwrap(outbox.entries.first?.messageId)
        await talk.sendReview("hello there")
        XCTAssertEqual(sender.sent.map(\.text), ["hello there"], "Send did not take the words as the person left them")
        XCTAssertEqual(sender.sent.first?.messageId, messageId, "Send made a second message id for the take")
        XCTAssertTrue(copied.isEmpty, "Send copied the words")
        XCTAssertEqual(talk.phase, .sent("hello there"))
        XCTAssertEqual(talk.destination, .ceo, "the page would still read as a dictation")
        XCTAssertTrue(outbox.entries.isEmpty, "a sent dictation stays in the list")
    }

    /// The server was away: Send keeps the words as a take for the CEO, which goes out by
    /// itself later as any other does; they are never copied.
    func testThePagesSendThatCannotReachTheServerKeepsTheWordsToGoOutLater() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await dictate(talk)
        await talk.sendReview("hello")
        XCTAssertEqual(talk.phase, .notSent(TalkReason.serverUnavailable, kept: true))
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.text, "hello")
        XCTAssertNil(entry.copy, "the person picked Send: it is a take for the CEO now")
        XCTAssertTrue(TalkSession.waits(entry))
        XCTAssertEqual(activity.ended.last?.state.later, true)
        await talk.resendKept(source: "test")
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// iOS did not take the words: the page stays with them, for another Copy or a Send.
    func testACopyIOSRefusesLeavesThePageAndTheWords() async throws {
        copyTakes = false
        let talk = session()
        try await dictate(talk)
        XCTAssertFalse(talk.copyReview("hello"))
        XCTAssertEqual(talk.phase, .review("hello"))
        XCTAssertEqual(outbox.entries.first?.text, "hello")
        copyTakes = true
        XCTAssertTrue(talk.copyReview("hello"))
        XCTAssertEqual(copied, ["hello"])
    }

    /// Words with nothing in them are no message: neither button does anything.
    func testThePageSendsAndCopiesNothingWhenTheWordsWereClearedAway() async throws {
        let talk = session()
        try await dictate(talk)
        XCTAssertFalse(talk.copyReview(" \n "))
        await talk.sendReview("   ")
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertEqual(talk.phase, .review("hello"))
    }

    /// Closed with neither: the words, as left, wait in the list with Send and Copy, and
    /// nothing sends or copies them by itself.
    func testAPageClosedWithNeitherKeepsTheWordsInTheListForSendOrCopy() async throws {
        let talk = session()
        try await dictate(talk)
        talk.closeReview("hello, kept")
        XCTAssertEqual(talk.phase, .idle)
        XCTAssertNil(talk.reviewTake)
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.text, "hello, kept")
        XCTAssertEqual(entry.copy, true)
        XCTAssertEqual(entry.reason, TalkReason.notChosen)
        await talk.resendKept(source: "test")
        XCTAssertTrue(copied.isEmpty, "a kept dictation was copied without the person's Copy")
        XCTAssertTrue(sender.sent.isEmpty, "a kept dictation was sent without the person's Send")
        // The list's Send.
        let sent = await talk.resend(entry.id, send: true)
        XCTAssertTrue(sent)
        XCTAssertEqual(sender.sent.map(\.text), ["hello, kept"])
        XCTAssertEqual(sender.sent.first?.messageId, entry.messageId)
        XCTAssertTrue(copied.isEmpty)
        XCTAssertFalse(talk.lastResentCopied)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    func testAKeptDictationsCopyInTheListCopiesItAndSendsNothing() async throws {
        let talk = session()
        try await dictate(talk)
        talk.closeReview()
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        let done = await talk.resend(id)
        XCTAssertTrue(done)
        XCTAssertEqual(copied, ["hello"])
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertTrue(talk.lastResentCopied)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// The page's words deleted from the list (or sent or copied there): the page goes, and
    /// the next press starts a take again.
    func testThePageGoesWhenItsWordsLeaveTheList() async throws {
        let talk = session()
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        talk.discard(id)
        XCTAssertEqual(talk.phase, .idle, "the page stayed with words no longer kept")
        XCTAssertNil(talk.reviewTake)
        let outcome = try await talk.toggle(source: "test", to: .ceo)
        XCTAssertEqual(outcome, .listening, "a press only brought back a page with nothing on it")
        await talk.cancel(source: "test")
    }

    /// A page left unseen behind another app never blocks the next press: Talk to Walnut
    /// listens from behind as always, and the words wait in the list, still news.
    func testAPressAfterAnUnseenPageStartsItsTakeAndTheWordsWaitInTheList() async throws {
        let talk = session()
        foreground = false
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        let outcome = try await talk.toggle(source: "test", to: .ceo)
        XCTAssertEqual(outcome, .listening, "an old page took over the press")
        XCTAssertEqual(talk.destination, .ceo)
        XCTAssertNil(talk.reviewTake)
        XCTAssertFalse(talk.closedPages.contains(id), "an unseen page reads as closed by the person")
        XCTAssertEqual(outbox.unsent.first { $0.id == id }?.text, "hello", "the words were dropped")
        try await talk.toggle(source: "test", to: .ceo)
        await talk.finishing?.value
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertEqual(outbox.unsent.map(\.id), [id], "the dictation went out with the take")
        XCTAssertTrue(copied.isEmpty)
    }

    /// Closed by the person: in the list, and not offered again as news.
    func testAClosedPageIsNotOfferedAgain() async throws {
        let talk = session()
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        talk.closeReview("hello")
        XCTAssertTrue(talk.closedPages.contains(id))
    }

    /// The first save failed: Close saves the words again rather than losing them.
    func testClosingAPageWhoseEntryIsGoneKeepsTheWords() async throws {
        let talk = session()
        try await dictate(talk)
        outbox.remove(try XCTUnwrap(talk.reviewTake))
        talk.closeReview("hello, corrected")
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.text, "hello, corrected")
        XCTAssertEqual(entry.copy, true)
        XCTAssertEqual(entry.reason, TalkReason.notChosen)
    }

    /// Send from the page ends the card that said the words wait in Walnut.
    func testThePagesSendEndsTheReadyCard() async throws {
        let talk = session()
        foreground = false
        try await dictate(talk)
        let card = try XCTUnwrap(activity.ended.last)
        foreground = true
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        await talk.sendReview("hello")
        XCTAssertNotNil(outbox.unsent.first, "the take is kept to send later")
        XCTAssertTrue(TalkLiveActivity.endsNow(card.state, keeping: try XCTUnwrap(activity.lastKeeping)),
                      "the card still says the words wait to be sent or copied")
    }

    /// The server was away though the network never dropped: while Walnut is in front the
    /// waiting take is tried again by itself, as the screen promised, and goes out once.
    func testAWaitingTakeGoesOutByItselfWhileWalnutIsInFront() async throws {
        sender.failures = [APIError.network(underlying: URLError(.cannotConnectToHost))]
        let talk = session()
        talk.retryLaterDelay = .milliseconds(20)
        try await talk.toggle(source: "test", to: .ceo)
        try await talk.toggle(source: "test", to: .ceo)
        await talk.finishing?.value
        XCTAssertEqual(talk.phase, .notSent(TalkReason.serverUnavailable, kept: true))
        try await waitUntil { self.sender.sent.count == 1 }
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// A page the last process left open opens on its page at the next launch, never as a list.
    func testAPageTheLastProcessLeftOpenReopensOnItsPage() async throws {
        recorder.finishResult = .words("ship it", recordingID: "rec-p")
        let talk = session()
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        outbox = TalkOutbox(key: key)
        let next = session()
        XCTAssertEqual(next.phase, .review("ship it"))
        XCTAssertEqual(next.reviewTake, id)
        XCTAssertEqual(next.destination, .dictation)
        await next.sendReview("ship it")
        XCTAssertEqual(sender.sent.map(\.text), ["ship it"])
    }

    /// Copy on a take on its way to the CEO copies its words and leaves it to go.
    func testCopyingAWaitingTakeLeavesItToGoToTheCEO() async throws {
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        let talk = session()
        try await talk.toggle(source: "test", to: .ceo)
        try await talk.toggle(source: "test", to: .ceo)
        await talk.finishing?.value
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        XCTAssertTrue(talk.copyWords(id))
        XCTAssertEqual(copied, ["hello"])
        XCTAssertEqual(outbox.unsent.map(\.id), [id], "a copy took the take off its way to the CEO")
    }

    /// The page's Send lands on the CEO chat in Walnut, where the person sees their message
    /// and the answer; a Send that did not get there stays on its screen.
    func testThePagesSendOpensTheCEOChatOnlyOnceItGotThere() async throws {
        let talk = session()
        try await dictate(talk)
        await talk.sendReview("hello")
        XCTAssertEqual(ceoChatsOpened, 1)
        sender.failures = [APIError.network(underlying: URLError(.notConnectedToInternet))]
        try await dictate(talk)
        await talk.sendReview("hello again")
        XCTAssertEqual(ceoChatsOpened, 1, "a failed Send moved the person to the chat")
    }

    /// An unseen page set aside by a Talk to Walnut press opens again once Walnut is in
    /// front and nothing runs; a closed one never does.
    func testAnUnseenPageReopensWhenWalnutComesForwardIdle() async throws {
        let talk = session()
        foreground = false
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        try await talk.toggle(source: "test", to: .ceo)
        talk.reopenUnseenPageIfIdle()
        XCTAssertFalse(talk.isReviewing, "a page took over a take that listens")
        try await talk.toggle(source: "test", to: .ceo)
        await talk.finishing?.value
        foreground = true
        talk.reopenUnseenPageIfIdle()
        XCTAssertEqual(talk.reviewTake, id)
        XCTAssertEqual(talk.phase, .review("hello"))
        talk.closeReview("hello")
        talk.reopenUnseenPageIfIdle()
        XCTAssertFalse(talk.isReviewing, "a closed page came back")
    }

    /// A closed page is remembered across launches: the next launch offers nothing.
    func testAClosedPageStaysClosedForTheNextLaunch() async throws {
        let talk = session()
        try await dictate(talk)
        let id = try XCTUnwrap(talk.reviewTake)
        talk.closeReview("hello")
        outbox = TalkOutbox(key: key)
        XCTAssertTrue(session().closedPages.contains(id), "a new launch would offer the closed page again")
        XCTAssertTrue(prefs.string(forKey: TalkSession.offeredKey)?.contains(id) == true)
    }

    /// A dictation kept by choice reads plainly; a real failure stays a failure.
    func testOnlyAChosenDictationReadsAsAwaitingChoice() async throws {
        let talk = session()
        try await dictate(talk)
        talk.closeReview("hello")
        XCTAssertTrue(TalkSession.awaitsChoice(try XCTUnwrap(outbox.unsent.first)))
        recorder.finishResult = .failed("Voice unavailable: the Mac is asleep.", recordingID: "rec-x")
        try await dictate(talk)
        let failed = try XCTUnwrap(outbox.unsent.first { $0.recordingID == "rec-x" })
        XCTAssertFalse(TalkSession.awaitsChoice(failed))
    }

    /// Send always sends what the page shows, even when its entry could not be kept.
    func testThePagesSendSendsEvenWhenItsEntryIsGone() async throws {
        let talk = session()
        try await dictate(talk)
        outbox.remove(try XCTUnwrap(talk.reviewTake))
        await talk.sendReview("hello")
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertEqual(talk.phase, .sent("hello"))
    }

    /// Ended from behind another app: the card says the words wait in Walnut, stays until
    /// they are sent or copied, and goes then.
    func testADictationEndedFromBehindLeavesACardUntilItsWordsAreSentOrCopied() async throws {
        let talk = session()
        try await talk.toggle(source: "test", to: .dictation)
        foreground = false
        try await talk.toggle(source: "test", to: .dictation)
        await talk.finishing?.value
        let card = try XCTUnwrap(activity.ended.last)
        XCTAssertEqual(card.linger, talk.notSentLinger, "the card went before the person saw it")
        XCTAssertEqual(card.state.title, "Your words are ready")
        XCTAssertEqual(card.state.subtitle, "Open Walnut to send or copy them.")
        let id = try XCTUnwrap(talk.reviewTake)
        XCTAssertEqual(card.state.take, id)
        XCTAssertFalse(TalkLiveActivity.endsNow(card.state, keeping: Set(outbox.entries.map(\.id))), "the card went while the words wait")
        foreground = true
        XCTAssertTrue(talk.copyReview("hello"))
        XCTAssertTrue(TalkLiveActivity.endsNow(card.state, keeping: try XCTUnwrap(activity.lastKeeping)), "the card stayed after Copy")
    }

    /// Corrections made on the page are kept when Walnut goes away before Send or Copy.
    func testThePagesCorrectionsAreKeptForTheList() async throws {
        let talk = session()
        try await dictate(talk)
        talk.keepReviewWords("hello, corrected")
        XCTAssertEqual(outbox.entries.first?.text, "hello, corrected")
        talk.keepReviewWords("  ")
        XCTAssertEqual(outbox.entries.first?.text, "hello, corrected", "cleared words replaced the kept ones")
    }

    /// A press while the page is up brings the page back; it never drops its words for a new take.
    func testAPressWhileThePageIsUpShowsItAndStartsNoTake() async throws {
        let talk = session()
        try await dictate(talk)
        let started = activity.started.count
        let outcome = try await talk.toggle(source: "test", to: .ceo)
        XCTAssertEqual(outcome, .reviewing)
        XCTAssertEqual(talk.phase, .review("hello"))
        XCTAssertEqual(activity.started.count, started, "a press started a new take over the page")
        XCTAssertEqual(pagesShown, 2)
        XCTAssertTrue(sender.sent.isEmpty)
    }

    func testAFailedTranscriptionOfADictationKeepsTheRecordingAndBothButtonsTranscribeItFirst() async throws {
        recorder.finishResult = .failed("Voice unavailable: the Mac is asleep.", recordingID: "rec-9")
        recorder.transcribeResult = .words("later words", recordingID: "rec-9")
        let talk = session()
        try await dictate(talk)
        XCTAssertEqual(talk.phase, .notSent("Voice unavailable: the Mac is asleep.", kept: true))
        XCTAssertEqual(activity.ended.last?.state.title, "Couldn't get your words")
        XCTAssertEqual(pagesShown, 0, "a page with no words was shown")
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertNil(entry.text)
        XCTAssertEqual(entry.recordingID, "rec-9")
        XCTAssertEqual(entry.copy, true)
        let done = await talk.resend(entry.id, send: true)
        XCTAssertTrue(done)
        XCTAssertEqual(recorder.transcribed, ["rec-9"])
        XCTAssertEqual(sender.sent.map(\.text), ["later words"])
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// The server was away: a take for the CEO waits to go out by itself, a dictation never.
    func testADictationTheServerMissedWaitsOnlyForThePerson() async throws {
        recorder.finishResult = .failed(TalkReason.serverUnavailable, recordingID: "rec-away")
        recorder.transcribeResult = .words("later words", recordingID: "rec-away")
        let talk = session()
        try await dictate(talk)
        let entry = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(entry.copy, true)
        XCTAssertFalse(TalkSession.waits(entry), "a dictation would go out by itself")
        XCTAssertNotEqual(activity.ended.last?.state.later, true, "the card says it sends by itself")
        await talk.resendKept(source: "test")
        XCTAssertTrue(recorder.transcribed.isEmpty, "a kept dictation was retried without the person")
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertTrue(recorder.forgotten.isEmpty, "the audio went before its words were safe")
        let done = await talk.resend(entry.id)
        XCTAssertTrue(done)
        XCTAssertEqual(copied, ["later words"])
        XCTAssertEqual(recorder.forgotten, ["rec-away"])
    }

    func testACopyInTheListThatFailsAgainKeepsTheWordsAndSaysItWasTried() async throws {
        let talk = session()
        try await dictate(talk)
        talk.closeReview()
        copyTakes = false
        let id = try XCTUnwrap(outbox.unsent.first?.id)
        let done = await talk.resend(id)
        XCTAssertFalse(done)
        XCTAssertEqual(outbox.unsent.first?.text, "hello")
        XCTAssertEqual(outbox.unsent.first?.reason, TalkReason.notCopied)
        XCTAssertEqual(outbox.unsent.first?.attempts, 1)
        XCTAssertNil(talk.lastResent)
    }

    /// The cap ends a dictation on its page: nothing goes anywhere until the person picks.
    func testTheCapEndsADictationOnItsPage() async throws {
        var detector = TalkPauseDetector()
        detector.maxDuration = 0.05
        recorder.levels = [-15]
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test", to: .dictation)
        try await waitUntil { talk.isReviewing }
        XCTAssertEqual(talk.phase, .review("hello"))
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(sender.sent.isEmpty)
    }

    func testADictationWithNoWordsOpensNoPageAndSaysSo() async throws {
        recorder.finishResult = .noWords(recordingID: "rec-cough")
        let talk = session()
        try await dictate(talk)
        XCTAssertEqual(talk.phase, .notSent("Didn't catch any words, so there is nothing to send or copy.", kept: false))
        XCTAssertEqual(activity.ended.last?.state.title, "Nothing heard")
        XCTAssertEqual(pagesShown, 0)
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertEqual(recorder.forgotten, ["rec-cough"])
    }

    func testAMarkIsLeftOnlyWhileADictationRuns() async throws {
        recorder.beginFailure = "Audio is in use by another app."
        let talk = session()
        do { try await talk.toggle(source: "test", to: .dictation) } catch {}
        XCTAssertFalse(prefs.bool(forKey: TalkSession.clipboardTakeKey), "a refused start left the mark")
        recorder.beginFailure = nil
        // A take for the CEO after a dictation is no dictation.
        try await dictate(talk)
        talk.closeReview()
        try await talk.toggle(source: "test", to: .ceo)
        XCTAssertFalse(prefs.bool(forKey: TalkSession.clipboardTakeKey))
        XCTAssertEqual(talk.destination, .ceo)
        await talk.cancel(source: "test")
    }

    func testACancelledDictationLeavesNoMark() async throws {
        let talk = session()
        try await talk.toggle(source: "test", to: .dictation)
        await talk.cancel(source: "test")
        XCTAssertFalse(prefs.bool(forKey: TalkSession.clipboardTakeKey))
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    /// A process that died with a dictation leaves its recording: it is listed for the
    /// person's Send or Copy, never as a take that goes to the CEO by itself.
    func testADictationTheLastProcessLeftIsListedForThePersonNeverSentByItself() throws {
        prefs.set(true, forKey: TalkSession.clipboardTakeKey)
        recorder.kept = ["rec-orphan"]
        _ = session()
        let orphan = try XCTUnwrap(outbox.unsent.first)
        XCTAssertEqual(orphan.copy, true)
        XCTAssertEqual(orphan.reason, "Walnut stopped before this dictation was ready.")
        XCTAssertFalse(TalkSession.waits(orphan))
        XCTAssertFalse(prefs.bool(forKey: TalkSession.clipboardTakeKey), "the next launch would mark another take")
    }

    /// A process that died with the page up leaves the words in the list, as they were heard.
    func testThePageTheLastProcessLeftIsListedWithItsWords() async throws {
        let talk = session()
        try await dictate(talk)
        XCTAssertTrue(talk.isReviewing)
        // A new process reads the list from the disk.
        outbox = TalkOutbox(key: key)
        let next = session()
        let entry = try XCTUnwrap(next.outbox.unsent.first)
        XCTAssertEqual(entry.text, "hello")
        XCTAssertEqual(entry.copy, true)
        XCTAssertEqual(entry.reason, TalkReason.notChosen, "a page left open is not listed as waiting for Send or Copy")
    }

    func testATakeTheLastProcessLeftWithNoMarkIsStillOneToSend() throws {
        recorder.kept = ["rec-orphan"]
        _ = session()
        let orphan = try XCTUnwrap(outbox.unsent.first)
        XCTAssertNil(orphan.copy)
        XCTAssertEqual(orphan.reason, "Walnut stopped before this recording was sent.")
    }

    /// A press of either shortcut ends the take on screen as it was started.
    func testAPressOfEitherShortcutEndsTheTakeAsItWasStarted() async throws {
        let talk = session()
        try await talk.toggle(source: "test", to: .ceo)
        try await talk.toggle(source: "test", to: .dictation)
        await talk.finishing?.value
        XCTAssertEqual(sender.sent.map(\.text), ["hello"])
        XCTAssertEqual(pagesShown, 0)
        // And the next take is a dictation again.
        try await talk.toggle(source: "test", to: .dictation)
        try await talk.toggle(source: "test", to: .ceo)
        await talk.finishing?.value
        XCTAssertEqual(talk.phase, .review("hello"))
        XCTAssertEqual(sender.sent.count, 1)
    }
}

private final class GatedSender: TalkSending, @unchecked Sendable {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var count = 0

    func send(text: String, messageId: String, beforeStart: @escaping @Sendable () async -> Void) async throws {
        count += 1
        if opened { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
    }
}

final class TalkPauseDetectorTests: XCTestCase {
    /// The pause rules, which hold only for a detector that ends a take on a pause.
    private func pausing() -> TalkPauseDetector {
        var detector = TalkPauseDetector()
        detector.sendsOnPause = true
        return detector
    }

    /// By default a pause ends nothing: speech and then a long quiet listen on to the cap,
    /// and only a take that heard nothing at all gives up.
    func testByDefaultOnlySilenceOrTheCapEndsATake() {
        var spoken = TalkPauseDetector()
        spoken.maxDuration = 30
        let (decision, time) = run(&spoken, [(0.5, -55), (3, -20), (40, -55)])
        XCTAssertEqual(decision, .tooLong, "a pause ended the take at \(time) s")
        XCTAssertGreaterThanOrEqual(time, 30)
        var silent = TalkPauseDetector()
        XCTAssertEqual(run(&silent, [(20, -70)]).0, .noSpeech)
        var soft = TalkPauseDetector()
        soft.maxDuration = 30
        XCTAssertEqual(run(&soft, [(40, -45)]).0, .tooLong, "sound that never counted as speech was given up on")
    }

    private func run(_ detector: inout TalkPauseDetector, _ pattern: [(seconds: Double, db: Float)], step: Double = 0.1) -> (TalkPauseDetector.Decision, Double) {
        var time = 0.0
        for (seconds, db) in pattern {
            let end = time + seconds
            while time < end - 1e-9 {
                time += step
                let decision = detector.feed(level: db, at: time)
                if decision != .keepListening { return (decision, time) }
            }
        }
        return (.keepListening, time)
    }

    func testSpeechThenAPauseEndsTheTakeAfterThePause() {
        var detector = pausing()
        let (decision, time) = run(&detector, [(0.5, -55), (3, -20), (5, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
        // The pause counts from the first quiet reading (one tick after the speech).
        XCTAssertEqual(time, 3.5 + 0.1 + 1.8, accuracy: 0.15)
    }

    func testABreathBetweenSentencesDoesNotSend() {
        var detector = pausing()
        let (decision, _) = run(&detector, [(0.5, -55), (2, -20), (1, -55), (2, -20)])
        XCTAssertEqual(decision, .keepListening)
    }

    func testSilenceGivesUpAfterTheTimeout() {
        var detector = pausing()
        let (decision, time) = run(&detector, [(20, -60)])
        XCTAssertEqual(decision, .noSpeech)
        XCTAssertEqual(time, 8, accuracy: 0.15)
    }

    func testACoughIsNotSpeech() {
        var detector = pausing()
        let (decision, _) = run(&detector, [(1, -58), (0.1, -15), (20, -58)])
        XCTAssertEqual(decision, .noSpeech)
    }

    func testSpeechInANoisyRoomStillEndsOnAPause() {
        var detector = pausing()
        let (decision, _) = run(&detector, [(0.5, -32), (4, -14), (4, -32)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testNormalSpeechFromTheFirstInstantStillEndsOnAPause() {
        var detector = pausing()
        let (decision, _) = run(&detector, [(3, -28), (4, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testSpeakingFromTheFirstInstantIsHeard() {
        var detector = pausing()
        let (decision, _) = run(&detector, [(3, -18), (4, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testAVeryLongTakeIsSentAtTheCap() {
        var detector = pausing()
        detector.maxDuration = 10
        let (decision, time) = run(&detector, [(30, -18)])
        XCTAssertEqual(decision, .tooLong)
        XCTAssertEqual(time, 10, accuracy: 0.15)
    }
}

final class TalkMainSenderTests: XCTestCase {
    func testWordsGoIntoTheCEOsCurrentSessionWithTheirMessageId() async throws {
        let transport = FakeMainTransport()
        let sender = TalkMainSender(transport: { transport }, isPaired: { true })
        try await sender.send(text: "create a task", messageId: "qm-mobile-abc")
        XCTAssertEqual(transport.calls, ["orgMain", "detail:task-main", "send:sess-main:create a task:qm-mobile-abc"])
    }

    func testACEOWithNoSessionStartsWithTheseWords() async throws {
        let transport = FakeMainTransport()
        transport.sessionIds = [nil]
        let sender = TalkMainSender(transport: { transport }, isPaired: { true })
        try await sender.send(text: "\u{67E5}\u{4E00}\u{67E5}", messageId: "qm-mobile-abc")
        XCTAssertEqual(transport.calls, ["orgMain", "detail:task-main", "launch:task-main:\u{67E5}\u{4E00}\u{67E5}"])
    }

    func testAStartWhoseAnswerWasLostSaysTheWordsMayHaveArrived() async {
        let transport = FakeMainTransport()
        transport.sessionIds = [nil]
        transport.launchError = APIError.network(underlying: URLError(.timedOut))
        let sender = TalkMainSender(transport: { transport }, isPaired: { true })
        do {
            try await sender.send(text: "hi", messageId: "qm-mobile-abc")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(
                TalkMainSender.reason(for: error),
                "The connection dropped while the CEO chat was starting, so this may have arrived. Check the CEO chat before you resend."
            )
        }
    }

    func testAnUnpairedPhoneSendsNothing() async {
        let transport = FakeMainTransport()
        let sender = TalkMainSender(transport: { transport }, isPaired: { false })
        do {
            try await sender.send(text: "hi", messageId: "qm-mobile-abc")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(TalkMainSender.reason(for: error), "This iPhone isn't connected to a Walnut server. Open Walnut to pair it.")
        }
        XCTAssertTrue(transport.calls.isEmpty)
    }

    func testEveryFailureHasASentenceToActOn() {
        let cases: [(Error, String)] = [
            (APIError.unauthorized, "Your Walnut server did not accept this iPhone. Open Walnut to check its connection."),
            (APIError.network(underlying: URLError(.cannotConnectToHost)), "Walnut server unavailable."),
            (APIError.server(status: 501, code: "x", message: "", serverHash: nil, serverContent: nil), "The CEO can start only while your Mac is online."),
            (APIError.server(status: 500, code: "x", message: "Disk full.", serverHash: nil, serverContent: nil), "Disk full."),
        ]
        for (error, expected) in cases {
            XCTAssertEqual(TalkMainSender.reason(for: error), expected)
        }
    }
}

final class TalkBundleTests: XCTestCase {
    private var app: [String: Any] { Bundle.main.infoDictionary ?? [:] }

    @MainActor
    func testTheSilentSoundASentTakeExpandsTheIslandWithIsInTheApp() {
        // An alert naming a sound the bundle lacks would play the default one.
        let name = TalkLiveActivity.silentSound
        let url = Bundle.main.url(forResource: (name as NSString).deletingPathExtension, withExtension: (name as NSString).pathExtension)
        XCTAssertNotNil(url, "\(name) is not in the app bundle")
    }

    func testAFailureSaysResendOnlyWhenSomethingIsKept() {
        let state = { (kept: Bool?) in
            TalkActivityAttributes.ContentState(phase: .failed, startedAt: Date(), words: nil, reason: "Why.", kept: kept)
        }
        XCTAssertEqual(state(true).subtitle, "Why. Open Walnut to resend it.")
        XCTAssertEqual(state(false).subtitle, "Why.")
        XCTAssertEqual(state(nil).subtitle, "Why. Open Walnut to resend it.", "a state from before the field reads as kept")
    }

    func testTheAppDeclaresLiveActivities() {
        XCTAssertEqual(app["NSSupportsLiveActivities"] as? Bool, true)
    }

    func testTheWidgetExtensionShipsInsideTheAppWithTheAppsBuildNumber() throws {
        let plugins = try XCTUnwrap(Bundle.main.builtInPlugInsURL)
        let appex = plugins.appendingPathComponent("WalnutWidgets.appex")
        let info = try XCTUnwrap(Bundle(url: appex)?.infoDictionary, "WalnutWidgets.appex is not embedded")
        XCTAssertEqual(info["CFBundleVersion"] as? String, app["CFBundleVersion"] as? String)
        XCTAssertEqual(info["CFBundleShortVersionString"] as? String, app["CFBundleShortVersionString"] as? String)
        let ext = try XCTUnwrap(info["NSExtension"] as? [String: Any])
        XCTAssertEqual(ext["NSExtensionPointIdentifier"] as? String, "com.apple.widgetkit-extension")
        XCTAssertEqual(info["CFBundleIdentifier"] as? String, "\(Bundle.main.bundleIdentifier ?? "").widgets")
    }

    func testTheIntentRecordsWithoutOpeningWalnut() {
        // An AudioRecordingIntent records from behind the app on screen; a
        // LiveActivityIntent may start the take's Live Activity there; the press
        // opens Walnut only for the fallback.
        XCTAssertFalse(TalkToWalnutIntent.openAppWhenRun)
        XCTAssertTrue((TalkToWalnutIntent() as Any) is any LiveActivityIntent)
        XCTAssertTrue((TalkToWalnutIntent() as Any) is any AudioRecordingIntent)
        if #available(iOS 26.0, *) {
            XCTAssertTrue(TalkToWalnutIntent.supportedModes.contains(.background))
            XCTAssertTrue(TalkToWalnutIntent.supportedModes.contains(.foreground(.dynamic)))
        }
    }

    func testTheShortcutIsInTheAppsIntentMetadata() throws {
        // App Shortcuts are read by iOS from the metadata the build extracts;
        // without it nothing shows in Shortcuts or the Action Button picker.
        let metadata = try XCTUnwrap(Bundle.main.url(forResource: "Metadata", withExtension: "appintents"))
        let extract = metadata.appendingPathComponent("extract.actionsdata")
        let text = try String(contentsOf: extract, encoding: .utf8)
        XCTAssertTrue(text.contains("TalkToWalnutIntent"))
        XCTAssertTrue(text.contains("Talk to Walnut"))
        XCTAssertTrue(text.contains("DictateToClipboardIntent"))
        XCTAssertTrue(text.contains("Dictate with"), "the Dictate shortcut's phrases are not in the metadata")
    }

    func testDictateIsAnAudioRecordingPressLikeTalkToWalnut() {
        XCTAssertFalse(DictateToClipboardIntent.openAppWhenRun)
        XCTAssertEqual(DictateToClipboardIntent.destination, .dictation)
        XCTAssertEqual(TalkToWalnutIntent.destination, .ceo)
        XCTAssertTrue((DictateToClipboardIntent() as Any) is any LiveActivityIntent)
        XCTAssertTrue((DictateToClipboardIntent() as Any) is any AudioRecordingIntent)
        if #available(iOS 26.0, *) {
            XCTAssertTrue(DictateToClipboardIntent.supportedModes.contains(.background))
            XCTAssertTrue(DictateToClipboardIntent.supportedModes.contains(.foreground(.dynamic)))
        }
    }

    /// A Live Activity state an older build wrote (no `copy`) still reads as a take for the CEO.
    func testALiveActivityStateWithoutTheCopyFieldReadsAsTheCEO() throws {
        let old = #"{"phase":"sent","startedAt":0,"words":"hi"}"#
        let state = try JSONDecoder().decode(TalkActivityAttributes.ContentState.self, from: Data(old.utf8))
        XCTAssertNil(state.copy)
        XCTAssertEqual(state.title, "Sent to your CEO")
        var copy = state
        copy.copy = true
        XCTAssertEqual(copy.title, "Your words are ready")
        XCTAssertEqual(copy.subtitle, "Open Walnut to send or copy them.")
        copy.phase = .failed
        XCTAssertEqual(copy.title, "Couldn't get your words")
    }
}

/// A Talk to Walnut take that did not go out is offered for a resend in one
/// place only: its own unsent list, never a composer's saved-recording row.
@MainActor
final class TalkTakeOwnershipTests: XCTestCase {
    func testAComposerNeverCountsOrRetriesATalkTake() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("talk-own-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = VoiceRecordingStore(baseDir: dir)
        for (id, surface) in [("talk-take", VoiceRecorder.talkSurface), ("chat-take", "chat")] {
            let url = store.newRecordingURL(id: id)
            try Data([0, 1, 2, 3]).write(to: url)
            XCTAssertTrue(store.preserve(id: id, reason: "transcribe-failed", surface: surface))
        }
        let composer = VoiceRecorder(store: store)
        composer.surface = "chat"
        composer.refreshPending()
        XCTAssertEqual(composer.pendingCount, 1, "the chat composer sees only its own take")

        let talk = VoiceRecorder(store: store)
        talk.surface = VoiceRecorder.talkSurface
        talk.refreshPending()
        XCTAssertEqual(talk.pendingCount, 1)

        composer.discardPending()
        XCTAssertNotNil(store.recording(id: "talk-take"), "a composer's Discard never deletes a talk take")
        XCTAssertNil(store.recording(id: "chat-take"))
    }
}

/// What an unsent take says about itself: a reason the person can act on, and,
/// for a recording with no words, its length and audio to play back.
@MainActor
final class TalkUnsentWordsTests: XCTestCase {
    func testAnUnreachableServerIsNamedNotTheirConnection() {
        let take = VoiceTalkRecorder.take(
            words: nil, recordingID: "r", error: "Transcription failed. Check your connection. Recording saved.",
            failure: .transport
        )
        XCTAssertEqual(take, .failed("Walnut server unavailable.", recordingID: "r"))
    }

    func testAnotherFailureKeepsItsWordsWithoutRepeatingThatTheRecordingIsKept() {
        XCTAssertEqual(
            VoiceTalkRecorder.reason(failure: nil, error: "Voice unavailable: the Mac is asleep. Recording saved."),
            "Voice unavailable: the Mac is asleep."
        )
        XCTAssertEqual(VoiceTalkRecorder.reason(failure: nil, error: nil), "Couldn't turn the recording into text.")
    }

    func testAnUnreachableServerReadsTheSameEverywhereItIsSaid() {
        // Every path that names the unreachable server: the recorder, the send,
        // and a take an older build saved with its longer wording.
        XCTAssertEqual(VoiceTalkRecorder.reason(failure: .transport, error: nil), TalkReason.serverUnavailable)
        XCTAssertEqual(TalkMainSender.reason(for: APIError.network(underlying: URLError(.timedOut))), TalkReason.serverUnavailable)
        for wording in TalkReason.serverUnavailableWordings {
            XCTAssertEqual(TalkReason.short(wording + " to turn this into text."), TalkReason.serverUnavailable)
        }
        XCTAssertEqual(VoiceTalkRecorder.reason(failure: nil, error: "Couldn't reach your Walnut server to turn this into text."), TalkReason.serverUnavailable)
    }

    func testATakeAnOlderBuildSavedLoadsWithTheShortReason() {
        let key = "talk-outbox-legacy-\(UUID().uuidString)"
        defer { DurableStore.remove(key: key) }
        let entry = TalkOutbox.Entry(
            id: "e", messageId: "qm-e", createdAt: Date(), text: nil, recordingID: "r",
            reason: "Couldn't reach your Walnut server to turn this into text. Recording saved.", attempts: 1, updatedAt: Date()
        )
        XCTAssertTrue(DurableStore.save([entry], key: key))
        XCTAssertEqual(TalkOutbox(key: key).unsent.first?.reason, TalkReason.serverUnavailable)
    }

    func testNoWordsFromTheServerIsNoWordsNotAFailure() {
        XCTAssertEqual(VoiceTalkRecorder.take(words: nil, recordingID: "r", error: nil, failure: .empty), .noWords(recordingID: "r"))
    }

    func testLengthReadsInSecondsThenMinutes() {
        XCTAssertEqual(TalkPlayback.length(0.2), "1 s")
        XCTAssertEqual(TalkPlayback.length(6.4), "6 s")
        XCTAssertEqual(TalkPlayback.length(72), "1 min 12 s")
    }
}

/// The replayed test recording stands in for the microphone in UI tests. Its loudness
/// follows the readings, so a reader the machine held up still hears the words: on a
/// loaded CI runner the first take's monitor read nothing for seconds, the wall clock
/// ran past the recording, and the take was dropped as silent (CI run 42923466536).
final class TalkReplayCaptureTests: XCTestCase {
    func testAReaderHeldUpStillHearsTheWholeRecording() {
        let rate = 16_000.0
        // 1 s of silence, 1 s of a loud tone, then the end of the file.
        let samples = [Int16](repeating: 0, count: 16_000)
            + (0..<16_000).map { Int16(truncatingIfNeeded: ($0 % 40 < 20) ? 12_000 : -12_000) }
        var clock = Date(timeIntervalSince1970: 0)
        let capture = TalkReplayCapture(samples: samples, rate: rate, now: { clock })
        // The first reading comes 6 s late, far past the end of the recording.
        clock += 6
        var levels = [capture.level]
        for _ in 0..<40 {
            clock += 0.1
            levels.append(capture.level)
        }
        XCTAssertTrue(levels.contains { $0 > -20 }, "the held-up reader never heard the tone: \(levels)")
        XCTAssertLessThan(levels[1], -100, "the recording's own silence comes first")
    }

    func testOneReadingMovesOnAtMostAQuarterSecond() {
        var clock = Date(timeIntervalSince1970: 0)
        let tone = (0..<8_000).map { Int16(truncatingIfNeeded: ($0 % 40 < 20) ? 12_000 : -12_000) }
        let capture = TalkReplayCapture(samples: [Int16](repeating: 0, count: 8_000) + tone, rate: 16_000, now: { clock })
        _ = capture.level
        clock += 30
        XCTAssertLessThan(capture.level, -100, "one late reading skipped the silence and the tone at once")
    }
}
