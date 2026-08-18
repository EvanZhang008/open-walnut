import AVFoundation
import Foundation

/// Why an `AVAudioSession` activation failed, in terms a person can act on.
///
/// This exists as its own pure type for one reason: the interesting logic (which
/// OSStatus means "a phone call is holding the mic" versus "our own category
/// config is illegal") is precisely the part a unit test CAN cover, while
/// `AVAudioSession` itself cannot be driven from a test at all. The simulator
/// implements no audio arbitration, so every code handled here is unreachable
/// there and only ever shows up on a real device. Keeping the mapping pure is
/// how we get to assert on it without a microphone.
///
/// Field incident 2026-08-18 (build 45): two mic presses one second apart both
/// failed with OSStatus 561017449 and the user saw an opaque "Recording failed:
/// NSOSStatusErrorDomain 561017449 …". 561017449 is FourCC `'!pri'` =
/// `insufficientPriority`, which per the SDK header means "the app was not
/// allowed to set the audio category because another app (Phone, etc.) is
/// controlling it". Nothing the app does can win that arbitration; the only
/// useful response is to say so plainly.
struct VoiceSessionDiagnosis: Equatable {
    /// Stable short label for the structured log. A field recurrence then says
    /// WHICH branch ran instead of leaving us to decode an OSStatus by hand,
    /// and it distinguishes this (post-fix) path from the old opaque one.
    let reason: String

    /// User-facing sentence. Never contains a domain, an OSStatus, or the word
    /// "error" — the exception is `.unknown`, where the raw diagnostic really is
    /// the most useful thing we can say.
    let message: String

    /// Could waiting a moment and activating again plausibly succeed? True for
    /// contention that ends on its own (a call hanging up, Siri finishing);
    /// false for "the hardware isn't there" and for our own config bugs.
    let retryable: Bool

    /// Should the next attempt drop to the barest legal category config? True
    /// only for errors that say "you passed something this device rejected",
    /// where re-trying the SAME options is pointless but a simpler shape may
    /// work. Distinct from `retryable`: this one needs no wait, just a change.
    let tryBareConfig: Bool

    // MARK: - Classification

    /// Map an activation failure to advice. Anything outside
    /// `NSOSStatusErrorDomain` (or an unrecognized status) falls through to
    /// `.unknown`, which keeps the raw diagnostic visible rather than inventing
    /// a reassuring sentence for a failure we do not understand.
    static func classify(_ error: NSError) -> VoiceSessionDiagnosis {
        guard error.domain == NSOSStatusErrorDomain else { return unknown(error) }
        switch error.code {
        // '!pri' — another app (Phone, FaceTime, CarPlay) owns the audio
        // category. The 2026-08-18 field failure. Retrying inside one tap
        // cannot win this, so the message has to carry the whole fix.
        case AVAudioSession.ErrorCode.insufficientPriority.rawValue:
            return .init(
                reason: "insufficient-priority",
                message: "Another app is using audio (a call?) — end it and try again",
                retryable: true,
                tryBareConfig: false
            )

        // '!int' — a non-mixable session going active from the BACKGROUND.
        // `.record` is inherently non-mixable, so this is what a quick action
        // that fires before the app is actually in front looks like.
        case AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue:
            return .init(
                reason: "cannot-interrupt-others",
                message: "Audio is in use by another app — open Walnut and try again",
                retryable: true,
                tryBareConfig: false
            )

        // 'siri' — Siri is holding the mic. Ends by itself in a second or two.
        case AVAudioSession.ErrorCode.siriIsRecording.rawValue:
            return .init(
                reason: "siri-recording",
                message: "Siri is listening — wait a moment and try again",
                retryable: true,
                tryBareConfig: false
            )

        // '!act' — session still running I/O. Genuinely transient: our own
        // teardown racing our setup.
        case AVAudioSession.ErrorCode.isBusy.rawValue:
            return .init(
                reason: "busy",
                message: "The microphone was busy — try again",
                retryable: true,
                tryBareConfig: false
            )

        // '!rec' — not allowed to start recording (a mixable record started
        // from the background). Same user-visible shape as the background case.
        case AVAudioSession.ErrorCode.cannotStartRecording.rawValue:
            return .init(
                reason: "cannot-start-recording",
                message: "Recording can't start right now — open Walnut and try again",
                retryable: true,
                tryBareConfig: false
            )

        // 'msrv' — the audio system was reset underneath us. A rebuild often
        // works, which is exactly what a retry does here.
        case AVAudioSession.ErrorCode.mediaServicesFailed.rawValue:
            return .init(
                reason: "media-services-failed",
                message: "Audio restarted on this device — try again",
                retryable: true,
                tryBareConfig: false
            )

        // '!res' — no input hardware. Waiting changes nothing.
        case AVAudioSession.ErrorCode.resourceNotAvailable.rawValue:
            return .init(
                reason: "resource-unavailable",
                message: "No microphone is available on this device",
                retryable: false,
                tryBareConfig: false
            )

        // -50 — WE passed something illegal. The -50 minefield documented on
        // `activateSession()`. Retrying identically is pointless; the barest
        // legal config is the one thing worth trying.
        case AVAudioSession.ErrorCode.badParam.rawValue:
            return .init(
                reason: "bad-param",
                message: "Recording couldn't start on this device — try again",
                retryable: false,
                tryBareConfig: true
            )

        // '!cat' — the category doesn't support what we asked of it. Same
        // shape as -50: change the request, don't repeat it.
        case AVAudioSession.ErrorCode.incompatibleCategory.rawValue:
            return .init(
                reason: "incompatible-category",
                message: "Recording couldn't start on this device — try again",
                retryable: false,
                tryBareConfig: true
            )

        default:
            return unknown(error)
        }
    }

