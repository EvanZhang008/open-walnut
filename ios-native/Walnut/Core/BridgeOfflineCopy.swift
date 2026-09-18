import Foundation

/// The one sentence every surface shows when the cloud replica could not reach the
/// primary box (`bridge_offline`).
///
/// This is deliberately the ONLY branch lifted out of the four error ladders that
/// print it (`NewSessionSheet.createErrorMessage`,
/// `SessionLifecycleController.friendlyError`, `RoutinesView.friendlyError`,
/// `SessionControlsSheet.friendlyControlError`). Two things make it the odd one out:
/// its copy was already word for word identical in all four places, and it is the
/// only code where the server knows something this app cannot, namely how long the
/// primary has been unreachable ("Your primary box (Mac) has been unreachable for 6
/// minutes. It may be asleep (open the lid) or offline."). That duration is the
/// difference between a two second blip worth retrying and a laptop that has been
/// shut for half an hour, so it has to reach the user unchanged on every surface,
/// and the stand-in sentence has to live in exactly one place so the four surfaces
/// cannot drift apart again.
///
/// The neighbouring branches must NOT be folded in here. They are worded per
/// surface on purpose: `not_found` says "this session no longer exists" in the two
/// session ladders and "this routine no longer exists" in the routines ladder,
/// `session_control_needs_upgrade` names the capability the caller was actually
/// using, and `cron_owner` and `conflict` each belong to one screen. Merging them
/// would trade a precise answer for a vague one, which is the exact bug this file
/// exists to fix.
enum BridgeOfflineCopy {

    /// Stands in when the server sent nothing specific (an older replica that has
    /// no duration to report). Plain sentences, no dashes: this is read on a phone.
    static let fallback =
        "The primary box isn't reachable from the cloud right now. Try again when it reconnects."

    /// The server's own sentence when it sent one, the fixed sentence otherwise.
    ///
    /// Whitespace is absence, not content: presence is decided AFTER trimming, or a
    /// message of two spaces paints an error row with nothing in it. Real content
    /// keeps its text and loses only the surrounding noise.
    static func message(serverMessage: String?) -> String {
        let trimmed = (serverMessage ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    /// The same answer, read straight off the error's own `.server` payload.
    ///
    /// This destructures the case instead of reading `localizedDescription`. For
    /// `.server` the two hold the same string today, but `errorDescription` is
    /// presentation code that already decorates other cases (`.network` replaces
    /// Apple's raw TLS text), so a later change there could silently start painting
    /// decorated text into this row. Any error that is not `.server` carries no
    /// server sentence at all, which is exactly the fallback.
    static func message(_ error: APIError) -> String {
        guard case .server(_, _, let sentence, _, _) = error else { return fallback }
        return message(serverMessage: sentence)
    }
}
