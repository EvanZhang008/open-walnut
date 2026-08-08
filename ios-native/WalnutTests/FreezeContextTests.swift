import XCTest
@testable import Walnut

/// Invariants of the freeze-context registry (the "WHERE did it freeze" side of
/// MainThreadWatchdog). These matter because the registry is read from a
/// BACKGROUND thread while the main thread is dead: if a snapshot key goes
/// missing, or the keyboard counter stops windowing, a field freeze report goes
/// back to being undiagnosable.
final class FreezeContextTests: XCTestCase {

    private var context: FreezeContext { FreezeContext.shared }

    override func setUp() {
        super.setUp()
        context.resetForTesting()
    }

    override func tearDown() {
        context.resetForTesting()
        super.tearDown()
    }

    // MARK: - Snapshot round-trip

    func testSnapshotCarriesEveryContextKey() {
        let meta = context.snapshotMeta()
        for key in [
            "ctxScreen", "ctxKeyboard", "ctxKbFlips10s", "ctxDraftChars",
            "ctxHistoryRows", "ctxLiveChars", "ctxLiveTruncated",
            "ctxMemoryMB", "ctxTrail", "ctxMainWork",
        ] {
            XCTAssertNotNil(meta[key], "freeze meta must always carry \(key)")
        }
    }

    func testPushedStateRoundTripsIntoSnapshot() {
        context.setScreen("session:1a2b3c4d")
        context.setDraftChars(148)
        context.setHistoryRows(412)
        context.setLiveText(chars: 96_000, truncated: true)
        context.noteKeyboard(visible: true)

        let meta = context.snapshotMeta()
        XCTAssertEqual(meta["ctxScreen"], "session:1a2b3c4d")
        XCTAssertEqual(meta["ctxDraftChars"], "148")
        XCTAssertEqual(meta["ctxHistoryRows"], "412")
        XCTAssertEqual(meta["ctxLiveChars"], "96000")
        XCTAssertEqual(meta["ctxLiveTruncated"], "1")
        XCTAssertEqual(meta["ctxKeyboard"], "shown")
    }

    /// SwiftUI runs the INCOMING view's onAppear before the outgoing view's
    /// onDisappear. An unconditional clear would therefore erase the screen the
    /// user just navigated to — the name guard is what prevents that.
    func testLeavingRestoresThePreviousScreenAndIgnoresStaleClears() {
        context.setScreen("tasks")
        context.setScreen("session:deadbeef")
        context.clearScreen("session:deadbeef")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "tasks")

        context.setScreen("chat")
        context.clearScreen("session:deadbeef") // stale disappear, arrives late
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "chat",
                       "a stale disappear must not clobber the current screen")
    }

    func testMemoryReadIsPlausible() {
        // Read off-main deliberately: the watchdog's report path never touches
        // the main thread, so this call must be safe from any queue.
        let expectation = expectation(description: "memory read off-main")
        DispatchQueue.global(qos: .utility).async {
            let mb = FreezeContext.residentMemoryMB()
            XCTAssertGreaterThan(mb, 0, "phys_footprint should be readable off-main")
            XCTAssertLessThan(mb, 20_000, "implausible footprint — wrong units?")
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)
    }

    // MARK: - Breadcrumb ring buffer

    func testTrailKeepsTheLastEightEventsNewestFirst() {
        for i in 0..<12 { context.note("e\(i)") }
        let trail = context.snapshotMeta()["ctxTrail"] ?? ""
        let parts = trail.components(separatedBy: " | ")
        XCTAssertEqual(parts.count, 8, "ring buffer must stay bounded at 8")
        XCTAssertTrue(parts.first?.contains("e11") == true, "newest event comes first")
        XCTAssertTrue(parts.last?.contains("e4") == true, "oldest kept event is #4")
        XCTAssertFalse(trail.contains("e3"), "evicted events must be gone")
    }

    func testTrailCarriesMagnitudeAndAge() {
        context.note("voice-transcribed", 148)
        let trail = context.snapshotMeta()["ctxTrail"] ?? ""
        XCTAssertTrue(trail.contains("voice-transcribed:148"), "trail was: \(trail)")
        // Formatted as "-<age>s <name>" — the age is what pairs a breadcrumb
        // with the stall onset.
        XCTAssertTrue(trail.hasPrefix("-"), "trail entries lead with a relative age")
    }

    func testEmptyTrailIsAPlaceholderNotAnEmptyString() {
        XCTAssertEqual(context.snapshotMeta()["ctxTrail"], "-")
    }

    // MARK: - Keyboard counter windowing

    /// THE probe for the suspected show/hide oscillation. It must count only
    /// events inside the 10s window — an all-time counter would make every
    /// long-lived session look like it was oscillating.
    func testKeyboardTransitionsWindowsToTenSeconds() {
        let now: TimeInterval = 1_000
        // Three flips long ago, four inside the window.
        for offset in [30.0, 25.0, 20.0] {
            context.noteKeyboard(visible: true, at: now - offset)
        }
        for offset in [9.5, 6.0, 3.0, 0.5] {
            context.noteKeyboard(visible: false, at: now - offset)
        }
        XCTAssertEqual(context.keyboardTransitions(now: now), 4)
        XCTAssertEqual(context.snapshotMeta(now: now)["ctxKbFlips10s"], "4")
        XCTAssertEqual(context.keyboardTransitions(window: 60, now: now), 7)
    }

    func testKeyboardRingBufferIsBoundedButStillCountsAFastOscillation() {
        let now: TimeInterval = 500
        // 40 flips in 4s — far past the ring's capacity. The count saturates at
        // the buffer size, which is fine: any double-digit number is the signal.
        for i in 0..<40 {
            context.noteKeyboard(visible: i % 2 == 0, at: now - 4 + Double(i) * 0.1)
        }
        let flips = context.keyboardTransitions(now: now)
        XCTAssertGreaterThanOrEqual(flips, 10, "an oscillation must read as double digits")
        XCTAssertLessThanOrEqual(flips, 24, "ring buffer must stay bounded")
        XCTAssertEqual(context.snapshotMeta(now: now)["ctxKeyboard"], "hidden",
                       "visibility reflects the LAST event")
    }

    // MARK: - Overhead

    /// The push paths run per keystroke / per 8Hz flush. They must be scalar
    /// writes under a lock — no allocation, no string building.
    func testPushPathIsCheapEnoughForAHotPath() {
        let iterations = 100_000
        let started = Date()
        for i in 0..<iterations {
            context.setDraftChars(i)
            context.setLiveText(chars: i, truncated: false)
        }
        let elapsed = Date().timeIntervalSince(started)
        // 200k locked scalar writes. Generous ceiling for a loaded CI machine;
        // a regression that starts allocating or formatting blows well past it.
        XCTAssertLessThan(elapsed, 2.0, "push path cost \(elapsed)s for \(iterations) iterations")
    }
}
