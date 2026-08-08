import XCTest
import SwiftUI
@testable import Walnut

/// Reproduction attempts + gates for the round-4B freeze family: "opened a
/// session page and froze within 5-20s, zero streaming, zero keyboard"
/// (2026-08-08 field kills at 07:14:30Z, 14:20:38Z and 14:29:56Z, build 36).
///
/// Field facts these tests are scaled to (measured from the three sessions'
/// REAL exported transcripts, ~/.walnut data — the fixtures below mirror the
/// distribution, never the content):
///   - 07:14 kill: 173 msgs (106 tool rows, preview total 30KB), 150 on phone
///   - 14:20 kill: 108 msgs (67 tool, preview 31KB, 5 tables), 109 on phone,
///     arrived via scene-resume after 6.2h background
///   - 14:29 kill: 82 msgs (42 tool, preview 6KB), 91 on phone, pure
///     foreground page-to-page navigation
///   All three: ctxLiveChars=0, kbFlips=0, keyboard hidden — the ONLY workload
///   is the transcript paint + whatever lands within the next 20s.
///
/// Timeline nuance the fixtures cannot fully replicate: in the 14:29 kill the
/// stall began ~12s AFTER both transcript loads had completed (reconcile long
/// done) with no logged event in between — so a green run here does NOT prove
/// the field bug is gone; it bounds the paint paths we CAN drive. The
/// ctxMainWork ledger + stall sampler (MainWorkForensicsTests) exist for the
/// part we cannot reproduce.
///
/// Budget convention (same as WatchdogRegressionTests): this M-series sim is
/// ~3-5x an A-series phone, so 1s of measured main thread ≈ the 5s watchdog
/// line on device.
@MainActor
final class FirstPaintFreezeTests: XCTestCase {

