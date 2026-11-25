import Foundation

/// How long a passing thing stays on screen before the app takes it away by itself: a notice
/// ("Copied", "Sent"), an Undo offer, a run's outcome, a tap-again-to-confirm window.
///
/// A person reads it in a couple of seconds. A UI test on a busy CI simulator does not: XCUITest's
/// tap returns only once the app is idle, which took 3 s there, and each query takes 1 to 3 s, so a
/// 2.5 s notice was gone before the test could look (2026-11-16, CI on iOS 26.5: SessionChangesUITests
/// "Copy said nothing"; 2026-11-24: Routines' 4 s "Ran just now" and the review's 5 s Undo, the same).
/// In a debug build launched by the UI tests (`-walnut.uiTestKeychain`, UITestLaunch) it stays at
/// least `uiTestFloor` seconds; release builds and every other launch keep the normal time.
///
/// Every timed take-away a UI test can meet goes through here (`after`, or `seconds` for a wait or a
/// window the caller measures itself): tests/web/ios-timed-hide-guard.test.ts finds every timed
/// take-away in the source and lists the rest with why none is a passing thing a test must catch.
enum NoticeTiming {
    /// The least a passing thing stays in a UI-test launch.
    static let uiTestFloor: Double = 8

    static func seconds(_ normal: Double, defaults: UserDefaults = .standard) -> Double {
        #if DEBUG
        if defaults.bool(forKey: "walnut.uiTestKeychain") { return max(normal, uiTestFloor) }
        #endif
        return normal
    }

    /// Runs `takeAway` on the main actor once the thing has been up its held time, `seconds(normal)`
    /// (`normal` itself outside a UI-test launch of a debug build, at least `uiTestFloor` in one),
    /// unless the returned task is cancelled first.
    @MainActor @discardableResult
    static func after(
        _ normal: Double, defaults: UserDefaults = .standard, _ takeAway: @escaping @MainActor () -> Void
    ) -> Task<Void, Never> {
        let wait = seconds(normal, defaults: defaults)
        return Task { @MainActor in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            takeAway()
        }
    }
}
