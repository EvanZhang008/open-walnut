import XCTest
@testable import Walnut

/// The board-refresh funnel (TasksStoreRefresh.swift), pinned against the
/// 2026-09-01 request storm.
///
/// What happened: the board's refresh hung off a SwiftUI `.task`, which is tied to
/// a view's lifetime in the render tree rather than to the screen being visible.
/// With a session conversation pushed over the board, that `.task` was re-armed
/// again and again (measured on the pinned simulator: 22 re-arms against 2 body
/// passes of the same view instance, `@State` never rebuilt), and the bundle it
/// fired WROTE the lists the board renders — so each fetch bought the next one.
/// The phone asked production for five endpoints every ~160ms for thirteen
/// minutes: 1,880 requests/minute, ~3.7 MB/s of JSON re-serialised on the single
/// event loop every route shares.
///
/// Every test here is one sentence of that story, because the individual pieces
/// all looked correct while it was happening: the requests were 200s, the parses
/// succeeded, and the same-value write guards meant the UI did not even flicker.
///
/// `focusTasks` stands in for "a bundle ran": exactly one call per bundle, and it
/// is the member of the five that the injected transport really answers. The
/// tasks/sessions halves ride the store's own WalnutAPI, and `taskFolders` has a
/// no-op default implementation in the protocol, so neither can be counted here.
@MainActor
final class BoardRefreshFunnelTests: XCTestCase {
    private func makeStore() -> (TasksStore, MockTaskTransport) {
        let mock = MockTaskTransport()
        return (TasksStore(transport: mock), mock)
    }

    // MARK: - The incident

    func testABurstOfAppearanceAsksFiresExactlyOneBundle() async {
        let (store, mock) = makeStore()
        // 25 asks is the measured re-arm count, not a round number.
        for _ in 0..<25 {
            await store.refreshBoard(origin: .boardAppeared)
        }
        XCTAssertEqual(
            mock.callCount("focusTasks"), 1,
            "an appearance signal that repeats must not repeat the fetch — this is the storm"
        )
    }

