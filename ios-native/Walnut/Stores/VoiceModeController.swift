import Foundation
import Observation
import UIKit

/// What voice mode reads answers with: `SpeechOutput` in the app, a stand-in that
/// records what it was asked to say in tests.
@MainActor
protocol VoiceSpeaker: AnyObject {
    var isSpeaking: Bool { get }
    func speak(_ text: String, language: String, id: String) async
    func stop(handoff: Bool)
}

extension SpeechOutput: VoiceSpeaker {}

/// Voice mode on a session page: talk to the session, hear its answer.
///
/// The loop: tap the mic, speak, tap again. The take is transcribed by the
/// user's own Walnut server (the same recorder and engine the composer's mic
/// uses) and SENT at once with `voice: true`, which asks the session for a short
/// spoken answer first (voice-reply.ts on the server). When a turn ends, the
/// newest answer is read aloud on the phone (`SpokenText` + `SpeechOutput`).
///
/// "A turn ends" covers turns nobody on the phone started: a Walnut agent that
/// handed work to another task is woken when that task finishes, and its answer
/// is a new turn on this same page. That is what lets voice mode say "it is
/// done, what next?" without the person asking again.
///
/// What is never read: anything already on the page when voice mode was turned
/// on (the baseline), and anything read before. A turn that ends while the person
/// is recording is held, not dropped: Replay reads it.
///
/// Nothing new starts speaking while Walnut is away (the phone locked, another app
/// in front): an answer that becomes due then is read when Walnut is back. An
/// answer already being read when the person leaves is read to its end.
///
/// Hands-free (`handsFree`, the `voice_conversation` experiment): one tap turns
/// voice mode on and it listens on its own. A pause after speech sends the take
/// (`TalkPauseDetector`), the answer is read, and it listens again, with no tap in
/// between. While it listens, the words heard so far show in the box
/// (`VoiceLiveWords`). A tap of the mic sends what was said at once, or, before
/// anything was said, pauses listening; a minute of quiet pauses it too. Over
/// the answer the mic is off (the phone's speaker would hear itself): a tap of the
/// mic or Stop ends the reading and listens. The loop is in
/// VoiceModeController+HandsFree.swift.
@Observable
@MainActor
final class VoiceModeController {
    enum Phase: Equatable {
        case ready
        case listening
        case transcribing
        /// The words went out; the session has not answered yet.
        case waiting
        case speaking
    }

    let recorder: VoiceRecorder
    let speaker: any VoiceSpeaker
    /// Listens on its own, sends on a pause, listens again after the answer.
    let handsFree: Bool
    /// The words of the take being recorded, shown in the box (hands-free only).
    let liveWords: VoiceLiveWords
    /// Delivers one spoken message to the session (`voice: true`). Answers false
    /// when the send did not go through.
    private let send: (String) async -> Bool
    /// Whether the owner shows these words as a failed message of its own (a
    /// session page's failed bubble, with Retry). Words that could not be sent
    /// and are not shown there are kept here (`unsentText`).
    private let ownerShowsUnsent: (String) -> Bool
    /// Walnut is in front of the person (the app is active).
    let isAppActive: () -> Bool

    /// The newest answer this controller knows, for Replay.
    private(set) var lastAnswer: ChatMessage?
    /// A sentence for the person when something did not work ("No speech heard").
    var notice: String?
    /// True from a voice send until the next answer arrives.
    private(set) var awaitingAnswer = false
    /// Words that were transcribed but could not be sent, kept for Send again.
    /// Only when the owner shows no copy of its own (`ownerShowsUnsent`): the ask
    /// launch has no bubble before it starts, and a session page shows none when
    /// it takes no message at all (a session that cannot be woken). Otherwise the
    /// page's failed bubble, with its own Retry, is the one copy. Nothing said is
    /// lost without a trace.
    private(set) var unsentText: String?
    /// Hands-free is listening on its own: off after the person paused it, after a
    /// minute of quiet, or after something failed, until a tap of the mic.
    var listensOnItsOwn = false
    /// The take being recorded has heard speech (a tap then sends it, not pauses).
    var takeHeardSpeech = false

