import Foundation

/// Main-thread work ledger — the forensic answer to "what was the main thread
/// chewing when it froze".
///
/// Every 0x8BADF00D field report so far (5 kills across builds 34-36) had a
/// thread-0 stack of pure SwiftUICore/AttributeGraph system frames: we could
/// prove the app died in a layout pass, but not WHOSE data change fed it. The
/// crumb trail records what the user did (send, kb, screen); this ledger
/// records what the APP did — every batch apply that lands observable state on
/// the main thread wraps itself in `MainWork.track(label, count:)`, and the
/// watchdog's report carries the resulting `ctxMainWork` trail:
///
///     ctxMainWork: RUNNING sc.reconcile(109) for 8.2s | -0.3s tasks.feed(12, 8ms) | …
///
/// Two properties make this decisive rather than suggestive:
///  - A `RUNNING …` entry names an item that BEGAN and never finished — read
///    lock-protected from the watchdog's background queue while the main
///    thread is dead, it is the killer by construction when the freeze is one
///    long synchronous stall.
///  - When the freeze is instead an accumulation (many sub-second passes that
///    never let the run loop breathe), the completed ring shows the rate and
///    per-item cost of the recent applies.
///
/// Budget alarm: any tracked item over `warnBudgetMs` logs a warn line
/// IMMEDIATELY (not only at freeze time), so over-budget work is visible in
/// routine field logs long before it compounds into a kill. Items over
/// `crumbThresholdMs` also land a crumb on the flight-recorder tape.
///
/// Cost discipline: begin/end are locked array ops (FreezeContext's lock for
/// the freeze-visible ring, a local lock for `recent()`); labels must be
/// short literals; the trail formats lazily at read time, once per report.
///
/// (Merged from the timeline engine's interim shim — `track` signature,
/// `recent()` and `resetForTesting()` are its agreed contract, kept intact.)
enum MainWork {
    struct Entry {
        let at: TimeInterval
        let label: String
        let count: Int
        let ms: Double
    }

    /// A single main-thread batch apply above this logs its own warn line —
    /// ~6 dropped frames at 60fps, and far enough under the watchdog's 5s
    /// line that ramps show up in the field log before kills do.
    static let warnBudgetMs: Double = 100
    /// Batches slower than this also land a FreezeContext crumb (visible on
    /// the flight-recorder tape without pulling the full ring).
    private static let crumbThresholdMs = 24.0

    private static let lock = NSLock()
    private static var ring: [Entry] = []
    private static let ringLimit = 64

    /// Run `body` on the caller's thread (in practice: MainActor apply
    /// batches), recording {label, count, elapsed}. `label` must be a short
    /// literal ("sc.reconcile"); `count` carries the magnitude (rows, events,
    /// bytes). Nesting is supported (innermost reports first in the trail).
    ///
    /// While `body` runs, the item is visible to FreezeContext.workTrail() as
    /// `RUNNING label(count) for Xs` — that mid-flight visibility is the whole
    /// point: a wedge that never returns still gets named in the freeze report.
    @discardableResult
    static func track<T>(_ label: String, count: Int, _ body: () throws -> T) rethrows -> T {
        let startedAt = FreezeContext.shared.beginWork(label, count: count)
        defer {
            let ms = FreezeContext.shared.endWork(startedAt: startedAt)
            record(label: label, count: count, ms: ms)
        }
        return try body()
    }

    private static func record(label: String, count: Int, ms: Double) {
        lock.lock()
        ring.append(Entry(at: FreezeContext.uptimeNow(), label: label, count: count, ms: ms))
        if ring.count > ringLimit { ring.removeFirst(ring.count - ringLimit) }
        lock.unlock()
        if ms >= crumbThresholdMs {
            // Slow batch — put it on the freeze tape (label is a literal; the
            // magnitude carries the count so nothing interpolates content).
            FreezeContext.shared.note("mainwork-\(label)", count)
        }
        if ms >= warnBudgetMs {
            AppLog.warn("mainwork", "main-thread batch over budget", [
                "label": label,
                "count": String(count),
                "ms": String(format: "%.0f", ms),
            ])
        }
    }

    /// Snapshot of the most recent entries, newest last. Any thread.
    static func recent(_ limit: Int = 32) -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return Array(ring.suffix(limit))
    }

    /// WalnutTests only — deterministic ledgers between cases.
    static func resetForTesting() {
        lock.lock()
        ring = []
        lock.unlock()
    }
}
