import Foundation
import QuartzCore

/// Frame-splits oversized snapshot applies so no single main-thread batch can
/// approach the watchdog line. Small diffs (the streaming steady state) apply
/// in one tracked batch; a large diff (first paint of a 400-row page, a
/// 1000-row reconcile) applies as successive slices, each budgeted at
/// ~`budgetMs`, yielding a run-loop turn between slices.
///
/// Snapshots are latest-wins: a newer snapshot arriving mid-split abandons
/// the remaining slices (the apply callback re-runs against the newer rows).
/// Every batch is wrapped in `MainWork.track` — the forensic ledger names the
/// batch and its row count if it ever stalls.
@MainActor
final class TimelineApplyBudgeter {
    /// Per-batch main-thread budget. ~half a 60fps frame: parity with the
    /// engine's design bound ("main-thread apply batches ≈ 8ms").
    static let budgetMs: Double = 8
    /// Row-count granularity of one slice when splitting. Applying a row is
    /// O(1) (height array entry + data source row), so a generous slice still
    /// lands well under budget; the budget check between slices is the
    /// authoritative gate.
    static let sliceRows = 120

    private var pendingGeneration = 0
    private var scheduled = false

    /// Batches applied for the CURRENT snapshot so far (test observable).
    private(set) var lastApplyBatches = 0

    /// Abandon any in-flight progressive fill (its remaining slices must not
    /// land after the caller applies newer rows through another path).
    func invalidate() {
        pendingGeneration = .max
    }

    /// Apply `snapshot` through `applySlice(range, isFinal)`, splitting into
    /// budgeted batches. `applySlice` must be synchronous main-thread work
    /// (the controller's row-array splice + collection view update).
    func apply(
        snapshot: TimelineSnapshot,
        applySlice: @escaping @MainActor (_ rows: ArraySlice<TimelineRow>, _ isFinal: Bool) -> Void
    ) {
        pendingGeneration = snapshot.generation
        lastApplyBatches = 0
        applyChunks(snapshot: snapshot, from: 0, applySlice: applySlice)
    }

    private func applyChunks(
        snapshot: TimelineSnapshot, from start: Int,
        applySlice: @escaping @MainActor (_ rows: ArraySlice<TimelineRow>, _ isFinal: Bool) -> Void
    ) {
        guard snapshot.generation == pendingGeneration else { return } // superseded
        let rows = snapshot.rows
        var cursor = start
        let batchStart = CACurrentMediaTime()
        // One budgeted main-thread batch: as many slices as fit the budget.
        while cursor < rows.count {
            let end = min(cursor + Self.sliceRows, rows.count)
            let isFinal = end == rows.count
            let sliceRange = cursor..<end
            MainWork.track("timeline.apply", count: sliceRange.count) {
                applySlice(rows[sliceRange], isFinal)
            }
            lastApplyBatches += 1
            cursor = end
            if (CACurrentMediaTime() - batchStart) * 1_000 >= Self.budgetMs { break }
        }
        if cursor < rows.count {
            // Over budget with rows remaining — yield a run-loop turn, then
            // continue (unless a newer snapshot supersedes this one).
            // RunLoop.perform (NOT a Task): run-loop blocks are drained by
            // every plain RunLoop spin — Swift-concurrency main-actor jobs
            // are not guaranteed to run inside a nested RunLoop.run, which
            // both XCTest drains and some UIKit re-entrancy points use.
            // `.common` keeps the fill progressing during scroll tracking.
            let next = cursor
            RunLoop.main.perform(inModes: [.common]) { [weak self] in
                self?.applyChunks(snapshot: snapshot, from: next, applySlice: applySlice)
            }
        }
        if start == 0, rows.isEmpty {
            MainWork.track("timeline.apply", count: 0) {
                applySlice(rows[0..<0], true)
            }
            lastApplyBatches += 1
        }
    }
}