    /// The fallback. Keeps domain + code in the sentence on purpose: an
    /// unrecognized failure is exactly the case where the user's screenshot is
    /// our only evidence, and a friendly-but-empty message would destroy it.
    private static func unknown(_ error: NSError) -> VoiceSessionDiagnosis {
        .init(
            reason: "unclassified",
            message: "Recording failed: \(error.domain) \(error.code) — \(error.localizedDescription)",
            retryable: false,
            tryBareConfig: true
        )
    }

    // MARK: - Retry cadence

    /// How long to wait before re-activating after a retryable failure.
    ///
    /// Two waits, not one: the old code slept 150ms after the FIRST failure
    /// only, then fired its remaining attempts back to back with no delay,
    /// so all three activations landed inside ~150ms. Against real audio
    /// arbitration (a call being answered, Siri winding down) that is far too
    /// tight to be a retry at all. The budget is deliberately bounded: the
    /// delays are paid only on the failing path, and 800ms before an honest
    /// message beats 150ms before a wrong one.
    static let backoffMs: [Int] = [300, 500]

    /// Milliseconds to wait after failure number `attempt` (0-based), or nil
    /// when the attempts are spent and the caller should give up and report.
    static func backoff(afterAttempt attempt: Int) -> Int? {
        attempt >= 0 && attempt < backoffMs.count ? backoffMs[attempt] : nil
    }

    /// Total activation attempts one `start()` may make.
    static var maxAttempts: Int { backoffMs.count + 1 }

    // MARK: - Log helpers

    /// Render an OSStatus as its FourCC when it is printable ASCII.
    ///
    /// Purely a diagnostic nicety, and a big one: `561017449` is unreadable,
    /// `'!pri'` is instantly greppable against the SDK's enum table. Codes that
    /// aren't four printable bytes (notably -50) return nil rather than mojibake.
    static func fourCC(_ code: Int) -> String? {
        guard code > 0, code <= 0xFFFF_FFFF else { return nil }
        var chars = ""
        for shift in [24, 16, 8, 0] {
            let byte = (code >> shift) & 0xFF
            guard byte >= 32, byte < 127 else { return nil }
            chars.append(Character(UnicodeScalar(UInt8(byte))))
        }
        return chars
    }
}

/// An activation failure that has already been classified, carrying the trail
/// (`attempts`, which call threw) so `start()` logs the whole story in one line.
struct VoiceSessionActivationFailure: Error {
    let underlying: NSError
    let diagnosis: VoiceSessionDiagnosis
    /// How many activation attempts were made before giving up (1-based).
    let attempts: Int
    /// Which call threw: `set-category` or `set-active`. These fail for
    /// different reasons (arbitration versus an illegal option combo) and the
    /// old log could not tell them apart.
    let stage: String
}
