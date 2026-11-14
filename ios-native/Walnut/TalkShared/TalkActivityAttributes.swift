import ActivityKit
import AppIntents
import Foundation

/// Where a take's words go: the CEO chat (Talk to Walnut), or a page that shows them
/// first, with Send (to the CEO chat) and Copy (to paste anywhere): Dictate.
enum TalkDestination: String, Codable, Hashable {
    case ceo, dictation
}

/// The Live Activity a Talk to Walnut take shows on the Lock Screen and in the
/// Dynamic Island. Compiled into the app (which starts and updates it) and the
/// widget extension (which draws it), so both read the same shape.
///
/// iOS requires a recording started by an `AudioRecordingIntent` to show one
/// for as long as it records; it is also the light "sent" confirmation and the
/// place a failure is said, since no screen of Walnut is open.
struct TalkActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable {
            case listening, transcribing, sending, sent, failed
        }

        var phase: Phase
        /// When listening began, for the running clock.
        var startedAt: Date
        /// The words, once transcribed (shown short).
        var words: String?
        /// Why it was not sent (failed only).
        var reason: String?
        /// Whether the take waits in Walnut's Not Sent list (failed only). A
        /// take that was thrown away (no words heard) has nothing to resend.
        /// Nil, in a state written before this field, reads as kept.
        var kept: Bool?
        /// A kept take Walnut sends by itself once the server answers (the
        /// server was away): saved, not lost.
        var later: Bool?
        /// No words were heard: nothing went wrong, nothing was sent.
        var quiet: Bool?
        /// The kept take a failed card speaks of, so the card goes once that
        /// take is sent or deleted instead of saying it still waits.
        var take: String?
        /// A dictation (Dictate): its words go to the page that offers Send and Copy, not
        /// straight to the CEO chat. Nil, in a state written before this field, is the CEO.
        var copy: Bool?
    }
}

extension TalkActivityAttributes.ContentState {
    var title: String {
        switch phase {
        case .listening: return "Listening"
        case .transcribing: return "Getting your words"
        case .sending: return "Sending to your CEO"
        case .sent: return copy == true ? "Your words are ready" : "Sent to your CEO"
        case .failed:
            if later == true { return "Waiting to send" }
            if quiet == true { return "Nothing heard" }
            return copy == true ? "Couldn't get your words" : "Not sent"
        }
    }

    /// Only a take that did not go out and will not go by itself needs the
    /// person's attention: it alone sounds.
    var needsAttention: Bool { phase == .failed && later != true && quiet != true }

    var subtitle: String {
        switch phase {
        case .listening:
            return copy == true ? "Tap Done, or press the Action Button again" : "Tap Send, or press the Action Button again"
        case .transcribing, .sending: return words ?? "One moment"
        // A dictation's words wait on their page in Walnut.
        case .sent: return copy == true ? "Open Walnut to send or copy them." : (words ?? "")
        case .failed:
            let why = reason ?? "Something went wrong."
            if later == true { return why + " It sends the next time you open Walnut." }
            if kept == false { return why }
            return why + (copy == true ? " Open Walnut to try again." : " Open Walnut to resend it.")
        }
    }

    var symbol: String {
        switch phase {
        case .listening: return "waveform"
        case .transcribing, .sending: return "arrow.up.circle"
        case .sent: return copy == true ? "text.bubble.fill" : "checkmark.circle.fill"
        case .failed:
            if later == true { return "tray.and.arrow.up.fill" }
            if quiet == true { return "mic.slash" }
            return "exclamationmark.triangle.fill"
        }
    }
}

/// The Live Activity's Send button (Copy, for a take going to the clipboard): end the
/// take now and deliver it.
struct TalkSendNowIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Send to Walnut Now"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await TalkSession.shared.finishSoon(source: "activity-send")
        #endif
        return .result()
    }
}

/// The Live Activity's Cancel button: drop the take, send nothing.
struct TalkCancelIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Cancel Talk to Walnut"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await TalkSession.shared.cancel(source: "activity-cancel")
        #endif
        return .result()
    }
}
