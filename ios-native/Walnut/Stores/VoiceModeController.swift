import Foundation
import Observation

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
    private let speaker: SpeechOutput
    /// Delivers one spoken message to the session (`voice: true`). Answers false
    /// when the send did not go through; the page shows its own error then.
    private let send: (String) async -> Bool

    /// The newest answer this controller knows, for Replay.
    private(set) var lastAnswer: ChatMessage?
    /// A sentence for the person when something did not work ("No speech heard").
    var notice: String?
    /// True from a voice send until the next answer arrives.
    private(set) var awaitingAnswer = false
    /// Words that were transcribed but could not be sent, kept for Send again.
    /// Only for an owner that keeps no copy of its own (the ask launch): a session
    /// page keeps the failed bubble, with its own Retry.
    private(set) var unsentText: String?
    private let keepsUnsentText: Bool

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

    /// Said when the session stops to ask the person something on screen.
    static let needsAnswerLine = "It needs your answer on the screen."

    /// How long a provisional row may stand in for the canonical one.
    static let provisionalGrace: TimeInterval = 4

    init(
        sessionID: String,
        rows: [ChatMessage],
        awaitingAnswer: Bool = false,
        keepsUnsentText: Bool = false,
        // Optional, built here: a default argument is evaluated outside the
        // main actor, where neither can be made.
        recorder: VoiceRecorder? = nil,
        speaker: SpeechOutput? = nil,
        send: @escaping (String) async -> Bool
    ) {
        self.recorder = recorder ?? VoiceRecorder()
        self.speaker = speaker ?? .shared
        self.send = send
        self.awaitingAnswer = awaitingAnswer
        self.keepsUnsentText = keepsUnsentText
        self.recorder.surface = "voice:\(sessionID)"
        baseline = Set(rows.filter(Self.isAnswer).map(\.id))
        lastAnswer = rows.last(where: Self.isAnswer)
        latestRows = rows
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
        guard let text = await recorder.stopAndTranscribe() else {
            // The recorder kept the audio (or there was nothing to keep) and set
            // its own sentence; the notice rows show it with Retry.
            if recorder.errorMessage == nil { notice = "No speech heard. Tap the mic and try again." }
            return
        }
        await deliver(text)
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
        if !(await send(trimmed)) {
            awaitingAnswer = false
            if keepsUnsentText { unsentText = trimmed }
        }
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
        guard let first = fresh.first, recorder.state == .idle, !speaker.isSpeaking else { return }
        await speaker.speak(Self.needsAnswerLine, language: "en-US", id: "needs-answer-\(first)")
    }

    nonisolated static func newRequests(_ ids: [String], announced: Set<String>) -> [String] {
        ids.filter { !announced.contains($0) }
    }

    /// Stop the voice (the person tapped Stop).
    func stopSpeaking() {
        speaker.stop()
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
        speaker.stop()
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
