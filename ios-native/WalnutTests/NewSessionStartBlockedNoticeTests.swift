import XCTest
@testable import Walnut

/// THE SHEET MUST SAY THAT START WILL FAIL, BEFORE THE PROMPT IS TYPED.
///
/// The 2026-09-17 report: a user tried to create a session on a remote host from
/// the phone and it failed every attempt, while messages to an already-running
/// session kept working. Their laptop was asleep with the lid shut, and sessions
/// are created ON that box. What made it maddening rather than merely broken is
/// that the New Session sheet looked completely normal: hosts and recent paths
/// are restored from a disk cache on purpose, so the form painted, the launch
/// options fetch failed, and the failure was dropped on the floor (`if options ==
/// nil`). The host, the path and a whole first message were typed before the app
/// admitted anything was wrong.
///
/// So the sheet has three states, not two, and these cases pin which one each
/// failure produces. The decision is a pure static function precisely so it can be
/// judged here, with no network and no view.
final class NewSessionStartBlockedNoticeTests: XCTestCase {

    /// What a current server sends for `bridge_offline`: the duration is the whole
    /// point of it, and it is the one fact the app cannot work out for itself.
    private let offlineSentence =
        "Your primary box (Mac) has been unreachable for 41 minutes. "
        + "It may be asleep (open the lid) or offline."

    private func verdict(
        code: String = "bridge_offline", message: String? = nil, hasOptions: Bool
    ) -> NewSessionSheet.LaunchOptionsFailure {
        NewSessionSheet.launchOptionsFailure(
            code: code, serverMessage: message, hasOptions: hasOptions
        )
    }

    // MARK: - The state the incident actually produced

    /// A cached host list means the form works. It must keep working, AND it must
    /// carry the warning: this is the case the old code had no state for.
    func testBridgeOfflineWithCachedOptionsWarnsWithoutReplacingTheForm() {
        let result = verdict(message: offlineSentence, hasOptions: true)
        XCTAssertNil(result.blocking,
                     "a usable form must not be replaced — every field below still does its job")
        XCTAssertEqual(result.warning, offlineSentence,
                       "the server's sentence rides verbatim: it carries how long the box has been gone")
    }

    /// The pre-existing behaviour, unchanged: with nothing on screen there is no
    /// form to annotate, so the sheet still degrades to the unavailable section.
    func testBridgeOfflineWithNothingCachedStillBlocksTheSheet() {
        let result = verdict(message: offlineSentence, hasOptions: false)
        XCTAssertEqual(result.blocking, offlineSentence,
                       "an empty sheet degrades to the retryable unavailable section, as before")
        XCTAssertNotNil(result.warning,
                        "the warning is decided regardless of the cache; the body picks which one shows")
    }

    // MARK: - Copy that survives a server with nothing to say

    /// An older replica sends no sentence. The user still has to read something
    /// that names the problem and the remedy.
    func testMissingOrEmptyServerMessageStillReadsAsAnAnswer() {
        for message in [nil, "", "   \n "] as [String?] {
            for hasOptions in [true, false] {
                let result = verdict(message: message, hasOptions: hasOptions)
                let shown = (hasOptions ? result.warning : result.blocking) ?? ""
                XCTAssertFalse(shown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                               "empty server message left a blank notice (hasOptions: \(hasOptions))")
                XCTAssertTrue(shown.lowercased().contains("reachable"),
                              "fallback copy must still name the problem, got: \(shown)")
            }
        }
    }

    // MARK: - The two codes that mean "Start cannot work"

    /// `session_launch_needs_upgrade` warns too: the cloud relay serves the options
    /// fetch and the launch through the same bridge command, so a daemon too old to
    /// answer one is too old to answer the other. Its copy stays CLIENT-side though
    /// — the server text for that code is diagnostic, not something to read on a
    /// phone.
    func testUpgradeCodeWarnsWithClientCopyRatherThanServerDiagnostics() {
        let diagnostic = "session.launch: unknown command (daemon build 41)"
        let result = verdict(code: "session_launch_needs_upgrade", message: diagnostic, hasOptions: true)
        XCTAssertNil(result.blocking)
        let warning = result.warning ?? ""
        XCTAssertFalse(warning.contains("unknown command"),
                       "diagnostic server text must not reach the user, got: \(warning)")
        XCTAssertTrue(warning.lowercased().contains("update"),
                      "upgrade copy must say what fixes it, got: \(warning)")
    }

