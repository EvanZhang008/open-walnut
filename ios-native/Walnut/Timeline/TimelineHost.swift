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
    /// Reasoning the agent emitted during the current (or just-finished) turn,
    /// accumulated by the stores' shared `LiveAgentActivity`. Defaulted, unlike
    /// `scope` below: an omitted reasoning region renders nothing, while an
    /// omitted scope renders the WRONG conversation.
    var liveThinking: String = ""
    /// Every tool call the in-flight turn has made, unfolded (see
    /// `TimelineInput.liveTools`). Defaulted like `liveThinking`: an omitted list
    /// renders no tool rows.
    var liveTools: [LiveToolCall] = []
    var activity: String?
    /// Which conversation these messages belong to. NOT optional and NOT
    /// defaulted on purpose: one host instance serves every conversation the
    /// user switches between (nothing keys it by conversation), so the scope is
    /// the only thing that makes two conversations' rows distinguishable — see
    /// `TimelineScope`. Pass `TimelineScope.draft` when there is no conversation
    /// yet.
    var scope: String
    var showLoadEarlier: Bool = false
    /// Where each banked message is in its life (see
    /// `TimelineInput.queuedMessageStates`). Defaulted: a surface with no queue
    /// passes nothing and renders exactly as before.
    var queuedMessageStates: [String: QueuedSend.Status] = [:]
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
        // A Dynamic Type change moves every measured height and changes NO width,
        // so the layout pass never fires for it and nothing else would ever ask for
        // a rebuild — which is why a live text-size change used to leave the
        // transcript's heights behind while its cells grew (rows overlapping,
        // labels sliced). `resubmit()` re-stamps the category from the controller's
        // own traits and the actor invalidates on it.
        controller.onTextSizeChange = { [weak coordinator] in
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
            liveThinking: liveThinking,
            liveTools: liveTools,
            activity: activity,
            showLoadEarlier: showLoadEarlier,
            width: 0, // stamped in resubmit()
            expandedRowIDs: coordinator.expandedRowIDs,
            queuedMessageStates: queuedMessageStates,
            scope: TimelineScope.sanitize(scope)
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
            input.sizeCategory = controller.traitCollection.preferredContentSizeCategory
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
