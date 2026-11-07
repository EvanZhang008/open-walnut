import AVFoundation
import Foundation
import Observation
import UIKit

/// One take of Talk to Walnut: press, talk, and the words go to the CEO chat.
///
/// The Action Button (or Siri, Control Center, a shortcut, the Lock Screen)
/// runs `TalkToWalnutIntent`, which calls `toggle`: the first press starts
/// listening in the background with a Live Activity; a pause after speech, a
/// second press or the activity's Send button ends the take; the words are
/// transcribed by the paired server (the same engine the chat mic uses) and
/// sent as the person's message. Whatever goes wrong after the take started is
/// kept in `TalkOutbox` with the reason, for a resend, never dropped: a take a
/// call cut off, or one a dead process left on disk, joins the list too.
@Observable
@MainActor
final class TalkSession {
    static let shared = TalkSession()

    enum Phase: Equatable {
        case idle
        /// The microphone is being opened (a second, under audio contention).
        case starting
        case listening
        case transcribing
        case sending
        /// The words that reached the CEO chat.
        case sent(String)
        /// Nothing was sent; the sentence says why. `kept` = it is on the
        /// unsent list for a resend.
        case notSent(String, kept: Bool)
    }

    enum Outcome: Equatable {
        case listening
        case finishing
    }

    enum StartError: LocalizedError, CustomLocalizedStringResourceConvertible, Equatable {
        case notPaired
        case micDenied
        case micNotAsked
        /// Walnut was not on screen: iOS lets no app start recording from the background.
        case notInFront
        case busy
        case couldNotStart(String)

        var errorDescription: String? {
            switch self {
            case .notPaired:
                return "Walnut isn't connected to your server yet. Open Walnut and pair it first."
            case .micDenied:
                return "Walnut can't use the microphone. Turn it on in the iPhone Settings app, Walnut, Microphone."
            case .micNotAsked:
                return "Open Walnut once and allow the microphone (Walnut's Settings tab, Action Button), then try again."
            case .notInFront:
                return "Walnut didn't come to the front, so iOS wouldn't let it listen. Open Walnut, then press again."
            case .busy:
                return "Walnut is still sending what you said. Try again in a moment."
            case .couldNotStart(let reason):
                return reason
            }
        }

        var localizedStringResource: LocalizedStringResource {
            LocalizedStringResource(stringLiteral: errorDescription ?? "Talk to Walnut could not start.")
        }
    }

    enum MicAccess { case granted, denied, undetermined }

    private(set) var phase: Phase = .idle
    private(set) var startedAt: Date?
    /// Unsent entries being resent right now (their rows show progress).
    private(set) var resending: Set<String> = []
    /// The words of the last take a Resend delivered, so the list the person
    /// tapped it in says it went out (its row leaves, as a Delete's does).
    private(set) var lastResent: String?
    let outbox: TalkOutbox

    private let recorder: TalkRecording
    private let sender: TalkSending
    private let activity: TalkActivityPresenting
    private let micAccess: () -> MicAccess
    private let isForeground: () -> Bool
    private let isPaired: () -> Bool
    @ObservationIgnored private var monitor: Task<Void, Never>?
    /// The finish in flight, so a caller that must can wait for it.
    @ObservationIgnored private(set) var finishing: Task<Void, Never>?
    @ObservationIgnored private var detector = TalkPauseDetector()
    /// How often the microphone level is read.
    @ObservationIgnored var tick: Duration = .milliseconds(100)
    /// Readings in a row with no level before the take counts as cut off.
    @ObservationIgnored var silentReadsToCutOff = 5
    @ObservationIgnored var sentLinger: TimeInterval = 4
    @ObservationIgnored var notSentLinger: TimeInterval = 60 * 60
    @ObservationIgnored var detectorTemplate = TalkPauseDetector()
    /// The tap the person feels (a seam for the unit tests).
    @ObservationIgnored var cue: (TalkCue) -> Void = TalkCue.play
    /// Automatic resends of one entry before only the person's Resend tries it.
    static let autoResendLimit = 8

    /// A kept take Walnut still sends by itself (the server was away and it has
    /// tries left): it waits, calmly. Anything else needs the person.
    static func waits(_ entry: TalkOutbox.Entry) -> Bool {
        TalkReason.goesOutLater(entry.reason ?? "") && entry.attempts < autoResendLimit
    }
    @ObservationIgnored private var resendingKept = false

