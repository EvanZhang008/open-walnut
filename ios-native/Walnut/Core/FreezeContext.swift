import Foundation
import SwiftUI
import UIKit

/// Always-on "what was the app doing" registry, read by `MainThreadWatchdog`
/// when the main thread stops answering.
///
/// WHY A PRE-WRITTEN SNAPSHOT: at freeze time the main thread is DEAD. The
/// watchdog reports from its own background queue, so it cannot ask the UI
/// anything — no `DispatchQueue.main.sync`, no UIKit reads, no MainActor
/// `await` (that's the bug AppLog already fixed for device identity). The only
/// context it can attach is context that was written BEFORE the freeze.
///
/// So the flow is inverted: views and stores PUSH cheap state changes in here
/// as they happen (a few scalar writes under an NSLock, from the main thread),
/// and the watchdog PULLS the latest snapshot lock-protected from a background
/// thread. Nothing here allocates on a hot path — string formatting happens
/// only inside `snapshotMeta()`, which runs at most once per freeze.
///
/// Field notes this exists to answer (build 35, 0x8BADF00D on idle sessions):
/// which screen, how big was the live turn / history, was the keyboard
/// oscillating, what did the user just do, how much memory were we holding.
final class FreezeContext: @unchecked Sendable {
    static let shared = FreezeContext()

    private let lock = NSLock()

    // MARK: - Snapshot fields (all guarded by `lock`)

    private var screen = "?"
    /// One level of history so a pop/tab-switch restores the surface below
    /// instead of leaving a stale name (see `clearScreen`).
    private var previousScreen = "?"
    private var keyboardVisible = false
    /// Uptimes of the last keyboard show/hide notifications. Bounded ring —
    /// the watchdog only ever asks "how many in the last N seconds".
    private var keyboardEvents: [TimeInterval] = []
    /// UTF-8 length of the composer draft being edited. UTF-8 count is O(1) on
    /// native Swift strings; `String.count` (grapheme clusters) is O(n) and
    /// this is written per keystroke.
    private var draftChars = 0
    private var historyRows = 0
    private var liveTextChars = 0
    private var liveTextTruncated = false
    private var crumbs: [Crumb] = []

    // MARK: Main-thread work ledger (fed by MainWork.begin)
    //
    // The 5-kill blind spot this closes: every 0x8BADF00D report so far had a
    // thread-0 stack of pure SwiftUICore/AttributeGraph system frames and a
    // crumb trail of what the USER did — but nothing saying what data landing
    // the main thread was chewing when it died. The ledger keeps (a) a ring of
    // recently COMPLETED main-thread batch applies and (b) the currently
    // RUNNING one, so the watchdog's report can point at "sc.reconcile(109)
    // started 8.2s ago and never finished" instead of guessing.

    private struct WorkEntry {
        let at: TimeInterval
        let label: String
        let count: Int?
        let ms: Double
    }

    /// Completed main-thread work items, newest last.
    private var workRing: [WorkEntry] = []
    /// In-flight work, innermost last (tracked entries can nest: a replayed
    /// turn-end inside replayQueuedEvents runs flushPendingDelta).
    private var activeWork: [(label: String, count: Int?, startedAt: TimeInterval)] = []
    private static let maxWorkEntries = 16

    private struct Crumb {
        let at: TimeInterval
        /// Usually a literal — never built from user content.
        let name: String
        /// Optional magnitude (chars, rows). Formatted lazily at read time.
        let count: Int?
    }

    private static let maxKeyboardEvents = 24
    private static let maxCrumbs = 8
    /// Window the keyboard-oscillation counter reports over.
    static let keyboardWindowSeconds: TimeInterval = 10

