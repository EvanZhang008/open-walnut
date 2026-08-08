import XCTest
import Observation
@testable import Walnut

/// Gates for the 2026-08-07 main-thread audit's P2 batch — same-value write
/// suppression, per-event cost amplifiers, and launch-path I/O:
///
///  - OBS-6: ConnectionStore.online same-value writes must be inert (every
///    successful REST call reports reachability; `online` has 7+ readers).
///  - IO-6:  AppConfig.token must hit the Keychain ONCE per process, not one
///    SecItemCopyMatching XPC per API request / image load / SSE connect.
///  - MAIN-9: ComposerDrafts persists the WHOLE dict to UserDefaults — must
///    be debounced, not per keystroke.
///  - OBS-5: VoiceRecorder is a @State default value (initial-value expression
///    runs per ComposerBar struct init) — init must stay cheap and
///    side-effect-free (no LifecycleHub registration, no URLSession).
///  - TMR-1: a clean EOF from a connection that never delivered a frame must
///    not reset SSE backoff (200-then-close server = ~1Hz reconnect storm).
///  - MAIN-10: user bubbles clip at the transcript's 4K bound before CoreText
///    lays them out (optimistic bubbles carry the FULL text for retry).
///  - OBS-8/TMR-5: reconciling an IDENTICAL transcript (5s polling fallback)
///    must not invalidate historyMessages readers.
@MainActor
final class LifecycleHygieneTests: XCTestCase {

    // MARK: - OBS-6: online same-value writes

    func testOnlineSameValueWritesAreInert() {
        let store = ConnectionStore()
        store.reportReachability(true, source: "tasks-rest") // establish online
        XCTAssertTrue(store.online)

        var fired = 0
        withObservationTracking {
            _ = store.online
        } onChange: {
            fired += 1
        }
        for _ in 0..<10 {
            store.reportReachability(true, source: "tasks-rest")
        }
        XCTAssertEqual(fired, 0,
            "\(fired) invalidations from 10 already-online success reports — every REST call re-invalidates the 7+ views reading `online` (audit OBS-6)")
    }

    // MARK: - IO-6: token Keychain round-trips

    func testTokenReadsHitKeychainOncePerProcess() {
        AppConfig.resetTokenCacheForTesting()
        KeychainHelper.keychainReads.withLock { $0 = 0 }
        for _ in 0..<10 {
            _ = AppConfig.token
        }
        let reads = KeychainHelper.keychainReads.withLock { $0 }
        XCTAssertEqual(reads, 1,
            "\(reads) SecItemCopyMatching XPCs for 10 token reads (n=10) — the in-process token cache regressed; every API request pays a securityd round-trip again (audit IO-6)")
    }

    // MARK: - MAIN-9: draft persist debounce

    func testDraftPersistIsDebouncedAcrossKeystrokes() {
        let drafts = ComposerDrafts.shared
        let key = "session:debounce-gate"
        defer { drafts.clear(key) }

        // Flush any pending write from other tests, then measure a burst.
        RunLoop.current.run(until: Date().addingTimeInterval(0.7))
        ComposerDrafts.persistWrites.withLock { $0 = 0 }
        var text = ""
        for ch in "twenty keystrokes hit" {
            text.append(ch)
            drafts.setDraft(text, key: key)
        }
        let during = ComposerDrafts.persistWrites.withLock { $0 }
        XCTAssertEqual(during, 0,
            "\(during) UserDefaults writes DURING a 21-keystroke burst — the persist debounce regressed to per-keystroke whole-dict writes (audit MAIN-9)")

        // The debounced write must actually land (durability half).
        RunLoop.current.run(until: Date().addingTimeInterval(0.7))
        let after = ComposerDrafts.persistWrites.withLock { $0 }
        XCTAssertEqual(after, 1,
            "expected exactly 1 coalesced persist after the debounce window, got \(after)")
        XCTAssertEqual(drafts.draft(key), text, "draft content must survive the debounce")
    }

    // MARK: - OBS-5: VoiceRecorder as a @State default value

    func testVoiceRecorderInitIsCheapAndSideEffectFree() {
        // Warm one instance (class metadata, first-touch costs).
        _ = VoiceRecorder()
        let t0 = DispatchTime.now()
        var recorders: [VoiceRecorder] = []
        for _ in 0..<50 {
            recorders.append(VoiceRecorder())
        }
        let totalMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
        print(String(format: "[voice] 50 VoiceRecorder inits: %6.2fms total (n=50)", totalMs))
        // Pre-fix each init built a WalnutAPI (fresh URLSession) + mutated the
        // LifecycleHub registry; ComposerBar's @State default runs this at
        // body-eval rate during streaming (audit OBS-5). 50 inits in single-
        // digit ms = the lazy path is intact.
        XCTAssertLessThan(totalMs, 10.0,
            "50 throwaway VoiceRecorder inits cost \(totalMs)ms — the @State default value is doing real work again (audit OBS-5)")
        withExtendedLifetime(recorders) {}
    }

