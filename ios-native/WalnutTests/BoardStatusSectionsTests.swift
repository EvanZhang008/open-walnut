import XCTest
import SwiftUI
@testable import Walnut

/// The board's status sections (Watching, Needs you, Working, Waiting / snoozed, Background,
/// Completed):
/// which row goes where, in what order, what is open by default and how that is stored, and
/// the Watch write. The model is `BoardStatusSections.swift`; `BoardModel.assemble` is where
/// the bands give their rows up to it.
final class BoardStatusSectionsTests: XCTestCase {

    private static let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!

    private func task(
        _ id: String, project: String = "", status: String = "todo", phase: String = "TODO",
        pinned: Bool? = true, updated: String = "2026-08-27T00:00:00Z",
        completed: String? = nil, start: String? = nil, waitUntil: String? = nil,
        watched: String? = nil, background: String? = nil,
        userState: String? = nil, user: WalnutUserStatus? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "task \(id)", status: status, phase: phase,
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-20T00:00:00Z", updatedAt: updated,
            completedAt: completed ?? (status == "done" ? updated : nil),
            starred: nil, pinned: pinned, tags: nil, summary: nil,
            startDate: start,
            userStatus: user ?? userState.map { WalnutUserStatus(state: $0) },
            waitUntil: waitUntil, watchedAt: watched, backgroundAt: background
        )
    }

    private func session(_ id: String, taskId: String, lastActive: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "s", taskId: taskId, taskTitle: "t", project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil, startedAt: "2026-08-20T00:00:00Z",
            lastActiveAt: lastActive, messageCount: 1, cwd: nil, pinned: true,
            focusTier: nil, description: nil
        )
    }

    private func board(
        _ tasks: [WalnutTask], tierOf: [String: String]? = nil, sessions: [WalnutSession] = [],
        query: String = "", grouping: BoardGrouping = .tier, date: BoardDateFilter = .now,
        scope: String? = nil
    ) -> BoardAssembly {
        let pinned = tasks.filter { $0.pinned == true }.map(\.id)
        let tiers = tierOf ?? Dictionary(uniqueKeysWithValues: pinned.map { ($0, "focus") })
        var order: [String: [String]] = [:]
        for id in pinned { if let tier = tiers[id] { order[tier, default: []].append(id) } }
        return BoardModel.assemble(
            tasks: tasks, sessions: sessions, tierOf: tiers, tierOrder: order, customTiers: [],
            query: query, grouping: grouping, dateFilter: date, scope: scope,
            statusSections: true, now: Self.now
        )
    }

    private func bandIds(_ b: BoardAssembly) -> [String] { b.bands.flatMap { $0.rows.map(\.id) } }

    // MARK: - Membership

    /// Each row of the view is drawn exactly once, in its state's section: done in Completed,
    /// the user's turn in Needs you (the user status first, the phase as the fallback, never
    /// a done row), WAITING or a later start (under Now) in Waiting / snoozed, the rest in the
    /// bands under Working. Both groupings agree.
    func testEveryRowLandsInExactlyOneSection() {
        let tasks = [
            task("open"),
            task("needsPhase", phase: "NEED_ACTION"),
            task("needsStatus", phase: "IN_PROGRESS", userState: "needs"),
            task("notNeeds", phase: "NEED_ACTION", userState: "waiting"),
            task("doneNeeds", status: "done", phase: "COMPLETE", userState: "needs"),
            task("parked", phase: "WAITING"),
            task("parkedNeeds", phase: "WAITING", userState: "needs"),
            task("later", start: "2026-09-01"),
        ]
        for grouping in [BoardGrouping.tier, .project] {
            let b = board(tasks, grouping: grouping)
            let s = b.sections
            XCTAssertTrue(s.active)
            XCTAssertEqual(Set(bandIds(b)), ["open", "notNeeds"], "\(grouping)")
            XCTAssertEqual(Set(s.needs.map(\.id)), ["needsPhase", "needsStatus", "parkedNeeds"], "\(grouping)")
            XCTAssertEqual(Set(s.waiting.map(\.id)), ["parked", "later"], "\(grouping)")
            XCTAssertEqual(s.done.map(\.id), ["doneNeeds"], "\(grouping)")
            XCTAssertEqual(s.workingCount, 2)
            let drawn = bandIds(b) + s.needs.map(\.id) + s.waiting.map(\.id) + s.done.map(\.id)
            XCTAssertEqual(drawn.count, Set(drawn).count, "a row drawn twice (\(grouping))")
            XCTAssertEqual(Set(drawn), Set(tasks.map(\.id)), "a row lost (\(grouping))")
        }
    }

    /// There is no To read section (2026-11-03, the user: "I dont wnat serpeate to read"): a
    /// stored `read`, or an older server's `waiting` with `toRead`, is a Needs you row, sorted
    /// with the others by latest activity and wearing the needs mark; a snoozed status stays
    /// under Waiting / snoozed whatever it holds.
    func testToReadRowsAreNeedsYouRowsAndNothingSnoozed() {
        let tasks = [
            task("read", phase: "NEED_ACTION", updated: "2026-08-25T00:00:00Z",
                 user: .init(state: "read", waitingOn: "The result is ready", toRead: "result")),
            task("legacy", phase: "NEED_ACTION", updated: "2026-08-26T00:00:00Z",
                 user: .init(state: "waiting", waitingOn: "It answered your question", toRead: "answer")),
            task("snoozed", phase: "WAITING",
                 user: .init(state: "waiting", snoozed: .init(until: "2026-09-01"), toRead: "result")),
            task("needs", phase: "NEED_ACTION", user: .init(state: "needs", ask: "Pick one", toRead: "result")),
            task("open"),
        ]
        let s = board(tasks).sections
        XCTAssertEqual(s.needs.map(\.id), ["needs", "legacy", "read"], "latest activity first, To read among them")
        XCTAssertEqual(s.count(.needs), 3)
        XCTAssertEqual(s.waiting.map(\.id), ["snoozed"])
        XCTAssertEqual(BoardStatusSection.allCases.filter { s.isShown($0) }, [.needs, .working, .waiting])
        // No To read section exists at all.
        XCTAssertEqual(BoardStatusSection.allCases, [.watching, .needs, .working, .waiting, .background, .done])
        XCTAssertNil(BoardStatusSection(rawValue: "read"))
        XCTAssertFalse(BoardStatusSection.allCases.map(\.label).contains("To read"))
        // A stored "read: true" open preference from the build that had the section is ignored.
        XCTAssertEqual(BoardStatusSectionPrefs.decode(#"{"read":false,"needs":true}"#).keys.sorted { $0.rawValue < $1.rawValue },
                       BoardStatusSection.allCases.sorted { $0.rawValue < $1.rawValue })
        // A To read row wears the needs mark in Needs you, whatever its phase.
        XCTAssertEqual(BoardModel.dot(tasks[0], in: .needs), .needsAction)
        XCTAssertEqual(BoardModel.dot(tasks[1], in: .needs), .needsAction)
        XCTAssertNil(BoardModel.dot(tasks[2], in: .waiting))
        // Each Needs you row's third line: the ask, or what there is to read.
        XCTAssertEqual(s.needs.map { TeamStatusModel.needLine($0.task?.userStatus)?.line },
                       ["Decide: Pick one", "Take a look: It answered your question", "Can close: The result is ready"])
    }

    /// The mark follows the row's group: under Waiting / snoozed or Completed no row
    /// wears the needs dot, even one whose phase alone (an older server) would ask for it.
    /// Unread still shows everywhere.
    func testTheRowMarkFollowsItsSectionNotThePhase() {
        let phaseOnly = task("p", phase: "NEED_ACTION")
        XCTAssertEqual(BoardModel.dot(phaseOnly), .needsAction)
        XCTAssertEqual(BoardModel.dot(phaseOnly, in: nil), .needsAction)
        XCTAssertEqual(BoardModel.dot(phaseOnly, in: .needs), .needsAction)
        for section in [BoardStatusSection.waiting, .done] {
            XCTAssertNil(BoardModel.dot(phaseOnly, in: section), "\(section)")
        }
        var unread = task("u", phase: "NEED_ACTION")
        unread.unread = true
        XCTAssertEqual(BoardModel.dot(unread, in: .waiting), .unread)
        // A snoozed status is Waiting, never Needs you, so its row sits under Waiting / snoozed.
        let snoozed = task("s", start: "2026-09-01", user: .init(state: "waiting", snoozed: .init(until: "2026-09-01", ask: "Approve")))
        XCTAssertFalse(BoardModel.needsHuman(snoozed))
        XCTAssertEqual(board([snoozed]).sections.waiting.map(\.id), ["s"])
    }

    /// The tier scope narrows Needs you, Waiting and Completed to the tier in view, and the
    /// rail's chips keep counting each tier's open work (Needs you rows included), so a chip
    /// does not change its number because the screen grew sections.
    func testTheScopeNarrowsTheStateSectionsAndTheRailKeepsItsCounts() {
        let tasks = [
            task("f1"), task("f2", phase: "NEED_ACTION"), task("fd", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", phase: "NEED_ACTION"), task("sw", phase: "WAITING"),
        ]
        let tierOf = ["f1": "focus", "f2": "focus", "fd": "focus", "s1": "satellite", "s2": "satellite", "sw": "satellite"]
        let all = board(tasks, tierOf: tierOf)
        XCTAssertEqual(all.rail.map(\.count), [4, 2, 2], "All, Focus, Satellite: open, not waiting")
        XCTAssertEqual(Set(all.sections.needs.map(\.id)), ["f2", "s2"])
        let focus = board(tasks, tierOf: tierOf, scope: "focus")
        XCTAssertEqual(focus.scope, "focus")
        XCTAssertEqual(focus.rail.map(\.count), all.rail.map(\.count))
        XCTAssertEqual(focus.sections.needs.map(\.id), ["f2"])
        XCTAssertEqual(focus.sections.done.map(\.id), ["fd"])
        XCTAssertTrue(focus.sections.waiting.isEmpty)
        XCTAssertEqual(bandIds(focus), ["f1"])
    }

    /// A tier whose rows all went to sections draws no empty band under Working, and its
    /// chip stays on the rail.
    func testAnEmptiedTierHasNoBandButKeepsItsChip() {
        let tasks = [task("a"), task("b", phase: "NEED_ACTION")]
        let b = board(tasks, tierOf: ["a": "focus", "b": "satellite"])
        XCTAssertEqual(b.bands.map(\.bandId), ["focus"])
        XCTAssertTrue(b.rail.contains { $0.bandId == "satellite" && $0.count == 1 })
        XCTAssertEqual(b.sections.workingCount, 1)
    }

    // MARK: - Watching

    /// Watching follows the selected tier, including done and WAITING tasks. An unpinned
    /// watch is visible only on All. A watched task is in no other section or band.
    /// `wWait` is stored in the retired Wait tier, as an older client may have left it: it
    /// shows in Satellite, and a scope naming Wait has no chip, so it falls back to All.
    func testWatchingFollowsTheSelectedTierAndOwnsItsRows() {
        let tasks = [
            task("plain"),
            task("wPinned", watched: "2026-08-25T00:00:00Z"),
            task("wUnpinned", pinned: false, watched: "2026-08-24T00:00:00Z"),
            task("wOther", watched: "2026-08-26T00:00:00Z"),
            task("wWait", watched: "2026-08-27T00:00:00Z"),
            task("wDone", status: "done", phase: "COMPLETE", watched: "2026-08-23T00:00:00Z"),
            task("wNeeds", phase: "NEED_ACTION", watched: "2026-08-22T00:00:00Z"),
            task("wParked", phase: "WAITING", watched: "2026-08-21T00:00:00Z"),
            task("notWatched", watched: ""),
        ]
        let tierOf = ["plain": "focus", "wPinned": "focus", "wOther": "satellite", "wWait": "wait", "wDone": "focus",
                      "wNeeds": "focus", "wParked": "focus", "notWatched": "focus"]
        for grouping in [BoardGrouping.tier, .project] {
            let b = board(tasks, tierOf: tierOf, grouping: grouping, scope: "focus")
            XCTAssertEqual(b.sections.watching.map(\.id),
                ["wParked", "wNeeds", "wDone", "wPinned"], "only Focus, oldest watch first")
            XCTAssertEqual(Set(bandIds(b)), ["plain", "notWatched"])
            XCTAssertTrue(b.sections.needs.isEmpty && b.sections.waiting.isEmpty && b.sections.done.isEmpty)
            let satellite = board(tasks, tierOf: tierOf, grouping: grouping, scope: "satellite")
            XCTAssertEqual(satellite.sections.watching.map(\.id), ["wOther", "wWait"], "the old Wait task shows in Satellite")
            XCTAssertEqual(satellite.rail.first { $0.bandId == "satellite" }?.count, 2)
            XCTAssertFalse(satellite.rail.contains { $0.bandId == "wait" }, "no Parked chip")
            let retired = board(tasks, tierOf: tierOf, grouping: grouping, scope: "wait")
            XCTAssertNil(retired.scope, "a retired tier is no scope: the board falls back to All")
            let all = board(tasks, tierOf: tierOf, grouping: grouping)
            XCTAssertEqual(all.sections.watching.map(\.id),
                ["wParked", "wNeeds", "wDone", "wUnpinned", "wPinned", "wOther", "wWait"])
        }
    }

    /// A new watch lands at the foot: Watching keeps the order the user added them, and a
    /// missing or unreadable time sorts last, ties by id.
    func testWatchingKeepsTheOrderTheUserAddedThem() {
        let rows = [
            BoardRow(task: task("c", watched: "2026-08-26T10:00:00.500Z")),
            BoardRow(task: task("a", watched: "2026-08-26T09:00:00Z")),
            BoardRow(task: task("z", watched: "not a date")),
            BoardRow(task: task("b", watched: "2026-08-26T09:00:00Z")),
        ]
        XCTAssertEqual(BoardStatusSectionModel.sorted(.watching, rows).map(\.id), ["a", "b", "c", "z"])
    }

    // MARK: - Order inside a section

    /// Needs you: latest activity first, where activity is the latest of the last edit and
    /// the session's last activity.
    func testNeedsYouPutsTheLatestActivityFirst() {
        let tasks = [
            task("old", phase: "NEED_ACTION", updated: "2026-08-20T00:00:00Z"),
            task("edited", phase: "NEED_ACTION", updated: "2026-08-26T00:00:00Z"),
            task("talked", phase: "NEED_ACTION", updated: "2026-08-19T00:00:00Z"),
        ]
        let b = board(tasks, sessions: [session("s", taskId: "talked", lastActive: "2026-08-27T08:00:00Z")])
        XCTAssertEqual(b.sections.needs.map(\.id), ["talked", "edited", "old"])
    }

    /// Waiting / snoozed: the soonest wake first (a WAITING clock, else a start date), then the
    /// rows with no clock by latest activity. A wait clock on a task that is not WAITING does
    /// not count.
    func testWaitingPutsTheSoonestWakeFirst() {
        let tasks = [
            task("noClockOld", phase: "WAITING", updated: "2026-08-20T00:00:00Z"),
            task("noClockNew", phase: "WAITING", updated: "2026-08-26T00:00:00Z"),
            task("clockLate", phase: "WAITING", waitUntil: "2026-09-10T00:00:00Z"),
            task("clockSoon", phase: "WAITING", waitUntil: "2026-08-28T00:00:00Z"),
            task("snoozed", start: "2026-09-01T00:00:00Z"),
            task("clockIgnored", start: "2026-09-05T00:00:00Z", waitUntil: "2026-08-27T13:00:00Z"),
        ]
        XCTAssertEqual(board(tasks).sections.waiting.map(\.id),
            ["clockSoon", "snoozed", "clockIgnored", "clockLate", "noClockNew", "noClockOld"])
    }

    /// Completed: the latest completion first.
    func testCompletedPutsTheLatestCompletionFirst() {
        let tasks = [
            task("first", status: "done", phase: "COMPLETE", completed: "2026-08-21T00:00:00Z"),
            task("last", status: "done", phase: "COMPLETE", completed: "2026-08-26T00:00:00Z"),
            task("middle", status: "done", phase: "COMPLETE", completed: "2026-08-24T00:00:00Z"),
        ]
        XCTAssertEqual(board(tasks).sections.done.map(\.id), ["last", "middle", "first"])
    }

    // MARK: - Project runs and the "Show N more" row

    /// Rows run by project in the order each project's first row appears; one project is one
    /// run (the view draws no label for it).
    func testProjectRunsFollowTheFirstRowOfEachProject() {
        let rows = ["b1", "a1", "b2", "i1", "a2"].map { id -> BoardRow in
            let project = id.hasPrefix("a") ? "acme" : id.hasPrefix("b") ? "marina" : ""
            return BoardRow(task: task(id, project: project))
        }
        let runs = BoardStatusSectionModel.projectRuns(rows)
        XCTAssertEqual(runs.map(\.project), ["marina", "acme", ""])
        XCTAssertEqual(runs.map { $0.rows.map(\.id) }, [["b1", "b2"], ["a1", "a2"], ["i1"]])
        XCTAssertEqual(runs.last?.label, "Inbox")
        XCTAssertEqual(BoardStatusSectionModel.projectRuns(Array(rows.prefix(1))).count, 1)
    }

    /// 30 rows, then "Show N more" for the next batch; a tap adds 30.
    func testASectionShowsThirtyRowsThenShowMore() {
        let rows = (0..<75).map { i in BoardRow(task: task(String(format: "r%02d", i), project: i < 40 ? "acme" : "marina")) }
        let runs = BoardStatusSectionModel.projectRuns(rows)
        let first = BoardStatusSectionModel.visibleRuns(runs, shown: 30)
        XCTAssertEqual(first.flatMap(\.rows).count, 30)
        XCTAssertEqual(first.map(\.project), ["acme"], "the run past the cut is not drawn")
        XCTAssertEqual(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 30), "Show 30 more")
        let second = BoardStatusSectionModel.visibleRuns(runs, shown: 60)
        XCTAssertEqual(second.map { $0.rows.count }, [40, 20])
        XCTAssertEqual(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 60), "Show 15 more")
        XCTAssertNil(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 90))
        XCTAssertNil(BoardStatusSectionModel.showMoreLabel(total: 30, shown: 30))
    }

    // MARK: - Defaults, visibility and the words

    func testDefaultsAndWords() {
        XCTAssertEqual(BoardStatusSection.allCases.map(\.label),
            ["Watching", "Needs you", "Working", "Waiting / snoozed", "Background", "Completed"])
        XCTAssertEqual(BoardStatusSection.allCases.filter(\.defaultOpen), [.watching, .needs, .working])
        XCTAssertEqual(BoardWatchItem.label(watched: false), "Watch")
        XCTAssertEqual(BoardWatchItem.label(watched: true), "Stop watching")
        XCTAssertEqual(BoardWatchItem.systemImage(watched: false), "eye")
        XCTAssertEqual(BoardWatchItem.systemImage(watched: true), "eye.slash")
        XCTAssertEqual(BoardBackgroundItem.label(inBackground: false), "Move to Background")
        XCTAssertEqual(BoardBackgroundItem.label(inBackground: true), "Take out of Background")
        XCTAssertEqual(BoardStatusSection.allCases.filter(\.autoFolds), [.waiting, .background, .done])
    }

    /// Working always has its heading; every other section only when it holds a row.
    func testOnlyWorkingIsShownWhenEmpty() {
        let s = board([task("a")]).sections
        XCTAssertEqual(BoardStatusSection.allCases.filter { s.isShown($0) }, [.working])
        XCTAssertFalse(s.drawsRows)
        let full = board([task("a", phase: "NEED_ACTION"), task("b", status: "done", phase: "COMPLETE")]).sections
        XCTAssertEqual(BoardStatusSection.allCases.filter { full.isShown($0) }, [.needs, .working, .done])
        XCTAssertTrue(full.drawsRows)
        XCTAssertEqual(full.workingCount, 0)
    }

    // MARK: - Search turns the sections off

    /// While a query is live there are no sections at all (search shows its own results): the
    /// bands hold the matching rows as before, a watched or needs-you row included.
    func testAQueryTurnsTheSectionsOff() {
        let tasks = [task("1", watched: "2026-08-26T00:00:00Z"), task("2", phase: "NEED_ACTION"), task("3")]
        let b = board(tasks, query: "task")
        XCTAssertFalse(b.sections.active)
        XCTAssertEqual(BoardStatusSection.allCases.filter { b.sections.isShown($0) }, [])
        XCTAssertEqual(Set(bandIds(b)), ["1", "2", "3"])
    }

    // MARK: - The stored open state

    private let t0 = Date(timeIntervalSince1970: 1_793_770_000)

    func testFirstVisitFoldsWaitingAndCompleted() {
        let open = BoardStatusSectionPrefs.decode("")
        XCTAssertEqual(open[.watching], true)
        XCTAssertEqual(open[.needs], true)
        XCTAssertEqual(open[.working], true, "Working is the board itself on the phone")
        XCTAssertEqual(open[.waiting], false)
        XCTAssertEqual(open[.background], false, "Background folds on a first visit")
        XCTAssertEqual(open[.done], false)
        XCTAssertEqual(BoardStatusSectionPrefs.autoCloseAfter, 15 * 60)
    }

    /// Background folds again 15 minutes after it was opened, like Waiting and Completed, and
    /// an older build's boolean for it (none ever wrote one, but a hand edit may) reads folded.
    func testBackgroundIsAnAutoFold() {
        var raw = BoardStatusSectionPrefs.toggling(.background, raw: "", now: t0)
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.background, raw: raw))
        XCTAssertTrue(raw.hasPrefix(#"{"background":"#), raw)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: t0.addingTimeInterval(15 * 60 - 1)), raw)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: t0.addingTimeInterval(15 * 60)), "")
        raw = BoardStatusSectionPrefs.toggling(.background, raw: raw, now: t0)
        XCTAssertFalse(BoardStatusSectionPrefs.isOpen(.background, raw: raw))
        XCTAssertEqual(raw, "")
        XCTAssertEqual(BoardStatusSectionPrefs.decode(#"{"background":true}"#)[.background], false)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(#"{"background":true}"#, now: t0), "")
    }

    func testWatchingAndNeedsYouKeepTheUserChoiceWithNoClock() {
        var raw = BoardStatusSectionPrefs.toggling(.needs, raw: "", now: t0)
        XCTAssertEqual(raw, #"{"needs":false}"#)
        let muchLater = t0.addingTimeInterval(30 * 24 * 3600)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: muchLater), raw, "no clock on a sticky choice")
        raw = BoardStatusSectionPrefs.toggling(.needs, raw: raw, now: t0)
        XCTAssertEqual(raw, "", "back at its default stores nothing")
    }

    func testAnOpenedSectionFoldsAgainFifteenMinutesLater() {
        var raw = BoardStatusSectionPrefs.toggling(.done, raw: "", now: t0)
        let stored = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Double]
        XCTAssertEqual(stored, ["done": t0.timeIntervalSince1970], "an opened section holds its opening time")
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.done, raw: raw))
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: t0.addingTimeInterval(15 * 60 - 1)), raw)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: t0.addingTimeInterval(15 * 60)), "")
        raw = BoardStatusSectionPrefs.toggling(.waiting, raw: raw, now: t0)
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.waiting, raw: raw))
        raw = BoardStatusSectionPrefs.toggling(.working, raw: raw, now: t0)
        XCTAssertFalse(BoardStatusSectionPrefs.isOpen(.working, raw: raw))
        XCTAssertTrue(BoardStatusSectionPrefs.pruned(raw, now: t0.addingTimeInterval(3600)).contains(#""working":false"#), "Working keeps the choice")
        raw = BoardStatusSectionPrefs.toggling(.done, raw: raw, now: t0)
        raw = BoardStatusSectionPrefs.toggling(.waiting, raw: raw, now: t0)
        raw = BoardStatusSectionPrefs.toggling(.working, raw: raw, now: t0)
        XCTAssertEqual(raw, "", "folded again stores nothing")
    }

    func testAnOpeningTimeAheadOfTheClockCountsFromNow() {
        let ahead = #"{"done":\#(t0.timeIntervalSince1970 + 3600)}"#
        let raw = BoardStatusSectionPrefs.pruned(ahead, now: t0)
        let stored = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Double]
        XCTAssertEqual(stored, ["done": t0.timeIntervalSince1970])
    }

    func testAnOlderBuildBooleanOnAnAutoSectionReadsFolded() {
        let raw = #"{"done":true,"waiting":true,"working":false,"watching":false}"#
        let open = BoardStatusSectionPrefs.decode(raw)
        XCTAssertEqual(open[.done], false)
        XCTAssertEqual(open[.waiting], false)
        XCTAssertEqual(open[.working], false)
        XCTAssertEqual(open[.watching], false)
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(raw, now: t0), #"{"watching":false,"working":false}"#)
    }

    func testGarbageInTheStoreReadsAsTheDefaults() {
        for junk in ["not json", "[]", "3", #"{"done":"yes","needs":1}"#] {
            let raw = BoardStatusSectionPrefs.pruned(junk, now: t0)
            for section in BoardStatusSection.allCases {
                XCTAssertEqual(BoardStatusSectionPrefs.isOpen(section, raw: raw), section.defaultOpen, junk)
            }
        }
        // A number that is no recent opening time folds at the first prune.
        XCTAssertEqual(BoardStatusSectionPrefs.pruned(#"{"waiting":1,"junk":5}"#, now: t0), "")
    }

    /// Persisted across launches: read back through `@AppStorage`, the way TasksView reads
    /// it, against a private defaults suite.
    func testOpenStatePersistsThroughAppStorage() throws {
        let suite = "board-sections-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        func stored() -> AppStorage<String> {
            AppStorage(wrappedValue: "", BoardStatusSectionPrefs.openKey, store: defaults)
        }
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.needs, raw: stored().wrappedValue))
        stored().wrappedValue = BoardStatusSectionPrefs.toggling(.needs, raw: stored().wrappedValue)
        XCTAssertEqual(defaults.string(forKey: BoardStatusSectionPrefs.openKey), #"{"needs":false}"#)
        XCTAssertFalse(BoardStatusSectionPrefs.isOpen(.needs, raw: stored().wrappedValue), "a new reader sees it")
    }

    // MARK: - Background

    /// Every state a row can be in: Needs you, To read (stored and an older server's), Working,
    /// Waiting, snoozed, a later start under Now, no status derived (each phase), a state this
    /// build does not know. Built per id so a test can name the row it means.
    private func everyState(background: String?) -> [WalnutTask] {
        [
            task("needs", phase: "NEED_ACTION", background: background,
                 user: .init(state: "needs", ask: "Pick one")),
            task("read", phase: "NEED_ACTION", background: background,
                 user: .init(state: "read", waitingOn: "The result is ready", toRead: "result")),
            task("legacyRead", phase: "NEED_ACTION", background: background,
                 user: .init(state: "waiting", waitingOn: "It answered", toRead: "answer")),
            task("working", phase: "IN_PROGRESS", background: background, userState: "working"),
            task("waiting", phase: "WAITING", background: background, userState: "waiting"),
            task("snoozed", start: "2026-09-01", background: background,
                 user: .init(state: "waiting", snoozed: .init(until: "2026-09-01", ask: "Approve"))),
            task("later", start: "2026-09-01", background: background),
            task("rawTodo", background: background),
            task("rawNeeds", phase: "NEED_ACTION", background: background),
            task("rawProgress", phase: "IN_PROGRESS", background: background),
            task("rawWaiting", phase: "WAITING", background: background),
            task("unknown", phase: "IN_PROGRESS", background: background, userState: "mystery"),
        ]
    }

    /// The class guard (2026-11-11, the user: in Background "whatever its status, it does not
    /// come out"): an open task with `background_at` is drawn in Background and nowhere else,
    /// whatever its state, under both groupings and in a tier scope. Every other section is read
    /// through `allCases`, so a section added later is checked too, and the bands (Working's
    /// rows) never hold it.
    func testAnOpenBackgroundTaskIsDrawnInBackgroundOnlyWhateverItsState() {
        let marked = everyState(background: "2026-08-26T00:00:00Z")
        let ids = Set(marked.map(\.id))
        for grouping in [BoardGrouping.tier, .project] {
            for scope in [nil, "focus"] as [String?] {
                let b = board(marked, grouping: grouping, scope: scope)
                let s = b.sections
                let label = "\(grouping) scope \(scope ?? "all")"
                XCTAssertEqual(Set(s.background.map(\.id)), ids, label)
                XCTAssertEqual(s.background.count, ids.count, "each row once (\(label))")
                XCTAssertTrue(bandIds(b).isEmpty, "no Background row in the Working bands (\(label))")
                XCTAssertEqual(s.workingCount, 0, label)
                for section in BoardStatusSection.allCases where section != .background {
                    XCTAssertTrue(Set(s.rows(section).map(\.id)).isDisjoint(with: ids),
                                  "\(section) draws a Background row (\(label))")
                }
                XCTAssertTrue(s.isShown(.background), label)
                XCTAssertTrue(s.drawsRows, "an empty Working is no empty board (\(label))")
            }
        }
        // The same rows with no mark go where their states put them: the mark alone moves them.
        let plain = board(everyState(background: nil)).sections
        XCTAssertTrue(plain.background.isEmpty)
        XCTAssertFalse(plain.needs.isEmpty)
        XCTAssertFalse(plain.waiting.isEmpty)
        // The pure model agrees with the assembly, row by row.
        for t in marked {
            let row = BoardRow(task: t, session: nil, knownSessionIds: nil)
            XCTAssertEqual(BoardStatusSectionModel.section(row, dateFilter: .now, now: Self.now), .background, t.id)
            XCTAssertTrue(BoardStatusSectionModel.isBackground(t), t.id)
        }
        // A blank mark is no mark (an older server never sends one at all).
        XCTAssertFalse(BoardStatusSectionModel.isBackground(task("blank", background: " ")))
        XCTAssertFalse(BoardStatusSectionModel.isBackground(task("none")))
        XCTAssertFalse(BoardStatusSectionModel.isBackground(nil))
    }

    /// A WAITING row the board holds out of its bands (the Parked shelf) goes to Background
    /// too when it is marked, never to Waiting / snoozed.
    func testAHeldWaitingRowInBackgroundIsDrawnInBackground() {
        let tasks = [task("parked", phase: "WAITING", background: "2026-08-26T00:00:00Z"), task("open")]
        let s = board(tasks).sections
        XCTAssertEqual(s.background.map(\.id), ["parked"])
        XCTAssertTrue(s.waiting.isEmpty)
    }

    /// Background is no state: a completed task keeps its mark but is drawn under Completed,
    /// and the menu still offers to take it out. A watch wins over Background.
    func testCompletedGoesToCompletedAndAWatchWins() {
        let done = task("done", status: "done", phase: "COMPLETE", background: "2026-08-26T00:00:00Z")
        let both = task("both", phase: "NEED_ACTION", watched: "2026-08-26T00:00:00Z",
                        background: "2026-08-26T00:00:00Z", userState: "needs")
        let b = board([done, both, task("open")])
        let s = b.sections
        XCTAssertEqual(s.done.map(\.id), ["done"])
        XCTAssertEqual(s.watching.map(\.id), ["both"])
        XCTAssertTrue(s.background.isEmpty)
        XCTAssertTrue(s.needs.isEmpty)
        XCTAssertEqual(bandIds(b), ["open"])
        XCTAssertFalse(BoardStatusSectionModel.isBackground(done))
        XCTAssertTrue(BoardBackgroundItem.inBackground(done), "the menu can take a completed task out")
        XCTAssertFalse(BoardBackgroundItem.inBackground(task("plain")))
    }

    /// Background's heading dot counts the rows that ask the user something (Needs you, or a
    /// NEED_ACTION phase with no status derived), never To read or any other state; they come
    /// first, then latest activity, and keep the needs mark in Background.
    func testBackgroundAsksComeFirstAndOnlyNeedsLightTheDot() {
        let rows = everyState(background: "2026-08-26T00:00:00Z")
        let s = board(rows).sections
        XCTAssertEqual(s.backgroundAsks, 2, "needs and rawNeeds")
        XCTAssertEqual(Set(s.background.prefix(2).map(\.id)), ["needs", "rawNeeds"])
        XCTAssertEqual(BoardStatusSectionModel.backgroundNeedsCount(s.background), 2)
        let onlyRead = board([task("r", phase: "NEED_ACTION", background: "2026-08-26T00:00:00Z",
                                   user: .init(state: "read", toRead: "result"))]).sections
        XCTAssertEqual(onlyRead.backgroundAsks, 0, "To read lights no dot")
        XCTAssertEqual(board([task("w", phase: "IN_PROGRESS", background: "2026-08-26T00:00:00Z",
                                   userState: "working")]).sections.backgroundAsks, 0)
        // The order: asking rows first, then the latest activity.
        let ordered = board([
            task("old-ask", phase: "NEED_ACTION", updated: "2026-08-20T00:00:00Z",
                 background: "2026-08-26T00:00:00Z", userState: "needs"),
            task("new-quiet", phase: "IN_PROGRESS", updated: "2026-08-27T00:00:00Z",
                 background: "2026-08-26T00:00:00Z", userState: "working"),
            task("new-ask", phase: "NEED_ACTION", updated: "2026-08-26T00:00:00Z",
                 background: "2026-08-26T00:00:00Z", userState: "needs"),
            task("old-quiet", phase: "WAITING", updated: "2026-08-21T00:00:00Z",
                 background: "2026-08-26T00:00:00Z", userState: "waiting"),
        ]).sections
        XCTAssertEqual(ordered.background.map(\.id), ["new-ask", "old-ask", "new-quiet", "old-quiet"])
        // A row there that asks keeps the needs mark.
        XCTAssertEqual(BoardModel.dot(rows[0], in: .background), .needsAction)
    }

    /// `background_at` decodes, an older server sends none, every copy of a row keeps it, and an
    /// edit keeps it and the watch apart the way the server does.
    @MainActor
    func testBackgroundFieldDecodesAndEditsKeepItApartFromTheWatch() throws {
        func decode(_ extra: String) throws -> WalnutTask {
            let json = #"{"id":"t","title":"t","status":"todo","phase":"TODO","priority":"none","project":"""# + extra + "}"
            return try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        }
        let t = try decode(#","background_at":"2026-08-26T00:00:00Z""#)
        XCTAssertEqual(t.backgroundAt, "2026-08-26T00:00:00Z")
        XCTAssertTrue(BoardStatusSectionModel.isBackground(t))
        let old = try decode("")
        XCTAssertNil(old.backgroundAt)
        XCTAssertFalse(BoardStatusSectionModel.isBackground(old))
        XCTAssertEqual(TasksStore.withPinned(t, true).backgroundAt, t.backgroundAt)
        XCTAssertEqual(TasksStore.applyEdit(.init(title: "x"), to: t).backgroundAt, t.backgroundAt)
        XCTAssertNil(TasksStore.applyEdit(.init(backgroundAt: ""), to: t).backgroundAt, "\"\" takes it out")
        XCTAssertFalse(TasksStore.TaskEdit(backgroundAt: "").isEmpty, "taking it out is an edit")
        // Background ends a watch; a watch takes it out of Background; "" on one leaves the other.
        let watched = try decode(#","watched_at":"2026-08-25T00:00:00Z""#)
        let moved = TasksStore.applyEdit(.init(backgroundAt: "2026-08-27T00:00:00Z"), to: watched)
        XCTAssertEqual(moved.backgroundAt, "2026-08-27T00:00:00Z")
        XCTAssertNil(moved.watchedAt)
        let rewatched = TasksStore.applyEdit(.init(watchedAt: "2026-08-28T00:00:00Z"), to: moved)
        XCTAssertEqual(rewatched.watchedAt, "2026-08-28T00:00:00Z")
        XCTAssertNil(rewatched.backgroundAt)
        XCTAssertEqual(TasksStore.applyEdit(.init(watchedAt: ""), to: t).backgroundAt, t.backgroundAt)
        XCTAssertEqual(TasksStore.applyEdit(.init(backgroundAt: ""), to: watched).watchedAt, watched.watchedAt)
    }

    // MARK: - The wire fields

    /// `watched_at` and `wait_until` decode, an older server sends neither, and every copy of
    /// a row the store makes keeps them.
    @MainActor
    func testWatchAndWaitFieldsDecodeAndSurviveRowCopies() throws {
        func decode(_ extra: String) throws -> WalnutTask {
            let json = #"{"id":"t","title":"t","status":"todo","phase":"WAITING","priority":"none","project":"""# + extra + "}"
            return try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        }
        let t = try decode(#","watched_at":"2026-08-26T00:00:00Z","wait_until":"2026-08-30T00:00:00Z""#)
        XCTAssertEqual(t.watchedAt, "2026-08-26T00:00:00Z")
        XCTAssertEqual(t.waitUntil, "2026-08-30T00:00:00Z")
        let old = try decode("")
        XCTAssertNil(old.watchedAt)
        XCTAssertFalse(BoardStatusSectionModel.isWatched(old))
        XCTAssertEqual(TasksStore.withPinned(t, true).watchedAt, t.watchedAt)
        XCTAssertEqual(TasksStore.withPinned(t, true).waitUntil, t.waitUntil)
        XCTAssertEqual(TasksStore.applyEdit(.init(title: "x"), to: t).watchedAt, t.watchedAt)
        XCTAssertNil(TasksStore.applyEdit(.init(watchedAt: ""), to: t).watchedAt, "\"\" stops watching")
        XCTAssertEqual(TasksStore.applyEdit(.init(watchedAt: "2026-08-27T00:00:00Z"), to: old).watchedAt,
                       "2026-08-27T00:00:00Z")
        XCTAssertFalse(TasksStore.TaskEdit(watchedAt: "").isEmpty, "a stop is an edit")
    }
}

/// The Watch write: optimistic through the store, rolled back on a failed PATCH.
@MainActor
final class BoardWatchWriteTests: XCTestCase {

    private func row(_ id: String, watched: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: "t", status: "todo", phase: "TODO", priority: "none", project: "",
            dueDate: nil, createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil,
            watchedAt: watched
        )
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    func testWatchAppliesAtOnceAndSendsTheTime() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1")]
        let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!
        let write = Task { await store.setWatched(store.tasks[0], watched: true, now: now) }
        await waitFor { store.tasks[0].watchedAt != nil }
        XCTAssertEqual(store.tasks[0].watchedAt, "2026-08-27T12:00:00Z", "the row moves to Watching before the PATCH answers")
        gate.open()
        let error = await write.value
        XCTAssertNil(error)
        XCTAssertEqual(store.tasks[0].watchedAt, "2026-08-27T12:00:00Z")
        XCTAssertEqual(mock.calls.last?.args.last, "watched_at=2026-08-27T12:00:00Z")
    }

    func testStopWatchingSendsAnEmptyValue() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1", watched: "2026-08-26T00:00:00Z")]
        let error = await store.setWatched(store.tasks[0], watched: false)
        XCTAssertNil(error)
        XCTAssertNil(store.tasks[0].watchedAt)
        XCTAssertEqual(mock.calls.last?.args.last, "watched_at=")
    }

    func testMoveToBackgroundAppliesAtOnceSendsTheTimeAndEndsTheWatch() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1", watched: "2026-08-26T00:00:00Z")]
        let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!
        let write = Task { await store.setBackground(store.tasks[0], inBackground: true, now: now) }
        await waitFor { store.tasks[0].backgroundAt != nil }
        XCTAssertEqual(store.tasks[0].backgroundAt, "2026-08-27T12:00:00Z", "the row moves before the PATCH answers")
        XCTAssertNil(store.tasks[0].watchedAt, "and leaves Watching, as the server's write does")
        gate.open()
        let error = await write.value
        XCTAssertNil(error)
        XCTAssertEqual(store.tasks[0].backgroundAt, "2026-08-27T12:00:00Z")
        XCTAssertEqual(mock.calls.last?.args.last, "background_at=2026-08-27T12:00:00Z")
    }

    func testTakeOutOfBackgroundSendsAnEmptyValue() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        var t = row("t1")
        t.backgroundAt = "2026-08-26T00:00:00Z"
        store.tasks = [t]
        let error = await store.setBackground(store.tasks[0], inBackground: false)
        XCTAssertNil(error)
        XCTAssertNil(store.tasks[0].backgroundAt)
        XCTAssertEqual(mock.calls.last?.args.last, "background_at=")
    }

    func testAFailedMoveToBackgroundRollsBackWithItsWatch() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        mock.errorsByEndpoint["updateTask"] = APIError.server(
            status: 400, code: "bad_request", message: "background_at must be an ISO-8601 datetime",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1", watched: "2026-08-26T00:00:00Z")]
        let write = Task { await store.setBackground(store.tasks[0], inBackground: true) }
        await waitFor { store.tasks[0].backgroundAt != nil }
        XCTAssertNotNil(store.tasks[0].backgroundAt, "optimistic first")
        gate.open()
        let error = await write.value
        XCTAssertNotNil(error, "the failure is reported")
        XCTAssertNil(store.tasks[0].backgroundAt, "the row goes back where it was")
        XCTAssertEqual(store.tasks[0].watchedAt, "2026-08-26T00:00:00Z", "its watch with it")
    }

    func testAFailedWatchRollsBack() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        mock.errorsByEndpoint["updateTask"] = APIError.server(
            status: 400, code: "bad_request", message: "at least one updatable field is required",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1")]
        let write = Task { await store.setWatched(store.tasks[0], watched: true) }
        await waitFor { store.tasks[0].watchedAt != nil }
        XCTAssertNotNil(store.tasks[0].watchedAt, "optimistic first")
        gate.open()
        let error = await write.value
        XCTAssertNotNil(error, "the failure is reported")
        XCTAssertNil(store.tasks[0].watchedAt, "and the row goes back where it was")
    }
}