    /// Same clock as MainThreadWatchdog: CLOCK_UPTIME_RAW pauses across host
    /// sleep, so a napping simulator can't fabricate a 10s "window".
    static func uptimeNow() -> TimeInterval {
        TimeInterval(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000
    }

    private var started = false

    /// Call once at app startup (main thread), next to the watchdog's start().
    /// Subscribes the keyboard probes — the suspected oscillation loop of the
    /// build-35 freezes is only visible as a COUNT over a window.
    func start() {
        lock.lock()
        if started { lock.unlock(); return }
        started = true
        lock.unlock()
        // Posted on the main thread; the handler is a handful of scalar writes.
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillShowNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.noteKeyboard(visible: true) }
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillHideNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.noteKeyboard(visible: false) }
    }

    // MARK: - Push (main thread, hot paths)

    /// Current visible surface: "chat", "notes", "tasks", "settings",
    /// "session:<8-char id prefix>".
    func setScreen(_ name: String) {
        lock.lock()
        let changed = screen != name
        if changed {
            previousScreen = screen
            screen = name
            pushCrumbLocked(name: "screen", count: nil)
        }
        lock.unlock()
        // Universal nav trail: every `freezeScreen` surface lands on the tape
        // with no per-view instrumentation. The snapshot keeps only the current
        // screen plus one level of history, so the LOG is the only place the
        // full path through the app survives.
        if changed { emitCrumb(name: "screen:\(name)", count: nil) }
    }

    /// Leaving a surface. Guarded by name because SwiftUI runs the incoming
    /// view's onAppear BEFORE the outgoing view's onDisappear — an
    /// unconditional reset there would erase the screen we just entered.
    func clearScreen(_ name: String) {
        lock.lock()
        let restored = screen == name ? previousScreen : nil
        if let restored { screen = restored }
        lock.unlock()
        if let restored { emitCrumb(name: "screen-left:\(name)>\(restored)", count: nil) }
    }

    /// Per-keystroke. Pass a UTF-8 length (O(1)), never `String.count`.
    func setDraftChars(_ utf8Length: Int) {
        lock.lock(); draftChars = utf8Length; lock.unlock()
    }

    /// Live-turn size. Called from the ~8Hz delta flush, so: counts only, no
    /// content, no formatting.
    func setLiveText(chars: Int, truncated: Bool) {
        lock.lock()
        liveTextChars = chars
        liveTextTruncated = truncated
        lock.unlock()
    }

    func setHistoryRows(_ rows: Int) {
        lock.lock(); historyRows = rows; lock.unlock()
    }

    /// Breadcrumb of a notable action. `name` should be a literal;
    /// `count` carries the magnitude so callers never interpolate.
    func note(_ name: String, _ count: Int? = nil) {
        lock.lock()
        pushCrumbLocked(name: name, count: count)
        lock.unlock()
        // OUTSIDE the lock, deliberately: the sink writes to AppLog, which takes
        // its own lock, and nesting the two would invite a deadlock the day
        // either side grows a callback. `Breadcrumbs` installs the sink so every
        // crumb pushed anywhere in the app also lands on the uploaded tape —
        // the crumb ring only keeps the last 8, the log keeps all of them.
        emitCrumb(name: name, count: count)
    }

    /// Internal (not private) for WalnutTests: `at` lets a test place events on
    /// an explicit timeline instead of racing a 10s wall window.
    func noteKeyboard(visible: Bool, at: TimeInterval? = nil) {
        let now = at ?? Self.uptimeNow()
        lock.lock()
        keyboardVisible = visible
        keyboardEvents.append(now)
        if keyboardEvents.count > Self.maxKeyboardEvents {
            keyboardEvents.removeFirst(keyboardEvents.count - Self.maxKeyboardEvents)
        }
        pushCrumbLocked(name: visible ? "kb-show" : "kb-hide", count: nil, at: now)
        let flips = keyboardEvents.reduce(into: 0) { $0 += ($1 >= now - Self.keyboardWindowSeconds ? 1 : 0) }
        lock.unlock()
        // Keyboard oscillation is a leading indicator of the composer freeze
        // class, and the 10s flip COUNT is the signal — carry it on every line
        // so the log shows the ramp, not just the eventual freeze report.
        emitCrumb(name: visible ? "kb-show" : "kb-hide", count: flips)
    }

    // MARK: - Main-thread work ledger (push side; see MainWork)

    /// Begin an in-flight work item. Cheap: two locked appends, no formatting.
    /// Returns the uptime used as the entry's identity for `endWork`.
    func beginWork(_ label: String, count: Int?) -> TimeInterval {
        let now = Self.uptimeNow()
        lock.lock()
        activeWork.append((label, count, now))
        lock.unlock()
        return now
    }

    /// Complete the innermost in-flight item and move it into the ring.
    /// `startedAt` guards against unbalanced calls (a mismatch drops the pop).
    func endWork(startedAt: TimeInterval) -> Double {
        let now = Self.uptimeNow()
        lock.lock()
        guard let last = activeWork.last, last.startedAt == startedAt else {
            lock.unlock()
            return 0
        }
        activeWork.removeLast()
        let ms = (now - last.startedAt) * 1_000
        workRing.append(WorkEntry(at: now, label: last.label, count: last.count, ms: ms))
        if workRing.count > Self.maxWorkEntries {
            workRing.removeFirst(workRing.count - Self.maxWorkEntries)
        }
        lock.unlock()
        return ms
    }

    /// The freeze report's "who was on the main thread" line. Two parts:
    ///  - `RUNNING label(count) for Xs` — an item that BEGAN and never ended
    ///    is the killer in a wedge (the watchdog reads this mid-freeze);
    ///  - newest-first completed items with their measured cost.
    /// Formatting happens here (read side, once per report), never on push.
    func workTrail(now: TimeInterval? = nil) -> String {
        let at = now ?? Self.uptimeNow()
        lock.lock()
        let active = activeWork
        let ring = workRing
        lock.unlock()
        var parts: [String] = []
        // Innermost first: it is the frame actually executing.
        for item in active.reversed() {
            let age = String(format: "%.1f", max(0, at - item.startedAt))
            let magnitude = item.count.map { "(\($0))" } ?? ""
            parts.append("RUNNING \(item.label)\(magnitude) for \(age)s")
        }
        for entry in ring.reversed() {
            let age = String(format: "%.1f", max(0, at - entry.at))
            let magnitude = entry.count.map { "\($0), " } ?? ""
            parts.append("-\(age)s \(entry.label)(\(magnitude)\(String(format: "%.0f", entry.ms))ms)")
        }
        return parts.isEmpty ? "-" : parts.joined(separator: " | ")
    }

    // MARK: - Crumb sink (uploaded tape)

    /// Installed by `Breadcrumbs`; nil in unit tests unless a test sets it.
    /// Guarded by its own lock so the sink can be swapped while crumbs flow.
    private let sinkLock = NSLock()
    private var crumbSink: ((String, Int?) -> Void)?

    /// Register the sink every crumb is mirrored to. Called once at startup.
    func setCrumbSink(_ sink: ((String, Int?) -> Void)?) {
        sinkLock.lock()
        crumbSink = sink
        sinkLock.unlock()
    }

    private func emitCrumb(name: String, count: Int?) {
        sinkLock.lock()
        let sink = crumbSink
        sinkLock.unlock()
        sink?(name, count)
    }

    private func pushCrumbLocked(name: String, count: Int?, at: TimeInterval? = nil) {
        crumbs.append(Crumb(at: at ?? Self.uptimeNow(), name: name, count: count))
        if crumbs.count > Self.maxCrumbs {
            crumbs.removeFirst(crumbs.count - Self.maxCrumbs)
        }
    }

    // MARK: - Pull (watchdog's background queue)

    /// Keyboard show/hide notifications within the last `window` seconds. A
    /// healthy screen shows 0–2; a double-digit count IS the oscillation.
    /// Internal for WalnutTests.
    func keyboardTransitions(window: TimeInterval = FreezeContext.keyboardWindowSeconds,
                             now: TimeInterval? = nil) -> Int {
        let cutoff = (now ?? Self.uptimeNow()) - window
        lock.lock()
        defer { lock.unlock() }
        return keyboardEvents.reduce(into: 0) { $0 += ($1 >= cutoff ? 1 : 0) }
    }

    /// Flat `[String: String]` for AppLog meta. Keys are `ctx*`-prefixed so a
    /// single `grep ctxScreen` pulls every freeze line out of a log dump.
    /// SAFE OFF-MAIN: reads only this object's locked scalars plus the
    /// process's own memory footprint (a mach call, no UIKit, no main hop).
    func snapshotMeta(now: TimeInterval? = nil) -> [String: String] {
        let at = now ?? Self.uptimeNow()
        lock.lock()
        let screen = self.screen
        let keyboardVisible = self.keyboardVisible
        let draftChars = self.draftChars
        let historyRows = self.historyRows
        let liveTextChars = self.liveTextChars
        let liveTextTruncated = self.liveTextTruncated
        let crumbs = self.crumbs
        let kbEvents = self.keyboardEvents
        lock.unlock()

        let cutoff = at - Self.keyboardWindowSeconds
        let flips = kbEvents.reduce(into: 0) { $0 += ($1 >= cutoff ? 1 : 0) }
        // Newest first: the last thing that happened is the interesting one.
        let trail = crumbs.reversed().map { crumb -> String in
            let age = String(format: "%.1f", max(0, at - crumb.at))
            let magnitude = crumb.count.map { ":\($0)" } ?? ""
            return "-\(age)s \(crumb.name)\(magnitude)"
        }.joined(separator: " | ")

        return [
            "ctxScreen": screen,
            "ctxKeyboard": keyboardVisible ? "shown" : "hidden",
            "ctxKbFlips10s": String(flips),
            "ctxDraftChars": String(draftChars),
            "ctxHistoryRows": String(historyRows),
            "ctxLiveChars": String(liveTextChars),
            "ctxLiveTruncated": liveTextTruncated ? "1" : "0",
            "ctxMemoryMB": String(Self.residentMemoryMB()),
            "ctxTrail": trail.isEmpty ? "-" : trail,
            // Who was on the main thread: in-flight batch applies (the killer
            // in a wedge) + the last 16 completed ones with measured cost.
            "ctxMainWork": workTrail(now: at),
        ]
    }

    /// Physical footprint in MB (the number jetsam judges), or -1 if the mach
    /// call fails. Reading your own task info off the main thread is safe.
    static func residentMemoryMB() -> Int {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), raw, &count)
            }
        }
        guard result == KERN_SUCCESS else { return -1 }
        return Int(info.phys_footprint / (1024 * 1024))
    }

    /// Internal for WalnutTests — a shared singleton needs a clean slate
    /// between cases. Never called by product code.
    func resetForTesting() {
        lock.lock()
        screen = "?"
        previousScreen = "?"
        keyboardVisible = false
        keyboardEvents = []
        draftChars = 0
        historyRows = 0
        liveTextChars = 0
        liveTextTruncated = false
        crumbs = []
        workRing = []
        activeWork = []
        lock.unlock()
        // Also drop the crumb sink: a test that ran after app startup would
        // otherwise keep writing into the real AppLog pipeline.
        setCrumbSink(nil)
    }
}

extension View {
    /// One-line screen tracking for the freeze registry. Paired appear/disappear
    /// so a pop restores the surface underneath (see `clearScreen`).
    func freezeScreen(_ name: String) -> some View {
        onAppear { FreezeContext.shared.setScreen(name) }
            .onDisappear { FreezeContext.shared.clearScreen(name) }
    }
}
