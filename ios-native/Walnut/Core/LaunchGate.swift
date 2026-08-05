import Foundation
import UIKit
import os

/// One-shot "the app is really in front of the user" gate.
///
/// iOS launches an app's process in the BACKGROUND for prewarming and for
/// silent pushes. Such a process may never become active — and while it is not
/// active the OS still bills any scene-driving work against the ~10s
/// scene-update allowance, then kills the process (0x8BADF00D, elapsed CPU far
/// above what the app was actually scheduled for). A build-27 field crash was
/// exactly this: a background launch ran the full cold-start path (synchronous
/// cache decodes + the first SwiftUI render) under CPU starvation and died in
/// AttributeGraph layout with no user interaction at all.
///
/// So: NOTHING that hydrates state, opens a stream, polls, or probes the
/// network may run before the first activation. Register it here instead and it
/// fires on `didBecomeActiveNotification` — the only notification that arrives
/// for all of cold launch, a prewarmed process finally opened, and a
/// background→foreground return (same signal `MainThreadWatchdog` arms on).
///
/// Deliberately NOT gated: MetricKit crash delivery and the AppLog uploader.
/// They are the telemetry path, they never touch SwiftUI, and a crash report
/// that waits for an activation that may never come is a lost crash report.
@MainActor
final class LaunchGate {
    static let shared = LaunchGate()

    /// True once the app has become active at least once this process lifetime.
    private(set) var hasActivated = false
    /// True when the process was launched into the background (prewarm / push).
    let launchedInBackground: Bool

    private var pending: [() -> Void] = []

    private init() {
        // `.background` at App.init time is the documented discriminator for a
        // prewarmed/background launch; a normal launch reports `.inactive`.
        launchedInBackground = UIApplication.shared.applicationState == .background
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { LaunchGate.shared.activate() }
        }
    }

    /// Run `work` now if the app is already active, else on first activation.
    /// Pessimistic by design: a normal foreground launch activates within a
    /// frame or two of the first render, so the cost is a few milliseconds.
    func whenActive(_ work: @escaping () -> Void) {
        if hasActivated {
            work()
        } else {
            pending.append(work)
        }
    }

    /// Async convenience — the task is created only once activated.
    func whenActive(_ work: @escaping @MainActor () async -> Void) {
        whenActive { Task { @MainActor in await work() } }
    }

    private func activate() {
        hasActivated = true
        guard !pending.isEmpty else { return }
        let work = pending
        pending.removeAll()
        LaunchTrace.mark("activation: running \(work.count) deferred startup job(s)")
        for job in work { job() }
    }
}

/// Cold-start budget instrumentation. Proves the first frame is committed
/// without waiting on any disk read — the invariant P0-1 exists to protect.
///
/// Emits os_signpost intervals (visible in Instruments / `log stream
/// --predicate 'subsystem == "dev.openwalnut.launch"'`) plus a DEBUG print.
enum LaunchTrace {
    private static let log = OSLog(subsystem: "dev.openwalnut.launch", category: "coldstart")
    /// Process start, read from the kernel — not from our own first line of
    /// code, so pre-main dyld/runtime time is included.
    static let processStart: Date = Self.kernelProcessStart() ?? Date()
    private static let firstFrameMarked = OSAllocatedUnfairLock(initialState: false)

    static func mark(_ label: String) {
        let elapsed = Date().timeIntervalSince(processStart) * 1000
        os_signpost(.event, log: log, name: "launch", "%{public}@ at %.1fms", label, elapsed)
        #if DEBUG
        print(String(format: "[launch] %@ +%.1fms", label, elapsed))
        #endif
    }

    /// Called from the root view's first render. Reports the elapsed budget and
    /// how many SYNCHRONOUS DiskCache reads happened before it — must be 0.
    @MainActor
    static func markFirstFrame() {
        let alreadyMarked = firstFrameMarked.withLock { marked -> Bool in
            defer { marked = true }
            return marked
        }
        guard !alreadyMarked else { return }
        let elapsed = Date().timeIntervalSince(processStart) * 1000
        let syncLoads = DiskCache.synchronousLoadCount
        os_signpost(
            .event, log: log, name: "firstFrame",
            "firstFrame at %.1fms syncDiskLoads=%d background=%{public}@",
            elapsed, syncLoads, LaunchGate.shared.launchedInBackground ? "yes" : "no"
        )
        #if DEBUG
        print(String(format: "[launch] firstFrame +%.1fms syncDiskLoads=%d", elapsed, syncLoads))
        #endif
        // Field-visible too: a regression that reintroduces a blocking cache
        // read on the startup path shows up in the uploaded client log.
        AppLog.info("launch", "first frame", [
            "elapsedMs": String(format: "%.0f", elapsed),
            "syncDiskLoads": String(syncLoads),
            "launchedInBackground": LaunchGate.shared.launchedInBackground ? "true" : "false",
        ])
    }

    private static func kernelProcessStart() -> Date? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return nil }
        let started = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000)
    }
}
