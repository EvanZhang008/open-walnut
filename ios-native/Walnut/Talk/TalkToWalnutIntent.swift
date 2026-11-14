import AppIntents
import Foundation

/// Talk to Walnut: press the Action Button (or run the shortcut anywhere), say
/// something, and it goes to the CEO chat as your message.
///
/// The press records without opening Walnut: an `AudioRecordingIntent`, so iOS lets
/// it record from behind the app on screen (or the Lock Screen) while the take's
/// Live Activity shows, which `TalkSession.start` puts up before the microphone
/// opens. Build 160 opened the microphone first, and every press on a phone was
/// refused ('!int', shown as "Audio is in use by another app"); the simulator
/// enforces none of it. The Live Activity's Send, or a second press, sends.
///
/// When the take cannot start from behind (Live Activities off, the microphone
/// never allowed, iOS refusing it anyway) the press opens Walnut instead, already
/// listening on its Talk screen (`TalkPanel`), as build 161 did for every press, and
/// with the take's Live Activity up there too: AppIntents ends the process when an
/// AudioRecordingIntent leaves the microphone on without one.
/// Locked, iOS first asks for Face ID: these words are instructions to your
/// agents, and a locked phone in someone else's hand must not give them.
///
/// Also a `LiveActivityIntent`: only that lets a run that did not open Walnut start
/// the Live Activity ("not foreground" otherwise, and with none, no recording).
struct TalkToWalnutIntent: TalkPressIntent, AudioRecordingIntent, LiveActivityIntent, ForegroundContinuableIntent {
    static let title: LocalizedStringResource = "Talk to Walnut"
    static let description = IntentDescription(
        "Say something and Walnut sends it to your CEO chat, as if you typed it there. Tap Send, or run it again, to send.",
        categoryName: "Walnut"
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    /// Runs where it was pressed; Walnut comes forward only for the fallback.
    static let openAppWhenRun = false
    /// iOS 26: runs in the background, and may bring Walnut forward (the fallback).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
    static let destination: TalkDestination = .ceo

    @MainActor
    func perform() async throws -> some IntentResult {
        try await press()
        return .result()
    }
}

/// Dictate: the same take as Talk to Walnut, but its words open on one page, exactly as
/// heard, with Send (to the CEO chat) and Copy (to paste anywhere); nothing goes anywhere
/// before the person picks one (the user, 2026-11-11: "just one page that can send and can
/// copy"). The page needs Walnut in front, so the press opens Walnut and listens there.
/// Locked, iOS asks for Face ID first, as for Talk to Walnut.
///
/// The type keeps its first name: an Action Button set to it in iOS stays set across the
/// rename (iOS keeps the intent's type, not its title).
struct DictateToClipboardIntent: TalkPressIntent, AudioRecordingIntent, LiveActivityIntent, ForegroundContinuableIntent {
    static let title: LocalizedStringResource = "Dictate"
    static let description = IntentDescription(
        "Say something and Walnut shows your words on one page: send them to your CEO chat, or copy them to paste anywhere.",
        categoryName: "Walnut"
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    /// Walnut comes forward from `press`, after Face ID, as Talk to Walnut's fallback does.
    static let openAppWhenRun = false
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
    static let destination: TalkDestination = .dictation

    @MainActor
    func perform() async throws -> some IntentResult {
        try await press()
        return .result()
    }
}

/// One press of Talk to Walnut or Dictate: both run this, so the two can
/// never drift apart on the rules a real phone enforces (`ForegroundRecordingGuardTests`
/// reads this extension as part of each intent that conforms).
protocol TalkPressIntent: ForegroundContinuableIntent {
    /// Where a take this press starts delivers its words.
    static var destination: TalkDestination { get }
}

/// A press is bringing Walnut forward to listen there (Face ID, a cold launch), for
/// either intent: there is one take at a time.
@MainActor var talkPressOpening = false

extension TalkPressIntent {
    @MainActor
    func press() async throws {
        let talk = TalkSession.shared
        let destination = Self.destination
        // A second press while the first still brings Walnut forward ("nothing happened"):
        // the first starts the take; this one only shows the panel, never ends it.
        if talkPressOpening {
            AppLog.info("talk", "intent press ignored", ["reason": "opening-walnut"])
            if talk.inFront { TalkPanel.shared.show() }
            return
        }
        // A dictation's page left unseen behind another app: its words wait in the list, and
        // this press is a new take (a Talk to Walnut press still listens from behind).
        if talk.isReviewing, !talk.inFront {
            AppLog.info("talk", "press sets the unseen dictation aside", ["source": "intent"])
            talk.closeReview()
        }
        // A dictation's take ended from another app ends on its page: Walnut comes forward.
        if talk.phase == .listening, talk.destination == .dictation, !talk.inFront {
            talkPressOpening = true
            defer { talkPressOpening = false }
            try await openWalnut()
            _ = await talk.waitUntilInFront()
            try await Self.takeInFront(talk)
            return
        }
        // A press while a take listens finishes it, wherever it shows; one while it opens
        // the microphone or sends leaves that take alone.
        if talk.isBusy || talk.inFront {
            try await Self.takeInFront(talk)
            return
        }
        // A dictation ends on its page, and a dictation's page waits for Send or Copy:
        // only Walnut in front shows it, so both open Walnut. A take for the CEO listens
        // from behind.
        if destination == .ceo, !talk.isReviewing {
            do {
                try await talk.toggle(source: "intent", to: destination)
                return
            } catch let refused as TalkSession.StartError where TalkToWalnutIntent.opensWalnut(for: refused) {
                AppLog.info("talk", "listening in Walnut instead", ["reason": refused.localizedDescription])
            }
        } else {
            AppLog.info("talk", "opening Walnut", ["for": talk.isReviewing ? "dictation-page" : "dictation"])
        }
        talkPressOpening = true
        defer { talkPressOpening = false }
        try await openWalnut()
        // The take waits until Walnut is in front: from behind it was just refused.
        guard await talk.waitUntilInFront() else { throw TalkSession.StartError.notInFront }
        try await Self.takeInFront(talk)
    }

