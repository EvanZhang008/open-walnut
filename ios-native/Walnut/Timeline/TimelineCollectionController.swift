import UIKit

/// The UIKit timeline: a UICollectionView over pre-measured immutable rows.
///
/// Main-thread cost model (the whole point of the engine):
///  - applying a snapshot = height-array arithmetic (O(rows) additions, ~µs)
///    + visible-cell attach (O(1) per visible cell) — batched and budgeted by
///    TimelineApplyBudgeter, ledgered by MainWork;
///  - steady-state streaming = a TimelineDiff whose reloads touch ONLY the
///    live-tail rows: history cells are never reconfigured mid-stream;
///  - scrolling = cell reuse against pre-built NSAttributedStrings (glyph
///    layout for the incoming cell only).
///
/// Bottom-pin: same sticky-intent model as ScrollBottomTracking (unpin >200pt,
/// repin <40pt, only during user-driven scroll phases, suppressed while
/// geometry is frozen). The KeyboardRepinMachine stays OUTSIDE (behavior
/// layer, wired by the SwiftUI page); this controller only exposes
/// `scrollToBottom()` and the intent callbacks.
final class TimelineCollectionController: UIViewController {
    // Wiring from the host (set before viewDidLoad).
    var isPinned: () -> Bool = { true }
    var setPinned: (Bool) -> Void = { _ in }
    var geometryFrozen: () -> Bool = { false }
    var onAction: (TimelineRowAction) -> Void = { _ in }
    /// Fired when the layout width first becomes known / changes (rotation):
    /// the host re-submits its input so rows re-measure at the new width.
    var onWidthChange: (CGFloat) -> Void = { _ in }
    private var lastReportedWidth: CGFloat = 0
    /// Pull-to-refresh (SwiftUI `.refreshable` can't reach a hosted
    /// UICollectionView, so the refresh control lives here).
    var onRefresh: (() async -> Void)?
    private var refreshControl: UIRefreshControl?

    private(set) var rows: [TimelineRow] = []
    private let layout = TimelineLayout()
    private(set) var collectionView: UICollectionView!
    private let budgeter = TimelineApplyBudgeter()
    private var appliedGeneration = 0

    private static let unpinThreshold: CGFloat = 200
    private static let repinThreshold: CGFloat = 40
    /// Suppress intent sampling briefly around programmatic scrolls (mirror of
    /// the SwiftUI pages' programmaticGeometryFrozen).
    private var programmaticFreezeUntil: CFTimeInterval = 0

    /// The user's finger (or its momentum) currently owns the scroll position.
    /// Programmatic scrolls never set these flags, so this is the authoritative
    /// "a human is scrolling" signal — every follow/pin action must yield to it.
    private var userScrollActive: Bool {
        guard let collectionView else { return false }
        return collectionView.isTracking || collectionView.isDragging
            || collectionView.isDecelerating
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.register(TimelineTextCell.self,
                                forCellWithReuseIdentifier: TimelineTextCell.reuseID)
        collectionView.register(TimelineUserBubbleCell.self,
                                forCellWithReuseIdentifier: TimelineUserBubbleCell.reuseID)
        collectionView.register(TimelineCodeCell.self,
                                forCellWithReuseIdentifier: TimelineCodeCell.reuseID)
        collectionView.register(UICollectionViewCell.self,
                                forCellWithReuseIdentifier: TimelineHostedCell.reuseID)
        view.addSubview(collectionView)
        if onRefresh != nil {
            let control = UIRefreshControl()
            control.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
            collectionView.refreshControl = control
            refreshControl = control
        }
    }

    @objc private func refreshPulled() {
        guard let onRefresh else { refreshControl?.endRefreshing(); return }
        Task { @MainActor [weak self] in
            await onRefresh()
            self?.refreshControl?.endRefreshing()
        }
    }

