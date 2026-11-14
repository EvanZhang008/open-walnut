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
/// Dictate (`DictateToClipboardIntent`) is the same take with another destination:
/// its words, exactly as transcribed, open on one page (`TalkPanel`) with Send, to the
/// CEO chat, and Copy, to the clipboard (the user, 2026-11-11: "just one page that can
/// send and can copy"). Nothing goes anywhere until the person picks one, and words
/// they leave there wait in the same list, with both.
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
        /// A dictation's words, on its page until the person sends or copies them.
        case review(String)
        /// The words now on the clipboard (a dictation's Copy).
        case copied(String)
        /// Nothing was sent; the sentence says why. `kept` = it is on the
        /// unsent list for a resend.
        case notSent(String, kept: Bool)
    }

    enum Outcome: Equatable {
        case listening
        case finishing
        /// A dictation's page is up: the press only brings it back.
        case reviewing
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
    /// The kept entry the dictation page shows.
    private(set) var reviewTake: String?
    /// The takes Walnut already offered in the unsent sheet, kept across launches (the
    /// sheet's own `@AppStorage` reads and writes the same key). A dictation's page the
    /// person closed with neither button joins them: it is in the list by their choice,
    /// so no launch offers it again as news.
    static let offeredKey = "walnut.talk.offeredUnsent"
    var closedPages: Set<String> {
        Set((prefs.string(forKey: Self.offeredKey) ?? "").split(separator: ",").map(String.init))
    }
    /// Retries a take that waits for the server while Walnut is in front (a seam for the
    /// unit tests): the person was told it goes by itself once the server answers again.
    @ObservationIgnored var retryLaterDelay: Duration = .seconds(30)
    @ObservationIgnored private var retryLater: Task<Void, Never>?
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
    /// Opens the CEO chat in Walnut once the page's Send got there, so the person sees
    /// their message and the answer (a seam for the unit tests).
    @ObservationIgnored var openCEOChat: @MainActor () -> Void = {
        ContentActionLink.shared.openChat(taskId: nil, sessionId: nil)
    }
    /// Brings up the dictation's page (a seam for the unit tests).
    @ObservationIgnored var presentReview: @MainActor () -> Void = { _ = TalkPanel.shared.show() }
    /// Automatic resends of one entry before only the person's Resend tries it.
    static let autoResendLimit = 8

    /// A kept take Walnut still sends by itself (the server was away and it has
    /// tries left): it waits, calmly. Anything else needs the person.
    /// A dictation never waits: it goes only where the person sends or copies it, and
    /// copied later by itself it would replace whatever they copied since.
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
        reopenUnseenPage()
    }

    /// Walnut came to the front: a dictation the person has not seen yet (its take ended
    /// from behind, then another take or iOS took its card) opens on its page.
    func reopenUnseenPageIfIdle() {
        guard !isBusy, !isReviewing else { return }
        reopenUnseenPage()
    }

    /// A dictation whose page the person never closed (iOS ended Walnut while it was up,
    /// or the take ended from behind and Walnut was gone by the time they came back): the
    /// next launch opens it on its page again, as a warm return does, never as a list.
    private func reopenUnseenPage() {
        let closed = closedPages
        guard let entry = outbox.unsent
            .filter({ Self.awaitsChoice($0) && !closed.contains($0.id) })
            .max(by: { $0.createdAt < $1.createdAt }),
            let text = entry.text
        else { return }
        reviewTake = entry.id
        destination = .dictation
        phase = .review(text)
        AppLog.info("talk", "dictation page reopened", ["chars": String(text.count)])
    }

    /// A kept take's words onto the clipboard, the take left as it was (it still goes to
    /// the CEO): with the server away, the person may want them somewhere else now.
    @discardableResult
    func copyWords(_ id: String) -> Bool {
        guard let text = outbox.entry(id)?.text else { return false }
        return copier(text)
    }

    /// A dictation's page is up, waiting for Send or Copy.
    var isReviewing: Bool {
        if case .review = phase { return true }
        return false
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
        case .review:
            // Walnut in front shows the page: a press there brings it back, never drops its
            // words for a new take. A page left unseen behind another app is no reason to
            // block the next press: its words are already in the list (Settings, Action
            // Button) with Send and Copy, and the press starts its take.
            if isForeground() {
                AppLog.info("talk", "press shows the dictation", ["source": source])
                presentReview()
                return .reviewing
            }
            AppLog.info("talk", "press sets the unseen dictation aside", ["source": source])
            closeReview(seen: false)
            try await start(source: source, to: destination)
            return .listening
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
        // launch: it must be listed as a dictation, never sent to the CEO by itself.
        prefs.set(destination == .dictation, forKey: Self.clipboardTakeKey)
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
    /// `send`: a kept dictation goes to the CEO chat (its Send) instead of the clipboard.
    @discardableResult
    func resend(_ id: String, send: Bool = false) async -> Bool {
        guard var entry = outbox.entry(id), !resending.contains(id) else { return false }
        if send, entry.copy == true {
            // The person picked Send: from now on it is a take for the CEO, kept as one.
            entry.copy = nil
            outbox.update(id) { $0.copy = nil }
        }
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
        let sent = entry.copy == true ? copyOut(entry) : await deliver(entry, live: false)
        if sent {
            lastResent = entry.text
            lastResentCopied = entry.copy == true
            // The words are on the clipboard: the audio they came from can go.
            if entry.copy == true, let recordingID = entry.recordingID { recorder.forget(recordingID: recordingID) }
        }
        return sent
    }

    func clearResentNotice() { lastResent = nil }

    // MARK: - The dictation's page

    /// The page's Send: the words, as the person left them, go to the CEO chat the way a
    /// take for it does (kept for a resend when they do not get there).
    func sendReview(_ words: String) async {
        guard isReviewing, Self.hasWords(words) else { return }
        // A take for the CEO now, under its own id (the card that said the words wait in
        // Walnut is the dictation's, and goes with it) and the dictation's message id, so a
        // send the server already has is not sent twice. With no kept entry (it could not
        // be saved), a new one: Send always sends.
        let kept = reviewTake.flatMap(outbox.entry)
        let entry = TalkOutbox.Entry(
            id: UUID().uuidString, messageId: kept?.messageId ?? SendRetryPolicy.newMessageId(),
            createdAt: kept?.createdAt ?? Date(), text: words, recordingID: nil, reason: nil, attempts: 0,
            updatedAt: Date(), copy: nil
        )
        destination = .ceo
        outbox.begin(entry)
        if let old = reviewTake {
            reviewTake = nil
            drop(old)
        }
        AppLog.info("talk", "dictation sent from its page", ["chars": String(words.count)])
        // A Send followed at once by leaving Walnut still finishes.
        let background = BackgroundWork.begin("talk-send")
        defer { background.end() }
        if await deliver(entry, live: true), isForeground() { openCEOChat() }
    }

    /// The page's Copy: the words, as the person left them, onto the clipboard. False when
    /// iOS did not take them: the page stays, with its words, for another try.
    @discardableResult
    func copyReview(_ words: String) -> Bool {
        guard isReviewing, Self.hasWords(words) else { return false }
        keepReviewWords(words)
        guard copy(words, live: true) else { return false }
        if let id = reviewTake { drop(id) }
        reviewTake = nil
        phase = .copied(words)
        cue(.sent)
        return true
    }

    /// The page's words as the person left them, onto the kept entry (Walnut is going to
    /// the background, the page closes): iOS may end Walnut before a Send or Copy.
    func keepReviewWords(_ words: String) {
        guard isReviewing, Self.hasWords(words) else { return }
        if let id = reviewTake, outbox.entry(id) != nil {
            outbox.update(id) { $0.text = words }
            return
        }
        // The first save failed (the disk was full): another try, so the words are not
        // lost with the page.
        let entry = newEntry(text: words, recordingID: nil, reason: TalkReason.notChosen, copy: true)
        if outbox.begin(entry) { reviewTake = entry.id }
    }

    /// The page closed with neither: the words stay in the list (Settings, Action Button),
    /// as the person last left them, with Send and Copy. `seen` is false when a press set
    /// aside a page the person never saw: that one is still news the next time Walnut opens.
    func closeReview(_ words: String? = nil, seen: Bool = true) {
        guard case .review(let heard) = phase else { return }
        keepReviewWords(words ?? heard)
        let kept = reviewTake.flatMap(outbox.entry) != nil
        if seen, let id = reviewTake {
            let offered = closedPages.union([id]).filter { outbox.entry($0) != nil }
            prefs.set(offered.sorted().joined(separator: ","), forKey: Self.offeredKey)
        }
        reviewTake = nil
        phase = .idle
        AppLog.info("talk", "dictation page closed", ["kept": String(kept), "seen": String(seen)])
    }

    /// A dictation whose words wait for the person's Send or Copy by their own choice (the
    /// page closed, or not reached yet): nothing went wrong, so the lists show it plainly.
    static func awaitsChoice(_ entry: TalkOutbox.Entry) -> Bool {
        entry.copy == true && entry.text != nil && entry.reason == TalkReason.notChosen
    }

    /// Words worth sending or copying: not only spaces and line breaks.
    static func hasWords(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

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
        // The page's words were sent, copied or deleted from the list: the page has nothing left.
        if id == reviewTake {
            reviewTake = nil
            if isReviewing { phase = .idle }
        }
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
        if destination == .dictation {
            completeDictation(take)
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

    /// A dictation: its words open on their page as heard, even one the 5-minute cap ended
    /// (nothing goes anywhere until the person sends or copies it).
    private func completeDictation(_ take: TalkTake) {
        switch take {
        case .words(let text, let recordingID):
            // In the list before the page shows: a process that dies on it leaves the words.
            let entry = newEntry(text: text, recordingID: recordingID, reason: TalkReason.notChosen, copy: true)
            // The audio goes once the words are safe on disk.
            if outbox.begin(entry), let recordingID {
                recorder.forget(recordingID: recordingID)
                outbox.update(entry.id) { $0.recordingID = nil }
            }
            reviewTake = entry.id
            phase = .review(text)
            cue(.sent)
            AppLog.info("talk", "dictation ready", ["chars": String(text.count)])
            // Walnut in front shows the page, and the card has nothing more to say. Behind
            // another app (the take was ended from there), the card says the words wait in
            // Walnut, and stays until they are sent or copied; tapping it opens Walnut.
            var ready = state(.sent, words: text)
            ready.take = entry.id
            activity.end(ready, linger: isForeground() ? 0 : notSentLinger)
            presentReview()
            // The server just transcribed it: what it missed before goes now.
            Task { await resendKept(source: "after-dictation") }
        case .noWords(let recordingID):
            if let recordingID { recorder.forget(recordingID: recordingID) }
            finishNotSent("Didn't catch any words, so there is nothing to send or copy.", kept: false, linger: 6, quiet: true)
        case .failed(let reason, let recordingID):
            let entry = newEntry(text: nil, recordingID: recordingID, reason: reason, attempts: 1, copy: true)
            let kept = recordingID != nil && outbox.begin(entry)
            finishNotSent(reason, kept: kept, linger: notSentLinger, take: entry.id)
        }
    }

    /// A kept dictation's Copy in the list: its words onto the clipboard, unchanged.
    @discardableResult
    private func copyOut(_ entry: TalkOutbox.Entry) -> Bool {
        guard let text = entry.text else { return false }
        guard copy(text, live: false) else {
            outbox.update(entry.id) {
                $0.reason = TalkReason.notCopied
                $0.attempts += 1
            }
            return false
        }
        drop(entry.id)
        return true
    }

    /// The one way words reach the clipboard, from the page (`live`) or the list.
    private func copy(_ text: String, live: Bool) -> Bool {
        let done = copier(text)
        if done {
            AppLog.info("talk", "copied", ["chars": String(text.count), "live": live ? "true" : "false"])
        } else {
            AppLog.warn("talk", "copy failed", ["live": live ? "true" : "false"])
        }
        return done
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
        // A dictation never goes out by itself: it waits for the person's Send or Copy.
        ending.later = kept && destination != .dictation && TalkReason.goesOutLater(reason)
        ending.quiet = quiet
        ending.take = kept ? take : nil
        activity.end(ending, linger: linger)
        if ending.later == true { retryWhileWaiting() }
    }

    /// While a take waits for the server and Walnut is in front, try again now and then
    /// (30 s, doubling to 5 minutes): the network may never have dropped (the server
    /// itself was away), so no path change would send it. Each try counts toward
    /// `autoResendLimit`, after which it is the person's to send.
    private func retryWhileWaiting() {
        guard retryLater == nil else { return }
        retryLater = Task { @MainActor [weak self] in
            var delay = self?.retryLaterDelay ?? .seconds(30)
            while !Task.isCancelled {
                try? await Task.sleep(for: delay)
                guard let self, !Task.isCancelled else { return }
                guard self.outbox.unsent.contains(where: Self.waits) else { break }
                if self.isForeground() { await self.resendKept(source: "retry-later") }
                delay = min(delay * 2, .seconds(300))
            }
            self?.retryLater = nil
        }
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
        let notice = destination == .dictation
            ? "Didn't hear anything, so there is nothing to send or copy." : "Didn't hear anything, so nothing was sent."
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
        // The take that died was a dictation: what it left waits for the person's Send or Copy.
        let copy = prefs.bool(forKey: Self.clipboardTakeKey)
        prefs.removeObject(forKey: Self.clipboardTakeKey)
        for id in recorder.keptTakeIDs() where !listed.contains(id) {
            // Dated by when it was recorded, not found: the time is how the
            // person tells one take from another.
            outbox.begin(newEntry(
                text: nil, recordingID: id,
                reason: copy ? "Walnut stopped before this dictation was ready." : "Walnut stopped before this recording was sent.",
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
        if destination == .dictation { content.copy = true }
        return content
    }

    /// Set while a dictation records or is transcribed.
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

/// The clipboard a dictation's Copy puts its words on.
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
