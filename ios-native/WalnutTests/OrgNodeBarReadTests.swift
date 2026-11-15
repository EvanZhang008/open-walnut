import XCTest
@testable import Walnut

/// An Org node's chat learns it is one (and shows its Threads, Tasks and Brief bar) from its task,
/// read by id when the list leaves the task out, as it does Main's. That read is tried again while
/// the page is up: one read that failed on a loaded phone left Main's chat without its bar for as
/// long as it stayed open (2026-11-15, CI). It stops when reading again cannot help, and after a
/// few reads.
final class OrgNodeBarReadTests: XCTestCase {
    private func delay(_ error: Error, _ failures: Int = 1) -> TimeInterval? {
        SessionConversationView.linkedTaskRetryDelay(after: error, failures: failures)
    }

    private func server(_ status: Int) -> APIError {
        .server(status: status, code: "x", message: "x", serverHash: nil, serverContent: nil)
    }

    func testAReadThatCouldNotReachTheServerIsTriedAgainSoonerFirstThenSlower() {
        let offline = APIError.network(underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        XCTAssertEqual(delay(offline, 1), 1)
        XCTAssertEqual(delay(offline, 2), 2)
        XCTAssertEqual(delay(offline, 3), 4)
        XCTAssertEqual(delay(offline, 5), 15, "never slower than every 15 s")
        XCTAssertNil(delay(offline, SessionConversationView.linkedTaskReadLimit), "it gives up after a few reads")
        XCTAssertEqual(delay(server(503)), 1, "a server that is starting")
        XCTAssertEqual(delay(server(500)), 1)
        XCTAssertEqual(delay(server(429)), 1)
    }

    func testAReadThatCannotHelpIsNotTriedAgain() {
        XCTAssertNil(delay(CancellationError()), "the page went away")
        XCTAssertNil(delay(APIError.cancelled))
        XCTAssertNil(delay(APIError.unauthorized))
        XCTAssertNil(delay(APIError.notConfigured))
        XCTAssertNil(delay(APIError.badResponse), "an answer that is not a task reads the same next time")
        XCTAssertNil(delay(server(404)), "the task is not there")
        XCTAssertNil(delay(server(403)))
    }
}
