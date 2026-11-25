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

    /// `after` takes the thing away once its time is up, and never once its task was cancelled.
    @MainActor
    func testAfterTakesItAwayUnlessCancelled() async {
        var shown = true
        var kept = true
        NoticeTiming.after(0.05) { shown = false }
        let cancelled = NoticeTiming.after(0.05) { kept = false }
        cancelled.cancel()
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertFalse(shown, "the notice stayed past its time")
        XCTAssertTrue(kept, "a cancelled take-away still ran")
    }
}
