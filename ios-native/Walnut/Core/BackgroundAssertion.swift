import Foundation
import UIKit

/// `UIApplication.beginBackgroundTask` / `endBackgroundTask` from any thread.
///
/// Both are DOCUMENTED thread-safe, and the log uploader must be able to hold a
/// background assertion from its own queue — including while the main thread is
/// FROZEN, which is the entire point of the freeze-report path. Swift's
/// concurrency checker only sees `UIApplication.shared`'s MainActor isolation
/// and cannot see that documentation, so it warns at every call site. This shim
/// states the exception ONCE, with the reason, instead of scattering it.
///
/// NOT `MainActor.assumeIsolated`: that TRAPS when the caller really isn't on
/// the main thread — which for this shim is the normal case — turning a
/// compile-time warning into a field crash inside the freeze reporter. The
/// `nonisolated(unsafe)` capture below is the honest form of the same claim: we
/// take responsibility for the thread-safety, and the audit trail is this
/// comment plus Apple's documentation.
enum BackgroundAssertion {
    /// Captured once, on the main thread, from `AppLog.captureDeviceIdentity()`
    /// (same startup hook that caches device identity for the same reason).
    /// Before capture, begin/end are no-ops returning `.invalid` — a log upload
    /// in the first milliseconds of launch simply runs without an assertion.
    nonisolated(unsafe) private static var application: UIApplication?

    @MainActor
    static func capture() {
        application = UIApplication.shared
    }

    static func begin(_ name: String) -> UIBackgroundTaskIdentifier {
        application?.beginBackgroundTask(withName: name) ?? .invalid
    }

    static func end(_ identifier: UIBackgroundTaskIdentifier) {
        guard identifier != .invalid else { return }
        application?.endBackgroundTask(identifier)
    }
}
