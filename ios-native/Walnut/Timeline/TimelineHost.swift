import SwiftUI
import UIKit

/// SwiftUI shell around the UIKit timeline. This is the ONLY point where the
/// store's observable fields are read: `updateUIViewController` runs whenever
/// any read field changes, snapshots a plain TimelineInput and ships it to
/// the background layout actor. SwiftUI's own diff over this view is O(1) —
/// the representable has no child view tree to diff, which is the structural
/// fix (data change can no longer trigger a full-tree AttributeGraph pass).
///
/// The pinned-to-bottom intent model, KeyboardRepinMachine and the freeze
/// forensics all stay OUTSIDE this type: the page composes them exactly as it
/// did around the old ScrollView (they are behavior, not rendering).
struct TimelineHost: UIViewControllerRepresentable {
    /// Snapshot of the store's timeline state — the page's body builds this
    /// from whatever store it owns (SessionConversationStore / ChatStore).
    var messages: [ChatMessage]
    var streaming: Bool
    var liveText: String
    var liveTextTruncated: Bool
    var activity: String?
    var showLoadEarlier: Bool = false
    /// Bumped by the store when a layout-shifting mutation should re-assert
    /// the pinned bottom (send, turn-end, streaming re-assert).
    var scrollToBottomSignal: Int
    /// Sticky user intent — same closures the ScrollBottomTracking modifier
    /// consumed (reads/writes the store's @ObservationIgnored bottomPinned).
    var isPinned: () -> Bool
    var setPinned: (Bool) -> Void
    /// Keyboard / programmatic geometry freeze from the page (repin machine).
    var geometryFrozen: () -> Bool
    /// Row-level user actions (retry / discard / load-earlier / image tap).
    var onAction: (TimelineRowAction) -> Void
    /// Pull-to-refresh handler (nil = no refresh control). Captured at make
    /// time — a UIRefreshControl can't be added conditionally later.
    var onRefresh: (() async -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> TimelineCollectionController {
        let controller = TimelineCollectionController()
        let coordinator = context.coordinator
        coordinator.controller = controller
        controller.isPinned = isPinned
        controller.setPinned = setPinned
        controller.geometryFrozen = geometryFrozen
        controller.onAction = { [weak coordinator] action in
            coordinator?.handle(action)
        }
        controller.onWidthChange = { [weak coordinator] _ in
            coordinator?.resubmit()
        }
        controller.onRefresh = onRefresh
        return controller
    }

    func updateUIViewController(_ controller: TimelineCollectionController, context: Context) {
        let coordinator = context.coordinator
        // Closures capture the CURRENT store; refresh them on every update.
        controller.isPinned = isPinned
        controller.setPinned = setPinned
        controller.geometryFrozen = geometryFrozen
        coordinator.onAction = onAction
        coordinator.latestInput = TimelineInput(
            messages: messages,
            streaming: streaming,
            liveText: liveText,
            liveTextTruncated: liveTextTruncated,
            activity: activity,
            showLoadEarlier: showLoadEarlier,
            width: 0, // stamped in resubmit()
            expandedRowIDs: coordinator.expandedRowIDs
        )
        coordinator.resubmit()
        if scrollToBottomSignal != coordinator.lastScrollSignal {
            coordinator.lastScrollSignal = scrollToBottomSignal
            controller.scrollToBottom(animated: false)
        }
    }

    @MainActor
    final class Coordinator {
        weak var controller: TimelineCollectionController?
        var latestInput: TimelineInput?
        var lastScrollSignal = 0
        var expandedRowIDs: Set<String> = []
        var onAction: (TimelineRowAction) -> Void = { _ in }
        private let actor = TimelineLayoutActor()

        /// Ship the latest input to the actor (latest-wins there) and apply
        /// completed snapshots back on the main queue.
        func resubmit() {
            guard var input = latestInput, let controller else { return }
            let width = controller.contentWidth
            guard width > 0 else { return } // pre-layout; onWidthChange re-fires
            input.width = width
            input.expandedRowIDs = expandedRowIDs
            Task { [actor] in
                await actor.submit(input) { snapshot in
                    Task { @MainActor [weak self] in
                        self?.controller?.apply(snapshot)
                    }
                }
            }
        }

        func handle(_ action: TimelineRowAction) {
            switch action {
            case .toggleExpanded(let rowID):
                if expandedRowIDs.contains(rowID) {
                    expandedRowIDs.remove(rowID)
                } else {
                    expandedRowIDs.insert(rowID)
                }
                resubmit() // heights change; rebuild off-main
            default:
                onAction(action)
            }
        }
    }
}
