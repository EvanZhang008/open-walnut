import XCTest
@testable import Walnut

/// The lock-screen work card's pure halves: the links a card opens, the content the server
/// pushes (decoded exactly as ActivityKit decodes it), and what the app does with the card on
/// each read of the server's numbers (`WorkCardPlan`).
final class WorkCardTests: XCTestCase {

    // MARK: - Links

    func testEveryListRoundTripsThroughItsLink() {
        for list in WorkCardList.allCases {
            let url = WorkCardLink.url(list)
            XCTAssertEqual(url.absoluteString, "walnut://work?list=\(list.rawValue)")
            XCTAssertEqual(WorkCardLink.list(from: url), list)
        }
    }

    func testOnlyCardLinksAreCardLinks() {
        XCTAssertNil(WorkCardLink.list(from: URL(string: "wn://pair?name=a&token=b")!))
        XCTAssertNil(WorkCardLink.list(from: URL(string: "https://work?list=needs")!))
        XCTAssertNil(WorkCardLink.list(from: URL(string: "walnut://inbox?list=needs")!))
        // A card link this build cannot read still opens the lists, on Working.
        XCTAssertEqual(WorkCardLink.list(from: URL(string: "walnut://work")!), .working)
        XCTAssertEqual(WorkCardLink.list(from: URL(string: "walnut://work?list=later")!), .working)
        XCTAssertEqual(WorkCardLink.list(from: URL(string: "WALNUT://WORK?list=needs")!), .needs)
    }

    // MARK: - The pushed content

    /// What src/core/push/work-card.ts sends as `content-state`, byte for byte.
    private let pushed = #"{"working":3,"needs":2,"completed":5,"since":1793782800,"updatedAt":1793786400,"needsTitle":"Review the release notes"}"#

    func testDecodesTheServersContentState() throws {
        let s = try JSONDecoder().decode(WorkCardAttributes.ContentState.self, from: Data(pushed.utf8))
        XCTAssertEqual(s.working, 3)
        XCTAssertEqual(s.needs, 2)
        XCTAssertEqual(s.completed, 5)
        XCTAssertEqual(s.sinceDate, Date(timeIntervalSince1970: 1_793_782_800))
        XCTAssertEqual(s.updatedDate, Date(timeIntervalSince1970: 1_793_786_400))
        XCTAssertEqual(s.needsTitle, "Review the release notes")
        XCTAssertEqual(s.primaryList, .needs)
    }

    func testNothingNeedsYouHasNoTitleAndOpensWorking() throws {
        let raw = #"{"working":1,"needs":0,"completed":0,"since":1,"updatedAt":2}"#
        let s = try JSONDecoder().decode(WorkCardAttributes.ContentState.self, from: Data(raw.utf8))
        XCTAssertNil(s.needsTitle)
        XCTAssertEqual(s.primaryList, .working)
        XCTAssertEqual(WorkCardList.allCases.map { s.count($0) }, [1, 0, 0])
    }

    func testDecodesTheServersView() throws {
        let raw = #"{"state":\#(pushed),"lists":{"working":["a","b","c"],"needs":["d","e"],"completed":["f"]},"active":true,"stretch":"2026-11-04T09:00:00.000Z"}"#
        let v = try JSONDecoder().decode(WalnutAPI.WorkCardView.self, from: Data(raw.utf8))
        XCTAssertTrue(v.active)
        XCTAssertEqual(v.stretch, "2026-11-04T09:00:00.000Z")
        XCTAssertEqual(v.lists.ids(.needs), ["d", "e"])
        let idle = #"{"state":\#(pushed),"lists":{"working":[],"needs":[],"completed":[]},"active":false,"stretch":null}"#
        XCTAssertNil(try JSONDecoder().decode(WalnutAPI.WorkCardView.self, from: Data(idle.utf8)).stretch)
    }

    func testTheUpdateTimeAloneIsNoNewFace() {
        let a = state(3, 1, 0, at: 10)
        XCTAssertTrue(a.sameFace(as: state(3, 1, 0, at: 99)))
        XCTAssertFalse(a.sameFace(as: state(3, 2, 0, at: 10)))
        var titled = a
        titled.needsTitle = "x"
        XCTAssertFalse(a.sameFace(as: titled))
    }

    // MARK: - The plan

