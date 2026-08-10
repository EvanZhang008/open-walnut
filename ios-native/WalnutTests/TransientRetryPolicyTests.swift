import XCTest
@testable import Walnut

/// Policy tests for the one-shot transient retry in WalnutAPI.perform.
/// Field incident 2026-08-09: two isolated NSURLErrorSecureConnectionFailed
/// (-1200) on POSTs right after background→foreground transitions surfaced
/// Apple's raw "A TLS error…" to the user with no retry. The policy below is
/// pure (no network) so the safety boundaries stay pinned:
///  - -1200 retries for ANY method (handshake failed ⇒ body never sent)
///  - -1001/-1005 retry only for GET or explicitly retry-safe endpoints
///    (they can fire AFTER the body reached the server ⇒ double-send risk)
///  - everything else never auto-retries
final class TransientRetryPolicyTests: XCTestCase {

    // MARK: -1200 TLS handshake failure — safe for every method

    func testTLSHandshakeFailureRetriesPOST() {
        XCTAssertTrue(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorSecureConnectionFailed, method: "POST", retrySafe: false
        ))
    }

    func testTLSHandshakeFailureRetriesGET() {
        XCTAssertTrue(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorSecureConnectionFailed, method: "GET", retrySafe: false
        ))
    }

    // MARK: -1001 / -1005 — only idempotent or explicitly retry-safe

    func testTimeoutRetriesGETButNotPOST() {
        XCTAssertTrue(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorTimedOut, method: "GET", retrySafe: false
        ))
        XCTAssertFalse(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorTimedOut, method: "POST", retrySafe: false
        ))
    }

    func testConnectionLostRetriesGETButNotPOST() {
        XCTAssertTrue(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorNetworkConnectionLost, method: "get", retrySafe: false
        ))
        XCTAssertFalse(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorNetworkConnectionLost, method: "POST", retrySafe: false
        ))
    }

    func testRetrySafeOverrideAllowsPOSTTimeout() {
        XCTAssertTrue(WalnutAPI.shouldRetryTransient(
            errorCode: NSURLErrorTimedOut, method: "POST", retrySafe: true
        ))
    }

    // MARK: everything else stays single-shot

    func testNonTransientCodesNeverRetry() {
        for code in [
            NSURLErrorCancelled,
            NSURLErrorNotConnectedToInternet,
            NSURLErrorCannotFindHost,
            NSURLErrorServerCertificateUntrusted, // real cert problem ≠ transient
            NSURLErrorBadServerResponse,
        ] {
            XCTAssertFalse(
                WalnutAPI.shouldRetryTransient(errorCode: code, method: "GET", retrySafe: true),
                "code \(code) must not auto-retry"
            )
        }
    }

    // MARK: user-facing copy — no raw Apple TLS text after a double failure

    func testTransientNetworkErrorCopyIsHumanReadable() {
        let tlsError = NSError(
            domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed,
            userInfo: [NSLocalizedDescriptionKey: "A TLS error caused the secure connection to fail."]
        )
        let message = APIError.network(underlying: tlsError).errorDescription ?? ""
        XCTAssertFalse(message.contains("TLS"), "raw TLS jargon must not reach the user")
        XCTAssertTrue(message.lowercased().contains("try again"))
    }

    func testNonTransientNetworkErrorKeepsSystemDescription() {
        let offline = NSError(
            domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet,
            userInfo: [NSLocalizedDescriptionKey: "The Internet connection appears to be offline."]
        )
        let message = APIError.network(underlying: offline).errorDescription ?? ""
        XCTAssertTrue(message.contains("offline"))
    }
}
