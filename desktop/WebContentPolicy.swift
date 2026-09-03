import Foundation

// MARK: - WebContent watchdog: pure policy
//
// The Mac app is one WKWebView that lives as long as the app does. A browser
// tab gets closed and reopened; this page process does not, so everything the
// compositor keeps (tiles for kept-alive iframes, layers for panels that were
// opened once) accumulates for days. Measured 2026-09-02: after ~11h the
// WebContent process held 2.7GB of graphics memory (891 IOSurfaces) and the
// main thread froze for 17s at a time with no JavaScript on the stack, while
// Chrome on the same server was smooth because it was a fresh process on the
// current bundle.
//
// The leaks that were found are fixed in the web app. This policy is the
// guarantee for the ones that are not found yet: measure the page process,
// report it, and when it is bloated and the user is not looking, replace it.
// The same idle gate lets the shell pick up a newer server bundle without
// waiting for a lazy import to fail under the user's click.
//
// Foundation only: `scripts/test-desktop.sh` compiles this file into a plain
// test binary, so nothing here may touch AppKit or WebKit.

enum FootprintLevel: String {
    case normal
    case high
    case critical
}

enum RecycleReason: String {
    /// Over the recycle threshold and the user is idle or the window is hidden.
    case footprint
    /// So far over the threshold that a short pause in input is enough.
    case footprintForced = "footprint_forced"
    /// The server serves a newer bundle than the one loaded in the page.
    case staleBundle = "stale_bundle"
}

enum WatchdogVerdict: Equatable {
    case hold
    case recycle(RecycleReason)
    /// Wanted to recycle; a gate said no. `why` is a stable token for logs.
    case suppressed(RecycleReason, why: String)
}

struct WebContentSample {
    var footprintBytes: UInt64
    /// Seconds since this WebContent process started serving the window.
    var processAge: TimeInterval
    /// Seconds since the user's last keyboard/mouse event anywhere on the Mac.
    var userIdle: TimeInterval
    /// Window is on screen: not miniaturized, not fully occluded, app not hidden.
    var windowVisible: Bool
    var bundleStale: Bool
}

struct WebContentPolicy {
    static let megabyte: UInt64 = 1_048_576

    var sampleInterval: TimeInterval = 60
    /// Above this the sample is logged at warn level.
    var warnBytes: UInt64 = 1_500 * megabyte
    /// Above this the page process is replaced once the user is idle.
    var recycleBytes: UInt64 = 2_200 * megabyte
    /// Above this a short pause in input is enough: at this size the app is
    /// already freezing for seconds at a time, waiting for idle means waiting
    /// for the user to give up.
    var forceBytes: UInt64 = 3_500 * megabyte
    var idleForRecycle: TimeInterval = 90
    var pauseForForce: TimeInterval = 10
    /// Nothing is wrong with a stale bundle, so it waits for a real break.
    var idleForStaleBundle: TimeInterval = 300
    /// A fresh page legitimately spikes while it boots and hydrates.
    var minProcessAge: TimeInterval = 300
    var maxRecyclesPerHour = 3
    /// Log every Nth quiet sample; level changes always log.
    var reportEverySamples = 5

    // UserDefaults keys (`defaults write com.local.walnut-desktop <key> <value>`).
    static let enabledKey = "walnutWebContentWatchdog"
    static let warnKey = "walnutWebContentWarnMB"
    static let recycleKey = "walnutWebContentRecycleMB"

    /// Whether the watchdog runs at all. Default on; `-bool NO` turns it off.
    static func isEnabled(_ defaults: UserDefaults) -> Bool {
        defaults.object(forKey: enabledKey) == nil || defaults.bool(forKey: enabledKey)
    }

