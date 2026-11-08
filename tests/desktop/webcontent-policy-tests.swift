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
        // A short pause is enough at critical memory (2026-11-08: a page at 2.4 GB
        // stopped painting while a 90 s idle gate waited for the user to step away).
        precondition(policy.verdict(for: sample(2_300, idle: 8), state: state, now: now) == .recycle(.footprint))
        precondition(policy.verdict(for: sample(2_300, idle: 120), state: state, now: now) == .recycle(.footprint))
        // Or the window is not on screen: the swap is invisible, idle is moot.
        precondition(policy.verdict(for: sample(2_300, idle: 0, visible: false), state: state, now: now)
                     == .recycle(.footprint))

        // A page that is still booting spikes legitimately; never recycle it.
        precondition(policy.verdict(for: sample(2_300, age: 60, idle: 999), state: state, now: now)
                     == .suppressed(.footprint, why: "process_too_young"))

        // Far past the threshold a short pause is enough (the app is already freezing).
        precondition(policy.verdict(for: sample(3_600, idle: 2), state: state, now: now)
                     == .suppressed(.footprintForced, why: "user_active"))
        precondition(policy.verdict(for: sample(3_600, idle: 3), state: state, now: now)
                     == .recycle(.footprintForced))

        // Between samples the runtime looks for the pause only for a memory swap held by input.
        precondition(policy.wantsPauseCheck(.suppressed(.footprint, why: "user_active")))
        precondition(policy.wantsPauseCheck(.suppressed(.footprintForced, why: "user_active")))
        precondition(!policy.wantsPauseCheck(.suppressed(.staleBundle, why: "user_active")),
                     "a newer bundle waits for a real break, not a pause")
        precondition(!policy.wantsPauseCheck(.suppressed(.footprint, why: "rate_limited")))
        precondition(!policy.wantsPauseCheck(.hold))
        precondition(!policy.wantsPauseCheck(.recycle(.footprint)))

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

        // The memory notice: on at the first held critical sample, kept through the
        // dips a bloated page makes, gone under the warn level or on a swap.
        var notice = MemoryNoticeState()
        let held = WatchdogVerdict.suppressed(.footprint, why: "user_active")
        precondition(!notice.update(level: .high, verdict: .hold, now: now), "high alone shows nothing")
        precondition(notice.update(level: .critical, verdict: held, now: now))
        precondition(notice.update(level: .high, verdict: .suppressed(.staleBundle, why: "user_active"), now: now),
                     "a dip under the threshold keeps the notice")
        precondition(!notice.update(level: .normal, verdict: .hold, now: now), "back under warn: gone")
        precondition(!notice.update(level: .critical, verdict: .recycle(.footprint), now: now),
                     "a swap that goes now needs no notice")
        precondition(notice.update(level: .critical, verdict: .suppressed(.footprint, why: "unsaved_work"), now: now))
        notice.dismiss(at: now)
        precondition(!notice.update(level: .critical, verdict: held, now: now.addingTimeInterval(60)), "Later holds it back")
        precondition(notice.update(level: .critical, verdict: held, now: now.addingTimeInterval(MemoryNoticeState.snooze + 1)),
                     "and it comes back while the page is still critical")
        notice.reset()
        precondition(!notice.shown)

        // Guard for the whole class: a page at critical memory is never left as it is.
        // Every sample a critical page can give (any idle, visibility, age, budget,
        // unsaved text) either swaps it now, swaps it at the next short pause (the
        // pause check), or puts the native notice with Reload Page on screen.
        for mbValue in [2_200, 2_404, 3_016, 3_499, 3_500, 4_200] as [UInt64] {
            for idle in [0, 1, 2, 3, 5, 7, 8, 9, 15, 60, 89, 120, 400] as [TimeInterval] {
                for visible in [true, false] {
                    for age in [30, 299, 300, 7_140] as [TimeInterval] {
                        for spent in [0, 3] {
                            for unsaved in [false, true] {
                                var budget = WebContentWatchdogState()
                                for i in 0..<spent { budget.recordRecycle(at: now.addingTimeInterval(TimeInterval(-60 * (i + 1)))) }
                                let s = sample(mbValue, age: age, idle: idle, visible: visible)
                                precondition(policy.level(for: s.footprintBytes) == .critical)
                                var verdict = policy.verdict(for: s, state: budget, now: now)
                                if case let .recycle(reason) = verdict, unsaved {
                                    verdict = .suppressed(reason, why: "unsaved_work")
                                }
                                var n = MemoryNoticeState()
                                let shown = n.update(level: .critical, verdict: verdict, now: now)
                                let goesNow: Bool = { if case .recycle = verdict { return true }; return false }()
                                precondition(goesNow || shown,
                                             "critical page left with no swap and no notice: \(mbValue)MB idle \(idle) visible \(visible) age \(age) spent \(spent) unsaved \(unsaved) -> \(verdict)")
                                if !goesNow, idle >= policy.pauseForRecycle, age >= policy.minProcessAge, spent == 0, !unsaved {
                                    preconditionFailure("a pause of \(idle)s did not swap a critical page: \(verdict)")
                                }
                            }
                        }
                    }
                }
            }
        }

        // What holds the memory: the category table of `footprint -p`, largest first.
        let table = """
        ======================================================================
        com.apple.WebKit.WebContent [34312]: 64-bit    Footprint: 561 MB (16384 bytes per page)
        ======================================================================

          Dirty      Clean  Reclaimable    Regions    Category
            ---        ---          ---        ---    ---
          77 MB        0 B          0 B        125    Owned physical footprint (unmapped) (graphics)
         440 MB        0 B          0 B         44    WebKit malloc
        1.5 GB        0 B          0 B          3    JS JIT generated code
        5184 KB        0 B          0 B        545    JS VM Gigacage
            0 B      23 MB          0 B         60    mapped file
            ---        ---          ---        ---    ---
         561 MB      23 MB          0 B       6836    TOTAL

        Auxiliary data:
            phys_footprint: 561 MB
        """
        let rows = footprintCategories(table)
        precondition(rows.count == 5, "five categories, TOTAL and the header skipped: \(rows)")
        precondition(rows[0].category == "JS JIT generated code" && rows[0].bytes == UInt64(1.5 * 1_073_741_824))
        precondition(rows[1].category == "WebKit malloc" && rows[1].bytes == 440 * mb)
        precondition(rows[2].category == "Owned physical footprint (unmapped) (graphics)")
        precondition(footprintSummary(rows, top: 2) == "JS JIT generated code=1536;WebKit malloc=440")
        precondition(footprintCategories("footprint: no such process").isEmpty, "unknown text gives nothing, never a guess")

        // Breakdown cadence: going high, going critical, then every ten minutes while bloated.
        var cadence2 = BreakdownCadence()
        precondition(!cadence2.due(level: .normal, now: now), "a healthy page costs no footprint run")
        precondition(cadence2.due(level: .high, now: now))
        precondition(!cadence2.due(level: .high, now: now.addingTimeInterval(60)))
        precondition(cadence2.due(level: .critical, now: now.addingTimeInterval(120)), "going critical logs at once")
        precondition(!cadence2.due(level: .high, now: now.addingTimeInterval(180)), "a dip back to high is no news")
        precondition(!cadence2.due(level: .critical, now: now.addingTimeInterval(300)))
        precondition(cadence2.due(level: .high, now: now.addingTimeInterval(120 + BreakdownCadence.every)), "the curve goes on")

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
        precondition(tuned.sampleInterval == 60 && tuned.minProcessAge == 300, "unset test knobs keep the defaults")
        defaults.set(2, forKey: WebContentPolicy.sampleKey)      // too fast: ignored
        defaults.set(0, forKey: WebContentPolicy.minAgeKey)      // never "no minimum": ignored
        precondition(WebContentPolicy.fromDefaults(defaults).sampleInterval == 60)
        precondition(WebContentPolicy.fromDefaults(defaults).minProcessAge == 300)
        defaults.set(5, forKey: WebContentPolicy.sampleKey)
        defaults.set(20, forKey: WebContentPolicy.minAgeKey)
        precondition(WebContentPolicy.fromDefaults(defaults).sampleInterval == 5)
        precondition(WebContentPolicy.fromDefaults(defaults).minProcessAge == 20)
        // Reduce-transparency is the opposite default from the watchdog: it changes
        // how the app LOOKS, so an unset key must mean "leave the design alone".
        precondition(!WebContentPolicy.reduceGlass(defaults), "glass stays on unless asked")
        defaults.set(true, forKey: WebContentPolicy.reduceGlassKey)
        precondition(WebContentPolicy.reduceGlass(defaults))
        defaults.removePersistentDomain(forName: "walnut-webcontent-policy-tests")
        precondition(!WebContentPolicy.reduceGlass(defaults), "clearing the domain restores the design")

        // Bundle id extraction from served HTML.
        precondition(bundleId(inHTML: "<script type=\"module\" crossorigin src=\"/assets/index-SGKAbTQh.js\"></script>") == "SGKAbTQh")
        precondition(bundleId(inHTML: "<html><body>deploying</body></html>") == nil,
                     "no entry script reads as unknown, never as changed")

        // A page that never answers: the deadline's nil is delivered once, and the
        // late reply that follows is dropped (so a swap waits at most the deadline,
        // and nothing runs twice).
        precondition(WebContentPolicy().pageAnswerDeadline > 0 && WebContentPolicy().pageAnswerDeadline <= 5,
                     "a hung page holds a swap for seconds, never forever")
        var delivered: [String?] = []
        let once = OnceAnswer<String?> { delivered.append($0) }
        precondition(once.answer(nil), "the deadline answers first")
        precondition(!once.answer("late reply"), "the page's late reply is dropped")
        precondition(delivered.count == 1 && delivered[0] == nil)
        var replied: [Bool] = []
        let fast = OnceAnswer<Bool> { replied.append($0) }
        fast.answer(true)
        fast.answer(false) // the deadline firing after a reply
        precondition(replied == [true], "a reply in time wins over the deadline")

        // Every question the watchdog asks the page goes through askPage (with the
        // deadline): a bare evaluateJavaScript whose answer gates a swap left
        // recycleInFlight set forever on a hung page (review, 2026-11-08). The one
        // other call reads the loaded bundle id and gates nothing.
        let watchdogSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("desktop/WebContentWatchdog.swift")
        let source = (try? String(contentsOf: watchdogSource, encoding: .utf8)) ?? ""
        precondition(!source.isEmpty, "read \(watchdogSource.path)")
        let calls = source.components(separatedBy: "evaluateJavaScript(").count - 1
        precondition(calls == 2, "WebContentWatchdog.swift has \(calls) evaluateJavaScript calls: a new one goes through askPage")
        precondition(source.contains("private func askPage("), "askPage is the one way to ask the page")

        print("WebContent policy tests passed")
    }
}
