import XCTest
@testable import Walnut

/// Gates for the build-37 forensic upgrade — the "worst case, every kill must
/// be fully attributable" bar set after five 0x8BADF00D field kills whose OS
/// stacks were 100% anonymous SwiftUICore/AttributeGraph frames.
///
/// Three capabilities under test:
///  1. **Main-thread work ledger** (`MainWork.track` → `ctxMainWork`): every
///     batch apply that lands observable state on the main thread records
///     label/count/ms; an item that BEGAN and never finished shows as
///     `RUNNING label(count) for Xs` when read mid-freeze.
///  2. **Stall sampler** (`StallSampler.sample`): the watchdog captures the
///     frozen main thread's stack from its background queue; Walnut frames
///     appear as `Walnut+0xOFFSET [symbol]` — attributable, not anonymous.
///  3. **The kill drill** — the acceptance bar itself: inject a synthetic 3s
///     main-thread stall through a named ledger entry, read the freeze report
///     the way MainThreadWatchdog does (background thread, main thread dead),
///     and assert the report NAMES the injected source. If this test passes,
///     the next field kill cannot be unattributable at the ledger level.
@MainActor
final class MainWorkForensicsTests: XCTestCase {

    override func setUp() {
        super.setUp()
        FreezeContext.shared.resetForTesting()
    }

    override func tearDown() {
        FreezeContext.shared.resetForTesting()
        super.tearDown()
    }

    // MARK: - 1. Ledger mechanics

    func testCompletedWorkLandsInTrailWithCountAndCost() {
        MainWork.track("test.batch", count: 109) {
            // Measurable but cheap: the assertion is on presence + shape.
            usleep(20_000)
        }
        let trail = FreezeContext.shared.workTrail()
        XCTAssertTrue(trail.contains("test.batch(109, "),
            "completed entry must carry label + count: \(trail)")
        XCTAssertTrue(trail.contains("ms)"), "completed entry must carry cost: \(trail)")
    }

    func testRunningWorkIsVisibleMidFlight() {
        // Read the trail INSIDE the tracked block — exactly what the watchdog
        // does when the main thread never returns from an apply.
        var midFlight = ""
        MainWork.track("test.wedge", count: 42) {
            midFlight = FreezeContext.shared.workTrail()
        }
        XCTAssertTrue(midFlight.contains("RUNNING test.wedge(42) for "),
            "an unfinished apply must be reported as RUNNING: \(midFlight)")
        // And it must move to completed once the block returns.
        let after = FreezeContext.shared.workTrail()
        XCTAssertFalse(after.contains("RUNNING"), "no RUNNING entries after completion: \(after)")
    }

    func testNestedTrackingReportsInnermostFirst() {
        var trail = ""
        MainWork.track("outer", count: 1) {
            MainWork.track("inner", count: 2) {
                trail = FreezeContext.shared.workTrail()
            }
        }
        guard let innerPos = trail.range(of: "RUNNING inner"),
              let outerPos = trail.range(of: "RUNNING outer") else {
            return XCTFail("both nested entries must be RUNNING: \(trail)")
        }
        XCTAssertLessThan(innerPos.lowerBound, outerPos.lowerBound,
            "innermost (currently executing) entry must come first: \(trail)")
    }

    func testRingIsBoundedAtSixteenEntries() {
        for i in 0..<40 {
            MainWork.track("test.spam", count: i) {}
        }
        let trail = FreezeContext.shared.workTrail()
        let entries = trail.components(separatedBy: " | ")
        XCTAssertEqual(entries.count, 16, "ring must cap at 16: \(entries.count)")
        XCTAssertTrue(entries.first?.contains("(39, ") == true,
            "newest entry first: \(entries.first ?? "-")")
    }

    func testSnapshotMetaCarriesMainWorkTrail() {
        MainWork.track("test.visible", count: 7) {}
        let meta = FreezeContext.shared.snapshotMeta()
        XCTAssertTrue(meta["ctxMainWork"]?.contains("test.visible(7, ") == true,
            "freeze meta must carry the work trail: \(meta["ctxMainWork"] ?? "nil")")
    }