    private let budgetMs = 1_000.0

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        FreezeContext.shared.resetForTesting()
        MainWork.resetForTesting()
    }

    override func tearDown() {
        if let w = hostWindow {
            w.isHidden = true
            w.rootViewController = nil
            hostWindow = nil
        }
        super.tearDown()
    }

    private var hostWindow: UIWindow?

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    // MARK: - Field-shape fixture (14:20 kill profile — the heaviest)

    /// Mirrors the 14:20 session's measured shape: 108 rows, 62% tool chips
    /// with ~470-char result previews, text rows p50=90 p90=883 (CJK-heavy),
    /// 5 markdown tables, 1 image-marker row. All content synthetic.
    private func fieldShapeTranscript(rows: Int) -> SessionTranscript {
        var messages: [SessionTranscript.Message] = []
        for i in 0..<rows {
            let ts = "2026-08-08T08:\(String(format: "%02d", i % 60)):\(String(format: "%02d", (i * 7) % 60))Z"
            switch i % 10 {
            case 0..<6:
                messages.append(SessionTranscript.Message(
                    role: "assistant", text: ["Bash", "Read", "Grep", "Edit", "WebFetch", "Task"][i % 6],
                    timestamp: ts, kind: "tool",
                    detail: "monitor step \(i) — poll the queue and classify the new entries",
                    resultPreview: String(repeating: "queue entry \(i): status=ok latency=\(i * 13)ms\n", count: 10)
                ))
            case 6..<8:
                let text: String
                switch i % 20 {
                case 6: text = TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(i, rows: 8)
                case 7: text = "分析截图:`/tmp/probe/shot-\(i).png` 供参考。\n\n" + TranscriptFixtures.cjk
                default: text = "第 \(i) 轮检查完成," + String(repeating: TranscriptFixtures.cjk, count: i % 3 == 0 ? 2 : 1)
                }
                messages.append(SessionTranscript.Message(role: "assistant", text: text, timestamp: ts, kind: nil))
            default:
                messages.append(SessionTranscript.Message(
                    role: "user", text: "继续第 \(i) 项,只读操作,结果整理成表格。", timestamp: ts, kind: nil
                ))
            }
        }
        return SessionTranscript(
            sessionId: "first-paint-test", exportedAt: "2026-08-08T09:00:00Z",
            truncated: false, messages: messages
        )
    }

    private func hostPage(store: SessionConversationStore) -> UIHostingController<some View> {
        let page = NavigationStack {
            SessionConversationView(session: ScriptedSSE.session(), store: store)
        }
        let host = UIHostingController(rootView: page)
        let window = hostWindow ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        hostWindow = window
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        return host
    }

    // MARK: - 1. Cold-cache first paint (07:14 + 14:29 shape: fresh open)

    /// The page's first layout with a COLD markdown cache — models both the
    /// eight-day-stale first open (07:14) and a 6.2h-background resume where
    /// iOS may have purged NSCaches (14:20). Measures the synchronous
    /// mount+layout+run-loop-settle cost of the full field-scale page.
    func testColdCacheFirstPaintOfFieldScalePage() {
        var worst = 0.0
        for pass in 0..<3 {
            MarkdownParser.resetCacheForTesting()
            let store = SessionConversationStore(session: ScriptedSSE.session())
            store.reconcile(fieldShapeTranscript(rows: 108)) // untimed: data landing
            let mountMs = ms {
                let host = hostPage(store: store)
                host.view.layoutIfNeeded()
            }
            // The bottom-anchored scroll settles across the next few frames —
            // drain them and charge only work above the fixed drain window.
            let settleMs = ms {
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            } - 500.0
            let total = mountMs + max(0, settleMs)
            worst = max(worst, total)
            print(String(format: "[first-paint] pass %d: cold-cache 108-row mount %7.1fms + settle-over-drain %7.1fms (budget %.0f)",
                         pass, mountMs, max(0, settleMs), budgetMs))
            hostWindow?.rootViewController = nil
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertLessThan(worst, budgetMs,
            "cold-cache first paint of a field-scale session page breaches the watchdog-scaled budget (n=3, worst)")
    }

    // MARK: - 2. Scene-resume composite (14:20 shape)

    /// The full 6.2h-background resume choreography on a mounted page:
    /// suspend the store (as LifecycleHub does on .background), purge the
    /// parser cache (what a long background can cost), then resume — SSE
    /// reconnect intent + a full fresh reconcile whose rows all CHANGED
    /// timestamps-forward (6h of new turns) — and measure the main-thread
    /// cost of the resume burst on the live view.
    func testSceneResumeReconcileBurstOnMountedPage() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.reconcile(fieldShapeTranscript(rows: 108))
        _ = hostPage(store: store)
        RunLoop.current.run(until: Date().addingTimeInterval(0.5)) // untimed mount settle

        var worst = 0.0
        for pass in 0..<3 {
            store.suspend()
            MarkdownParser.resetCacheForTesting() // background purged the caches
            // 6 hours later: the tail moved on — a fully NEW window (every row
            // replaced: worst legal reconcile, a real diff not a gated no-op).
            let fresh = fieldShapeTranscript(rows: 108 + pass + 1)
            let burstMs = ms {
                store.resume()
                store.reconcile(fresh)
                RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            } - 300.0
            worst = max(worst, max(0, burstMs))
            print(String(format: "[scene-resume] pass %d: resume+full-reconcile burst %7.1fms over drain (budget %.0f)",
                         pass, max(0, burstMs), budgetMs))
        }
        XCTAssertLessThan(worst, budgetMs,
            "scene-resume reconcile burst breaches the watchdog-scaled budget (n=3, worst)")
    }

    // MARK: - 3. The post-entry quiet window (14:29 shape)

    /// The 14:29 kill stalled ~12s after entry with reconcile LONG done and no
    /// logged event in between. Drive the two things that DO fire in that
    /// window — the events-feed status churn on the store (session status
    /// re-emits) and a second fresh reconcile with identical content (the
    /// equality-gated path) — on the mounted page, and require them to be
    /// near-free. If a regression makes "nothing happened" expensive again,
    /// this goes red.
    func testQuietWindowChurnOnMountedPageIsFree() {
        let transcript = fieldShapeTranscript(rows: 91)
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.reconcile(transcript)
        _ = hostPage(store: store)
        RunLoop.current.run(until: Date().addingTimeInterval(0.5)) // untimed

        let churnMs = ms {
            for _ in 0..<20 {
                // status re-emits (daemon reconcile echo) + identical-content
                // poll reconciles — the only store inputs in the quiet window.
                store.handle(SSEEvent(id: nil, event: "status", data: "{\"processStatus\":\"running\"}"))
                store.reconcile(transcript)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        } - 200.0
        print(String(format: "[quiet-window] 20x (status echo + identical reconcile) on mounted 91-row page: %7.1fms over drain", max(0, churnMs)))
        XCTAssertLessThan(max(0, churnMs), 250.0,
            "no-op churn on a settled page must stay near-free — the equality gates regressed")
    }
}
