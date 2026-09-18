import XCTest
@testable import Walnut

/// The `bridge_offline` sentence, on every surface that can show it.
///
/// The regression this file prevents: a fixed client sentence that reads the same
/// whether the primary box blipped for two seconds or has been shut in a bag for
/// half an hour. The cloud replica now names the duration ("has been unreachable for
/// 6 minutes. It may be asleep (open the lid) or offline."), and that duration is the
/// only fact that tells the user to go open the lid. Session launch already forwarded
/// it; the three control ladders (session lifecycle, routines, session controls) threw
/// it away and printed a vague stand-in. They all read `BridgeOfflineCopy` now, so
/// this file pins both halves: the shared sentence behaves the same everywhere, and
/// the neighbouring per-surface wording did NOT get flattened along with it.
@MainActor
final class BridgeOfflineCopyTests: XCTestCase {

    /// What a current replica actually sends.
    private let durationSentence =
        "Your primary box (Mac) has been unreachable for 6 minutes. It may be asleep (open the lid) or offline."

    private func offlineError(_ message: String) -> APIError {
        .server(status: 503, code: "bridge_offline", message: message,
                serverHash: nil, serverContent: nil)
    }

    private func notFoundError() -> APIError {
        .server(status: 404, code: "not_found", message: "no such id",
                serverHash: nil, serverContent: nil)
    }

    // MARK: - The string helper

    /// The whole point of the change: the duration reaches the user byte for byte.
    /// Rewriting it client-side is what hid the only actionable fact in the failure.
    func testServerSentenceWithADurationRidesThroughUnchanged() {
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: durationSentence), durationSentence)
    }

    /// An older replica answers `bridge_offline` with nothing specific. The row must
    /// not go blank, so the fixed sentence stands in.
    func testEmptyMessageFallsBack() {
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: ""), BridgeOfflineCopy.fallback)
    }

    /// Whitespace is absence, not content: decide presence AFTER trimming, or a
    /// message of two spaces paints an error row with nothing in it.
    func testWhitespaceOnlyMessageFallsBack() {
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: "   "), BridgeOfflineCopy.fallback)
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: "\n\t "), BridgeOfflineCopy.fallback)
    }

    func testNilMessageFallsBack() {
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: nil), BridgeOfflineCopy.fallback)
    }

    /// Surrounding whitespace is noise, not absence: the content still shows, and the
    /// fallback must not trigger.
    func testSurroundingWhitespaceIsTrimmedWithoutFallingBack() {
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: "  unreachable for 6 minutes\n"),
                       "unreachable for 6 minutes")
        XCTAssertEqual(BridgeOfflineCopy.message(serverMessage: "\n\(durationSentence)  "),
                       durationSentence)
    }

    // MARK: - The APIError overload

    func testAPIErrorOverloadReadsTheServerSentence() {
        XCTAssertEqual(BridgeOfflineCopy.message(offlineError(durationSentence)), durationSentence)
    }

    func testAPIErrorOverloadFallsBackWhenTheServerSentNothing() {
        XCTAssertEqual(BridgeOfflineCopy.message(offlineError("")), BridgeOfflineCopy.fallback)
        XCTAssertEqual(BridgeOfflineCopy.message(offlineError("  ")), BridgeOfflineCopy.fallback)
    }

    /// The total-function guarantee: an error shape with no server payload at all
    /// still answers with a sentence, never an empty string.
    func testAPIErrorOverloadFallsBackForNonServerErrors() {
        XCTAssertEqual(BridgeOfflineCopy.message(APIError.badResponse), BridgeOfflineCopy.fallback)
        XCTAssertEqual(BridgeOfflineCopy.message(APIError.notConfigured), BridgeOfflineCopy.fallback)
        XCTAssertEqual(BridgeOfflineCopy.message(APIError.unauthorized), BridgeOfflineCopy.fallback)
    }

    // MARK: - The string itself

    /// Mirrors the server-side test that pins the same property on the sentence it
    /// generates: this text is read on a phone, where a dash renders as a smudge and
    /// reads worse than a full stop.
    func testFallbackUsesNoEmOrEnDash() {
        XCTAssertFalse(BridgeOfflineCopy.fallback.contains("\u{2014}"),
                       "em dash in shipped copy: \(BridgeOfflineCopy.fallback)")
        XCTAssertFalse(BridgeOfflineCopy.fallback.contains("\u{2013}"),
                       "en dash in shipped copy: \(BridgeOfflineCopy.fallback)")
    }

    // MARK: - All four ladders forward the duration

    /// The bug being fixed, one assertion per surface. Every ladder is static and
    /// pure, so this needs no view and no network.
    func testEveryLadderSurfacesTheServerSentence() {
        let error = offlineError(durationSentence)
        XCTAssertEqual(SessionLifecycleController.friendlyError(error), durationSentence,
                       "session lifecycle must not swallow the duration")
        XCTAssertEqual(RoutinesView.friendlyError(error), durationSentence,
                       "routines must not swallow the duration")
        XCTAssertEqual(SessionControlsSheet.friendlyControlError(error), durationSentence,
                       "session controls must not swallow the duration")
        XCTAssertEqual(NewSessionSheet.createErrorMessage(code: "bridge_offline",
                                                          serverMessage: durationSentence),
                       durationSentence,
                       "session launch must not swallow the duration")
    }

    /// A replica with nothing specific to say still gets a readable row on every
    /// surface, and it is the SAME row, which is why the literal is shared.
    func testEveryLadderFallsBackToTheOneSharedSentence() {
        let error = offlineError("")
        XCTAssertEqual(SessionLifecycleController.friendlyError(error), BridgeOfflineCopy.fallback)
        XCTAssertEqual(RoutinesView.friendlyError(error), BridgeOfflineCopy.fallback)
        XCTAssertEqual(SessionControlsSheet.friendlyControlError(error), BridgeOfflineCopy.fallback)
        XCTAssertEqual(NewSessionSheet.createErrorMessage(code: "bridge_offline", serverMessage: nil),
                       BridgeOfflineCopy.fallback)
    }

    // MARK: - The neighbouring branches stay per-surface

    /// Sharing ONE branch must not become an excuse to share the rest. `not_found`
    /// names the thing that vanished, and a routine is not a session: a refactor that
    /// flattened these into one generic sentence would make the answer worse.
    func testNotFoundKeepsItsSurfaceSpecificWording() {
        let gone = notFoundError()
        XCTAssertEqual(SessionLifecycleController.friendlyError(gone),
                       "This session no longer exists on the server.")
        XCTAssertEqual(SessionControlsSheet.friendlyControlError(gone),
                       "This session no longer exists on the server.")
        XCTAssertEqual(RoutinesView.friendlyError(gone),
                       "This routine no longer exists on the server.")
    }

    /// The upgrade branch is worded around what the caller was doing (session
    /// control vs routines), so the three answers stay distinct too.
    func testNeedsUpgradeKeepsItsSurfaceSpecificWording() {
        let upgrading = APIError.server(status: 400, code: "session_control_needs_upgrade",
                                        message: "daemon predates capability",
                                        serverHash: nil, serverContent: nil)
        let lifecycle = SessionLifecycleController.friendlyError(upgrading)
        let routines = RoutinesView.friendlyError(upgrading)
        let controls = SessionControlsSheet.friendlyControlError(upgrading)
        XCTAssertTrue(lifecycle.contains("session control"), lifecycle)
        XCTAssertTrue(routines.contains("routines"), routines)
        XCTAssertTrue(controls.contains("session control"), controls)
        XCTAssertNotEqual(routines, lifecycle, "routines copy must stay its own sentence")
    }
}