    /// Thresholds may be tuned per machine (a 16GB Mac wants a lower recycle
    /// point than a 128GB one). Anything unset or nonsensical keeps the default.
    static func fromDefaults(_ defaults: UserDefaults) -> WebContentPolicy {
        var policy = WebContentPolicy()
        let warn = defaults.integer(forKey: warnKey)
        if warn >= 256 { policy.warnBytes = UInt64(warn) * megabyte }
        let recycle = defaults.integer(forKey: recycleKey)
        if recycle >= 512 { policy.recycleBytes = UInt64(recycle) * megabyte }
        if policy.recycleBytes < policy.warnBytes { policy.warnBytes = policy.recycleBytes }
        if policy.forceBytes < policy.recycleBytes { policy.forceBytes = policy.recycleBytes }
        return policy
    }

    func level(for bytes: UInt64) -> FootprintLevel {
        if bytes >= recycleBytes { return .critical }
        if bytes >= warnBytes { return .high }
        return .normal
    }

    func verdict(for sample: WebContentSample, state: WebContentWatchdogState, now: Date) -> WatchdogVerdict {
        let reason: RecycleReason
        let gateOpen: Bool
        let hidden = !sample.windowVisible
        if sample.footprintBytes >= forceBytes {
            reason = .footprintForced
            gateOpen = hidden || sample.userIdle >= pauseForForce
        } else if sample.footprintBytes >= recycleBytes {
            reason = .footprint
            gateOpen = hidden || sample.userIdle >= idleForRecycle
        } else if sample.bundleStale {
            reason = .staleBundle
            gateOpen = hidden || sample.userIdle >= idleForStaleBundle
        } else {
            return .hold
        }
        if sample.processAge < minProcessAge { return .suppressed(reason, why: "process_too_young") }
        if !gateOpen { return .suppressed(reason, why: "user_active") }
        if state.recyclesWithin(3600, of: now) >= maxRecyclesPerHour {
            return .suppressed(reason, why: "rate_limited")
        }
        return .recycle(reason)
    }
}

struct WebContentWatchdogState {
    var recycleTimes: [Date] = []
    var lastLevel: FootprintLevel?
    var samplesSinceReport = 0
    var lastSuppression: String?

    func recyclesWithin(_ seconds: TimeInterval, of now: Date) -> Int {
        recycleTimes.filter { now.timeIntervalSince($0) < seconds }.count
    }

    mutating func recordRecycle(at now: Date) {
        recycleTimes = recycleTimes.filter { now.timeIntervalSince($0) < 3600 }
        recycleTimes.append(now)
    }

    /// One line per five minutes when nothing changes, one line immediately
    /// when the level moves: enough to draw the curve, not enough to bury
    /// the rest of the log.
    mutating func shouldReport(level: FootprintLevel, policy: WebContentPolicy) -> Bool {
        samplesSinceReport += 1
        let changed = lastLevel != level
        lastLevel = level
        if changed || samplesSinceReport >= policy.reportEverySamples {
            samplesSinceReport = 0
            return true
        }
        return false
    }

    /// A suppression repeats every sample while the user keeps working over the
    /// threshold; log it when it starts and when its cause changes, not every minute.
    mutating func shouldReportSuppression(_ verdict: WatchdogVerdict) -> Bool {
        guard case let .suppressed(reason, why) = verdict else {
            lastSuppression = nil
            return false
        }
        let key = "\(reason.rawValue):\(why)"
        if lastSuppression == key { return false }
        lastSuppression = key
        return true
    }
}

/// Formats bytes the way the log reader thinks: whole megabytes.
func megabytes(_ bytes: UInt64) -> Int {
    Int(bytes / WebContentPolicy.megabyte)
}

/// Pulls the Vite entry hash out of a served or loaded index.html / script URL
/// (`/assets/index-SGKAbTQh.js` → `SGKAbTQh`). Nil when the markup has no entry
/// script, which happens while a deploy is mid-flight: the caller treats nil as
/// "unknown", never as "changed".
func bundleId(inHTML html: String) -> String? {
    guard let range = html.range(of: #"assets/index-([A-Za-z0-9_-]+)\.js"#, options: .regularExpression) else {
        return nil
    }
    let match = html[range]
    let start = match.index(match.startIndex, offsetBy: "assets/index-".count)
    let end = match.index(match.endIndex, offsetBy: -".js".count)
    return String(match[start..<end])
}
