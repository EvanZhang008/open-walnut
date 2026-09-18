import XCTest
@testable import Walnut

/// The copy a failed `POST /api/v1/sessions` puts in front of the user, per
/// server error code (`NewSessionSheet.createErrorMessage`).
///
/// The bug class: a fixed client sentence that reads the same no matter what the
/// server said. A user whose Mac was asleep behind a closed lid could not create a
/// session at all, and every attempt answered "the primary box isn't reachable
/// right now, try again when it reconnects". That is identical text whether the
/// box blipped for two seconds or had been shut for forty minutes. The one fact
/// that would have told them to open the lid is the duration, the server is the only
/// side that knows it, and the client used to throw its message away. So for
/// `bridge_offline` the server's sentence wins, while the fixed sentence stays for
/// an older replica that has nothing specific to say.
final class NewSessionCreateErrorCopyTests: XCTestCase {

    private func message(_ code: String, _ serverMessage: String?) -> String {
        NewSessionSheet.createErrorMessage(code: code, serverMessage: serverMessage)
    }

    /// The historical fixed sentence, still the fallback.
    private let genericOfflineCopy =
        "The primary box isn't reachable from the cloud right now — try again when it reconnects."

    // MARK: - bridge_offline prefers the server

    /// The whole point: a message that names how long the primary has been gone
    /// reaches the user unchanged. Rewriting it client-side is what hid the only
    /// actionable fact in the failure.
    func testBridgeOfflineSurfacesTheServerSentenceVerbatim() {
        let specific = "Your primary box has been unreachable for 41 minutes (it may be asleep or offline)"
        XCTAssertEqual(message("bridge_offline", specific), specific,
                       "the duration is the user's cue to go open the lid; it must not be rewritten")
    }

    /// A short generic sentence is still the server's answer, and still better
    /// than a client guess, so it rides through too.
    func testBridgeOfflinePrefersEvenAShortServerSentence() {
        XCTAssertEqual(message("bridge_offline", "Your primary box is offline"),
                       "Your primary box is offline")
    }

    // MARK: - bridge_offline falls back

    /// An older replica answers `bridge_offline` with no message at all. The
    /// screen must not go blank or show a stray space, so the fixed sentence
    /// stands in.
    func testBridgeOfflineFallsBackWhenTheMessageIsEmpty() {
        XCTAssertEqual(message("bridge_offline", ""), genericOfflineCopy)
    }

    /// Whitespace is absence, not content: decide presence AFTER trimming, or a
    /// message of two spaces paints an error row with nothing in it.
    func testBridgeOfflineFallsBackWhenTheMessageIsWhitespaceOnly() {
        XCTAssertEqual(message("bridge_offline", "   "), genericOfflineCopy)
        XCTAssertEqual(message("bridge_offline", "\n\t "), genericOfflineCopy)
    }

    func testBridgeOfflineFallsBackWhenTheMessageIsNil() {
        XCTAssertEqual(message("bridge_offline", nil), genericOfflineCopy)
    }

    /// Surrounding whitespace around real content is noise, not part of the
    /// sentence: the content still shows, and the fallback must not trigger.
    func testBridgeOfflineTrimsSurroundingWhitespaceAroundRealContent() {
        XCTAssertEqual(message("bridge_offline", "  unreachable for 6 minutes\n"),
                       "unreachable for 6 minutes")
    }

    // MARK: - the two upgrade codes keep their client copy

    /// These two stay client-written on purpose: the server's text for them is
    /// diagnostic, not something to show a person. A specific-looking server
    /// message must not change what they say.
    func testNotSupportedCloudIgnoresWhateverTheServerSaid() {
        let expected =
            "This cloud companion is too old to create sessions — update it, or connect directly to your primary box."
        XCTAssertEqual(message("not_supported_cloud", "session launch not supported in cloud mode"), expected)
        XCTAssertEqual(message("not_supported_cloud", ""), expected)
        XCTAssertEqual(message("not_supported_cloud", nil), expected)
    }

    func testSessionLaunchNeedsUpgradeIgnoresWhateverTheServerSaid() {
        let expected =
            "Your primary box's daemon needs an update for mobile session launch — it updates automatically on its next reconnect. Try again in a minute."
        XCTAssertEqual(message("session_launch_needs_upgrade", "daemon capability session.launch missing"), expected)
        XCTAssertEqual(message("session_launch_needs_upgrade", ""), expected)
        XCTAssertEqual(message("session_launch_needs_upgrade", nil), expected)
    }

    // MARK: - everything else

    /// Validation 4xx from the primary: its text IS the user-facing answer, and it
    /// arrives unchanged (an invented substitute would hide which field is wrong).
    func testUnknownCodeReturnsTheServerMessageVerbatim() {
        XCTAssertEqual(message("invalid_cwd", "cwd must be an absolute path"),
                       "cwd must be an absolute path")
        XCTAssertEqual(message("unknown_host", "Unknown host 'devbox'"), "Unknown host 'devbox'")
    }

    /// A code with no message and no client copy has nothing honest to say; an
    /// empty string is the caller's cue (it renders no error row) rather than a
    /// crash or a placeholder.
    func testUnknownCodeWithNoMessageIsEmpty() {
        XCTAssertEqual(message("some_new_code", nil), "")
        XCTAssertEqual(message("some_new_code", ""), "")
    }
}
