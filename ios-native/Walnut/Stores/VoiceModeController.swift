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
    private let speaker: any VoiceSpeaker
    /// Delivers one spoken message to the session (`voice: true`). Answers false
    /// when the send did not go through.
    private let send: (String) async -> Bool
    /// Whether the owner shows these words as a failed message of its own (a
    /// session page's failed bubble, with Retry). Words that could not be sent
    /// and are not shown there are kept here (`unsentText`).
    private let ownerShowsUnsent: (String) -> Bool
    /// Walnut is in front of the person (the app is active).
    private let isAppActive: () -> Bool

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
        isAppActive: (() -> Bool)? = nil,
        notifications: NotificationCenter = .default,
        send: @escaping (String) async -> Bool
    ) {
        self.recorder = recorder ?? VoiceRecorder()
        self.speaker = speaker ?? SpeechOutput.shared
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
        recorder.cancel()
    }

    private func finishTake() async {
        // Background time from Stop to the send's answer: the person may lock the
        // phone or switch apps right after tapping send. The recorder's own
        // assertion ends with the transcription, before the words go out.
        await withBackgroundTime("voice-take") {
            guard let text = await recorder.stopAndTranscribe() else {
                // The recorder kept the audio (or there was nothing to keep) and set
                // its own sentence; the notice rows show it with Retry.
                if recorder.errorMessage == nil { notice = "No speech heard. Tap the mic and try again." }
                return
            }
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
            notice = "No speech heard. Tap the mic and try again."
            return
        }
        awaitingAnswer = true
        sawTurnSinceSend = false
        unsentText = nil
        let sent = await withBackgroundTime("voice-send") { await send(trimmed) }
        if !sent {
            awaitingAnswer = false
            if !ownerShowsUnsent(trimmed) { unsentText = trimmed }
        }
    }

    /// Runs `work` with background time asked of iOS, so a send started just
    /// before the person leaves Walnut can finish. iOS's expiry ends it too: a
    /// request still out then is suspended with the app, not cut by a kill.
    private func withBackgroundTime<T>(_ name: String, _ work: () async -> T) async -> T {
        let time = BackgroundTime(name)
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
    }

    /// The session is waiting on the person (a permission or a question card).
    /// They may not be looking, so say it once per request; never over a take
    /// or an answer being read.
    func announceWaitingOnYou(requestIDs: [String]) async {
        let fresh = Self.newRequests(requestIDs, announced: announcedRequests)
        announcedRequests.formUnion(requestIDs)
        // Not while Walnut is away either: nothing new is read then. The card and
        // the status line are on the page when the person is back.
        guard let first = fresh.first, recorder.state == .idle, !speaker.isSpeaking,
              isAppActive() else { return }
        await speaker.speak(Self.needsAnswerLine, language: "en-US", id: "needs-answer-\(first)")
    }

    nonisolated static func newRequests(_ ids: [String], announced: Set<String>) -> [String] {
        ids.filter { !announced.contains($0) }
    }

    /// Stop the voice (the person tapped Stop).
    func stopSpeaking() {
        speaker.stop(handoff: false)
    }

    /// Walnut is back in front of the person: an answer that became due while it
    /// was away is read now. Also when nothing on the page changes on return (the
    /// provisional row's grace ran out while away, and its canonical row is late).
    func appBecameActive() {
        evaluate(now: Date())
    }

    /// Read the newest answer again, or for the first time if it arrived while
    /// the person was recording.
    func replay() async {
        guard let answer = lastAnswer else { return }
        await speak(answer)
    }

    /// Voice mode is closing: silence, and no take left running.
    func shutDown() {
        provisionalTimer?.cancel()
        if let activeObserver {
            notifications.removeObserver(activeObserver)
            self.activeObserver = nil
        }
        speaker.stop(handoff: false)
        if recorder.state == .recording { recorder.cancel() }
    }

    private func evaluate(now: Date) {
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
            provisionalSince = nil
            spokenIDs.insert(row.id)
            if Self.isProvisional(row) { provisionalTexts.insert(Self.textKey(row.text)) }
            lastAnswer = row
            awaitingAnswer = false
            // Never over a take: the person is talking. Replay reads it later.
            guard recorder.state == .idle else { return }
            Task { await self.speak(row) }
        }
    }

    private func speak(_ row: ChatMessage) async {
        guard let prepared = SpokenText.prepare(row.text) else { return }
        await speaker.speak(prepared.text, language: prepared.language, id: row.id)
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
    /// Voice mode on a session page (`SessionConversationView`): the words go to
    /// `store` as spoken sends, and a send that failed leaves its bubble there, with
    /// Retry, as the one copy. The other arguments are the WalnutTests seams.
    static func sessionPage(
        _ store: SessionConversationStore, sessionID: String, awaitingAnswer: Bool,
        speaker: (any VoiceSpeaker)? = nil, isAppActive: (() -> Bool)? = nil,
        notifications: NotificationCenter = .default
    ) -> VoiceModeController {
        VoiceModeController(
            sessionID: sessionID, rows: store.messages, awaitingAnswer: awaitingAnswer,
            ownerShowsUnsent: { store.showsFailedSend(of: $0) },
            speaker: speaker, isAppActive: isAppActive, notifications: notifications
        ) { text in
            await store.send(text, voice: true)
        }
    }
}

/// One background task asked of iOS for a voice step, ended by its owner or, when
/// time runs out first, by iOS's expiry handler: an app whose background task is
/// not ended by then is killed, and one that ends it is only suspended.
@MainActor
private final class BackgroundTime {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