    /// The ledger must be wired into the REAL store paths, not just exist.
    /// Drives a real reconcile through the public API and asserts it shows up
    /// with its row count — the exact line the next field report needs.
    func testRealReconcileIsTracked() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        var messages: [SessionTranscript.Message] = []
        for i in 0..<109 {
            messages.append(SessionTranscript.Message(
                role: i % 3 == 0 ? "user" : "assistant",
                text: "row \(i) — \(TranscriptFixtures.cjk)",
                timestamp: "2026-08-08T06:\(String(format: "%02d", i % 60)):00Z",
                kind: nil
            ))
        }
        store.reconcile(SessionTranscript(
            sessionId: "forensics-test", exportedAt: "2026-08-08T07:00:00Z",
            truncated: false, messages: messages
        ))
        let trail = FreezeContext.shared.workTrail()
        XCTAssertTrue(trail.contains("sc.reconcile(109, "),
            "a real reconcile must land in the ledger with its row count: \(trail)")
    }

    // MARK: - 2. Stall sampler

    /// Prove-you-were-looking: sample THIS thread's mach port from a background
    /// thread while it spins in a recognizable Walnut function, and require a
    /// Walnut-image frame in the result. This is the exact capture path the
    /// watchdog runs at freeze time.
    func testSamplerCapturesWalnutFramesFromABusyMainThread() {
        let port = mach_thread_self()
        let sampled = expectation(description: "background sample completed")
        nonisolated(unsafe) var frames: [String]?
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.1) {
            frames = StallSampler.sample(thread: port)
            sampled.fulfill()
        }
        // Keep the main thread busy in OUR code while the sample fires.
        spinRecognizably(seconds: 0.5)
        wait(for: [sampled], timeout: 5)
        guard let frames else {
            return XCTFail("sampler returned nil on a supported arch (arm64 sim)")
        }
        XCTAssertGreaterThan(frames.count, 0, "must capture at least the pc frame")
        // The spin loop lives in this test bundle; the app's stores live in
        // Walnut.app. Either image proves attribution beyond system frames.
        let attributable = frames.contains { $0.contains("Walnut") || $0.contains("WalnutTests") }
        XCTAssertTrue(attributable,
            "sampled stack must contain an attributable app frame, got: \(frames.joined(separator: " <- "))")
    }

    /// A distinctly-named function the sampler should catch the main thread in.
    /// `@inline(never)` so it keeps its own frame.
    @inline(never)
    private func spinRecognizably(seconds: Double) {
        let until = FreezeContext.uptimeNow() + seconds
        var sink = 0.0
        while FreezeContext.uptimeNow() < until {
            sink += Double.random(in: 0...1).squareRoot()
        }
        XCTAssertGreaterThan(sink, 0) // keep the loop un-eliminable
    }

    // MARK: - 3. The kill drill (acceptance gate)

    /// Simulated next field kill: a 3s synchronous main-thread stall injected
    /// through a named batch apply. While the "main thread" is wedged, a
    /// background thread assembles the freeze report exactly the way
    /// MainThreadWatchdog does (FreezeContext.snapshotMeta + StallSampler) and
    /// the test asserts the report UNAMBIGUOUSLY names the injected source.
    /// If this gate is green, the forensics cannot regress to "anonymous
    /// AttributeGraph frames + no suspect" again.
    func testKillDrillReportNamesTheInjectedStallSource() {
        let port = mach_thread_self()
        let reported = expectation(description: "background freeze report assembled")
        nonisolated(unsafe) var meta: [String: String] = [:]
        nonisolated(unsafe) var stack: [String]?
        // The "watchdog": fires mid-stall (the injected stall runs 3s; sample
        // at 1s to be safely inside it even under scheduler noise).
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.0) {
            stack = StallSampler.sample(thread: port)
            meta = FreezeContext.shared.snapshotMeta()
            reported.fulfill()
        }

        // The injected kill: one named ledger entry that stalls for 3s.
        MainWork.track("drill.injectedStall", count: 3_000) {
            spinRecognizably(seconds: 3.0)
        }

        wait(for: [reported], timeout: 10)

        // Verdict 1 — the ledger names the killer as RUNNING with its age.
        let work = meta["ctxMainWork"] ?? ""
        XCTAssertTrue(work.contains("RUNNING drill.injectedStall(3000) for "),
            "freeze report must name the in-flight apply: \(work)")

        // Verdict 2 — the sampled stack is attributable (not only system frames).
        guard let stack else {
            return XCTFail("drill: sampler must capture the wedged main thread")
        }
        XCTAssertTrue(stack.contains { $0.contains("Walnut") || $0.contains("WalnutTests") },
            "drill: sampled stack must contain an app frame: \(stack.joined(separator: " <- "))")

        // Post-drill: the entry settles into the completed ring with its cost,
        // and nothing is left RUNNING.
        let after = FreezeContext.shared.workTrail()
        XCTAssertFalse(after.contains("RUNNING"), "drill entry must complete: \(after)")
        XCTAssertTrue(after.contains("drill.injectedStall(3000, "),
            "drill entry must settle with measured cost: \(after)")
    }
}