    // Hands-free state (VoiceModeController+HandsFree.swift).
    @ObservationIgnored var detector = TalkPauseDetector()
    @ObservationIgnored var monitor: Task<Void, Never>?
    @ObservationIgnored var speakingFollow: Task<Void, Never>?
    @ObservationIgnored var takeStartedAt: Date?
    /// A take is being started (the session switch is async): no second start.
    @ObservationIgnored var startingTake = false
    /// An answer is about to be read (its Task has not reached the speaker yet).
    @ObservationIgnored var speakingSoon = false
    /// Listening stopped because Walnut went to the background; it resumes on return.
    @ObservationIgnored var pausedForAway = false
    @ObservationIgnored var resignObserver: NSObjectProtocol?
    /// How long a quiet stretch after speech sends the take (the web's endSilenceMs),
    /// and how long listening with nothing said pauses (the web's IDLE_MS). The unit
    /// tests shorten them.
    @ObservationIgnored var pauseToSendSeconds: TimeInterval = 1.2
    @ObservationIgnored var quietPauseSeconds: TimeInterval = 60
    /// Test seam: opens a take in place of the microphone.
    @ObservationIgnored var micOpener: (() async -> Bool)?

    /// Answer rows present when voice mode was turned on: never read.
    @ObservationIgnored private var baseline: Set<String> = []
    /// Rows already read (or deliberately skipped), by id.
    @ObservationIgnored private var spokenIDs: Set<String> = []
    /// Texts of PROVISIONAL rows that were read: the canonical row that replaces
    /// one has a new id and the same words, and counts as read once. Only
    /// provisional texts, so a later answer that happens to say the same words
    /// ("Done.") is still read.
    @ObservationIgnored private var provisionalTexts: Set<String> = []
    /// When the newest candidate was first seen as a provisional row: after a
    /// grace period it is read even if the canonical row never comes.
    @ObservationIgnored private var provisionalSince: (id: String, at: Date)?
    @ObservationIgnored private var provisionalTimer: Task<Void, Never>?
    @ObservationIgnored private var latestRows: [ChatMessage] = []
    @ObservationIgnored private var latestStreaming = false
    /// A turn ran since the last voice send. A turn that then ends with no answer
    /// (only tool calls) must still end the wait, or the bar says "waiting" forever.
    @ObservationIgnored private var sawTurnSinceSend = false

    /// Permission and question cards already announced, by request id.
    @ObservationIgnored private var announcedRequests: Set<String> = []
    /// Walnut coming back to the front (`appBecameActive`); removed by `shutDown`.
    @ObservationIgnored private var activeObserver: NSObjectProtocol?
    private let notifications: NotificationCenter

    /// Said when the session stops to ask the person something on screen.
    static let needsAnswerLine = "It needs your answer on the screen."

    /// How long a provisional row may stand in for the canonical one.
    static let provisionalGrace: TimeInterval = 4

