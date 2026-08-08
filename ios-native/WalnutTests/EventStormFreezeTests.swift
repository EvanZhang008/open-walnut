import XCTest
import SwiftUI
@testable import Walnut

/// Reproduction + regression gates for the 2026-08-08 **build-36** field
/// freezes — round 4, and the first round where the payload is provably tiny.
///
/// Field evidence (three 0x8BADF00D scene-update watchdog kills in 17 min,
/// all build 36, which already ships rounds 1-3):
///   1. 07:11:00Z session:0b253ffe — watching a 5h fable plan session while
///      sending 3 messages. FreezeContext: ctxLiveChars=97, historyRows=105,
///      kbFlips10s=0. The daemon jsonl for the death window carried
///      **1,179 lines / 55.1s = 21.4 lines/s** (measured, n=1,179), of which
///      589 were `thinking_delta` stream events with 7-35 BYTE payloads
///      (p50=7, p90=14, n=589) — microbursts to ~700 lines/s.
///   2. 07:14:30Z session:4d27380f — opened a STOPPED session (150 rows) and
///      froze in its first layout pass, never recovered (3 min wedge, killed
///      in background).
///   3. 07:27:36Z session:f98cb51b — streaming Mac session, froze ~11s after
///      send:429. Same shape as 1.
///   All three: appCPU/allowance ≈ 1.0 (pure compute loop), thread0 all
///   SwiftUICore/AttributeGraph, zero `main thread recovered` lines all day.
///
/// SUSPECTED MECHANISM — TESTED, AND THE SCALAR HALF WAS **REFUTED** (read
/// this before trusting the audit's P1 again): the cloud bridge forwards CLI
/// `thinking_delta` jsonl lines 1:1 as `thinking` SSE events (bridge-registry
/// forwardJsonlLine — no coalescing), and the store's handler wrote
/// `streaming = true; activity = "Thinking"` for EVERY event. The hypothesis
/// was that @Observable fires objectWillChange on same-value writes, so each
/// event would re-diff the whole 105-150 row page (`messageList` reads
/// `store.streaming`). MEASURED RESULT on this SDK (iOS 26 toolchain): the
/// @Observable macro already SUPPRESSES same-value writes for Equatable
/// scalars — 589 pre-fix product-path events fired 0 invalidations, and the
/// A/B sim run (fixed vs unconditional writes, field-rate and 500 ev/s storm)
/// froze NEITHER build. See ObservationSemanticsProbeTests for the runtime
/// semantics record. NOTE the asymmetry it also measured: whole-ARRAY
/// reassignment with equal content (reconcile's `historyMessages = next`)
/// DOES invalidate.
///
/// The equality-gated setters these tests pin down are therefore DEFENSE IN
/// DEPTH, not the proven root cause of the 2026-08-08 kills: they make the
/// "redundant events are free" invariant structural (compile-time visible,
/// runtime-version-independent) instead of an undocumented macro behavior.
///
/// Budget convention: same as WatchdogRegressionTests — this M-series sim is
/// ~3-5x an A-series phone, so 1s of measured main-thread ≈ the 5s watchdog
/// line on device.
@MainActor
final class EventStormFreezeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        FreezeContext.shared.resetForTesting()
    }

    override func tearDown() {
        if let w = hostWindow {
            w.isHidden = true
            w.rootViewController = nil
            hostWindow = nil
        }
        super.tearDown()
    }

    // MARK: - Fixtures (field scale: crash-1's real transcript shape)

    /// Field transcript shape for crash 1 (0b253ffe, measured from the real
    /// exported transcript): 105 rows, mostly tool chips (79/108), text rows
    /// small (p50=4, p90=526, max=1,478 chars). Payload is NOT the problem —
    /// keep it honest so a red here can only come from invalidation COUNT.
    private func fieldTranscript(rows: Int) -> SessionTranscript {
        var messages: [SessionTranscript.Message] = []
        for i in 0..<rows {
            let ts = "2026-08-08T06:\(String(format: "%02d", i % 60)):00Z"
            switch i % 10 {
            case 0..<7:
                messages.append(SessionTranscript.Message(
                    role: "assistant", text: ["Bash", "Read", "Grep", "Edit", "Task"][i % 5],
                    timestamp: ts, kind: "tool",
                    detail: "kubectl get events --field-selector reason=Failed -n ns-\(i)",
                    resultPreview: String(repeating: "result line \(i)\n", count: 12)
                ))
            case 7..<9:
                messages.append(SessionTranscript.Message(
                    role: "assistant",
                    text: i % 20 == 7 ? TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(i, rows: 6) : "收到,第 \(i) 步完成。",
                    timestamp: ts, kind: nil
                ))
            default:
                messages.append(SessionTranscript.Message(
                    role: "user", text: "继续第 \(i) 项,只读操作。", timestamp: ts, kind: nil
                ))
            }
        }
        return SessionTranscript(
            sessionId: "storm-test", exportedAt: "2026-08-08T07:00:00Z",
            truncated: false, messages: messages
        )
    }

    private func seededStore(rows: Int) -> SessionConversationStore {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.reconcile(fieldTranscript(rows: rows))
        XCTAssertEqual(store.messages.count, min(rows, 150), "fixture must land at field scale")
        return store
    }

    private func thinkingEvent() -> SSEEvent {
        SSEEvent(id: nil, event: "thinking", data: "{\"delta\":\"思考\"}")
    }

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    // MARK: - Gate 1: redundant flag writes must not invalidate observers

    /// RECORD, not a storm gate: on this SDK the @Observable macro already
    /// suppresses same-value writes for Equatable scalars, so this test stays
    /// green even with the equality-gated setters deleted (verified — it
    /// cannot catch a regression of OUR gate). It documents/pins the runtime
    /// behavior the app now also enforces structurally; if a future SDK drops
    /// the suppression, this is the test that turns red first. The actual
    /// storm defense is testHostedPageSurvivesThinkingDeltaStorm (wall-time
    /// budget on the real hosted page, gate-independent).
    func testRedundantThinkingEventsDoNotInvalidateObservers_recordsSdkSuppression() {
        let store = seededStore(rows: 105)

        // Positive control: the FIRST thinking event is a real transition.
        var baselineFired = false
        withObservationTracking {
            _ = store.streaming
            _ = store.activity
        } onChange: {
            baselineFired = true
        }
        store.handle(thinkingEvent())
        XCTAssertTrue(baselineFired,
            "positive control failed — the probe cannot see invalidations, so a green storm result would be meaningless")
        XCTAssertTrue(store.streaming)
        XCTAssertEqual(store.activity, "Thinking")

        // Storm: 589 repeat events = the measured death-window count (n=589).
        var stormFired = 0
        func arm() {
            withObservationTracking {
                _ = store.streaming
                _ = store.activity
            } onChange: {
                stormFired += 1
                Task { @MainActor in arm() } // re-arm: onChange is one-shot
            }
        }
        arm()
        for _ in 0..<589 {
            store.handle(thinkingEvent())
        }
        // Drain the re-arm hops so late invalidations are counted.
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(stormFired, 0,
            "\(stormFired) invalidations from 589 same-value thinking events — every one re-diffs the whole conversation page (the 0x8BADF00D storm)")
    }

    /// Same gate for the status path: the daemon re-emits session_state on
    /// every reconcile; a same-value processStatus write must be free.
    func testRedundantStatusEventsDoNotInvalidateObservers() {
        let store = seededStore(rows: 105)
        store.handle(SSEEvent(id: nil, event: "status", data: "{\"processStatus\":\"running\"}"))
        XCTAssertEqual(store.processStatus, "running")

        var fired = 0
        withObservationTracking {
            _ = store.processStatus
        } onChange: {
            fired += 1
        }
        for _ in 0..<100 {
            store.handle(SSEEvent(id: nil, event: "status", data: "{\"processStatus\":\"running\"}"))
        }
        XCTAssertEqual(fired, 0, "same-value status events must not invalidate the nav subtitle")
    }

    /// ChatStore mirror (the butler chat page has the same two flags and the
    /// same full-page `streaming` read in ChatView's body). Drives the REAL
    /// handler via the handleForTesting seam — the old version of this test
    /// re-implemented the equality gate inside the test body, so it passed
    /// even if ChatStore.handle regressed to unconditional writes.
    func testChatStoreRedundantThinkingEventsDoNotInvalidateObservers() {
        let chat = ChatStore()
        chat.activeID = "conv-1"

        // Positive control: message-start is a real transition (streaming
        // false→true) — proves the probe sees invalidations at all.
        var baselineFired = false
        withObservationTracking {
            _ = chat.streaming
            _ = chat.activity
        } onChange: {
            baselineFired = true
        }
        chat.handleForTesting(SSEEvent(id: nil, event: "message-start", data: "{}"), conversationID: "conv-1")
        chat.handleForTesting(thinkingEvent(), conversationID: "conv-1")
        XCTAssertTrue(baselineFired,
            "positive control failed — the probe cannot see invalidations, so a green storm result would be meaningless")
        XCTAssertTrue(chat.streaming)
        XCTAssertEqual(chat.activity, "Thinking")

        // Storm: repeat `thinking` through the REAL handler must be free.
        var stormFired = 0
        func arm() {
            withObservationTracking {
                _ = chat.streaming
                _ = chat.activity
            } onChange: {
                stormFired += 1
                Task { @MainActor in arm() } // re-arm: onChange is one-shot
            }
        }
        arm()
        for _ in 0..<200 {
            chat.handleForTesting(thinkingEvent(), conversationID: "conv-1")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(stormFired, 0,
            "\(stormFired) invalidations from 200 same-value thinking events through ChatStore.handle — the equality gate regressed")
    }

    // MARK: - Gate 2: the hosted page under the real event storm

    /// ONE window, reused — same discipline as ComposerFreezeTests (a leaked
    /// visible UIWindow crashes the NEXT suite in the target).
    private var hostWindow: UIWindow?

    private func hostConversationPage(store: SessionConversationStore) -> UIViewController {
        let page = NavigationStack {
            SessionConversationView(session: ScriptedSSE.session(), store: store)
        }
        let host = UIHostingController(rootView: page)
        let window = hostWindow ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        hostWindow = window
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        // Let the LazyVStack materialize its first viewport (untimed setup).
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        return host
    }

    /// Field composite on the REAL page: 105-row transcript mounted in the
    /// real SessionConversationView + the measured death-window storm (589
    /// thinking events + text deltas at the observed ratio) pumped through
    /// the real store while the run loop drains layout. The gate is total
    /// main-thread occupancy of the storm: pre-fix every event re-diffed the
    /// whole page (multi-second, watchdog territory at 3-5x on device);
    /// post-fix the storm is background noise.
    ///
    /// n note: the wall budget is asserted on the WORST of 3 passes to keep
    /// single-run scheduler noise out of the verdict.
    func testHostedPageSurvivesThinkingDeltaStorm() {
        let store = seededStore(rows: 105)
        _ = hostConversationPage(store: store)

        // Enter the streaming state the field session was in (turn running,
        // 97 chars of live text on screen).
        store.handle(SSEEvent(id: nil, event: "turn-start", data: "{}"))
        store.handle(ScriptedSSE.deltaEvent(bytes: 97))
        store.flushPendingDelta()
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))

        var worstMs = 0.0
        for pass in 0..<3 {
            let stormMs = ms {
                // 589 thinking + 60 text deltas ≈ the 55s death window's event
                // mix (measured); delivered back-to-back = the microburst case
                // (~700 lines/s bursts were observed on the same session).
                for i in 0..<589 {
                    store.handle(thinkingEvent())
                    if i % 10 == 0 { store.handle(ScriptedSSE.deltaEvent(bytes: 20)) }
                }
                // Drain everything the storm scheduled onto the main queue —
                // THIS is where pre-fix layout invalidations actually ran.
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            } - 200.0 // subtract the fixed drain window; keep only work above it
            worstMs = max(worstMs, stormMs)
            print(String(format: "[storm] pass %d: 589-event thinking storm on hosted 105-row page: %7.1fms over drain floor", pass, stormMs))
        }
        // Budget: the whole storm's extra main-thread work must stay under
        // 1s on this sim (~3-5x device ≈ the watchdog line). Pre-fix this was
        // 589 full-page diffs of a 105-row LazyVStack.
        XCTAssertLessThan(worstMs, 1_000.0,
            "thinking-delta storm re-layouts the whole page per event — the build-36 0x8BADF00D mechanism is back")
    }
}
