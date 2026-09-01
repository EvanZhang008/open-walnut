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
            case .richHeight(let rowID, let key, let width, let height):
                // A rich cell measured its web document. Bank it and rebuild so
                // the row carries the real height instead of the first guess —
                // this is the ONE row kind whose height flows main → actor,
                // because WebKit can only be measured on the main thread.
                //
                // Why this cannot ping-pong: the cell reports only when its
                // measurement moves by more than its 1pt dead band, and this
                // guard drops a report the cache already agrees with. A rebuild
                // sets the row to exactly the height the document produced, so
                // the web view's frame stops changing and no further report is
                // generated — one rebuild per genuine height change, and zero
                // for a re-attach of an unchanged card. (A document sized in
                // viewport units can still measure differently after being
                // resized; the cell's own report budget bounds that case.)
                //
                // Banked as ONE change (`recordMeasurement`), not as a document
                // record plus a row record: the actor invalidates from the set of
                // identities that moved, and a measurement is one event about one
                // row — two separate changes stamped the cache twice for it.
                let cache = RichHTMLHeightCache.shared
                guard cache.height(key: key, width: width) != height else { return }
                cache.recordMeasurement(key: key, width: width, rowID: rowID, height: height)
                resubmit()
            default:
                onAction(action)
            }
        }
    }
}
