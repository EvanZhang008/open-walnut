import XCTest
@testable import Walnut

/// T41 round 5 — the freeze reports were the WATCHDOG'S OWN ARITHMETIC.
///
/// For four rounds the phone kept reporting freezes after every fix landed
/// (build 36 layout busy-loop, build 37 UIKit timeline rewrite, build 45
/// batch). The 5th round finally read the raw samples instead of the
/// notifications, and the numbers were impossible for a real freeze:
///
///  - 9,676 `stall sample` lines across builds 42 / 44 / 45,
///  - `stalledSeconds` NEVER above **2.1** (exactly one 2s ping interval),
///  - `sampleIndex` == 1 in **100%** of them (the ring never advanced NOR
///    drained — a real 5s+ freeze produces indices 2 and 3),
///  - **47%** of the "frozen" main-thread stacks were parked in
///    `__CFRunLoopServiceMachPort` / `mach_msg` — an IDLE run loop waiting
///    for events, i.e. a perfectly healthy app doing nothing.
///
/// Cause: `tick()` measured `now - lastPong` where `lastPong` only advanced
/// when a pong ran, AND it dispatched a fresh ping on the same tick that read
/// the clock. An idle healthy app therefore always measured one full ping
/// interval of "stall". The ring was drained only when
/// `stalled < pingInterval * 1.5` (3s), which the steady 2.0s reading never
/// satisfied, so it filled once and stayed full for the process lifetime.
///
/// These gates pin the accounting: a HEALTHY app must report exactly ZERO
/// stall, and only an UNANSWERED ping may accumulate any.
final class WatchdogStallAccountingTests: XCTestCase {

    // MARK: - The bug, stated as arithmetic

    /// An ANSWERED ping means the main thread is responsive as of now. Any
    /// non-zero reading here is the T41 bug: it is what turned an idle app into
    /// 9,676 freeze reports.
    func testAnsweredPingMeansZeroStall() {
        // The exact field shape: the pong landed a full ping interval ago and
        // the app has been idle since. Pre-fix this returned 2.0.
        let stalled = MainThreadWatchdog.stallSeconds(
            now: 1_000, pingInFlight: false, pingSentAt: 998
        )
        XCTAssertEqual(stalled, 0, accuracy: 0.0001,
            "an answered ping must report ZERO stall — a responsive main thread is not stalled")
    }

    /// The sampling threshold (1.5s) and the report line (5s) must BOTH be
    /// unreachable for a healthy app, no matter how long it idles. Pre-fix,
    /// every single tick cleared 1.5s and so logged a `stall sample`.
    func testIdleHealthyAppNeverReachesSamplingOrReportThresholds() {
        // Simulate 10 minutes of a healthy app: the pong always comes back
        // before the next tick, so every tick observes pingInFlight == false.
        for tick in 0..<300 {
            let now = TimeInterval(tick) * 2
            let stalled = MainThreadWatchdog.stallSeconds(
                now: now, pingInFlight: false, pingSentAt: now - 2
            )
            XCTAssertEqual(stalled, 0, accuracy: 0.0001,
                "healthy tick \(tick) must measure zero stall, got \(stalled)")
            XCTAssertLessThan(stalled, 1.5, "must never cross the stall-SAMPLING threshold")
            XCTAssertLessThan(stalled, 5.0, "must never cross the freeze-REPORT threshold")
        }
    }

    // MARK: - A real freeze must still be caught

    /// Only an UNANSWERED ping accumulates stall, and it must accumulate
    /// honestly — the fix must not buy silence by under-reporting.
    func testUnansweredPingAccumulatesRealStallTime() {
        let sentAt: TimeInterval = 1_000
        XCTAssertEqual(
            MainThreadWatchdog.stallSeconds(now: sentAt + 2, pingInFlight: true, pingSentAt: sentAt),
            2, accuracy: 0.0001)
        // Crosses the sampling threshold (1.5s) but not the report line.
        XCTAssertGreaterThan(
            MainThreadWatchdog.stallSeconds(now: sentAt + 2, pingInFlight: true, pingSentAt: sentAt), 1.5)
        // A genuine 0x8BADF00D-class freeze: past the 5s report line.
        XCTAssertEqual(
            MainThreadWatchdog.stallSeconds(now: sentAt + 6, pingInFlight: true, pingSentAt: sentAt),
            6, accuracy: 0.0001)
        XCTAssertGreaterThan(
            MainThreadWatchdog.stallSeconds(now: sentAt + 6, pingInFlight: true, pingSentAt: sentAt), 5.0)
    }

    /// A stall that keeps building must produce STRICTLY GROWING readings, so
    /// the ring advances (sampleIndex 1 → 2 → 3). The field data's frozen
    /// `sampleIndex: 1` proved the old readings were flat, not growing.
    func testBuildingStallProducesGrowingReadingsSoTheRingAdvances() {
        let sentAt: TimeInterval = 500
        var previous = -1.0
        for tick in 1...4 {
            let stalled = MainThreadWatchdog.stallSeconds(
                now: sentAt + TimeInterval(tick) * 2, pingInFlight: true, pingSentAt: sentAt
            )
            XCTAssertGreaterThan(stalled, previous,
                "a building stall must grow tick over tick (tick \(tick))")
            previous = stalled
        }
        // Three ticks past the 1.5s sampling threshold = three distinct samples,
        // which is exactly what the 3-slot ring is sized for.
        XCTAssertGreaterThanOrEqual(previous, 5.0, "four ticks of a real freeze must reach the report line")
    }

    /// Clock guard: `uptimeNow()` is monotonic, but a suspend/resume reset can
    /// make `pingSentAt` briefly newer than `now`. That must read as 0, never
    /// as a negative "stall" that would underflow the formatting.
    func testClockSkewNeverProducesNegativeStall() {
        XCTAssertEqual(
            MainThreadWatchdog.stallSeconds(now: 100, pingInFlight: true, pingSentAt: 105),
            0, accuracy: 0.0001, "a future pingSentAt must clamp to zero, not go negative")
    }

    // MARK: - Build attribution (the permanent triage capability)

    /// T41's triage had to infer the build from the upload batch's top-level
    /// `appVersion` because `m_build` rode ONLY the 5s report, never the stall
    /// samples — and stall samples were 9,676 of the 9,680 lines. Every
    /// freeze-subsystem line must name its own build.
    func testBuildNumberIsAvailableForEveryFreezeLine() {
        let build = MainThreadWatchdog.buildNumber
        XCTAssertFalse(build.isEmpty, "build number must never be empty")
        // In the test bundle the host app's CFBundleVersion is present; the
        // contract is that it resolves to something attributable, not "?".
        XCTAssertNotEqual(build, "?",
            "CFBundleVersion must resolve so a stall sample is attributable to a build")
    }
}