    /// The pre-flight warning and the post-Start error describe the same fact, so
    /// they must not read like two different problems. Shared ladder, one answer.
    func testWarningSaysExactlyWhatStartWouldHaveSaid() {
        for code in ["bridge_offline", "session_launch_needs_upgrade"] {
            for message in [offlineSentence, ""] {
                XCTAssertEqual(
                    verdict(code: code, message: message, hasOptions: true).warning,
                    NewSessionSheet.createErrorMessage(code: code, serverMessage: message),
                    "warning and create error diverged for \(code)"
                )
            }
        }
    }

    // MARK: - Rules that only exist in the view, read as text

    /// Both of these are about WHERE an assignment sits in `loadOptions()`, which
    /// no value-level test can see. Same approach as `UITestLaunchRatchetTests`:
    /// read the source with `//` comments stripped, so a rule can never be
    /// satisfied by prose that merely describes it.
    private func loadOptionsSource() throws -> String {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
            .appendingPathComponent("Walnut/Views/Sessions/NewSessionSheet.swift")
        let text = try String(contentsOf: file, encoding: .utf8)
        let code = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let slashes = line.range(of: "//") else { return String(line) }
                return String(line[..<slashes.lowerBound])
            }
            .joined(separator: "\n")
        guard let start = code.range(of: "private func loadOptions() async {"),
              let end = code.range(of: "private func apply(", range: start.upperBound..<code.endIndex)
        else {
            XCTFail("could not locate loadOptions() in \(file.path)")
            return ""
        }
        return String(code[start.lowerBound..<end.lowerBound])
    }

    /// A sheet reopened after the box wakes must be clean, and so must one whose
    /// Check again / Retry succeeded. The clear therefore belongs to the SUCCESS
    /// branch of the fetch, which every one of those paths runs, and not to the top
    /// of `loadOptions()` where it would blink off and on while the link is down.
    func testWarningIsClearedOnEverySuccessfulFetchNotJustFirstOpen() throws {
        let source = try loadOptionsSource()
        guard let fetch = source.range(of: "try await api.sessionLaunchOptions()"),
              let firstCatch = source.range(of: "} catch", range: fetch.upperBound..<source.endIndex)
        else { return XCTFail("loadOptions() no longer fetches then catches") }
        let successBranch = source[fetch.upperBound..<firstCatch.lowerBound]
        XCTAssertTrue(successBranch.contains("startBlockedReason = nil"),
                      "the warning is not cleared where a good fetch lands")
        let beforeFetch = source[source.startIndex..<fetch.lowerBound]
        XCTAssertFalse(beforeFetch.contains("startBlockedReason = nil"),
                       "clearing before the fetch makes the warning blink on every refresh")
    }

    /// The failure must be recorded whether or not a cached list is on screen —
    /// gating it on `options == nil` is the original defect, and it reads as a
    /// perfectly reasonable line of code, which is why it needs a ratchet.
    func testRelayFailureIsRecordedEvenWhenCachedOptionsExist() throws {
        let source = try loadOptionsSource()
        guard let branch = source.range(of: "code == \"session_launch_needs_upgrade\" || code == \"bridge_offline\""),
              let nextCatch = source.range(of: "} catch", range: branch.upperBound..<source.endIndex)
        else { return XCTFail("the relay-failure catch branch is no longer recognisable") }
        let body = source[branch.upperBound..<nextCatch.lowerBound]
        XCTAssertTrue(body.contains("startBlockedReason ="),
                      "the relay failure no longer produces a warning")
        XCTAssertFalse(body.contains("if options == nil"),
                       "the warning is gated on an empty sheet again — that is the reported bug")
    }
}
