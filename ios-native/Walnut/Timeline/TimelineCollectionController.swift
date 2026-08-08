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
        let pinned = isPinned()

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
                if pinned {
                    self.collectionView.layoutIfNeeded()
                    self.pinToBottom(animated: false)
                }
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
                if pinned {
                    collectionView.layoutIfNeeded()
                    pinToBottom(animated: false)
                }
            }
        }
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
        programmaticFreezeUntil = CACurrentMediaTime() + 0.25
        collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
    }

    private var intentFrozen: Bool {
        geometryFrozen() || CACurrentMediaTime() < programmaticFreezeUntil
    }

    fileprivate func updateIntent() {
        // User-driven phases only (mirror of onScrollPhaseChange gating).
        guard collectionView.isTracking || collectionView.isDecelerating else { return }
        guard !intentFrozen else { return }
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
        id.range(of: "#", options: .backwards).map { String(id[..<$0.lowerBound]) } ?? id
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
            UIApplication.shared.open(url)
        default:
            onAction(action)
        }
    }
}