    init(
        recorder: TalkRecording? = nil,
        sender: TalkSending = TalkMainSender(),
        activity: TalkActivityPresenting? = nil,
        outbox: TalkOutbox = .shared,
        micAccess: @escaping () -> MicAccess = TalkSession.systemMicAccess,
        isForeground: @escaping () -> Bool = { UIApplication.shared.applicationState == .active },
        isPaired: @escaping () -> Bool = { AppConfig.isConfigured }
    ) {
        self.recorder = recorder ?? VoiceTalkRecorder()
        self.sender = sender
        self.activity = activity ?? TalkLiveActivity()
        self.outbox = outbox
        self.micAccess = micAccess
        self.isForeground = isForeground
        self.isPaired = isPaired
        recoverFromLastProcess()
    }

    var isBusy: Bool {
        switch phase {
        case .starting, .listening, .transcribing, .sending: return true
        default: return false
        }
    }

    // MARK: - The press

    /// The Action Button press: start listening, or, while listening, send.
    /// Returns at once: the send goes on in the background (an intent has a
    /// time limit, a slow transcription must not run into it).
    @discardableResult
    func toggle(source: String) async throws -> Outcome {
        switch phase {
        case .listening:
            beginFinish(source: source)
            return .finishing
        case .starting, .transcribing, .sending:
            AppLog.info("talk", "press ignored while busy", ["source": source])
            throw StartError.busy
        default:
            try await start(source: source)
            return .listening
        }
    }

    func start(source: String) async throws {
        guard !isBusy else { throw StartError.busy }
        guard isPaired() else { throw StartError.notPaired }
        let foreground = isForeground()
        switch micAccess() {
        case .denied: throw StartError.micDenied
        case .undetermined where !foreground: throw StartError.micNotAsked
        default: break
        }
        // Build 160 opened the microphone from the background: every press on a phone was
        // refused ('!int', "Audio is in use by another app"), and only a phone refuses it.
        guard foreground else { throw StartError.notInFront }
        phase = .starting
        startedAt = Date()
        // A field report then says whether Walnut was in front when it asked iOS for the
        // microphone (build 160 asked from the background and was refused, '!int').
        AppLog.info("talk", "opening microphone", ["source": source, "inFront": foreground ? "true" : "false"])
        if let failure = await recorder.begin() {
            phase = .idle
            startedAt = nil
            AppLog.warn("talk", "start failed", ["source": source, "reason": failure])
            throw StartError.couldNotStart(failure)
        }
        // No Live Activity: the take shows on Walnut's own Talk screen (the user, 2026-11-07:
        // "walnut don't need live, just make the action button thing").
        phase = .listening
        cue(.started)
        AppLog.info("talk", "listening", ["source": source])
        detector = detectorTemplate
        startMonitor()
    }