    /// Content width rows must be measured at (0 until the view has laid out).
    var contentWidth: CGFloat { collectionView?.bounds.width ?? 0 }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = collectionView.bounds.width
        if width > 0, width != lastReportedWidth {
            lastReportedWidth = width
            onWidthChange(width)
        }
    }

    // MARK: - Snapshot application

    /// Apply a freshly built snapshot. Small diffs go through targeted batch
    /// updates (streaming steady state: only live-tail cells reconfigure);
    /// large diffs (first paint, giant reconcile) fill progressively through
    /// the budgeter so no single main-thread batch exceeds its budget.
    func apply(_ snapshot: TimelineSnapshot) {
        guard isViewLoaded else { return }
        guard snapshot.generation > appliedGeneration else { return } // stale build
        appliedGeneration = snapshot.generation

        let diff = TimelineDiff.compute(old: rows, new: snapshot.rows)
        if diff.isEmpty { return }
        // History readers get anchored to the row they are looking at BEFORE
        // any mutation — a structural reloadData / head trim must not move
        // their viewport. Intent is re-read LIVE at every application point
        // below (never captured once): a multi-batch progressive fill outlives
        // any flag captured here, and the user can unpin mid-fill.
        let anchor = isPinned() ? nil : captureAnchor()

        if rows.isEmpty || diff.changeCount > TimelineApplyBudgeter.sliceRows {
            // Progressive fill: budgeted slices, reloadData per batch (cheap:
            // prefix sums + visible attach; off-screen rows cost nothing).
            budgeter.apply(snapshot: snapshot) { [weak self] slice, isFinal in
                guard let self else { return }
                if slice.startIndex == 0 {
                    self.rows = Array(slice)
                } else {
                    self.rows.append(contentsOf: slice)
                }
                if slice.startIndex == 0 && slice.isEmpty { self.rows = [] }
                self.layout.rowHeights = self.rows.map(\.height)
                self.collectionView.reloadData()
                self.layout.invalidateLayout()
                self.followOrRestore(anchor: anchor)
                _ = isFinal
            }
        } else {
            // Targeted update — one tracked batch, touched cells only.
            // Abandon any in-flight progressive fill FIRST (its remaining
            // slices landing after this apply would desync the data source).
            budgeter.invalidate()
            MainWork.track("timeline.diff", count: diff.changeCount) {
                rows = snapshot.rows
                layout.rowHeights = rows.map(\.height)
                if diff.deletes.isEmpty && diff.inserts.isEmpty {
                    // Reload-only tick (the streaming steady state): update
                    // touched visible cells in place — no reloadData, so text
                    // selection and cell state on unrelated rows survive.
                    for (index, row) in diff.reloads {
                        if let cell = collectionView.cellForItem(at: IndexPath(item: index, section: 0)) {
                            configure(cell: cell, row: row)
                        }
                    }
                    layout.invalidateLayout()
                } else {
                    // Structure changed. Deliberately NOT performBatchUpdates:
                    // our layout is a deterministic height array, animations
                    // are disabled anyway, and the batch-update count
                    // reconciliation is a whole class of hard crashes when
                    // applies outpace layout passes (storm conditions).
                    // reloadData costs O(visible) here — prepare() is prefix
                    // sums; only visible cells re-attach.
                    collectionView.reloadData()
                    layout.invalidateLayout()
                }
                followOrRestore(anchor: anchor)
            }
        }
    }

    /// Post-mutation scroll policy — the ONE place a snapshot apply may move
    /// the viewport. A pinned reader follows the bottom; an unpinned reader
    /// stays glued to the row they were reading (bottom-anchoring an unpinned
    /// viewport was the build-37 field bug). Never fights an active gesture.
    private func followOrRestore(anchor: ViewportAnchor?) {
        collectionView.layoutIfNeeded()
        // A live gesture (finger down OR deceleration) owns the position in
        // BOTH branches. Restoring the anchor mid-deceleration is not benign:
        // setContentOffset kills the momentum, so a reader flicking back
        // toward the bottom got their flick cancelled by every ~8Hz apply and
        // could never reach the repin zone. Appends land below the viewport,
        // so skipping the restore during a gesture doesn't visibly shift rows.
        guard !userScrollActive else { return }
        if isPinned() {
            pinToBottom(animated: false)
        } else if let anchor {
            restoreAnchor(anchor)
        }
    }

    // MARK: - Viewport anchoring (unpinned readers)

    /// Identity of the row at the viewport top + how far the offset sits into
    /// it. Row ids are stable across snapshot generations, so this survives
    /// structural changes that shift indices (head trim, giant reconcile).
    struct ViewportAnchor {
        let rowID: String
        let offsetDelta: CGFloat
    }

    private func captureAnchor() -> ViewportAnchor? {
        guard let cv = collectionView, !rows.isEmpty else { return nil }
        let y = cv.contentOffset.y + cv.adjustedContentInset.top
        guard let i = layout.rowIndex(at: max(0, y)), i < rows.count,
              let minY = layout.rowMinY(i) else { return nil }
        return ViewportAnchor(rowID: rows[i].id, offsetDelta: cv.contentOffset.y - minY)
    }

    /// Reposition so the anchor row sits where it was. Anchor row gone
    /// (trimmed / mid-progressive-fill prefix): leave the clamped offset —
    /// the final slice of a fill restores it once the row lands.
    private func restoreAnchor(_ anchor: ViewportAnchor) {
        guard let cv = collectionView else { return }
        guard let i = rows.firstIndex(where: { $0.id == anchor.rowID }),
              let minY = layout.rowMinY(i) else {
            // Anchor row not landed yet (mid-progressive-fill prefix). Kill
            // any in-flight AUTOMATIC animated adjustment anyway: when the
            // first fill slice shrinks contentSize below the reader's offset,
            // UIKit clamps via an ANIMATED UIScrollViewScrollAnimation that
            // keeps advancing frames across run-loop turns — left alive, it
            // drags the offset away after the fill finishes. An unanimated
            // set of the current offset cancels it.
            cv.setContentOffset(cv.contentOffset, animated: false)
            return
        }
        let minOffset = -cv.adjustedContentInset.top
        let maxOffset = max(minOffset, cv.contentSize.height - cv.bounds.height
                            + cv.adjustedContentInset.bottom)
        let target = min(max(minY + anchor.offsetDelta, minOffset), maxOffset)
        // ALWAYS set, no epsilon short-circuit: even a no-op-looking set must
        // run to cancel the automatic animated clamp described above (skipping
        // it when cur == target left the animation alive → offset drift).
        cv.setContentOffset(CGPoint(x: 0, y: target), animated: false)
    }

    // MARK: - Bottom pin

    /// Programmatic scroll to the newest row. Freezes intent sampling for
    /// 250ms so this move can't masquerade as a user drag and clear the
    /// sticky bottom intent (mirror of the SwiftUI scrollToBottom).
    ///
    /// Also RE-ESTABLISHES pinned intent: SwiftUI's `scrollTo(edge:.bottom)`
    /// re-associated ScrollPosition with the bottom edge, after which content
    /// growth followed automatically — the UIKit equivalent of that follow is
    /// the pinned flag. Every product signal already implies bottom intent
    /// (send sets it; streaming re-assert and reconcile guard on it).
    func scrollToBottom(animated: Bool = false) {
        guard isViewLoaded else { return }
        programmaticFreezeUntil = CACurrentMediaTime() + 0.25
        if !isPinned() { setPinned(true) }
        pinToBottom(animated: animated)
    }

    private func pinToBottom(animated: Bool) {
        let target = max(
            -collectionView.adjustedContentInset.top,
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom
        )
        // Deliberately NOT extending programmaticFreezeUntil here. This runs
        // per apply (~8Hz while streaming) — extending a 250ms freeze from it
        // kept intent sampling frozen for the WHOLE stream, so a reader's
        // upward drag could never unpin and every apply yanked them back to
        // the bottom (build-37 field bug). The freeze is not needed for
        // correctness either: this scroll's own didScroll is already excluded
        // by updateIntent's isTracking/isDecelerating gate (programmatic
        // scrolls never set those), and followOrRestore never calls this
        // while a user gesture owns the scroll position.
        collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
    }

    fileprivate func updateIntent() {
        // User-driven phases only (mirror of onScrollPhaseChange gating).
        guard collectionView.isTracking || collectionView.isDecelerating else { return }
        // Keyboard transitions own geometry outright (inset jitter mid-
        // animation produces false distances) — same rule as the SwiftUI
        // ScrollBottomTracking.
        guard !geometryFrozen() else { return }
        // The programmatic freeze only guards against a scrollToBottom's own
        // momentum masquerading as user intent. A physical finger on the
        // screen (isTracking) can never be programmatic, so it must sample
        // through the freeze — dropping those samples is what deadlocked the
        // unpin on device (streaming re-asserts every ~700ms chained 250ms
        // freeze windows, so a reader's drag was discarded and every apply
        // yanked them back to the bottom). Deceleration samples still honor
        // the freeze: a programmatic scroll can land mid-flick.
        guard collectionView.isTracking
            || CACurrentMediaTime() >= programmaticFreezeUntil else { return }
        let distance = max(
            0,
            collectionView.contentSize.height + collectionView.adjustedContentInset.bottom
                - collectionView.bounds.maxY
        )
        let want: Bool
        if distance > Self.unpinThreshold {
            want = false
        } else if distance < Self.repinThreshold {
            want = true
        } else {
            return // hysteresis band: keep current intent
        }
        guard isPinned() != want else { return }
        setPinned(want)
    }

    // MARK: - Cell configuration

    fileprivate func configure(cell: UICollectionViewCell, row: TimelineRow) {
        switch row.content {
        case .text(let text):
            (cell as? TimelineTextCell)?.configure(text: text, delegate: self)
        case .userBubble(let text, let size, let failed, let pending):
            (cell as? TimelineUserBubbleCell)?.configure(
                text: text, textSize: size, failed: failed, pending: pending,
                messageID: messageID(fromRowID: row.id), delegate: self
            )
        case .code(let text, let contentSize):
            (cell as? TimelineCodeCell)?.configure(text: text, contentSize: contentSize)
        default:
            TimelineHostedCell.configure(cell, row: row, delegate: self)
        }
    }

    /// Row ids are "<messageID>#<block>"; actions need the message id.
    private func messageID(fromRowID id: String) -> String {
        TimelineRow.messageID(fromRowID: id)
    }

    private func reuseID(for row: TimelineRow) -> String {
        switch row.content {
        case .text: return TimelineTextCell.reuseID
        case .userBubble: return TimelineUserBubbleCell.reuseID
        case .code: return TimelineCodeCell.reuseID
        default: return TimelineHostedCell.reuseID
        }
    }
}

// MARK: - Data source / delegate

extension TimelineCollectionController: UICollectionViewDataSource, UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView,
                        numberOfItemsInSection section: Int) -> Int {
        rows.count
    }

    func collectionView(_ collectionView: UICollectionView,
                        cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let row = rows[indexPath.item]
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: reuseID(for: row), for: indexPath)
        configure(cell: cell, row: row)
        return cell
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateIntent()
    }
}

extension TimelineCollectionController: TimelineCellActionDelegate {
    func timelineCell(didRequest action: TimelineRowAction) {
        switch action {
        case .openURL(let url):
            // Server-side file links (walnut-file:// or a bare absolute .html
            // path in a markdown link) open the in-app preview, not Safari.
            if let path = FilePreviewLink.path(from: url) {
                onAction(.previewFile(path: path))
            } else {
                UIApplication.shared.open(url)
            }
        default:
            onAction(action)
        }
    }
}
