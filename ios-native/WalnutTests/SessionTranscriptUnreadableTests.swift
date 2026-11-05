import XCTest
@testable import Walnut

/// A transcript read that fails reads as "can't load", never as an empty session, unless the
/// server says there is no transcript (404).
@MainActor
final class SessionTranscriptUnreadableTests: XCTestCase {
    func testOnlyANotFoundReadsAsNoTranscript() {
        let missing = APIError.server(status: 404, code: "not_found", message: "", serverHash: nil, serverContent: nil)
        let unavailable = APIError.server(status: 503, code: "transcript_unavailable", message: "retry shortly", serverHash: nil, serverContent: nil)
        XCTAssertFalse(SessionConversationStore.isUnreadable(missing))
        XCTAssertTrue(SessionConversationStore.isUnreadable(unavailable))
        XCTAssertTrue(SessionConversationStore.isUnreadable(URLError(.notConnectedToInternet)))
    }
}