    /// Wait (a few seconds at most) until Walnut is the app on screen: the
    /// shortcut opens it, and iOS starts the recording only once it is in front.
    @discardableResult
    func waitUntilInFront(timeout: TimeInterval = 10) async -> Bool {
        // A press on a locked phone that starts Walnut cold goes through Face ID, the
        // launch and the scene before Walnut is active: seconds on an older phone.
        let deadline = Date().addingTimeInterval(timeout)
        while !isForeground(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        if isForeground() { return true }
        AppLog.warn("talk", "not in front after wait", ["seconds": String(timeout)])
        return false
    }

    /// End the take and send it in the background, returning at once (the Live
    /// Activity's Send button).
    func finishSoon(source: String) {
        beginFinish(source: source)
    }

    /// End the take now and send it (the in-app Send). Returns
    /// once the words reached the CEO chat or were kept as unsent.
    func finishNow(source: String) async {
        beginFinish(source: source)
        await finishing?.value
    }

    /// Drop the take: nothing is sent (the Cancel button).
    func cancel(source: String) async {
        guard phase == .listening else { return }
        stopMonitor()
        recorder.discard()
        AppLog.info("talk", "take cancelled", ["source": source])
        phase = .idle
        activity.end(state(.failed, reason: "Cancelled.", kept: false), linger: 0)
    }

    // MARK: - Unsent words

    /// Send an unsent entry again: transcribe it first when it has no words yet.
    /// True when it reached the CEO chat (and left the list). The entry keeps its
    /// reason while it is resent, so the row stays on screen with its progress.
    @discardableResult
    func resend(_ id: String) async -> Bool {
        guard var entry = outbox.entry(id), !resending.contains(id) else { return false }
        resending.insert(id)
        defer { resending.remove(id) }
        if entry.text == nil {
            guard let recordingID = entry.recordingID else {
                outbox.update(id) { $0.reason = "This recording is no longer on this iPhone." }
                return false
            }
            switch await recorder.transcribe(recordingID: recordingID) {
            case .words(let text, _):
                entry.text = text
                outbox.update(id) { $0.text = text }
            case .noWords:
                outbox.update(id) {
                    $0.reason = "There are no words in this recording."
                    $0.attempts += 1
                }
                return false
            case .failed(let reason, _):
                outbox.update(id) {
                    $0.reason = reason
                    $0.attempts += 1
                }
                return false
            }
        }
        let sent = await deliver(entry, live: false)
        if sent { lastResent = entry.text }
        return sent
    }

    func clearResentNotice() { lastResent = nil }

    /// Send what is kept, oldest first, without the person tapping Resend: when
    /// Walnut comes to the front, when the network comes back, and after a take
    /// that did go out. It stops at the first failure (the server is still away),
    /// and leaves an entry to the person after `autoResendLimit` tries.
    func resendKept(source: String) async {
        guard !resendingKept, !isBusy, isPaired() else { return }
        resendingKept = true
        defer { resendingKept = false }
        let due = outbox.unsent
            .filter { $0.attempts < Self.autoResendLimit && !resending.contains($0.id) }
            .sorted { $0.createdAt < $1.createdAt }
        guard !due.isEmpty else { return }
        AppLog.info("talk", "resending kept", ["source": source, "count": String(due.count)])
        for entry in due {
            guard !isBusy else { return }
            if await !resend(entry.id) { return }
        }
    }

    /// The audio of an unsent entry that has no words yet, to play it back.
    func keptAudio(_ entry: TalkOutbox.Entry) -> TalkKeptAudio? {
        guard entry.text == nil, let recordingID = entry.recordingID else { return nil }
        return recorder.keptAudio(recordingID: recordingID)
    }

    func discard(_ id: String) {
        guard !resending.contains(id) else { return }
        if let entry = outbox.entry(id), entry.text == nil, let recordingID = entry.recordingID {
            recorder.forget(recordingID: recordingID)
        }
        drop(id)
    }

    // MARK: - Internals

    /// The one way a take leaves the list (sent, or deleted), so nothing still
    /// speaks of it: "Kept below to resend" stops showing once nothing is kept,
    /// and its "Not sent" or "Waiting to send" card leaves the Lock Screen.
    private func drop(_ id: String) {
        outbox.remove(id)
        if case .notSent(_, kept: true) = phase, outbox.unsent.isEmpty { phase = .idle }
        activity.endLeftovers(keeping: Set(outbox.entries.map(\.id)))
    }

    /// Start the finish in its own task, never inside the monitor that may have
    /// asked for it: the monitor is cancelled on the way, and a send running in a
    /// cancelled task fails at once (`URLSession` honours the cancellation).
    private func beginFinish(source: String) {
        guard phase == .listening else { return }
        stopMonitor()
        phase = .transcribing
        activity.update(state(.transcribing))
        AppLog.info("talk", "take ended", ["source": source])
        let background = BackgroundWork.begin("talk-send")
        finishing = Task { @MainActor [weak self] in
            defer { background.end() }
            await self?.completeTake()
        }
    }

    private func completeTake() async {
        switch await recorder.finish() {
        case .words(let text, let recordingID):
            await deliver(newEntry(text: text, recordingID: recordingID, reason: nil), live: true)
        case .noWords(let recordingID):
            if let recordingID { recorder.forget(recordingID: recordingID) }
            finishNotSent("Didn't catch any words, so nothing was sent.", kept: false, linger: 6, quiet: true)
        case .failed(let reason, let recordingID):
            let entry = newEntry(text: nil, recordingID: recordingID, reason: reason, attempts: 1)
            let kept = recordingID != nil && outbox.begin(entry)
            finishNotSent(reason, kept: kept, linger: notSentLinger, take: entry.id)
        }
    }

    private func newEntry(
        text: String?, recordingID: String?, reason: String?, attempts: Int = 0, createdAt: Date = Date()
    ) -> TalkOutbox.Entry {
        TalkOutbox.Entry(
            id: UUID().uuidString, messageId: SendRetryPolicy.newMessageId(), createdAt: createdAt,
            text: text, recordingID: recordingID, reason: reason, attempts: attempts, updatedAt: Date()
        )
    }

    /// Send one entry. `live` = the take just spoken (its Live Activity is up).
    @discardableResult
    private func deliver(_ entry: TalkOutbox.Entry, live: Bool) async -> Bool {
        guard let text = entry.text else { return false }
        if live {
            // On disk before the send: a process that dies mid-send leaves it here.
            outbox.begin(entry)
            phase = .sending
            activity.update(state(.sending, words: text))
        }
        do {
            try await sender.send(text: text, messageId: entry.messageId)
            drop(entry.id)
            AppLog.info("talk", "sent", ["chars": String(text.count), "live": live ? "true" : "false"])
            if live {
                phase = .sent(text)
                cue(.sent)
                activity.end(state(.sent, words: text), linger: sentLinger)
                // The server answers again: what it missed before goes now.
                Task { await resendKept(source: "after-send") }
            }
            return true
        } catch {
            let reason = TalkMainSender.reason(for: error)
            outbox.update(entry.id) {
                $0.reason = reason
                $0.attempts += 1
            }
            AppLog.warn("talk", "send failed", ["reason": reason, "live": live ? "true" : "false"])
            if live { finishNotSent(reason, kept: true, linger: notSentLinger, words: text, take: entry.id) }
            return false
        }
    }

    private func finishNotSent(
        _ reason: String, kept: Bool, linger: TimeInterval, words: String? = nil, quiet: Bool = false,
        take: String? = nil
    ) {
        phase = .notSent(reason, kept: kept)
        var ending = state(.failed, words: words, reason: reason, kept: kept)
        ending.later = kept && TalkReason.goesOutLater(reason)
        ending.quiet = quiet
        ending.take = kept ? take : nil
        activity.end(ending, linger: linger)
    }

    private func stopMonitor() {
        monitor?.cancel()
        monitor = nil
    }

    private func startMonitor() {
        stopMonitor()
        let tick = self.tick
        monitor = Task { @MainActor [weak self] in
            var unread = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                guard !Task.isCancelled, let self, self.phase == .listening, let since = self.startedAt else { return }
                guard let level = self.recorder.level() else {
                    // The recorder stopped under the take (a call, a media reset):
                    // finish it as cut off, which keeps it for a resend.
                    unread += 1
                    if unread >= self.silentReadsToCutOff {
                        self.beginFinish(source: "cut-off")
                        return
                    }
                    continue
                }
                unread = 0
                switch self.detector.feed(level: level, at: Date().timeIntervalSince(since)) {
                case .keepListening:
                    continue
                case .pauseAfterSpeech:
                    self.beginFinish(source: "pause")
                case .tooLong:
                    self.beginFinish(source: "max-duration")
                case .noSpeech where self.detector.heardSomething:
                    // Not clearly speech, not silence either: let the engine judge.
                    self.beginFinish(source: "no-clear-speech")
                case .noSpeech:
                    self.dropSilentTake()
                }
                return
            }
        }
    }