    private func state(_ w: Int, _ n: Int, _ c: Int, at: Double = 100) -> WorkCardAttributes.ContentState {
        .init(working: w, needs: n, completed: c, since: 1, updatedAt: at, needsTitle: nil)
    }

    private func view(_ s: WorkCardAttributes.ContentState, active: Bool = true, stretch: String? = "s1") -> WalnutAPI.WorkCardView {
        .init(state: s, lists: .init(working: [], needs: [], completed: []), active: active, stretch: stretch)
    }

    private func decide(
        enabled: Bool = true, allowed: Bool = true, _ v: WalnutAPI.WorkCardView,
        current: WorkCardPlan.Current? = nil, dismissed: String? = nil
    ) -> WorkCardPlan.Action {
        WorkCardPlan.decide(enabled: enabled, allowed: allowed, view: v, current: current, dismissedStretch: dismissed)
    }

    func testStartsWhenSomethingWorksAndNoCardShows() {
        XCTAssertEqual(decide(view(state(2, 0, 0))), .start)
    }

    func testTheGraceAfterTheLastTaskKeepsACardButStartsNone() {
        // The server still says active for a while (15 minutes) after the last task stopped.
        XCTAssertEqual(decide(view(state(0, 1, 2))), .none)
        XCTAssertEqual(decide(view(state(0, 1, 2)), current: .init(stretch: "s1", state: state(1, 1, 1))), .update)
    }

    func testNothingWorkingStartsNothingAndEndsACard() {
        XCTAssertEqual(decide(view(state(0, 3, 4), active: false, stretch: nil)), .none)
        XCTAssertEqual(decide(view(state(0, 3, 4), active: false, stretch: nil), current: .init(stretch: "s1", state: state(1, 3, 3))), .end)
    }

    func testTheSwitchOffOrLiveActivitiesOffEndsTheCardAndStartsNone() {
        let current = WorkCardPlan.Current(stretch: "s1", state: state(2, 0, 0))
        XCTAssertEqual(decide(enabled: false, view(state(2, 0, 0))), .none)
        XCTAssertEqual(decide(enabled: false, view(state(2, 0, 0)), current: current), .end)
        XCTAssertEqual(decide(allowed: false, view(state(2, 0, 0))), .none)
        XCTAssertEqual(decide(allowed: false, view(state(2, 0, 0)), current: current), .end)
    }

    func testUpdatesOnlyOnANewFaceAndNeverWithOlderNumbers() {
        let current = WorkCardPlan.Current(stretch: "s1", state: state(2, 0, 0, at: 100))
        XCTAssertEqual(decide(view(state(2, 0, 0, at: 200)), current: current), .none)
        XCTAssertEqual(decide(view(state(2, 1, 0, at: 200)), current: current), .update)
        // A push already drew newer numbers than this read: the read waits for the next one.
        XCTAssertEqual(decide(view(state(5, 5, 5, at: 50)), current: current), .none)
        // Same numbers, a new stretch (the server restarted it): the card takes the stretch.
        XCTAssertEqual(decide(view(state(2, 0, 0, at: 200), stretch: "s2"), current: current), .update)
    }

    func testACardTheUserRemovedStaysOffUntilTheNextStretch() {
        XCTAssertEqual(decide(view(state(2, 0, 0)), dismissed: "s1"), .none)
        XCTAssertEqual(decide(view(state(2, 0, 0), stretch: "s2"), dismissed: "s1"), .start)
    }

