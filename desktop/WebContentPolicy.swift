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
    /// Over the recycle threshold, and the user paused or the window is hidden.
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
    /// Above this the page process is replaced at the user's next short pause.
    var recycleBytes: UInt64 = 2_200 * megabyte
    /// Above this an even shorter pause is enough: at this size the app is
    /// already freezing for seconds at a time.
    var forceBytes: UInt64 = 3_500 * megabyte
    /// Critical memory waits only for a short pause, never for the user to step
    /// away. 2026-11-08: a page at 2.4 GB stopped painting (empty dark blocks where
    /// the text was) while the user worked on; the old 90 s idle gate held the swap
    /// back for minutes, and on 11-07 for a whole hour at 2.2 to 3.0 GB, because
    /// someone working never goes 90 s without input. The swap keeps the URL and
    /// every draft the page keeps in storage, and never runs over unsaved text
    /// (the shell asks the page first).
    var pauseForRecycle: TimeInterval = 8
    var pauseForForce: TimeInterval = 3
    /// While critical memory waits for a pause, the pause is looked for this often
    /// (the user's idle time only, no footprint read): a once-a-minute sample of
    /// someone working almost never lands inside an 8 s pause.
    var pauseCheckInterval: TimeInterval = 2
    /// How long the page has to say whether it holds unsaved text. A page process
    /// at critical memory can hang, and a question it never answers held every
    /// later swap behind it (`recycleInFlight`): no answer in time counts as
    /// "unsaved", so nothing is lost and the person decides.
    var pageAnswerDeadline: TimeInterval = 3
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
    /// Seconds between samples and the youngest process a swap may replace: for a
    /// test copy, usually as launch arguments (`-walnutWebContentSampleSec 5`),
    /// which UserDefaults reads and never stores.
    static let sampleKey = "walnutWebContentSampleSec"
    static let minAgeKey = "walnutWebContentMinAgeSec"
    static let reduceGlassKey = "walnutReduceGlass"

    /// Whether the watchdog runs at all. Default on; `-bool NO` turns it off.
    static func isEnabled(_ defaults: UserDefaults) -> Bool {
        defaults.object(forKey: enabledKey) == nil || defaults.bool(forKey: enabledKey)
    }

    /// Whether to strip `backdrop-filter` from the page.
    ///
    /// Off by default, because it changes how the app looks and the cost has not
    /// been proven. It exists because the cost CANNOT be measured from outside:
    /// WebKit composites a backdrop blur in WindowServer (Chromium does it inside
    /// its own GPU process), which is why the same page can feel fine in Chrome and
    /// slow here, and why headless WebKit — no WindowServer — measures no
    /// difference at all. With ~14 blurred layers covering 41% of the window at
    /// three session columns, several of them `blur(44px) saturate(1.8)`, the only
    /// honest way to settle it is to let the user flip it and say which felt better.
    static func reduceGlass(_ defaults: UserDefaults) -> Bool {
        defaults.bool(forKey: reduceGlassKey)
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
        let sample = defaults.integer(forKey: sampleKey)
        if sample >= 5 { policy.sampleInterval = TimeInterval(sample) }
        if defaults.object(forKey: minAgeKey) != nil {
            let age = defaults.integer(forKey: minAgeKey)
            if age >= 10 { policy.minProcessAge = TimeInterval(age) }
        }
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
            gateOpen = hidden || sample.userIdle >= pauseForRecycle
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

    /// Whether the runtime should look for the user's next pause between samples:
    /// only for a memory swap held back by input, the one hold a pause ends.
    func wantsPauseCheck(_ verdict: WatchdogVerdict) -> Bool {
        guard case let .suppressed(reason, why) = verdict, why == "user_active" else { return false }
        return reason == .footprint || reason == .footprintForced
    }
}

/// The notice the shell draws over the page while a page at critical memory is
/// not replaced (the user keeps working, text a reload would lose, the hourly
/// budget spent). It is native, not part of the page, because the failure it is
/// for is a page process that no longer paints: a notice in the page would be
/// as blank as the rest of it.
struct MemoryNoticeState {
    /// How long a dismissed notice stays away while the page is still critical.
    static let snooze: TimeInterval = 600

    private(set) var shown = false
    private var dismissedAt: Date?