    private func dropSilentTake() {
        let notice = "Didn't hear anything, so nothing was sent."
        stopMonitor()
        recorder.discard()
        phase = .notSent(notice, kept: false)
        var ending = state(.failed, reason: notice, kept: false)
        ending.quiet = true
        activity.end(ending, linger: 6)
        AppLog.info("talk", "take cancelled", ["source": "no-speech"])
    }

    /// A new process: a send still marked in flight died with the last one, a
    /// kept take nobody listed (the app was killed mid-take) joins the list, and
    /// a Live Activity the dead process left saying "Listening" goes, and so does
    /// a "Not sent" card whose take is no longer listed.
    private func recoverFromLastProcess() {
        outbox.settleInterrupted(reason: "Walnut closed before this was sent.")
        let listed = Set(outbox.entries.compactMap(\.recordingID))
        for id in recorder.keptTakeIDs() where !listed.contains(id) {
            // Dated by when it was recorded, not found: the time is how the
            // person tells one take from another.
            outbox.begin(newEntry(
                text: nil, recordingID: id, reason: "Walnut stopped before this recording was sent.",
                createdAt: recorder.keptAudio(recordingID: id)?.recordedAt ?? Date()
            ))
        }
        activity.endLeftovers(keeping: Set(outbox.entries.map(\.id)))
    }

    func state(
        _ phase: TalkActivityAttributes.ContentState.Phase, words: String? = nil, reason: String? = nil,
        kept: Bool? = nil
    ) -> TalkActivityAttributes.ContentState {
        TalkActivityAttributes.ContentState(
            phase: phase, startedAt: startedAt ?? Date(),
            words: words.map(Self.preview), reason: reason, kept: kept
        )
    }

    /// A Live Activity holds little: the first words are enough to recognise it.
    static func preview(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        return flat.count <= 120 ? flat : String(flat.prefix(117)) + "..."
    }

    nonisolated static func systemMicAccess() -> MicAccess {
        #if DEBUG
        // A replayed file stands in for the microphone, which it never opens.
        if TalkDebug.replayFile != nil { return .granted }
        #endif
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }
}

/// A finite stretch of background time, so a take that ends with the phone
/// locked still finishes its upload and send.
@MainActor
final class BackgroundWork {
    private var id = UIBackgroundTaskIdentifier.invalid

    static func begin(_ name: String) -> BackgroundWork {
        let work = BackgroundWork()
        work.id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak work] in
            AppLog.warn("talk", "background time ran out", ["name": name])
            work?.end()
        }
        return work
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