    func testRemovedMeansGoneWhileItsStretchRunsAndBeforeTheSystemLimit() {
        let now = Date(timeIntervalSince1970: 100_000)
        let v = view(state(2, 0, 0))
        let early = now.addingTimeInterval(-3600)
        XCTAssertTrue(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: early, stillOnScreen: false, view: v, now: now, startedIn: "i", runningIn: "i"))
        // Still on the lock screen (ended by iOS, not removed): not the user.
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: early, stillOnScreen: true, view: v, now: now, startedIn: "i", runningIn: "i"))
        // The server ended that stretch and a new one runs: the card ended, nobody removed it.
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s0", startedAt: early, stillOnScreen: false, view: v, now: now, startedIn: "i", runningIn: "i"))
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: early, stillOnScreen: false, view: view(state(0, 0, 0), active: false, stretch: nil), now: now, startedIn: "i", runningIn: "i"))
        // iOS ends a card after eight hours on its own.
        let old = now.addingTimeInterval(-WorkCardPlan.systemLimit - 1)
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: old, stillOnScreen: false, view: v, now: now, startedIn: "i", runningIn: "i"))
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: nil, startedAt: early, stillOnScreen: false, view: v, now: now, startedIn: "i", runningIn: "i"))
        // A card whose start this install lost is started again rather than kept off.
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: nil, stillOnScreen: false, view: v, now: now, startedIn: "i", runningIn: "i"))
    }

    func testACardAnUpdateOrARestartTookAwayWasNotRemovedByTheUser() {
        let now = Date(timeIntervalSince1970: 100_000)
        let v = view(state(2, 0, 0))
        let early = now.addingTimeInterval(-3600)
        func gone(_ startedIn: String?, _ runningIn: String?) -> Bool {
            WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: early, stillOnScreen: false, view: v, now: now,
                                      startedIn: startedIn, runningIn: runningIn)
        }
        // The same install and boot: the user swiped it away.
        XCTAssertTrue(gone("/apps/A|boot1", "/apps/A|boot1"))
        // Walnut was updated or reinstalled since (iOS gave it a new folder): iOS ended the card.
        XCTAssertFalse(gone("/apps/A|boot1", "/apps/B|boot1"))
        // The phone restarted after the card began.
        XCTAssertFalse(gone("/apps/A|boot1", "/apps/A|boot2"))
        // Not known (a card from a build that did not note it, or a boot that could not be read).
        XCTAssertFalse(gone(nil, "/apps/B|boot1"))
        XCTAssertFalse(gone(nil, nil))
        XCTAssertFalse(gone("/apps/A|boot1", nil))
    }

    func testThisInstallAndBootAreKnownAndStable() {
        let here = WorkCardController.runningIn
        XCTAssertNotNil(here)
        XCTAssertEqual(here, WorkCardController.runningIn)
        XCTAssertTrue(here?.hasPrefix(Bundle.main.bundlePath + "|") == true)
        XCTAssertGreaterThan(here?.split(separator: "|").last?.count ?? 0, 8)
    }

    func testCardsGoneBecauseLiveActivitiesWentOffWereNotRemovedByTheUser() {
        let now = Date(timeIntervalSince1970: 100_000)
        let early = now.addingTimeInterval(-3600)
        XCTAssertTrue(WorkCardPlan.removedByUser(startedAt: early, now: now, allowed: true))
        XCTAssertFalse(WorkCardPlan.removedByUser(startedAt: early, now: now, allowed: false))
        XCTAssertFalse(WorkCardPlan.wasDismissed(memoStretch: "s1", startedAt: early, stillOnScreen: false, view: view(state(2, 0, 0)), now: now, allowed: false, startedIn: "i", runningIn: "i"))
    }

    // MARK: - What the user is told

    func testTheFooterSaysWhenTheCardCannotChangeWhileWalnutIsClosed() {
        let ready = WorkCardPlan.footer(enabled: true, allowed: true, background: .ready)
        XCTAssertTrue(ready.contains("Silent"))
        XCTAssertTrue(ready.contains("15 minutes"))
        XCTAssertFalse(ready.contains("does not change"))
        // With no way to push, it says the card neither changes nor ends by itself while closed.
        let noKey = WorkCardPlan.footer(enabled: true, allowed: true, background: .noKey)
        XCTAssertTrue(noKey.contains("does not change"))
        XCTAssertTrue(noKey.contains("ends when you leave Walnut with nothing working"))
        XCTAssertFalse(ready.contains("are done"), "the footer names Completed as the card does")
        // Never asked: no notification row yet, so no background updates either.
        XCTAssertTrue(WorkCardPlan.footer(enabled: true, allowed: true, background: .ready, notificationsUndecided: true).contains("not turned on for Walnut yet"))
        XCTAssertEqual(WorkCardPlan.footer(enabled: true, allowed: true, background: .unknown), ready)
        XCTAssertTrue(WorkCardPlan.footer(enabled: true, allowed: true, background: .noKey).contains("no APNs key"))
        XCTAssertTrue(WorkCardPlan.footer(enabled: true, allowed: true, background: .notificationsOff).contains("Notifications are off"))
        // iOS says notifications are off, though the server still holds this phone's row.
        XCTAssertTrue(WorkCardPlan.footer(enabled: true, allowed: true, background: .ready, notificationsDenied: true).contains("Notifications are off"))
        XCTAssertTrue(WorkCardPlan.footer(enabled: true, allowed: false, background: .ready).contains("Live Activities are off"))
        // Switched off: only what the card is, no warning about a card that is not there.
        XCTAssertFalse(WorkCardPlan.footer(enabled: false, allowed: true, background: .noKey).contains("APNs"))
        // No repository paths for the person holding the phone.
        for b in [WorkCardPlan.Background.unknown, .ready, .noKey, .notificationsOff] {
            XCTAssertFalse(WorkCardPlan.footer(enabled: true, allowed: true, background: b).contains("docs/"))
        }
        XCTAssertTrue(WorkCardPlan.needsIOSSettings(enabled: true, allowed: false, notificationsDenied: false))
        XCTAssertTrue(WorkCardPlan.needsIOSSettings(enabled: true, allowed: true, notificationsDenied: true))
        XCTAssertFalse(WorkCardPlan.needsIOSSettings(enabled: false, allowed: false, notificationsDenied: true))
        XCTAssertFalse(WorkCardPlan.needsIOSSettings(enabled: true, allowed: true, notificationsDenied: false))
    }

    func testTheStartLineNamesTheDayOnceTheStretchIsOlderThanToday() {
        let cal = Calendar.current
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 15, minute: 0))!
        let today = cal.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 9, minute: 41))!
        let monday = cal.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 9, minute: 41))!
        XCTAssertEqual(WorkCardSheet.started(today, now: now), today.formatted(date: .omitted, time: .shortened))
        let older = WorkCardSheet.started(monday, now: now)
        XCTAssertTrue(older.contains(monday.formatted(.dateTime.weekday(.abbreviated))), older)
    }

    func testAnOlderServerSaysNothingAboutPushingAndANewOneDoes() throws {
        let old = #"{"state":\#(pushed),"lists":{"working":[],"needs":[],"completed":[]},"active":true,"stretch":"s"}"#
        XCTAssertNil(try JSONDecoder().decode(WalnutAPI.WorkCardView.self, from: Data(old.utf8)).pushes)
        let new = #"{"state":\#(pushed),"lists":{"working":[],"needs":[],"completed":[]},"active":true,"stretch":"s","pushes":false}"#
        XCTAssertEqual(try JSONDecoder().decode(WalnutAPI.WorkCardView.self, from: Data(new.utf8)).pushes, false)
    }

    // MARK: - The demo answers like the server

    @MainActor
    func testTheDemoCountsItsOwnTasks() throws {
        let server = DemoServer()
        let reply = server.workCard()
        guard case .json(let data) = reply.body else { return XCTFail("no JSON") }
        let v = try JSONDecoder().decode(WalnutAPI.WorkCardView.self, from: data)
        XCTAssertGreaterThan(v.state.working, 0, "the demo has working tasks, so it shows a card")
        XCTAssertTrue(v.active)
        XCTAssertEqual(v.lists.working.count, v.state.working)
        XCTAssertEqual(v.lists.needs.count, v.state.needs)
        XCTAssertEqual(v.lists.completed.count, v.state.completed)
        DemoServer.resetWorkCard()
    }
    // MARK: - Leaving the app, opening a link, the lists' rows

    func testLeavingTheAppWithNoWayToPushLeavesTheCardTrue() {
        XCTAssertEqual(WorkCardPlan.leaving(background: .ready, working: 0), .keep)
        XCTAssertEqual(WorkCardPlan.leaving(background: .unknown, working: 0), .keep)
        for b in [WorkCardPlan.Background.noKey, .notificationsOff] {
            // Nothing works and nothing will end it: it ends now, as the server would have.
            XCTAssertEqual(WorkCardPlan.leaving(background: b, working: 0), .end)
            // Work runs on unseen: it says how old its numbers are soon, instead of passing them off.
            XCTAssertEqual(WorkCardPlan.leaving(background: b, working: 3), .staleSoon)
            XCTAssertEqual(WorkCardPlan.leaving(background: b, working: nil), .staleSoon)
        }
        XCTAssertLessThan(WorkCardController.staleSoon, WorkCardController.staleAfter)
    }

    @MainActor
    func testACardLinkClosesAnOpenSheetButNeverOneHoldingUnsavedWork() {
        XCTAssertEqual(WorkCardLinkBox.plan(over: []), .show)
        XCTAssertEqual(WorkCardLinkBox.plan(over: [false]), .closeFirst)
        XCTAssertEqual(WorkCardLinkBox.plan(over: [false, false]), .closeFirst)
        // A sheet that refuses a swipe down (unsaved edits, a decision owed) stays in front.
        XCTAssertEqual(WorkCardLinkBox.plan(over: [true]), .keep)
        XCTAssertEqual(WorkCardLinkBox.plan(over: [false, true]), .keep)
        // A sheet on its way out: wait for it, rather than raise the list into its animation.
        XCTAssertEqual(WorkCardLinkBox.plan(over: [], closing: true), .wait)
        XCTAssertEqual(WorkCardLinkBox.plan(over: [true], closing: true), .keep)
    }

    func testTheTitleLinkNamesItsTaskAndOlderLinksStillOpenTheirList() {
        let url = WorkCardLink.url(.needs, task: "t-1")
        XCTAssertEqual(url.absoluteString, "walnut://work?list=needs&task=t-1")
        XCTAssertEqual(WorkCardLink.list(from: url), .needs)
        XCTAssertEqual(WorkCardLink.task(from: url), "t-1")
        XCTAssertNil(WorkCardLink.task(from: WorkCardLink.url(.needs)))
        XCTAssertNil(WorkCardLink.task(from: URL(string: "wn://pair?task=x")!))
        // The pushed state carries it; a server without it decodes to nil.
        let s = try! JSONDecoder().decode(WorkCardAttributes.ContentState.self, from: Data(#"{"working":1,"needs":1,"completed":0,"since":1,"updatedAt":2,"needsTitle":"x","needsTaskId":"t-1"}"#.utf8))
        XCTAssertEqual(s.needsTaskId, "t-1")
        // Another task with the same title is another face: its link must follow.
        var other = s
        other.needsTaskId = "t-2"
        XCTAssertFalse(s.sameFace(as: other))
    }

    private func task(_ id: String, summary: String? = nil, result: String? = nil, turnStarted: String? = nil) -> WalnutTask {
        var t = WalnutTask(
            id: id, title: "Task \(id)", status: "in_progress", phase: "IN_PROGRESS", priority: "none", project: "Walnut",
            dueDate: nil, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-26T05:00:00Z", completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: summary, parentTaskId: nil, userStatus: nil
        )
        if let result { t.resultReport = WalnutResultReport(result: result) }
        if let turnStarted { t.liveActivity = WalnutLiveActivity(kind: "tool", since: turnStarted, turnStartedAt: turnStarted) }
        return t
    }

    func testARowSaysWhatItsListMeans() {
        let t = task("a", summary: "Rebuilding the index: 38 of 120 shards are done.", result: "Index rebuilt; search is 3x faster.")
        // A finished task: what it reported, never the history that reads as still running.
        XCTAssertEqual(WorkCardSheet.detail(.completed, t), "Index rebuilt; search is 3x faster.")
        XCTAssertNil(WorkCardSheet.detail(.completed, task("b", summary: "38 of 120 done")))
        // A working task says nothing of its own: its summary may say "ready for review".
        XCTAssertNil(WorkCardSheet.detail(.working, t))
        XCTAssertNil(WorkCardSheet.detail(.needs, t))
    }

    func testARowTimeSaysWhatItIsTheTimeOf() {
        func row(_ t: WalnutTask, _ s: UserState) -> TeamStatusRow { TeamStatusRow(task: t, state: s, status: nil, depth: 1) }
        XCTAssertEqual(TeamStatusRowView.timeVerb(row(task("a"), .done)), "Finished")
        XCTAssertEqual(TeamStatusRowView.timeVerb(row(task("a", turnStarted: "2026-10-26T04:00:00Z"), .working)), "Started")
        XCTAssertEqual(TeamStatusRowView.timeVerb(row(task("a"), .working)), "Updated")
        XCTAssertEqual(TeamStatusRowView.timeVerb(row(task("a"), .needs)), "Asked")
    }
}
