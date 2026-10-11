import Foundation
import os

/// Where the app keeps its preferences. Outside the demo, the standard
/// defaults. In the demo, a suite of its own: whatever is switched on or chosen
/// in the demo lands there, never in the real app's preferences, and the suite
/// is wiped when the demo starts, at every launch in the demo, and when you
/// leave it (App Store gate, 2026-10-05: Apple Health turned on in the demo
/// stayed on after a relaunch).
///
/// Pairing stays in the standard defaults on purpose (`AppConfig`, the route
/// list): it is what says the demo is on, and leaving the demo clears it.
/// Launch arguments and test knobs are read from the standard defaults too.
enum AppPrefs {
    enum Scope: String { case real, demo }

    /// The demo's own suite. A separate preferences file in the app container.
    static let demoSuiteName = "dev.openwalnut.ios.demo"
    static let demo: UserDefaults = UserDefaults(suiteName: demoSuiteName) ?? .standard

    /// Set only while the demo's state is being erased (entering or leaving the
    /// demo), when the pairing that decides the scope is not in place yet or
    /// is already gone, so every store's own reset still writes to the demo.
    private static let forced = OSAllocatedUnfairLock<Scope?>(initialState: nil)

    static var scope: Scope {
        forced.withLock { $0 } ?? (DemoMode.isActive ? .demo : .real)
    }

    /// The defaults every preference reads and writes.
    static var defaults: UserDefaults { scope == .demo ? demo : .standard }

    /// The defaults a long-lived store was given: `.standard` means the app's
    /// own, so it follows the scope (a store made at launch outlives entering
    /// and leaving the demo); a suite a test injected stays that suite.
    static func resolve(_ given: UserDefaults) -> UserDefaults {
        given === UserDefaults.standard ? defaults : given
    }

    /// Runs `body` with the scope pinned (erasing the demo while unpaired).
    static func during<T>(_ scope: Scope, _ body: () throws -> T) rethrows -> T {
        let previous = forced.withLock { (value: inout Scope?) -> Scope? in
            let was = value
            value = scope
            return was
        }
        defer { forced.withLock { $0 = previous } }
        return try body()
    }

    /// Every preference the demo set, gone.
    static func eraseDemo() {
        demo.removePersistentDomain(forName: demoSuiteName)
        for key in demo.dictionaryRepresentation().keys where isOurs(key) {
            demo.removeObject(forKey: key)
        }
    }

    /// The app's own keys (the suite also lists the global domain's).
    static func isOurs(_ key: String) -> Bool {
        key.hasPrefix("walnut") || key.hasPrefix("tasks.") || key.hasPrefix("notes.")
    }
}
