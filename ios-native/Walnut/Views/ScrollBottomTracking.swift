import SwiftUI

/// Converts scroll geometry into sticky user intent. Programmatic layout,
/// streaming growth, and keyboard resizing never unpin a reader by themselves.
///
/// Intent is written through `setPinned` rather than a `@Binding`, and the store
/// keeps it `@ObservationIgnored`. That is load-bearing, not a style choice:
/// `onScrollGeometryChange`'s action runs *inside* the scroll view's layout pass,
/// so publishing from it re-invalidates the very subtree being measured. With a
/// tall LazyVStack of variable-height rows that feedback does not converge —
/// placement dirties the lazy item phases, the phase mutation dirties placement,
/// and `GraphHost.flushTransactions()` spins the main thread at 100% forever
/// (P0-2: the chat timeline went permanently blank under keyboard churn).
/// Intent is only ever *read* outside the view graph, so nothing needs to observe it.
struct ScrollBottomTracking: ViewModifier {
    let isPinned: () -> Bool
    let setPinned: (Bool) -> Void
    let geometryFrozen: () -> Bool
    @State private var tracking = TrackingState()

    private static let unpinThreshold: CGFloat = 200
    private static let repinThreshold: CGFloat = 40

    /// Reference state avoids publishing every geometry sample back into the
    /// view graph, which can otherwise trigger multiple-update-per-frame faults.
    private final class TrackingState {
        var distanceFromBottom: CGFloat = 0
        var userScrolling = false
    }

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
            } action: { _, distance in
                tracking.distanceFromBottom = distance
                updateIntent(distance: distance)
            }
            .onScrollPhaseChange { _, phase in
                tracking.userScrolling = phase == .interacting || phase == .decelerating
                guard tracking.userScrolling else { return }
                updateIntent(distance: tracking.distanceFromBottom)
            }
    }

    private func updateIntent(distance: CGFloat) {
        guard tracking.userScrolling, !geometryFrozen() else { return }
        let want: Bool
        if distance > Self.unpinThreshold {
            want = false
        } else if distance < Self.repinThreshold {
            want = true
        } else {
            return  // inside the hysteresis band: keep the current intent
        }
        // Idempotent: a geometry stream that never crosses a threshold must not
        // keep re-writing the same value.
        guard isPinned() != want else { return }
        setPinned(want)
    }
}

/// Freezes intent tracking while the keyboard changes the viewport, then asks
/// the sole ScrollPosition authority to restore a previously pinned bottom.
struct KeyboardBottomRepin: ViewModifier {
    @Binding var keyboardGeometryFrozen: Bool
    let isPinned: () -> Bool
    let repin: () -> Void
    @State private var pendingRepin = false
    @State private var failsafeTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
                if !keyboardGeometryFrozen { pendingRepin = isPinned() }
                keyboardGeometryFrozen = true
                armFailsafe()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                finishTransition()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                finishTransition()
            }
            // willHide can be the ONLY terminal signal for some interactive
            // dismissals; without it (and the failsafe below) the freeze
            // sticks and the user can never unpin to read history.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                finishTransition()
            }
            // Frame-only changes (rotation, QuickType bar, input-mode resize)
            // complete with didChangeFrame and never emit didShow/didHide.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
                finishTransition()
            }
            .onDisappear {
                failsafeTask?.cancel()
                keyboardGeometryFrozen = false
            }
    }

    /// Keyboard transitions that never emit a terminal notification (e.g. a
    /// predictive-bar frame change) must not wedge the freeze forever.
    private func armFailsafe() {
        failsafeTask?.cancel()
        failsafeTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            finishTransition()
        }
    }

    private func finishTransition() {
        failsafeTask?.cancel()
        failsafeTask = nil
        keyboardGeometryFrozen = false
        guard pendingRepin else { return }
        pendingRepin = false
        repin()
    }
}
