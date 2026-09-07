import Foundation
import XCTest
@testable import Walnut

/// Cuts this test process off from every real Walnut server, once, before XCTest
/// has built a single test case.
///
/// WHY. `WalnutTests` is a HOSTED test bundle: it is loaded into the installed
/// app, so it inherits the app container's pairing — on a dogfood device that is
/// the human's own server. Plenty of tests build a real store and call a
/// mutating method (`updateTask`, `batchSetDone`, `batchDelete`, `quickAdd`), and
/// those calls went out on the wire: a plain `xcodebuild test` was observed
/// sending a PATCH, two batch mutations and four natural-language parse requests
/// (a real model call each, ~10s apiece) at a live production server. Nothing was
/// lost only because the fixture ids happened not to exist there. That is luck,
/// not a design.
///
/// WHY NOT JUST RE-POINT THE APP. Writing `walnut.serverUrl` into UserDefaults
/// would fix the tests and break the human: the container is shared with the app,
/// so the device would come out of the run paired to the test's fake server. The
/// redirect therefore lives in memory, in THIS process only
/// (`AppConfig.processServerURLOverride`), and nothing on disk is read for the
/// URL or written at all.
///
/// HOW IT RUNS, AND WHY THIS CLASS IS THE BELT AND NOT THE MECHANISM. This class
/// is the test bundle's `NSPrincipalClass` (`INFOPLIST_KEY_NSPrincipalClass` in
/// `ios-native/project.yml`), so XCTest instantiates it while loading the bundle,
/// ahead of every test class. That is early enough for the tests and NOT early
/// enough for the process: measured on the first version of this file, XCTest
/// loads a hosted bundle only after `applicationDidFinishLaunching`, so the test
/// host's own launch traffic — a `POST /api/v1/client-logs`, the events SSE
/// subscribe, status/inbox/engine reads — had already reached the live server
/// before a single test ran. The guarantee therefore lives one level down, in the
/// DEFAULT of `AppConfig`'s override (blackholed whenever
/// `XCTestConfigurationFilePath` is in the environment, evaluated at the first
/// read of `serverURL` in the process). This class re-asserts the same values,
/// which costs nothing and keeps the intent readable from the test target.
@objc(WalnutTestsPrincipal)
final class WalnutTestsPrincipal: NSObject, XCTestObservation {

    /// Unreachable by construction, and cheap to prove it. Owned by `AppConfig`
    /// because the default has to be applied there, before any test code exists.
    static let blackholeURL = AppConfig.testBlackholeURL

    /// XCTestObservationCenter does not promise to keep observers alive, and
    /// neither does whoever instantiated the principal class.
    private static let retained = StrongRefBox()

    override init() {
        super.init()
        Self.install()
        XCTestObservationCenter.shared.addTestObserver(self)
        Self.retained.hold(self)
    }

    /// Idempotent: both entry points call it, and a test may call it after
    /// deliberately clearing the override.
    static func install() {
        AppConfig.processServerURLOverride = blackholeURL
        AppConfig.processTokenOverride = ""
    }

    func testBundleWillStart(_ testBundle: Bundle) {
        Self.install()
    }
}

/// Minimal strong-reference box (the test bundle has no other need for one).
final class StrongRefBox {
    private let lock = NSLock()
    private var held: AnyObject?
    func hold(_ object: AnyObject) {
        lock.lock()
        held = object
        lock.unlock()
    }
}
