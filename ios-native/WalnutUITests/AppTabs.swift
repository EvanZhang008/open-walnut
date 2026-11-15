import XCTest

/// The app's five tabs (`MainTabView`), found in the tab bar and nowhere else.
///
/// A tab's name is not unique on screen: Main's chat has a Tasks button on its Threads, Tasks and
/// Brief bar, and the Tasks page's drawer button reads "Tasks". A query on the whole app for the
/// name (`buttons["Tasks"]`) matched the tab and the bar both whenever Main's chat was on screen,
/// and the tap failed on "Multiple matching elements found" (2026-11-15, CI: WatchingTierUITests
/// right after ViewMemoryUITests, whose Main's chat the Chat tab reopened at the next launch).
/// `tests/web/ios-ui-test-tab-query-guard.test.ts` fails on a tab looked up by its name again.
enum AppTab: String, CaseIterable {
    case chat = "Chat"
    case inbox = "Inbox"
    case notes = "Notes"
    case tasks = "Tasks"
    case settings = "Settings"
}

extension XCUIApplication {
    /// The tab bar's button for `tab`.
    func tab(_ tab: AppTab) -> XCUIElement {
        tabBars.buttons[tab.rawValue]
    }
}