    init(
        sessionID: String,
        rows: [ChatMessage],
        awaitingAnswer: Bool = false,
        ownerShowsUnsent: @escaping (String) -> Bool = { _ in false },
        // Optional, built here: a default argument is evaluated outside the
        // main actor, where none of these can be made.
        recorder: VoiceRecorder? = nil,
        speaker: (any VoiceSpeaker)? = nil,
        handsFree: Bool = false,
        liveWords: VoiceLiveWords? = nil,
        isAppActive: (() -> Bool)? = nil,
        notifications: NotificationCenter = .default,
        send: @escaping (String) async -> Bool
    ) {
        self.recorder = recorder ?? VoiceRecorder()
        self.speaker = speaker ?? SpeechOutput.shared
        self.handsFree = handsFree
        self.liveWords = liveWords ?? VoiceLiveWords()
        self.send = send
        self.ownerShowsUnsent = ownerShowsUnsent
        self.isAppActive = isAppActive ?? { UIApplication.shared.applicationState == .active }
        self.notifications = notifications
        self.awaitingAnswer = awaitingAnswer
        self.recorder.surface = "voice:\(sessionID)"
        baseline = Set(rows.filter(Self.isAnswer).map(\.id))
        lastAnswer = rows.last(where: Self.isAnswer)
        latestRows = rows
        activeObserver = notifications.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.appBecameActive() }
        }
        if handsFree {
            resignObserver = notifications.addObserver(
                forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.appWillResign() }
            }
        }
    }

    var phase: Phase {
        switch recorder.state {
        case .recording: return .listening
        case .transcribing: return .transcribing
        case .idle: break
        }
        if speaker.isSpeaking { return .speaking }
        if awaitingAnswer { return .waiting }
        return .ready
    }

    // MARK: - Talking

    /// The one big button: start a take, or end it and send it. A tap while an
    /// answer is being read stops the voice first (barge-in).
    func micTapped() async {
        notice = nil
        if handsFree {
            await handsFreeMicTapped()
            return
        }
        switch recorder.state {
        case .transcribing:
            return
        case .recording:
            await finishTake()
        case .idle:
            speaker.stop(handoff: true)
            if !(await recorder.start()) {
                notice = recorder.errorMessage
            }
        }
    }

    /// Drop the take in progress.
    func cancelTake() {
        if handsFree {
            dropTake()
            listensOnItsOwn = false
            return
        }
        recorder.cancel()
    }

    func finishTake() async {
        // Background time from Stop to the send's answer: the person may lock the
        // phone or switch apps right after tapping send. The recorder's own
        // assertion ends with the transcription, before the words go out.
        await withBackgroundTime("voice-take") {
            stopMonitor()
            // No more drafts: the engine is the take's own now. Its words stay shown.
            liveWords.freeze()
            guard let text = await recorder.stopAndTranscribe() else {
                // The recorder kept the audio (or there was nothing to keep) and set
                // its own sentence; the notice rows show it with Retry.
                liveWords.clear()
                if handsFree, recorder.errorMessage == nil || recorder.lastTakeHadNoWords {
                    // Nothing in it after all (a cough, a door): listen on. The take is
                    // kept like any other; its notice would only stop the conversation.
                    if recorder.lastTakeHadNoWords { recorder.errorMessage = nil }
                    resumeIfQuiet()
                    return
                }
                if handsFree { listensOnItsOwn = false }
                if recorder.errorMessage == nil { notice = "No speech heard. Tap the mic and try again." }
                return
            }
            liveWords.clear()
            await deliver(text)
        }
    }

    /// A saved take the person retried from the notice rows.
    func deliverRecovered(_ text: String) async {
        await deliver(text)
    }

    private func deliver(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            if handsFree {
                // The engine found no words in it: listen on.
                resumeIfQuiet()
                return
            }
            notice = "No speech heard. Tap the mic and try again."
            return
        }
        awaitingAnswer = true
        sawTurnSinceSend = false
        unsentText = nil
        let sent = await withBackgroundTime("voice-send") { await send(trimmed) }
        if !sent {
            awaitingAnswer = false
            // Not sent: listening on would talk past words that are not there.
            listensOnItsOwn = false
            if !ownerShowsUnsent(trimmed) { unsentText = trimmed }
        }
    }

    /// Runs `work` with background time asked of iOS, so a send started just
    /// before the person leaves Walnut can finish. iOS's expiry ends it too: a
    /// request still out then is suspended with the app, not cut by a kill.
    private func withBackgroundTime<T>(_ name: String, _ work: () async -> T) async -> T {
        let time = VoiceBackgroundTime(name)
        defer { time.end() }
        return await work()
    }

    /// Send the kept words again (the person tapped Send again).
    func retryUnsent() async {
        guard let text = unsentText else { return }
        await deliver(text)
    }

    func discardUnsent() {
        unsentText = nil
    }

    // MARK: - Hearing

    /// Feed the page's current rows and turn state. Reads the newest answer when
    /// the session is idle and that answer has not been read.
    func observe(rows: [ChatMessage], streaming: Bool) {
        if streaming { sawTurnSinceSend = true }
        latestRows = rows
        latestStreaming = streaming
        evaluate(now: Date())
        if awaitingAnswer, !streaming, sawTurnSinceSend, provisionalSince == nil {
            awaitingAnswer = false
        }
        // A turn that ended with nothing to read: listen again.
        resumeIfQuiet()
    }

    /// The session is waiting on the person (a permission or a question card).
    /// They may not be looking, so say it once per request; never over a take
    /// or an answer being read.
    func announceWaitingOnYou(requestIDs: [String]) async {
        let fresh = Self.newRequests(requestIDs, announced: announcedRequests)
        announcedRequests.formUnion(requestIDs)
        // Not while Walnut is away either: nothing new is read then. The card and
        // the status line are on the page when the person is back.
        guard let first = fresh.first, isAppActive(), !speaker.isSpeaking, !startingTake else { return }
        // A hands-free take nobody spoke into yet gives way; one with words does not.
        if handsFree, recorder.state == .recording, !detector.hasSpeech { dropTake() }
        guard recorder.state == .idle else { return }
        speakingSoon = true
        await speaker.speak(Self.needsAnswerLine, language: "en-US", id: "needs-answer-\(first)")
        followSpeaking()
    }

    nonisolated static func newRequests(_ ids: [String], announced: Set<String>) -> [String] {
        ids.filter { !announced.contains($0) }
    }

    /// Stop the voice (the person tapped Stop).
    func stopSpeaking() {
        // Hands-free listens right after: the recorder takes the session, so the
        // speaker must not switch it off under the new take.
        speaker.stop(handoff: handsFree)
    }

    /// Walnut is back in front of the person: an answer that became due while it
    /// was away is read now. Also when nothing on the page changes on return (the
    /// provisional row's grace ran out while away, and its canonical row is late).
    func appBecameActive() {
        evaluate(now: Date())
        if pausedForAway {
            pausedForAway = false
            resumeIfQuiet()
        }
    }

    /// Read the newest answer again, or for the first time if it arrived while
    /// the person was recording.
    func replay() async {
        guard let answer = lastAnswer, !startingTake else { return }
        await speak(answer)
    }

    /// Voice mode is closing: silence, and no take left running.
    func shutDown() {
        provisionalTimer?.cancel()
        stopMonitor()
        speakingFollow?.cancel()
        listensOnItsOwn = false
        liveWords.clear()
        if let activeObserver {
            notifications.removeObserver(activeObserver)
            self.activeObserver = nil
        }
        if let resignObserver {
            notifications.removeObserver(resignObserver)
            self.resignObserver = nil
        }
        speaker.stop(handoff: false)
        if recorder.state == .recording { recorder.preserveAndStop(reason: "view-dismissed") }
    }

    func evaluate(now: Date) {
        let decision = Self.nextToSpeak(
            rows: latestRows, streaming: latestStreaming, baseline: baseline,
            spokenIDs: spokenIDs, provisionalTexts: provisionalTexts,
            provisionalSince: provisionalSince, now: now, grace: Self.provisionalGrace
        )
        switch decision {
        case .nothing:
            provisionalSince = nil
        case .replacesReadProvisional(let row):
            provisionalSince = nil
            spokenIDs.insert(row.id)
            provisionalTexts.remove(Self.textKey(row.text))
            lastAnswer = row
        case .waitForCanonical(let id):
            if provisionalSince?.id != id {
                provisionalSince = (id, now)
                provisionalTimer?.cancel()
                provisionalTimer = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(Self.provisionalGrace + 0.2))
                    guard !Task.isCancelled else { return }
                    self?.evaluate(now: Date())
                }
            }
        case .speak(let row):
            // Away (the phone locked, another app in front): nothing new starts
            // speaking. The answer is not taken yet, so `appBecameActive` (or the
            // rows the page reads on return) reads it then. Before this, the
            // provisional row's grace timer could fire away from the page and read
            // a new answer in the background (App Store gate r9, LOW 2).
            guard isAppActive() else { return }
            // A take is opening: decided once it is open (`startTake` asks again).
            guard !startingTake else { return }
            provisionalSince = nil
            spokenIDs.insert(row.id)
            if Self.isProvisional(row) { provisionalTexts.insert(Self.textKey(row.text)) }
            lastAnswer = row
            awaitingAnswer = false
            // A hands-free take nobody spoke into yet gives way to the answer.
            if handsFree, recorder.state == .recording, !detector.hasSpeech { dropTake() }
            // Never over a take: the person is talking. Replay reads it later.
            guard recorder.state == .idle else { return }
            speakingSoon = true
            Task { await self.speak(row) }
        }
    }

    private func speak(_ row: ChatMessage) async {
        speakingSoon = true
        // What the screen shows: never the agent-ack line or an Org chat's tasks line.
        guard let prepared = SpokenText.prepare(TimelineTurnMarker.strip(row.text)) else {
            speakingSoon = false
            resumeIfQuiet()
            return
        }
        if handsFree, recorder.state == .recording { dropTake() }
        await speaker.speak(prepared.text, language: prepared.language, id: row.id)
        followSpeaking()
    }

    // MARK: - The decision (pure, unit-tested)

    enum Decision: Equatable {
        case nothing
        /// The newest answer is still the provisional row; wait for the
        /// canonical one (same text, stable id) before reading.
        case waitForCanonical(String)
        /// The canonical row of a provisional row already read: not read again.
        case replacesReadProvisional(ChatMessage)
        case speak(ChatMessage)
    }

    nonisolated static func isProvisional(_ m: ChatMessage) -> Bool {
        m.id.hasPrefix("provisional-")
    }

    /// A plain assistant text row: what a session SAYS (tool and reasoning rows
    /// are not answers).
    nonisolated static func isAnswer(_ m: ChatMessage) -> Bool {
        m.role == "assistant" && m.kind == nil
            && !m.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    nonisolated static func textKey(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400))
    }

    nonisolated static func nextToSpeak(
        rows: [ChatMessage], streaming: Bool, baseline: Set<String>,
        spokenIDs: Set<String>, provisionalTexts: Set<String>,
        provisionalSince: (id: String, at: Date)?, now: Date, grace: TimeInterval
    ) -> Decision {
        // Mid-turn text is a draft of the answer, not the answer.
        guard !streaming else { return .nothing }
        // Only the newest answer, and only if nothing the person said came after
        // it: an answer older than their latest words is the previous turn's.
        guard let index = rows.lastIndex(where: isAnswer) else { return .nothing }
        if rows[(index + 1)...].contains(where: { $0.role == "user" && $0.kind == nil }) { return .nothing }
        let row = rows[index]
        if baseline.contains(row.id) || spokenIDs.contains(row.id) { return .nothing }
        if isProvisional(row) {
            if let since = provisionalSince, since.id == row.id, now.timeIntervalSince(since.at) >= grace {
                return .speak(row)
            }
            return .waitForCanonical(row.id)
        }
        if provisionalTexts.contains(textKey(row.text)) { return .replacesReadProvisional(row) }
        return .speak(row)
    }
}

extension VoiceModeController {
    /// The experiment that makes voice mode hands-free (src/core/experimental.ts),
    /// the same switch as the web's voice conversation.
    static let handsFreeExperiment = "voice_conversation"
    static var handsFreeIsOn: Bool { ServerClientSettings.shared.isOn(handsFreeExperiment) }

    /// Voice mode on a session page (`SessionConversationView`): the words go to
    /// `store` as spoken sends, and a send that failed leaves its bubble there, with
    /// Retry, as the one copy. The other arguments are the WalnutTests seams.
    static func sessionPage(
        _ store: SessionConversationStore, sessionID: String, awaitingAnswer: Bool,
        speaker: (any VoiceSpeaker)? = nil, isAppActive: (() -> Bool)? = nil,
        notifications: NotificationCenter = .default, handsFree: Bool? = nil
    ) -> VoiceModeController {
        VoiceModeController(
            sessionID: sessionID, rows: store.messages, awaitingAnswer: awaitingAnswer,
            ownerShowsUnsent: { store.showsFailedSend(of: $0) },
            speaker: speaker, handsFree: handsFree ?? handsFreeIsOn, isAppActive: isAppActive, notifications: notifications
        ) { text in
            await store.send(text, voice: true)
        }
    }
}
