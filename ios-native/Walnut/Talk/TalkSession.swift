import AVFoundation
import Foundation
import Observation
import UIKit

/// One take of Talk to Walnut: press, talk, and the words go to the CEO chat.
///
/// The Action Button (or Siri, Control Center, a shortcut, the Lock Screen)
/// runs `TalkToWalnutIntent`, which calls `toggle`: the first press starts
/// listening behind the app on screen with a Live Activity (or on Walnut's Talk
/// screen when Walnut is in front, or could not listen from behind); a second
/// press, the activity's Send or the Talk screen ends the take, never a pause by
/// itself (`TalkPauseDetector.sendsOnPause`); the words are
/// transcribed by the paired server (the same engine the chat mic uses) and
/// sent as the person's message. Whatever goes wrong after the take started is
/// kept in `TalkOutbox` with the reason, for a resend, never dropped: a take a
/// call cut off, or one a dead process left on disk, joins the list too.
///
/// Dictate to Clipboard (`DictateToClipboardIntent`) is the same take with another
/// destination: its words go onto the clipboard exactly as transcribed, never to
/// the CEO chat, and one that could not be copied waits in the same list for the
/// person's Copy.
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
        /// The words now on the clipboard (Dictate to Clipboard).
        case copied(String)
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
        /// Walnut was not on screen and could not come forward for the take.
        case notInFront
        /// The take could not start behind Walnut's back (Live Activities off, or iOS
        /// refused the microphone there): the press opens Walnut and starts it in front.
        case needsFront(String)
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
            case .needsFront(let reason):
                return reason
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
    /// Where the take on screen (or the last one) delivers its words.
    private(set) var destination: TalkDestination = .ceo
    private(set) var startedAt: Date?
    /// Unsent entries being resent right now (their rows show progress).
    private(set) var resending: Set<String> = []
    /// The words of the last take a Resend delivered, so the list the person
    /// tapped it in says it went out (its row leaves, as a Delete's does).
    private(set) var lastResent: String?
    /// The last take a Resend delivered was copied, not sent.
    private(set) var lastResentCopied = false
    let outbox: TalkOutbox

    private let recorder: TalkRecording
    private let sender: TalkSending
    private let activity: TalkActivityPresenting
    private let micAccess: () -> MicAccess
    private let isForeground: () -> Bool
    private let isPaired: () -> Bool
    /// Holds `clipboardTakeKey` while a take for the clipboard is under way.
    private let prefs: UserDefaults
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
    /// Puts words on the clipboard; false when iOS did not take them (a seam for the unit tests).
    @ObservationIgnored var copier: (String) -> Bool = TalkClipboard.copy
    /// Automatic resends of one entry before only the person's Resend tries it.
    static let autoResendLimit = 8

    /// A kept take Walnut still sends by itself (the server was away and it has
    /// tries left): it waits, calmly. Anything else needs the person.
    /// A take for the clipboard never waits: copied later by itself, it would replace
    /// whatever the person copied since.
    static func waits(_ entry: TalkOutbox.Entry) -> Bool {
        entry.copy != true && TalkReason.goesOutLater(entry.reason ?? "") && entry.attempts < autoResendLimit
    }
    @ObservationIgnored private var resendingKept = false
    /// Send or Cancel tapped on the Live Activity while the microphone still opens:
    /// done as soon as the take listens, never dropped.
    @ObservationIgnored private var endWhenListening: (cancel: Bool, source: String)?

    init(
        recorder: TalkRecording? = nil,
        sender: TalkSending = TalkMainSender(),
        activity: TalkActivityPresenting? = nil,
        outbox: TalkOutbox = .shared,
        micAccess: @escaping () -> MicAccess = TalkSession.systemMicAccess,
        isForeground: @escaping () -> Bool = { UIApplication.shared.applicationState == .active },
        isPaired: @escaping () -> Bool = { AppConfig.isConfigured },
        prefs: UserDefaults = AppPrefs.defaults
    ) {
        self.recorder = recorder ?? VoiceTalkRecorder()
        self.sender = sender
        self.activity = activity ?? TalkLiveActivity()
        self.outbox = outbox
        self.micAccess = micAccess
        self.isForeground = isForeground
        self.isPaired = isPaired
        self.prefs = prefs
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
    /// time limit, a slow transcription must not run into it). `destination` is
    /// where a take this press starts delivers; a press that ends a take ends it
    /// as it was started.
    @discardableResult
    func toggle(source: String, to destination: TalkDestination = .ceo) async throws -> Outcome {
        switch phase {
        case .listening:
            beginFinish(source: source)
            return .finishing
        case .starting, .transcribing, .sending:
            AppLog.info("talk", "press ignored while busy", ["source": source])
            throw StartError.busy
        default:
            try await start(source: source, to: destination)
            return .listening
        }
    }

    func start(source: String, to destination: TalkDestination = .ceo) async throws {
        guard !isBusy else { throw StartError.busy }
        // The press's own take, even one refused below: its panel speaks of it.
        self.destination = destination
        guard isPaired() else { throw StartError.notPaired }
        let foreground = isForeground()
        switch micAccess() {
        case .denied: throw StartError.micDenied
        case .undetermined where !foreground: throw StartError.micNotAsked
        default: break
        }
        phase = .starting
        startedAt = Date()
        endWhenListening = nil
        // Behind Walnut's back iOS records only while the take's Live Activity shows, and it
        // must be up BEFORE the microphone opens (Apple, AudioRecordingIntent: "you must start
        // a Live Activity when you begin the audio recording"). Build 160 opened the
        // microphone first and every press on a phone was refused ('!int'). In front too:
        // an AudioRecordingIntent that leaves the microphone on with no Live Activity is a
        // fatal error in AppIntents ("performed with an active audio session but without a
        // Live Activity"), which killed every press that opened Walnut.
        let live = activity.start(state(.listening))
        if !live {
            guard foreground else {
                phase = .idle
                startedAt = nil
                AppLog.warn("talk", "no live activity, opening Walnut", ["source": source])
                throw StartError.needsFront("Live Activities are off for Walnut, so it opened to listen.")
            }
            AppLog.info("talk", "listening in front with no live activity", ["source": source])
        }
        // A field report then says whether Walnut was in front when it asked iOS for the
        // microphone, and so which way the take went.
        AppLog.info("talk", "opening microphone", ["source": source, "inFront": foreground ? "true" : "false"])
        // A process that dies with this take leaves its recording, listed on the next
        // launch: it must be listed as a take for the clipboard, never sent to the CEO.
        prefs.set(destination == .clipboard, forKey: Self.clipboardTakeKey)
        var refused = await recorder.begin()
        #if DEBUG
        if refused == nil, !foreground, TalkDebug.refuseFromBehind {
            recorder.discard()
            refused = "Audio is in use by another app."
        }
        #endif
        if let failure = refused {
            phase = .idle
            startedAt = nil
            endWhenListening = nil
            prefs.removeObject(forKey: Self.clipboardTakeKey)
            AppLog.warn("talk", "start failed", ["source": source, "reason": failure, "inFront": foreground ? "true" : "false"])
            if live { activity.end(state(.failed, reason: failure, kept: false), linger: 0) }
            guard foreground else { throw StartError.needsFront(failure) }
            throw StartError.couldNotStart(failure)
        }
        phase = .listening
        cue(.started)
        AppLog.info("talk", "listening", ["source": source, "to": destination.rawValue])
        detector = detectorTemplate
        startMonitor()
        if let end = endWhenListening {
            endWhenListening = nil
            if end.cancel { await cancel(source: end.source) } else { beginFinish(source: end.source) }
        }
    }

    /// Whether Walnut is the app on screen now.
    var inFront: Bool { isForeground() }

    /// Whether a take can show its Live Activity (Live Activities are on for Walnut).
    var showsLiveActivity: Bool { activity.canShow }

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
        if phase == .starting { endWhenListening = (false, source) }
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
        if phase == .starting { endWhenListening = (true, source) }
        guard phase == .listening else { return }
        stopMonitor()
        recorder.discard()
        AppLog.info("talk", "take cancelled", ["source": source])
        prefs.removeObject(forKey: Self.clipboardTakeKey)
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
        let sent = entry.copy == true ? copyOut(entry, live: false) : await deliver(entry, live: false)
        if sent {
            lastResent = entry.text
            lastResentCopied = entry.copy == true
            // The words are on the clipboard: the audio they came from can go.
            if entry.copy == true, let recordingID = entry.recordingID { recorder.forget(recordingID: recordingID) }
        }
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
        // Only what Walnut sends by itself (`waits`): a take that needs the person (a start
        // that may have arrived, one the 5-minute cap ended, a refusal) is theirs to send,
        // as the lists and the Lock Screen say.
        let due = outbox.unsent
            .filter { Self.waits($0) && !resending.contains($0.id) }
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
        // A dictation keeps its audio until its words are copied, words or not.
        if let entry = outbox.entry(id), entry.text == nil || entry.copy == true, let recordingID = entry.recordingID {
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
    private func beginFinish(source: String, send: Bool = true) {
        guard phase == .listening else { return }
        stopMonitor()
        phase = .transcribing
        activity.update(state(.transcribing))
        AppLog.info("talk", "take ended", ["source": source])
        let background = BackgroundWork.begin("talk-send")
        finishing = Task { @MainActor [weak self] in
            defer { background.end() }
            await self?.completeTake(send: send)
        }
    }

    /// Why a take the cap ended waits for the person: nobody said to send it (a press
    /// in a pocket, a take forgotten), and the CEO's agents act on what arrives.
    static let stoppedAtCap = "Walnut stopped listening after 5 minutes, so this was not sent. Send it if you meant to."

    private func completeTake(send: Bool) async {
        // Kept takes now carry their destination: a dead process no longer needs the mark.
        defer { prefs.removeObject(forKey: Self.clipboardTakeKey) }
        let take = await recorder.finish()
        if destination == .clipboard {
            completeCopy(take)
            return
        }
        switch take {
        case .words(let text, let recordingID) where !send:
            let entry = newEntry(text: text, recordingID: recordingID, reason: Self.stoppedAtCap)
            let kept = outbox.begin(entry)
            finishNotSent(Self.stoppedAtCap, kept: kept, linger: notSentLinger, words: text, take: entry.id)
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

    /// A take for the clipboard: its words go there as heard, even one the 5-minute cap
    /// ended (a copy reaches no one, and the person pastes it only if they meant it).
    private func completeCopy(_ take: TalkTake) {
        switch take {
        case .words(let text, let recordingID):
            // The audio goes once the words are on the clipboard or safe in the list.
            let entry = newEntry(text: text, recordingID: recordingID, reason: nil, copy: true)
            if copyOut(entry, live: true) || outbox.entry(entry.id) != nil, let recordingID {
                recorder.forget(recordingID: recordingID)
                outbox.update(entry.id) { $0.recordingID = nil }
            }
        case .noWords(let recordingID):
            if let recordingID { recorder.forget(recordingID: recordingID) }
            finishNotSent("Didn't catch any words, so nothing was copied.", kept: false, linger: 6, quiet: true)
        case .failed(let reason, let recordingID):
            let entry = newEntry(text: nil, recordingID: recordingID, reason: reason, attempts: 1, copy: true)
            let kept = recordingID != nil && outbox.begin(entry)
            finishNotSent(reason, kept: kept, linger: notSentLinger, take: entry.id)
        }
    }

    /// Put an entry's words on the clipboard, unchanged. `live` = the take just spoken
    /// (its Live Activity is up); a failed live copy joins the list for the person's Copy.
    @discardableResult
    private func copyOut(_ entry: TalkOutbox.Entry, live: Bool) -> Bool {
        guard let text = entry.text else { return false }
        guard copier(text) else {
            AppLog.warn("talk", "copy failed", ["live": live ? "true" : "false"])
            if live {
                var kept = entry
                kept.reason = TalkReason.notCopied
                let saved = outbox.begin(kept)
                finishNotSent(TalkReason.notCopied, kept: saved, linger: notSentLinger, words: text, take: entry.id)
            } else {
                outbox.update(entry.id) {
                    $0.reason = TalkReason.notCopied
                    $0.attempts += 1
                }
            }
            return false
        }
        if outbox.entry(entry.id) != nil { drop(entry.id) }
        AppLog.info("talk", "copied", ["chars": String(text.count), "live": live ? "true" : "false"])
        if live {
            phase = .copied(text)
            cue(.sent)
            activity.end(state(.sent, words: text), linger: sentLinger)
            // The server just transcribed it: what it missed before goes now.
            Task { await resendKept(source: "after-copy") }
        }
        return true
    }

    private func newEntry(
        text: String?, recordingID: String?, reason: String?, attempts: Int = 0, createdAt: Date = Date(),
        copy: Bool = false
    ) -> TalkOutbox.Entry {
        TalkOutbox.Entry(
            id: UUID().uuidString, messageId: SendRetryPolicy.newMessageId(), createdAt: createdAt,
            text: text, recordingID: recordingID, reason: reason, attempts: attempts, updatedAt: Date(),
            copy: copy ? true : nil
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
            let outbox = self.outbox
            try await sender.send(text: text, messageId: entry.messageId) { @MainActor in
                outbox.update(entry.id) { $0.startingChat = true }
            }
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
        // A dictation never goes out by itself: it waits for the person's Copy.
        ending.later = kept && destination != .clipboard && TalkReason.goesOutLater(reason)
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
                    // Sent only when the person says so; a pause-sending take was asked to.
                    self.beginFinish(source: "max-duration", send: self.detector.sendsOnPause)
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
        let notice = destination == .clipboard
            ? "Didn't hear anything, so nothing was copied." : "Didn't hear anything, so nothing was sent."
        stopMonitor()
        recorder.discard()
        prefs.removeObject(forKey: Self.clipboardTakeKey)
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
        outbox.settleInterrupted(
            reason: TalkReason.closedMidSend, whileStarting: TalkSendError.startOutcomeUnknown.localizedDescription
        )
        let listed = Set(outbox.entries.compactMap(\.recordingID))
        #if DEBUG
        // A UI test starts from an empty list: recordings an earlier run left behind (one
        // a crash cut off, say) are not listed again over the next test's screen.
        if UserDefaults.standard.bool(forKey: "walnut.debug.talkClearOutbox") {
            for id in recorder.keptTakeIDs() where !listed.contains(id) { recorder.forget(recordingID: id) }
        }
        #endif
        // The take that died was one for the clipboard: what it left is copied, never sent.
        let copy = prefs.bool(forKey: Self.clipboardTakeKey)
        prefs.removeObject(forKey: Self.clipboardTakeKey)
        for id in recorder.keptTakeIDs() where !listed.contains(id) {
            // Dated by when it was recorded, not found: the time is how the
            // person tells one take from another.
            outbox.begin(newEntry(
                text: nil, recordingID: id,
                reason: copy ? "Walnut stopped before this recording was copied." : "Walnut stopped before this recording was sent.",
                createdAt: recorder.keptAudio(recordingID: id)?.recordedAt ?? Date(), copy: copy
            ))
        }
        activity.endLeftovers(keeping: Set(outbox.entries.map(\.id)))
    }

    func state(
        _ phase: TalkActivityAttributes.ContentState.Phase, words: String? = nil, reason: String? = nil,
        kept: Bool? = nil
    ) -> TalkActivityAttributes.ContentState {
        var content = TalkActivityAttributes.ContentState(
            phase: phase, startedAt: startedAt ?? Date(),
            words: words.map(Self.preview), reason: reason, kept: kept
        )
        if destination == .clipboard { content.copy = true }
        return content
    }

    /// Set while a take for the clipboard records or is transcribed.
    static let clipboardTakeKey = "walnut.talk.clipboardTake"

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

/// The clipboard a take for it lands on.
enum TalkClipboard {
    /// Put the words on the clipboard exactly as given. False when iOS did not take
    /// them (the clipboard's change count did not move).
    @MainActor
    static func copy(_ text: String) -> Bool {
        let board = UIPasteboard.general
        let before = board.changeCount
        board.string = text
        return board.changeCount != before
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
