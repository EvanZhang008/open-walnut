import XCTest
@testable import Walnut

/// A passing notice keeps its normal time, and stays longer only for a UI-test launch of a debug build.
final class NoticeTimingTests: XCTestCase {
    private func defaults(uiTest: Bool) -> UserDefaults {
        let name = "notice-timing-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        if uiTest { d.set(true, forKey: "walnut.uiTestKeychain") }
        return d
    }

    func testANormalLaunchKeepsTheNormalTime() {
        XCTAssertEqual(NoticeTiming.seconds(2.5, defaults: defaults(uiTest: false)), 2.5)
    }

    func testAUITestLaunchHoldsTheNoticeLonger() {
        #if DEBUG
        XCTAssertEqual(NoticeTiming.seconds(2.5, defaults: defaults(uiTest: true)), 8)
        XCTAssertEqual(NoticeTiming.seconds(12, defaults: defaults(uiTest: true)), 12, "never shorter than asked")
        #else
        XCTAssertEqual(NoticeTiming.seconds(2.5, defaults: defaults(uiTest: true)), 2.5)
        #endif
    }
}
