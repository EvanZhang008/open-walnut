import Foundation

/// How long a passing notice ("Copied", "Sent") stays on screen.
///
/// A person reads it in a couple of seconds. A UI test on a busy CI simulator does not: XCUITest's
/// tap returns only once the app is idle, which took 3 s there, so a 2.5 s notice was gone before
/// the test could look (2026-11-16, CI on iOS 26.5: SessionChangesUITests "Copy said nothing").
/// In a debug build launched by the UI tests (`-walnut.uiTestKeychain`, UITestLaunch) a notice
/// stays a few seconds longer; release builds and every other launch keep the normal time.
enum NoticeTiming {
    static func seconds(_ normal: Double, defaults: UserDefaults = .standard) -> Double {
        #if DEBUG
        if defaults.bool(forKey: "walnut.uiTestKeychain") { return max(normal, 8) }
        #endif
        return normal
    }
}
