import AppIntents
import Foundation

/// Talk to Walnut: press the Action Button (or run the shortcut anywhere), say
/// something, and it goes to the CEO chat as your message.
///
/// It opens Walnut, already listening (`TalkPanel`). iOS starts no recording for
/// an app that is not on screen: a privacy rule only calling apps are exempt
/// from, `AudioRecordingIntent` notwithstanding. Build 160 recorded from the
/// background and every press on a phone was refused ('!int', shown as "Audio
/// is in use by another app"); the simulator enforces none of it. Running it
/// again while it listens sends at once. Locked, iOS first asks for Face ID:
/// these words are instructions to your agents, and a locked phone in someone
/// else's hand must not give them.
///
/// A plain `AppIntent`, no Live Activity: an `AudioRecordingIntent` exists to record
/// from the background, which iOS refuses anyway, and requires a Live Activity.
/// The take started in front keeps recording if the person leaves Walnut mid-take
/// (the audio background mode), with iOS's own microphone indicator.
struct TalkToWalnutIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Walnut"
    static let description = IntentDescription(
        "Say something and Walnut sends it to your CEO chat, as if you typed it there. Pause, or run it again, to send.",
        categoryName: "Walnut"
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    /// Before iOS 26: open Walnut for the take.
    static let openAppWhenRun = true
    /// iOS 26: Walnut comes forward at once, before the take starts.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    @MainActor
    func perform() async throws -> some IntentResult {
        let talk = TalkSession.shared
        // Recording that starts before Walnut is in front is refused the way build 160's was;
        // say what happened instead of "Audio is in use by another app".
        guard await talk.waitUntilInFront() else { throw TalkSession.StartError.notInFront }
        // A press while it listens sends: the panel is already up and says so.
        guard TalkPanel.shared.show() else {
            AppLog.warn("talk", "panel not shown", ["reason": "no-scene-in-front"])
            try await talk.toggle(source: "intent")
            return .result()
        }
        do {
            try await talk.toggle(source: "intent")
        } catch TalkSession.StartError.busy {
            // A quick second press while the first take opens the microphone or sends:
            // that take carries on, and the panel keeps showing it.
            AppLog.info("talk", "intent press ignored", ["reason": "busy"])
        } catch {
            // Said on the panel, which is on screen; an iOS alert on top would say it twice.
            AppLog.warn("talk", "intent start failed", ["error": error.localizedDescription])
            TalkPanel.shared.showError(error.localizedDescription)
        }
        return .result()
    }
}

/// Listed in the Shortcuts app, Spotlight and Siri with no setup, and offered
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
    }

    static let shortcutTileColor: ShortcutTileColor = .orange
}
