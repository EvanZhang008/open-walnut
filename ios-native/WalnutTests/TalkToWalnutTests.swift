import XCTest
import AppIntents
@testable import Walnut

// Talk to Walnut (the Action Button shortcut to the CEO chat): the take's state
// machine, the pause detector, the unsent list, the CEO chat route, and the
// bundle facts iOS needs to offer the shortcut and show its Live Activity.

@MainActor
private final class FakeTalkRecorder: TalkRecording {
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
    private(set) var sent: [(text: String, messageId: String)] = []

    func send(text: String, messageId: String) async throws {
        try Task.checkCancellation()
        if !failures.isEmpty { throw failures.removeFirst() }
        sent.append((text, messageId))
    }
}

@MainActor
private final class FakeTalkActivity: TalkActivityPresenting {
    var allow = true
    private(set) var started: [TalkActivityAttributes.ContentState] = []
    private(set) var updates: [TalkActivityAttributes.ContentState] = []
    private(set) var ended: [(state: TalkActivityAttributes.ContentState, linger: TimeInterval)] = []
    private(set) var leftoversEnded = 0
    /// The takes still listed when the cards of the others were last told to go.
    private(set) var lastKeeping: Set<String>?

    func start(_ state: TalkActivityAttributes.ContentState) -> Bool {
        started.append(state)
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
    private var foreground = false
    private var paired = true
    private var cues: [TalkCue] = []
    private let key = "talk-outbox-test-\(UUID().uuidString)"

    override func setUp() async throws {
        recorder = FakeTalkRecorder()
        sender = FakeTalkSender()
        activity = FakeTalkActivity()
        outbox = TalkOutbox(key: key)
        mic = .granted
        foreground = false
        paired = true
    }

    override func tearDown() async throws {
        DurableStore.remove(key: key)
    }

    private func session(sender custom: TalkSending? = nil) -> TalkSession {
        let session = TalkSession(
            recorder: recorder, sender: custom ?? sender, activity: activity, outbox: outbox,
            micAccess: { [unowned self] in self.mic },
            isForeground: { [unowned self] in self.foreground },
            isPaired: { [unowned self] in self.paired }
        )
        session.tick = .milliseconds(5)
        session.cue = { [unowned self] in self.cues.append($0) }
        return session
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
        XCTAssertEqual(activity.started.map(\.phase), [.listening])

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

    func testAPauseAfterSpeechSendsByItself() async throws {
        var detector = TalkPauseDetector()
        detector.pauseToSend = 0.05
        detector.minSpeech = 0.01
        recorder.levels = Array(repeating: -60, count: 3) + Array(repeating: -15, count: 20) + Array(repeating: -60, count: 400)
        let talk = session()
        talk.detectorTemplate = detector
        try await talk.toggle(source: "test")
        try await waitUntil { if case .sent = talk.phase { return true }; return talk.phase != .listening && talk.phase != .transcribing && talk.phase != .sending }
        XCTAssertEqual(talk.phase, .sent("hello"), "the send must not run in the cancelled monitor")
        XCTAssertEqual(sender.sent.count, 1)
        XCTAssertEqual(recorder.discarded, 0)
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

    func testSoundThatNeverCountedAsSpeechIsStillTranscribed() async throws {
        var detector = TalkPauseDetector()
        detector.noSpeechTimeout = 0.05
        detector.minSpeech = 10
        recorder.levels = [-35]
        let talk = session()
        talk.detectorTemplate = detector
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

    func testWithLiveActivitiesOffABackgroundTakeIsRefusedNotLeftToDieSilently() async throws {
        activity.allow = false
        await assertThrows(session(), .liveActivitiesOff)
        XCTAssertEqual(recorder.discarded, 1)
        foreground = true
        let talk = session()
        try await pressTwice(talk)
        XCTAssertEqual(talk.phase, .sent("hello"), "in the app the screen shows the take instead")
    }

    func testAMicrophoneThatWillNotStartIsReportedAndNothingIsLeftListening() async throws {
        recorder.beginFailure = "Another app is using audio (a call?)."
        let talk = session()
        await assertThrows(talk, .couldNotStart("Another app is using audio (a call?)."))
        XCTAssertTrue(activity.started.isEmpty)
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
        XCTAssertEqual(outbox.entry("e1")?.reason, "Walnut closed before this was sent.")
        let orphan = try XCTUnwrap(outbox.unsent.first { $0.recordingID == "rec-orphan" })
        XCTAssertNil(orphan.text)
        XCTAssertEqual(orphan.createdAt, recorded, "a recovered take keeps the time it was recorded")
        XCTAssertEqual(outbox.entries.count, 2, "a take already listed is not listed twice")
        XCTAssertEqual(activity.leftoversEnded, 1)
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
}

private final class GatedSender: TalkSending, @unchecked Sendable {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var count = 0

    func send(text: String, messageId: String) async throws {
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
        var detector = TalkPauseDetector()
        let (decision, time) = run(&detector, [(0.5, -55), (3, -20), (5, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
        // The pause counts from the first quiet reading (one tick after the speech).
        XCTAssertEqual(time, 3.5 + 0.1 + 1.8, accuracy: 0.15)
    }

    func testABreathBetweenSentencesDoesNotSend() {
        var detector = TalkPauseDetector()
        let (decision, _) = run(&detector, [(0.5, -55), (2, -20), (1, -55), (2, -20)])
        XCTAssertEqual(decision, .keepListening)
    }

    func testSilenceGivesUpAfterTheTimeout() {
        var detector = TalkPauseDetector()
        let (decision, time) = run(&detector, [(20, -60)])
        XCTAssertEqual(decision, .noSpeech)
        XCTAssertEqual(time, 8, accuracy: 0.15)
    }

    func testACoughIsNotSpeech() {
        var detector = TalkPauseDetector()
        let (decision, _) = run(&detector, [(1, -58), (0.1, -15), (20, -58)])
        XCTAssertEqual(decision, .noSpeech)
    }

    func testSpeechInANoisyRoomStillEndsOnAPause() {
        var detector = TalkPauseDetector()
        let (decision, _) = run(&detector, [(0.5, -32), (4, -14), (4, -32)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testNormalSpeechFromTheFirstInstantStillEndsOnAPause() {
        var detector = TalkPauseDetector()
        let (decision, _) = run(&detector, [(3, -28), (4, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testSpeakingFromTheFirstInstantIsHeard() {
        var detector = TalkPauseDetector()
        let (decision, _) = run(&detector, [(3, -18), (4, -55)])
        XCTAssertEqual(decision, .pauseAfterSpeech)
    }

    func testAVeryLongTakeIsSentAtTheCap() {
        var detector = TalkPauseDetector()
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

    func testTheIntentMayStartItsLiveActivityFromTheBackground() {
        // iOS grants a background Live Activity start only to a LiveActivityIntent;
        // an AudioRecordingIntent alone is refused, and so is the recording.
        XCTAssertTrue((TalkToWalnutIntent() as Any) is any LiveActivityIntent)
        XCTAssertTrue((TalkToWalnutIntent() as Any) is any AudioRecordingIntent)
    }

    func testTheShortcutIsInTheAppsIntentMetadata() throws {
        // App Shortcuts are read by iOS from the metadata the build extracts;
        // without it nothing shows in Shortcuts or the Action Button picker.
        let metadata = try XCTUnwrap(Bundle.main.url(forResource: "Metadata", withExtension: "appintents"))
        let extract = metadata.appendingPathComponent("extract.actionsdata")
        let text = try String(contentsOf: extract, encoding: .utf8)
        XCTAssertTrue(text.contains("TalkToWalnutIntent"))
        XCTAssertTrue(text.contains("Talk to Walnut"))
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