    /// One sample in, whether the notice should be on screen out. Shown from the
    /// first critical sample that is not swapped at once; kept through the dips
    /// under the threshold a bloated page makes (2404, 2168, 2214, 1993 MB a
    /// minute apart on 11-08) until the page is back under the warn level or its
    /// process is replaced (`reset`).
    mutating func update(level: FootprintLevel, verdict: WatchdogVerdict, now: Date) -> Bool {
        if level == .normal {
            shown = false
            dismissedAt = nil
            return false
        }
        if case .recycle = verdict { shown = false; return false }
        if let dismissedAt, now.timeIntervalSince(dismissedAt) < Self.snooze { shown = false; return false }
        if level == .critical { shown = true }
        return shown
    }

    mutating func dismiss(at now: Date) {
        shown = false
        dismissedAt = now
    }

    mutating func reset() { self = MemoryNoticeState() }
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

/// The dirty bytes per category of `footprint -p <pid>`, largest first. The
/// watchdog logs the top of it when a page goes high or critical, so the next
/// bloated page says what holds the memory (the JavaScript and DOM heap is
/// "WebKit malloc", the compositor's tiles and layers are the "(graphics)" rows)
/// instead of only how much. Unknown lines are skipped; a changed table format
/// gives an empty answer, never a wrong one.
func footprintCategories(_ text: String) -> [(category: String, bytes: UInt64)] {
    let units: [String: Double] = ["B": 1, "KB": 1_024, "MB": 1_048_576, "GB": 1_073_741_824]
    var rows: [(category: String, bytes: UInt64)] = []
    let pattern = #"^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\s+[0-9.]+\s*(?:B|KB|MB|GB)\s+[0-9.]+\s*(?:B|KB|MB|GB)\s+[0-9]+\s+(.+?)\s*$"#
    guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
        let s = String(line)
        let range = NSRange(s.startIndex..., in: s)
        guard let m = re.firstMatch(in: s, range: range), m.numberOfRanges == 4,
              let v = Range(m.range(at: 1), in: s), let u = Range(m.range(at: 2), in: s),
              let c = Range(m.range(at: 3), in: s),
              let value = Double(s[v]), let unit = units[String(s[u])] else { continue }
        let category = String(s[c])
        if category == "TOTAL" { continue }
        rows.append((category, UInt64(value * unit)))
    }
    return rows.sorted { $0.bytes > $1.bytes }
}

/// When the watchdog logs a bloated process's footprint by category: as it goes
/// high, as it goes critical, and every ten minutes while it stays high, so a
/// long session draws the curve of each category (2026-11-08: one page at 2.0 GB
/// held 1.1 GB of compositor surfaces and 0.9 GB of WebKit heap, against 77 MB and
/// 440 MB fresh, and only a curve over the user's own work can say which grows
/// with what). One `footprint` run costs about half a second of a utility thread.
struct BreakdownCadence {
    static let every: TimeInterval = 600
    private var level: FootprintLevel?
    private var at: Date?

    mutating func due(level current: FootprintLevel, now: Date) -> Bool {
        guard current != .normal else { return false }
        let rose = level == nil || (level == .high && current == .critical)
        let stale = at.map { now.timeIntervalSince($0) >= Self.every } ?? true
        guard rose || stale else { return false }
        if level != .critical { level = current }
        at = now
        return true
    }
}

/// `WebKit malloc=1990;Owned physical footprint (unmapped) (graphics)=312;...`:
/// the top categories in whole megabytes, for one log field.
func footprintSummary(_ rows: [(category: String, bytes: UInt64)], top: Int = 5) -> String {
    rows.prefix(top).map { "\($0.category)=\(megabytes($0.bytes))" }.joined(separator: ";")
}

/// One answer from a call that may never answer (a page's JavaScript on a hung
/// process): the first of the reply and the deadline is delivered, the other is
/// dropped. Main thread only.
final class OnceAnswer<T> {
    private var done = false
    private let completion: (T) -> Void
    init(_ completion: @escaping (T) -> Void) { self.completion = completion }
    /// True when this call was the one delivered.
    @discardableResult func answer(_ value: T) -> Bool {
        guard !done else { return false }
        done = true
        completion(value)
        return true
    }
}
