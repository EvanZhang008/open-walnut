import UIKit

/// Puts the keyboard away, then runs the next step once it has gone.
///
/// A step that changes the page (a pop, a sheet closing) in the same update as the resign can keep
/// the keyboard: on iOS 26.5 the compare picker's search field and its keyboard stayed over the
/// diff the pick popped back to, though the pick had resigned it first (CI, 2026-11-16:
/// SessionChangesUITests "the picker's search stayed active after the pick"). Waiting for the
/// keyboard's own "did hide" keeps the two apart. With no text field focused the step runs at
/// once; when no hide comes within `limit`, it runs anyway and says so in the log.
@MainActor
enum KeyboardAway {
    static func then(limit: TimeInterval = 1.0, _ step: @escaping @MainActor () -> Void) {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let focus = windows.lazy.compactMap(\.textFocus).first else { step(); return }
        let once = RunOnce(step)
        let token = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { once.run() } }
        once.cleanup = { NotificationCenter.default.removeObserver(token) }
        _ = focus.resignFirstResponder()
        DispatchQueue.main.asyncAfter(deadline: .now() + limit) {
            if !once.ran { AppLog.info("keyboard", "no keyboard hide within the limit; the next step runs anyway", ["limit": "\(limit)"]) }
            once.run()
        }
    }
}

@MainActor
private final class RunOnce {
    private let step: @MainActor () -> Void
    var cleanup: (() -> Void)?
    private(set) var ran = false

    init(_ step: @escaping @MainActor () -> Void) { self.step = step }

    func run() {
        guard !ran else { return }
        ran = true
        cleanup?()
        cleanup = nil
        step()
    }
}
