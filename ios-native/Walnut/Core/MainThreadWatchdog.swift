import Foundation
import UIKit

/// Real-time freeze detector. Crash reporting (MetricKit) only fires when the
/// process DIES — a frozen app that the user force-quits produces nothing.
/// This watchdog runs on a background queue (which keeps running while the
/// main thread is stuck), pings the main queue every 2s, and when the pong
/// doesn't come back within the threshold it reports the freeze THROUGH the
/// background thread: AppLog append, disk persist, and upload are all
/// main-thread-free, so the report escapes even while the UI is dead.
/// MetricKit's hangDiagnostics (CrashReporter.swift) complements this with
/// the OS-sampled stack of the hang, delivered on a later launch.
final class MainThreadWatchdog: @unchecked Sendable {
    static let shared = MainThreadWatchdog()

    private let queue = DispatchQueue(label: "walnut.watchdog", qos: .utility)
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var lastPong = MainThreadWatchdog.uptimeNow()
    private var pingInFlight = false
    // Pessimistic default: don't count stall time until the app has
    // demonstrably become ACTIVE. iOS prewarms apps (process launched in the
    // background, then suspended before ever activating) — with an optimistic
    // `false` here the first tick after the user finally opens the app counted
    // the entire suspension as a hang (field: a 5942s "freeze" on build 27).
    private var backgrounded = true
    private var hangStart: TimeInterval?
    /// Mach port of the main thread, captured in start() (which runs on the
    /// main thread). The stall sampler suspends/reads/resumes THIS thread from
    /// the watchdog queue while it is frozen. Held for the process lifetime.
    private var mainThreadPort: thread_act_t = 0
    /// Stacks sampled while a stall is BUILDING (one per 2s tick past the
    /// sampling threshold, ring-bounded). A freeze that dies before the 5s
    /// report line still leaves these in the report when it fires; a freeze
    /// that recovers discards them.
    private var stallSamples: [String] = []
    private static let samplingThreshold: TimeInterval = 1.5
    private static let maxStallSamples = 3

    /// CLOCK_UPTIME_RAW pauses while the host sleeps. Wall-clock Date() does
    /// not: a simulator riding a Mac through clamshell sleep wakes up with a
    /// minutes-long Date() gap and no didEnterBackground (that guard only
    /// covers iOS app backgrounding), which reported the entire nap as a
    /// "main thread unresponsive" hang. Stall time must count awake time only.
    private static func uptimeNow() -> TimeInterval {
        TimeInterval(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000
    }

    private static let pingInterval: TimeInterval = 2
    private static let hangThreshold: TimeInterval = 5

    /// Call once at app startup (main thread).
    func start() {
        guard timer == nil else { return }
        // Capture the main thread's mach port while we ARE the main thread —
        // this is what lets the sampler target it later from the background.
        mainThreadPort = mach_thread_self()
        // Suspension guard: while backgrounded the whole process freezes, and
        // on resume Date() has jumped — without this flag the first tick after
        // resume would misread the gap as a giant hang.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.setBackgrounded(true) }
        // didBecomeActive (not willEnterForeground) is the ARM signal: it is
        // the only notification that fires on ALL of cold launch, prewarmed
        // launch finally opened, and background→foreground return. A prewarmed
        // process never becomes active, so the watchdog stays disarmed for it.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.setBackgrounded(false) }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private func setBackgrounded(_ value: Bool) {
        lock.lock()
        backgrounded = value
        lastPong = Self.uptimeNow() // reset the clock across suspend/resume boundaries
        pingInFlight = false
        lock.unlock()
    }

    private func tick() {
        lock.lock()
        let bg = backgrounded
        let inFlight = pingInFlight
        let last = lastPong
        let ongoingHang = hangStart
        lock.unlock()

        if bg { return }

        if !inFlight {
            lock.lock(); pingInFlight = true; lock.unlock()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.lock.lock()
                self.lastPong = Self.uptimeNow()
                self.pingInFlight = false
                self.lock.unlock()
            }
        }

        let stalled = Self.uptimeNow() - last
        // Stall-building sampler: once a stall crosses the sampling threshold
        // (well before the 5s report line), capture the frozen main thread's
        // stack on each 2s tick into a small ring. Two properties:
        //  - the 5s report ships stacks from EARLY in the stall, not just its
        //    5s mark — a compute loop's shape shows as differing tops;
        //  - a kill that lands before the report fires (0x8BADF00D grants no
        //    grace) still leaves the samples in the persisted log tail.
        // Safe here: this queue is the watchdog's own; StallSampler's
        // suspended-window rules make the capture allocation-free.
        if stalled > Self.samplingThreshold, mainThreadPort != 0, stallSamples.count < Self.maxStallSamples {
            if let frames = StallSampler.sample(thread: mainThreadPort) {
                stallSamples.append(frames.joined(separator: " <- "))
                // Persist each sample as its own line immediately — the report
                // may never come (kill first), but the disk queue survives.
                AppLog.error("freeze", "stall sample", [
                    "stalledSeconds": String(format: "%.1f", stalled),
                    "sampleIndex": String(stallSamples.count),
                    "mainStack": stallSamples.last ?? "-",
                ])
                AppLog.shared.persistNow()
            }
        }
        if stalled > Self.hangThreshold, ongoingHang == nil {
            lock.lock(); hangStart = last; lock.unlock()
            // The report carries every stack sampled while the stall built
            // (the 5-kill blind spot: OS kill stacks were 100% anonymous
            // SwiftUICore/AttributeGraph offsets with nothing attributable —
            // these samples name the Walnut frames underneath).
            var extra = ["stalledSeconds": String(format: "%.1f", stalled)]
            for (i, sample) in stallSamples.enumerated() {
                extra[i == 0 ? "mainStack" : "mainStack\(i + 1)"] = sample
            }
            // All main-thread-free: AppLog's lock append, file write, and
            // URLSession upload run fine while the UI is frozen. Same for the
            // FreezeContext merge below — it reads a PRE-WRITTEN snapshot under
            // its own lock and never touches UIKit or the main queue.
            AppLog.error("freeze", "main thread unresponsive", Self.meta(extra))
            AppLog.shared.persistNow()
            // Field freezes were invisible: a user who force-quits (or a freeze
            // that starts as the app suspends) hit AppLog's inBackground gate and
            // the report never left the device. uploadCritical bypasses the gate
            // once and holds a background task so the OS grants time to finish.
            AppLog.shared.uploadCritical()
        } else if stalled < Self.pingInterval * 1.5 {
            stallSamples = [] // main thread answered — the ring belonged to that stall
            if let began = ongoingHang {
                lock.lock(); hangStart = nil; lock.unlock()
                // Recovered hangs get the SAME context: a sub-threshold stall is
                // this bug at smaller scale and roughly 10x more frequent, so it is
                // the better statistical sample of which screen/state freezes.
                AppLog.error("freeze", "main thread recovered", Self.meta([
                    "hangSeconds": String(format: "%.1f", Self.uptimeNow() - began),
                ]))
                AppLog.shared.persistNow()
                AppLog.shared.uploadCritical()
            }
        }
    }

    /// Build + the freeze-context snapshot, merged under the caller's own keys.
    /// String formatting lives here (report path, at most once per freeze) —
    /// never on the push paths that feed FreezeContext.
    private static func meta(_ base: [String: String]) -> [String: String] {
        var meta = base
        meta["build"] = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        for (key, value) in FreezeContext.shared.snapshotMeta() { meta[key] = value }
        return meta
    }
}
