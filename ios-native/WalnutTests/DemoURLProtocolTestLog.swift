import Foundation
@testable import Walnut

extension DemoURLProtocol {
    /// The blocked requests the code under test made. The hosted test app's own
    /// long-lived clients were built at launch against the test blackhole
    /// (`AppConfig.testBlackholeURL`) and keep retrying on their backoff; a retry
    /// that lands while a demo test runs is refused here too, and it is not the
    /// code under test (r5 unit run: the app's events feed retried inside
    /// `testEveryRouteTheAppCallsHasAnAnswer`). Any other host still counts.
    static var blockedByTheCodeUnderTest: [LoggedRequest] {
        blockedRequests.filter { $0.host != AppConfig.testBlackholeURL.host }
    }
}
