import AppIntents
import Foundation

/// Talk to Walnut: press the Action Button (or run the shortcut anywhere), say
/// something, and it goes to the CEO chat as your message.
///
/// An `AudioRecordingIntent`, so iOS lets Walnut record without opening it,
/// from the Lock Screen too, while its Live Activity shows. Running it again
/// while it listens sends at once. Locked, iOS first asks for Face ID: these
/// words are instructions to your agents, and a locked phone in someone else's
/// hand must not give them.
///
/// Also a `LiveActivityIntent`: only that lets a run that did not open Walnut
/// start the Live Activity. With `AudioRecordingIntent` alone iOS refuses the
/// request ("not foreground"), and with no Live Activity there is no recording.
struct TalkToWalnutIntent: AudioRecordingIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Talk to Walnut"
    static let description = IntentDescription(
        "Say something and Walnut sends it to your CEO chat, as if you typed it there. Pause, or run it again, to send.",
        categoryName: "Walnut"
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult {
        try await TalkSession.shared.toggle(source: "intent")
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