    /// Bring Walnut forward: on iOS 26 with no question first; before it iOS asks.
    @MainActor
    private func openWalnut() async throws {
        if #available(iOS 26.0, *) {
            try await continueInForeground(nil, alwaysConfirm: false)
        } else {
            try await requestToContinueInForeground()
        }
    }

    /// The take on Walnut's Talk screen (Walnut is in front).
    @MainActor
    private static func takeInFront(_ talk: TalkSession) async throws {
        // Live Activities off: a take touched inside this run would leave the microphone on
        // with no Live Activity when it returns, a fatal error in AppIntents. Walnut is in
        // front, so the take starts (or a listening one ends) once the run is over.
        if !talk.showsLiveActivity {
            AppLog.info("talk", "take moves after the run", ["reason": "no-live-activity"])
            TalkPanel.shared.show()
            Task { @MainActor in
                try? await Task.sleep(for: TalkToWalnutIntent.afterRun)
                await TalkToWalnutIntent.startAfterRun(talk, to: destination)
            }
            return
        }
        // A press while it listens finishes it: the panel is already up and says so.
        guard TalkPanel.shared.show() else {
            // Behind the app on screen: a take listening there is finished; one opening the
            // microphone or sending carries on, with nothing to say about it.
            do {
                try await talk.toggle(source: "intent", to: destination)
            } catch TalkSession.StartError.busy {
                AppLog.info("talk", "intent press ignored", ["reason": "busy-behind"])
            }
            return
        }
        do {
            try await talk.toggle(source: "intent", to: destination)
        } catch TalkSession.StartError.busy {
            // A quick second press while the first take opens the microphone or sends:
            // that take carries on, and the panel keeps showing it.
            AppLog.info("talk", "intent press ignored", ["reason": "busy"])
        } catch {
            // Said on the panel, which is on screen; an iOS alert on top would say it twice.
            AppLog.warn("talk", "intent start failed", ["error": error.localizedDescription])
            TalkPanel.shared.showError(error.localizedDescription)
        }
    }
}

extension TalkToWalnutIntent {
    /// The refusals the Talk screen fixes: everything but an unpaired iPhone and a
    /// microphone turned off in Settings, which opening Walnut does not change.
    static func opensWalnut(for refused: TalkSession.StartError) -> Bool {
        switch refused {
        case .needsFront, .micNotAsked: return true
        default: return false
        }
    }

    /// How long after the run a take with no Live Activity starts or ends.
    static let afterRun: Duration = .milliseconds(800)

    @MainActor
    static func startAfterRun(_ talk: TalkSession, to destination: TalkDestination = .ceo) async {
        do {
            try await talk.toggle(source: "intent-after-run", to: destination)
        } catch TalkSession.StartError.busy {
            AppLog.info("talk", "intent press ignored", ["reason": "busy"])
        } catch {
            AppLog.warn("talk", "intent start failed", ["error": error.localizedDescription])
            TalkPanel.shared.showError(error.localizedDescription)
        }
    }
}

/// Both listed in the Shortcuts app, Spotlight and Siri with no setup, and offered
/// by Settings, Action Button, Shortcut.
struct WalnutShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToWalnutIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Tell \(.applicationName)",
                "Message \(.applicationName)",
            ],
            shortTitle: "Talk to Walnut",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: DictateToClipboardIntent(),
            phrases: [
                "Dictate with \(.applicationName)",
                "Dictate to \(.applicationName)",
            ],
            shortTitle: "Dictate",
            systemImageName: "text.bubble"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .orange
}
