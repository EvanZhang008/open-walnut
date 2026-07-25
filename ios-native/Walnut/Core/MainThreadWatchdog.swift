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
    private var backgrounded = false
    private var hangStart: TimeInterval?

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
        // Suspension guard: while backgrounded the whole process freezes, and
        // on resume Date() has jumped — without this flag the first tick after
        // resume would misread the gap as a giant hang.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.setBackgrounded(true) }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
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
        if stalled > Self.hangThreshold, ongoingHang == nil {
            lock.lock(); hangStart = last; lock.unlock()
            // All main-thread-free: AppLog's lock append, file write, and
            // URLSession upload run fine while the UI is frozen.
            AppLog.error("freeze", "main thread unresponsive", [
                "stalledSeconds": String(format: "%.1f", stalled),
                "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
            ])
            AppLog.shared.persistNow()
            // Field freezes were invisible: a user who force-quits (or a freeze
            // that starts as the app suspends) hit AppLog's inBackground gate and
            // the report never left the device. uploadCritical bypasses the gate
            // once and holds a background task so the OS grants time to finish.
            AppLog.shared.uploadCritical()
        } else if stalled < Self.pingInterval * 1.5, let began = ongoingHang {
            lock.lock(); hangStart = nil; lock.unlock()
            AppLog.error("freeze", "main thread recovered", [
                "hangSeconds": String(format: "%.1f", Self.uptimeNow() - began),
                "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
            ])
            AppLog.shared.persistNow()
            AppLog.shared.uploadCritical()
        }
    }
}