    func testAnAppearanceAskOverFreshListsFetchesNothing() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        XCTAssertEqual(mock.callCount("focusTasks"), 1)
        await store.refreshBoard(origin: .boardAppeared)
        XCTAssertEqual(
            mock.callCount("focusTasks"), 1,
            "the lists are a second old; the honest answer to 'are they fresh' is the lists"
        )
    }

    func testAnAppearanceAskOverStaleListsDoesFetch() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        // Coming back to the board after a while is exactly what this trigger is
        // FOR, so the gate has to let it through. Reaching into the timestamp
        // instead of sleeping keeps the test honest about what it is asserting.
        store.lastBoardRefreshAt = Date(timeIntervalSinceNow: -60)
        await store.refreshBoard(origin: .boardAppeared)
        XCTAssertEqual(mock.callCount("focusTasks"), 2)
    }

    // MARK: - Who is exempt, and who is not

    func testPullToRefreshAlwaysFetches() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(
            mock.callCount("focusTasks"), 2,
            "a spinner the user pulled down themselves has to end in a real fetch"
        )
    }

    func testASecondPullStillFetches() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .pullToRefresh)
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(mock.callCount("focusTasks"), 2)
    }

    func testTheColdStartForegroundDuplicateIsCollapsed() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        // A cold launch that also reports its first activation asks twice for the
        // same five answers. One of them is waste, and it was waste before this
        // funnel existed too.
        await store.refreshBoard(origin: .foreground)
        XCTAssertEqual(mock.callCount("focusTasks"), 1)
    }

    func testTheDuplicateIsCollapsedEvenWhenTheTwoLandSecondsApart() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .foreground)
        // 2.53s is the gap the UI gate MEASURED on real data between the activation
        // bundle and the cold-start one: `initialize()` awaits the disk-cache
        // adoptions (3,126 tasks, 818 sessions) before it asks, and an earlier
        // version of this funnel used a 2s window, so both ran and the launch cost 10
        // requests. Whichever of the two wins the race, the loser must recognise it.
        store.lastBoardRefreshAt = Date(timeIntervalSinceNow: -2.53)
        await store.refreshBoard(origin: .coldStart)
        XCTAssertEqual(
            mock.callCount("focusTasks"), 1,
            "the window has to be wider than a disk adoption, which no constant here "
                + "can bound — a 2s window made this collapse a coin flip"
        )
    }

    func testTheReverseRaceCollapsesToo() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        store.lastBoardRefreshAt = Date(timeIntervalSinceNow: -2.53)
        await store.refreshBoard(origin: .foreground)
        XCTAssertEqual(mock.callCount("focusTasks"), 1)
    }

    func testForegroundAfterARealAbsenceFetches() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        store.lastBoardRefreshAt = Date(timeIntervalSinceNow: -300)
        await store.refreshBoard(origin: .foreground)
        XCTAssertEqual(
            mock.callCount("focusTasks"), 2,
            "returning to the app must heal whatever the socket missed while it was away"
        )
    }

    func testThePollIsNeverDelayedByItsOwnWindow() {
        XCTAssertEqual(
            TasksStore.BoardRefreshOrigin.poll.minimumAge, 0,
            "the poll's spacing IS its timer (30s or 120s); a freshness window on top "
                + "of that would silently stretch the reconcile cadence"
        )
    }

    // MARK: - The invariants, stated as invariants
    //
    // These two are the whole lesson. A call site can always be rewritten by
    // someone who does not know this story, so the rule lives on the origin.

    func testAnAppearanceOriginIsFreshnessGated() {
        XCTAssertGreaterThan(
            TasksStore.BoardRefreshOrigin.boardAppeared.minimumAge, 0,
            "an appearance refresh is re-triggerable by the framework, so it MUST ask "
                + "how fresh the data is; a zero here re-opens the 2026-09-01 storm"
        )
    }

    func testEveryOriginThatCanBeReArmedOutsidesTheFloorIsStillCounted() {
        // The structural version of the bug above: any origin whose freshness window
        // is at or above the floor is refused by the FIRST gate, so a funnel that
        // only instruments the second gate is blind to it. Both gates must count.
        for origin in [
            TasksStore.BoardRefreshOrigin.boardAppeared, .coldStart, .foreground,
        ] {
            XCTAssertGreaterThanOrEqual(
                origin.minimumAge, TasksStore.boardRefreshFloor,
                "\(origin.rawValue) never reaches the floor branch, so its refusals "
                    + "have to be counted where they actually happen"
            )
        }
    }

    func testOnlyAGestureIsExemptFromTheFloor() {
        for origin in [
            TasksStore.BoardRefreshOrigin.coldStart, .foreground, .poll, .boardAppeared,
        ] {
            XCTAssertTrue(
                origin.honoursFloor,
                "\(origin.rawValue) is not a gesture, so it is bounded by the floor"
            )
        }
        XCTAssertFalse(TasksStore.BoardRefreshOrigin.pullToRefresh.honoursFloor)
    }

    // MARK: - Reporting
    //
    // The floor without the report would be the worst of both worlds: a bug that
    // no longer hurts the server and no longer shows up anywhere either.

    func testRefusedAsksAreCounted() async {
        let (store, _) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        for _ in 0..<12 {
            await store.refreshBoard(origin: .poll)
        }
        XCTAssertEqual(
            store._boardRefreshDropsForTesting, 12,
            "every refusal is counted, so a loop is visible as a number even when the "
                + "requests it would have made are gone"
        )
    }

    func testAppearanceRefusalsAreCountedToo() async {
        let (store, _) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        for _ in 0..<12 {
            await store.refreshBoard(origin: .boardAppeared)
        }
        // The first version of this funnel counted only the FLOOR's refusals, which
        // looked reasonable and was exactly wrong: since every appearance ask is
        // refused one branch earlier by the freshness window, the counter never saw
        // the origin the whole mechanism was built for, and the warning could only
        // ever name `poll`. Worse, a re-armed appearance loop answered by the window
        // makes no requests at all — so if this counter does not see it, nothing
        // does, while it still burns the MainActor at the framework's re-arm rate.
        XCTAssertEqual(
            store._boardRefreshDropsForTesting, 12,
            "the refusal that costs nothing downstream is precisely the one only this "
                + "counter can report"
        )
    }

    func testARunOfRefusalsIsCountedFromTheLastBundleNotForever() async {
        let (store, _) = makeStore()
        await store.refreshBoard(origin: .coldStart)
        for _ in 0..<4 { await store.refreshBoard(origin: .boardAppeared) }
        store.lastBoardRefreshAt = Date(timeIntervalSinceNow: -60)
        await store.refreshBoard(origin: .boardAppeared)
        for _ in 0..<2 { await store.refreshBoard(origin: .boardAppeared) }
        XCTAssertEqual(store.boardRefreshDropsSinceRun, 2, "a bundle that ran clears the run")
        XCTAssertEqual(store._boardRefreshDropsForTesting, 6, "the lifetime total keeps them all")
    }

    // MARK: - Coalescing

    func testConcurrentAsksJoinTheSameBundle() async {
        let (store, mock) = makeStore()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        // Two asks that cannot be told apart by the clock: both must land on ONE
        // bundle, or the funnel would still allow a parallel fan-out.
        let first = Task { await store.refreshBoard(origin: .pullToRefresh) }
        let second = Task { await store.refreshBoard(origin: .pullToRefresh) }
        // Let both reach the transport/join point before releasing it.
        try? await Task.sleep(for: .milliseconds(50))
        gate.open()
        await first.value
        await second.value
        XCTAssertEqual(mock.callCount("focusTasks"), 1)
    }

    func testTheHandleIsClearedSoLaterAsksStillWork() async {
        let (store, mock) = makeStore()
        await store.refreshBoard(origin: .pullToRefresh)
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(
            mock.callCount("focusTasks"), 2,
            "a leaked in-flight handle would turn every later ask into a join on a "
                + "finished task, i.e. a board that never refreshes again"
        )
    }
}
