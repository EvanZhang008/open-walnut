import Foundation

/// WebContentPolicy (desktop/WebContentPolicy.swift): the rules that decide when
/// the Mac app replaces its page process. Each check below is a way the
/// watchdog could hurt instead of help: swapping the page under someone's
/// hands, swapping a page that is still booting, spinning on a server that
/// keeps changing, or logging so often the log is useless.
@main
struct WebContentPolicyTests {
    static func main() {
        let policy = WebContentPolicy()
        let mb = WebContentPolicy.megabyte
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var state = WebContentWatchdogState()

        func sample(_ footprintMB: UInt64, age: TimeInterval = 3600, idle: TimeInterval = 0,
                    visible: Bool = true, stale: Bool = false) -> WebContentSample {
            WebContentSample(footprintBytes: footprintMB * mb, processAge: age, userIdle: idle,
                             windowVisible: visible, bundleStale: stale)
        }

        // Levels follow the two thresholds.
        precondition(policy.level(for: 900 * mb) == .normal)
        precondition(policy.level(for: 1_600 * mb) == .high)
        precondition(policy.level(for: 2_300 * mb) == .critical)

        // A healthy process is left alone whatever the user is doing.
        precondition(policy.verdict(for: sample(900, idle: 9_999), state: state, now: now) == .hold)

        // Over the threshold but the user is typing: hold, and say why.
        precondition(policy.verdict(for: sample(2_300, idle: 5), state: state, now: now)
                     == .suppressed(.footprint, why: "user_active"))
        // Same process, user stepped away: recycle.
        precondition(policy.verdict(for: sample(2_300, idle: 120), state: state, now: now) == .recycle(.footprint))
        // Or the window is not on screen: the swap is invisible, idle is moot.
        precondition(policy.verdict(for: sample(2_300, idle: 0, visible: false), state: state, now: now)
                     == .recycle(.footprint))

        // A page that is still booting spikes legitimately; never recycle it.
        precondition(policy.verdict(for: sample(2_300, age: 60, idle: 999), state: state, now: now)
                     == .suppressed(.footprint, why: "process_too_young"))

        // Far past the threshold a short pause is enough (the app is already freezing).
        precondition(policy.verdict(for: sample(3_600, idle: 3), state: state, now: now)
                     == .suppressed(.footprintForced, why: "user_active"))
        precondition(policy.verdict(for: sample(3_600, idle: 15), state: state, now: now)
                     == .recycle(.footprintForced))

        // A newer server bundle waits for a real break, not a pause.
        precondition(policy.verdict(for: sample(900, idle: 120, stale: true), state: state, now: now)
                     == .suppressed(.staleBundle, why: "user_active"))
        precondition(policy.verdict(for: sample(900, idle: 400, stale: true), state: state, now: now)
                     == .recycle(.staleBundle))
        // Memory outranks staleness in the reported reason.
        precondition(policy.verdict(for: sample(2_300, idle: 400, stale: true), state: state, now: now)
                     == .recycle(.footprint))

        // Rate limit: three swaps an hour, then hold even when everything else says go.
        for i in 0..<3 { state.recordRecycle(at: now.addingTimeInterval(TimeInterval(-600 * (i + 1)))) }
        precondition(policy.verdict(for: sample(2_300, idle: 999), state: state, now: now)
                     == .suppressed(.footprint, why: "rate_limited"))
        // The window slides: an hour later the budget is back.
        precondition(policy.verdict(for: sample(2_300, idle: 999), state: state, now: now.addingTimeInterval(3_601))
                     == .recycle(.footprint))

        // Report cadence: first sample logs, then every fifth, and any level change.
        var cadence = WebContentWatchdogState()
        precondition(cadence.shouldReport(level: .normal, policy: policy), "first sample must log")
        for _ in 0..<4 { precondition(!cadence.shouldReport(level: .normal, policy: policy)) }
        precondition(cadence.shouldReport(level: .normal, policy: policy), "fifth quiet sample must log")
        precondition(!cadence.shouldReport(level: .normal, policy: policy))
        precondition(cadence.shouldReport(level: .high, policy: policy), "a level change logs at once")

        // Suppression is logged when it starts and when its cause changes, not per minute.
        var sup = WebContentWatchdogState()
        precondition(sup.shouldReportSuppression(.suppressed(.footprint, why: "user_active")))
        precondition(!sup.shouldReportSuppression(.suppressed(.footprint, why: "user_active")))
        precondition(sup.shouldReportSuppression(.suppressed(.footprint, why: "rate_limited")))
        precondition(!sup.shouldReportSuppression(.hold))
        precondition(sup.shouldReportSuppression(.suppressed(.footprint, why: "rate_limited")),
                     "after a hold, the same suppression is news again")

        // Defaults: overrides must be sane or ignored, and stay ordered.
        let defaults = UserDefaults(suiteName: "walnut-webcontent-policy-tests")!
        defaults.removePersistentDomain(forName: "walnut-webcontent-policy-tests")
        precondition(WebContentPolicy.isEnabled(defaults), "watchdog is on unless turned off")
        defaults.set(false, forKey: WebContentPolicy.enabledKey)
        precondition(!WebContentPolicy.isEnabled(defaults))
        defaults.set(64, forKey: WebContentPolicy.warnKey)       // too small: ignored
        defaults.set(1_000, forKey: WebContentPolicy.recycleKey) // below the default warn: warn follows
        let tuned = WebContentPolicy.fromDefaults(defaults)
        precondition(tuned.recycleBytes == 1_000 * mb)
        precondition(tuned.warnBytes == 1_000 * mb, "warn can never sit above recycle")
        precondition(tuned.forceBytes >= tuned.recycleBytes)
        defaults.removePersistentDomain(forName: "walnut-webcontent-policy-tests")

        // Bundle id extraction from served HTML.
        precondition(bundleId(inHTML: "<script type=\"module\" crossorigin src=\"/assets/index-SGKAbTQh.js\"></script>") == "SGKAbTQh")
        precondition(bundleId(inHTML: "<html><body>deploying</body></html>") == nil,
                     "no entry script reads as unknown, never as changed")

        print("WebContent policy tests passed")
    }
}
