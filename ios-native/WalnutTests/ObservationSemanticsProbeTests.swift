import XCTest
import Observation
@testable import Walnut

/// Runtime-semantics RECORD for the round-4 (build 36) freeze investigation —
/// keep it: the whole "redundant SSE events re-diff the page" hypothesis
/// stands or falls on what @Observable actually does, and the answer is
/// version-dependent and documented nowhere. Measured on the iOS 26 sim:
///   • same-value SCALAR writes  → 0 onChange (the macro compares Equatable
///     values and skips the mutation) — the audit's P1-2 mechanism as
///     originally stated is REFUTED on this SDK;
///   • whole-ARRAY reassignment with EQUAL content → 1 onChange pre-fix
///     (arrays go through the unconditional setter path) — this HALF of the
///     redundant-write family was real, and reconcile() now equality-gates it
///     (asserted below as a hard gate).
/// If a toolchain update ever flips the scalar half, the first test here
/// turns red and the equality-gated setters in both stores stop being
/// "defense in depth" and become the load-bearing fix.
@MainActor
final class ObservationSemanticsProbeTests: XCTestCase {

    @Observable @MainActor
    final class Probe {
        var flag = false
        var label: String?
    }

    func testSameValueWriteSemantics() {
        let probe = Probe()
        probe.flag = true
        probe.label = "Thinking"

        var fired = 0
        withObservationTracking {
            _ = probe.flag
            _ = probe.label
        } onChange: {
            fired += 1
        }
        // Same-value writes:
        probe.flag = true
        probe.label = "Thinking"
        print("[probe] same-value writes fired onChange: \(fired)")
        // RECORD, not just a probe: this SDK's macro suppresses same-value
        // scalar writes. If a toolchain bump flips this, the equality-gated
        // setters in SessionConversationStore/ChatStore become load-bearing —
        // this red is the signal to re-audit every raw @Observable write.
        XCTAssertEqual(fired, 0, "SDK behavior changed: same-value scalar writes now invalidate")

        var fired2 = 0
        withObservationTracking {
            _ = probe.flag
        } onChange: {
            fired2 += 1
        }
        probe.flag = false // real change
        print("[probe] real change fired onChange: \(fired2)")
        XCTAssertEqual(fired2, 1, "positive control: a real change must fire")
    }

    /// Does a whole-array REASSIGNMENT with equal content invalidate?
    /// (reconcile() does `historyMessages = next` on every 5s poll.)
    func testEqualArrayReassignmentSemantics() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        let t = SessionTranscript(
            sessionId: "probe", exportedAt: "2026-08-08T07:00:00Z", truncated: false,
            messages: (0..<150).map { i in
                SessionTranscript.Message(role: "assistant", text: "row \(i)", timestamp: "2026-08-08T06:00:0\(i % 10)Z", kind: nil)
            }
        )
        store.reconcile(t)
        var fired = 0
        withObservationTracking {
            _ = store.messages.count
        } onChange: {
            fired += 1
        }
        store.reconcile(t) // identical content → identical stable ids
        print("[probe] equal-content reconcile fired onChange: \(fired)")
        // HARD GATE (was 1 pre-fix): equal-content array reassignment DOES
        // invalidate through the macro, so reconcile() must equality-gate the
        // `historyMessages = next` write. Red here = every 5s poll re-diffs
        // the whole 150-row page again.
        XCTAssertEqual(fired, 0, "equal-content reconcile must not invalidate the page")

        var fired2 = 0
        withObservationTracking {
            _ = store.messages.count
        } onChange: {
            fired2 += 1
        }
        var extended = t.messages
        extended.append(SessionTranscript.Message(role: "user", text: "new", timestamp: "2026-08-08T07:59:59Z", kind: nil))
        store.reconcile(SessionTranscript(sessionId: "probe", exportedAt: "x", truncated: false, messages: extended))
        print("[probe] changed-content reconcile fired onChange: \(fired2)")
        XCTAssertEqual(fired2, 1, "positive control: a real row change must fire")
    }
}
