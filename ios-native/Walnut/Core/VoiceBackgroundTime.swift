import UIKit

/// Voice uploads may outlast iOS background time. Relinquish an expired
/// assertion so iOS can suspend the app instead of terminating it for keeping
/// an expired task alive. Stored audio and transcripts survive either path.
@MainActor
final class VoiceBackgroundTime {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    private let endTask: (UIBackgroundTaskIdentifier) -> Void

    init(_ name: String) {
        endTask = { UIApplication.shared.endBackgroundTask($0) }
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // Expiration callbacks do not establish Swift actor isolation.
            Task { @MainActor [weak self] in self?.end() }
        }
    }

    /// Both normal completion and expiration may call end. Only one owns it.
    func end() {
        guard identifier != .invalid else { return }
        let current = identifier
        identifier = .invalid
        endTask(current)
    }

    #if DEBUG
    /// Tests assert idempotent release without asking the OS for background time.
    init(identifier: UIBackgroundTaskIdentifier, endTask: @escaping (UIBackgroundTaskIdentifier) -> Void) {
        self.identifier = identifier
        self.endTask = endTask
    }
    #endif
}
