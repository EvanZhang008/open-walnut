import XCTest

/// Press a button inside an html-app island, and read what its page shows, without
/// mistaking WebKit's two quiet failures for the island's.
///
/// 1. A tap that reaches a web view does not always reach the page. WebKit drops a
///    synthetic click whose touch began before the app had the page's first layer tree
///    commit after the load (`WebPage::attemptSyntheticClick`), and a web content
///    process that restarts takes the tap with it. So a press the page plainly did not
///    take (the next step absent, the same button still there) is tapped again.
/// 2. The page can be drawn while the web view lists none of it: WebKit links a web
///    view's accessibility tree to its page only while the web process is running
///    (`-[WKContentView _accessibilityRegisterUIProcessTokens]`), and a link that missed
///    that moment leaves the web view an empty text view to XCUITest. 2026-11-02 on the
///    lane B simulator: the quiz drew "Quiz done: 3 of 3 right" after a relaunch and the
///    web view held no text for the whole 30 s wait. That is `unreadable`, never a
///    reason to tap; the caller relaunches, and the island comes back from its saved
///    state, which is what these tests check anyway.
///
/// Neither covers a wrong page: a page that took two taps shows another step than the
/// test expects (another question, another count), and that fails where it is checked.
/// 2026-11-02, CI: the quiz's "Answer 4" was tapped once and "Question 2 of 3" never
/// appeared in the 30 s the test waited, though the page shows it within a second of a
/// tap it took. Either failure explains that.
enum IslandTap {
    enum Outcome { case shown, notShown, unreadable }

    /// Seconds a page gets to show the next step after a tap it took. On the simulator
    /// and on CI the step is listed at the first one-second poll after the tap; this is
    /// ten times that, so a slow page is waited for rather than tapped twice.
    static let settle: TimeInterval = 10

    static func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }

    /// The web view is there and lists nothing of its page (see 2 above). An island
    /// page always has text: a question, a count, a button's label.
    static func unreadable(_ app: XCUIApplication) -> Bool {
        let webView = app.webViews.firstMatch
        return webView.exists && webView.staticTexts.count == 0 && webView.buttons.count == 0
    }

    /// Wait for `value` on the page; `unreadable` when the web view lists no text.
    static func read(_ value: String, in app: XCUIApplication, timeout: TimeInterval) -> Outcome {
        if text(app, value).waitForExistence(timeout: timeout) { return .shown }
        return unreadable(app) ? .unreadable : .notShown
    }

    /// Tap `label` until the page shows `next`, up to `attempts` taps, each one the page
    /// did not take recorded with a screenshot.
    @MainActor
    static func press(_ label: String, in app: XCUIApplication, until next: String,
                      test: XCTestCase, attempts: Int = 3) -> Outcome {
        let button = app.webViews.buttons[label]
        for attempt in 1...attempts {
            guard button.waitForExistence(timeout: 15) else {
                return read(next, in: app, timeout: 1)
            }
            button.tap()
            let outcome = read(next, in: app, timeout: settle)
            guard outcome == .notShown else { return outcome }
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "tap-not-taken-\(label)-\(attempt)"
            shot.lifetime = .keepAlways
            test.add(shot)
        }
        return read(next, in: app, timeout: settle)
    }
}