    // MARK: - TMR-1: clean-EOF backoff policy

    func testCleanEOFBackoffOnlyResetsForProvenConnections() {
        // A connection that delivered nothing and died instantly must NOT earn
        // a prompt reconnect (the ~1Hz storm case).
        XCTAssertFalse(SSEClient.shouldResetBackoff(deliveredFrame: false, connectedSeconds: 0.2))
        XCTAssertFalse(SSEClient.shouldResetBackoff(deliveredFrame: false, connectedSeconds: 29))
        // Real connections do: a frame was delivered, or it held long enough.
        XCTAssertTrue(SSEClient.shouldResetBackoff(deliveredFrame: true, connectedSeconds: 0.2))
        XCTAssertTrue(SSEClient.shouldResetBackoff(deliveredFrame: false, connectedSeconds: 31))
    }

    // MARK: - MAIN-10: user bubble render clip

    func testUserBubbleTextIsClippedForLayout() {
        let giant = String(repeating: "长文本粘贴", count: 30_000) // 150K chars
        let clipped = MessageRow.clipBubbleText(giant)
        XCTAssertEqual(clipped.count, 4_001, "clip must be 4,000 chars + ellipsis")
        XCTAssertTrue(clipped.hasSuffix("…"))
        // Short text passes through untouched (no allocation churn).
        XCTAssertEqual(MessageRow.clipBubbleText("hello"), "hello")
        // Character-not-byte semantics (CJK must not get byte-sliced).
        let cjk = String(repeating: "字", count: 3_999)
        XCTAssertEqual(MessageRow.clipBubbleText(cjk), cjk)
    }

    // MARK: - GEO-4: WysiwygEditor willResignActive observer balance

    func testWysiwygObserverRemovedOnDismantle() {
        let editor = WysiwygEditor(
            attributedText: .constant(NSAttributedString(string: "test")),
            isEditable: true, notePath: "test.md",
            onChange: {}, onCheckboxToggle: {}
        )
        let coordinator = editor.makeCoordinator()
        // Stand-in for makeUIView's registration: a counted block observer on
        // the same token slot. dismantleUIView must remove WHATEVER token is
        // there — block observers never auto-unregister, and the old
        // token-dropped form leaked one per note ever opened (audit GEO-4).
        var fired = 0
        coordinator.resignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { _ in fired += 1 }

        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertEqual(fired, 1, "positive control — the observer must be live before dismantle")

        WysiwygEditor.dismantleUIView(WalnutTextView(), coordinator: coordinator)
        XCTAssertNil(coordinator.resignObserver, "dismantle must clear the token")
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertEqual(fired, 1,
            "observer fired after dismantleUIView — the willResignActive block observer leaks again (audit GEO-4: one per note ever opened)")
    }

    // MARK: - OBS-8/TMR-5: identical-transcript reconcile is inert

    func testIdenticalTranscriptReconcileIsInert() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        let transcript = SessionTranscript(
            sessionId: "inert-test", exportedAt: "2026-08-08T07:00:00Z",
            truncated: false,
            messages: (0..<50).map { i in
                SessionTranscript.Message(
                    role: i % 3 == 0 ? "user" : "assistant",
                    text: "row \(i) content 内容",
                    timestamp: String(format: "2026-08-08T06:%02d:00Z", i),
                    kind: nil
                )
            }
        )
        store.reconcile(transcript)
        XCTAssertEqual(store.messages.count, 50, "fixture must land")

        var fired = 0
        withObservationTracking {
            _ = store.historyMessages
        } onChange: {
            fired += 1
        }
        // The 5s polling fallback (bridge-offline can persist for DAYS) keeps
        // re-fetching the same transcript — each poll must be free.
        for _ in 0..<10 {
            store.reconcile(transcript)
        }
        XCTAssertEqual(fired, 0,
            "\(fired) invalidations from 10 identical-transcript reconciles (n=10) — the equality gate on historyMessages regressed; the 0.2Hz polling heartbeat re-diffs the whole page again (audit OBS-8/TMR-5)")
    }
}
