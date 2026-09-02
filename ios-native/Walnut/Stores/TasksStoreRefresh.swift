import Foundation

// MARK: - The board refresh bundle: ONE funnel for five requests
//
// The board's whole input set is five GETs — `/v1/tasks`, `/v1/sessions`,
// `/v1/tasks/groups` and the focus split (`/v1/focus/tasks` + `/v1/focus/tiers`) —
// and five places legitimately want all five: cold start, returning to the
// foreground, the REST reconcile poll, pull-to-refresh, and the board coming on
// screen.
//
// They now ask HERE instead of each firing its own four `async let`s, and the
// reason is a measured incident rather than tidiness. On 2026-09-01 the LAST of
// those — the board appearing — turned out not to be a user action at all: it hung
// off a SwiftUI `.task`, the framework re-armed it, and the bundle it fired wrote
// the very lists the board renders, so each fetch bought the next one. The phone
// asked the production server for all five endpoints every ~160ms for THIRTEEN
// MINUTES (server log: 1,880 requests/minute, ~31/s, all 200s, ~3.7 MB/s of JSON
// re-serialised on the single event loop every route shares). Nothing in the app
// noticed, because every individual piece was correct: the request was correct, the
// parse was correct, and the store's same-value write guards meant the UI did not
// even flicker. Only the server's request log showed it, and only because someone
// went looking.
//
// So this funnel exists to make that shape impossible to ship again, in three ways:
//
//  1. COALESCE. A second ask while a bundle is in flight joins that bundle instead
//     of starting a parallel one. Callers still `await` a fetch that really
//     finished, so nobody has to reason about who else might be loading.
//  2. FLOOR. A non-gesture ask within `boardRefreshFloor` of the last one is
//     dropped. The legitimate cadences are 30s and 120s, so a 2s floor cannot
//     delay any of them — it only ever eats a duplicate. A pull gesture is exempt:
//     the user asked, out loud, and refusing them is worse than one extra fetch.
//  3. REPORT. Dropped asks are counted, and a run of them logs a warning naming
//     the origin. A runaway becomes a line in the client log that says which
//     caller is looping — which is exactly what nobody had on 2026-09-01.
//
// What it deliberately does NOT do: silence the loop and call it fixed. The floor
// is a ceiling on the damage, not an explanation; the origin in the warning is
// there so the next one gets diagnosed instead of absorbed.

extension TasksStore {
    /// Who asked for a board refresh. Rawvalues are log-facing.
    enum BoardRefreshOrigin: String {
        /// `initialize()` — first render, after the cache adoption.
        case coldStart = "cold-start"
        /// Scene became active again (LifecycleHub fan-out).
        case foreground
        /// The REST reconcile poll (30s feed-down / 120s trust-but-verify).
        case poll
        /// A real pull-to-refresh gesture on the board.
        case pullToRefresh = "pull"
        /// The board came on screen.
        case boardAppeared = "board-appeared"

        /// Everything except a pull gesture. A user who pulls down has asked for
        /// fresh data in the most explicit way the platform offers, and a request
        /// they can see the spinner for is never the storm.
        var honoursFloor: Bool { self != .pullToRefresh }

        /// How fresh the lists have to be for this origin to skip the fetch.
        ///
        /// This is the load-bearing half of the funnel, and the reason is what an
        /// appearance signal actually is. It is NOT reliably "the user opened this
        /// screen": a SwiftUI `.task` is tied to a view's lifetime in the render
        /// tree, and with a session conversation pushed over the board the board's
        /// `.task` was re-armed over and over. Measured on the pinned simulator, one
        /// minute of a session sitting open: 22 `.task` runs against 2 body passes
        /// of that view, with its `@State` never rebuilt — so it was neither the
        /// user, nor a remount, nor even one-per-render. Since the bundle it fired
        /// WRITES `tasks`/`sessions`, each fetch produced the state change that led
        /// to the next: fetch → render → fetch, as fast as the server could answer.
        /// The trigger has since moved to `onAppear`, which does mean what it says,
        /// but the window stays because the lesson generalises: no "only fire once"
        /// discipline at a call site helps when the framework, not the user, decides
        /// how often that site runs.
        ///
        /// An appearance refresh whose question is "are these lists still fresh?"
        /// cannot loop, however often it is asked. 15s is the answer to a different
        /// question than the 2s anti-storm floor: coming back to the board after a
        /// glance at something else should NOT cost a fetch, coming back after a
        /// coffee should. Cold start and the poll pass 0 — they have their own
        /// spacing and their job is precisely to fetch.
        var minimumAge: TimeInterval {
            switch self {
            case .boardAppeared: return 15
            // A launch and its first activation are the same event as far as the
            // lists are concerned, and either one can win the race — so BOTH carry a
            // window wide enough to recognise the other's fetch.
            //
            // The width is set by how far apart they can actually land, which is not
            // a small number: `initialize()` awaits the disk-cache adoptions before
            // it asks, and on this user's real data (3,126 tasks, 818 sessions) the
            // UI gate measured the two bundles 2.53s apart — past an earlier 2s
            // window, so both ran and the launch cost 10 requests instead of 5. That
            // gap is bounded by disk and data size, not by anything this file can
            // promise, so the window has to be wider than any plausible adoption.
            case .coldStart, .foreground: return 15
            // The poll's own timer is the spacing (30s feed-down / 120s verify), and
            // a pull is the user asking out loud.
            case .poll, .pullToRefresh: return 0
            }
        }
    }

    /// Minimum spacing between two non-gesture bundles.
    ///
    /// Two seconds is chosen against the cadences that exist rather than as a
    /// round number: the poll is 30s or 120s, cold start happens once, and a
    /// foreground refresh happens once per activation. Nothing real repeats
    /// inside two seconds, so the floor's only victims are duplicates — most
    /// commonly cold start and the first activation landing together.
    static let boardRefreshFloor: TimeInterval = 2

    /// How many refusals in a row before the funnel says so out loud.
    static let boardRefreshDropReportEvery = 10

    /// …and how fast those ten have to arrive to count as a loop rather than a
    /// person. The measured runaway asked every ~160ms, so ten of them span under two
    /// seconds; nobody switches tabs ten times in three. Both conditions together,
    /// because count alone would fire on a determined thumb and rate alone would fire
    /// on any two quick taps.
    static let boardRefreshBurstSeconds: TimeInterval = 3

    /// Fetch the board's five inputs, coalesced and rate-floored.
    ///
    /// Returns only once a bundle that covers this caller has finished, whether
    /// that is the one it started or one it joined — so `await refreshBoard(...)`
    /// keeps the "the lists are fresh now" contract every previous call site had.
    /// A dropped ask returns immediately, which is the point: the data it would
    /// have fetched is at most `boardRefreshFloor` old.
    ///
    /// Two consequences of joining rather than queueing, both deliberate:
    ///  - a pull gesture that arrives mid-bundle rides that bundle instead of
    ///    starting a fresh one, so its spinner can end on an answer fetched up to a
    ///    second before the pull. Two seconds of staleness is a better trade than
    ///    two overlapping fan-outs of five requests;
    ///  - the fetch is an unstructured Task, so cancelling the CALLER (a
    ///    `.refreshable` the user flicks away from) no longer cancels the requests.
    ///    It has to work that way for a joiner to be able to wait on it at all, and
    ///    a bundle nobody is waiting for still lands in the store where the board
    ///    will use it.
    func refreshBoard(origin: BoardRefreshOrigin) async {
        guard isActive else { return }
        // Join, never duplicate. No `await` between this read and the assignment
        // below, so on the MainActor two callers can never both become the owner.
        if let running = boardRefreshTask {
            await running.value
            return
        }
        let now = Date()
        // The origin's own freshness window first — a `boardAppeared` ask over
        // 15-second-old lists is answered by the lists themselves.
        if let last = lastBoardRefreshAt, now.timeIntervalSince(last) < origin.minimumAge {
            noteBoardRefreshRefused(origin, reason: "fresh", at: now)
            return
        }
        // …then the floor, which is about damage rather than freshness: whatever
        // origin is asking, and whatever it thinks it knows, five requests every
        // two seconds is as fast as this bundle is ever allowed to go.
        if origin.honoursFloor, let last = lastBoardRefreshAt,
           now.timeIntervalSince(last) < Self.boardRefreshFloor {
            noteBoardRefreshRefused(origin, reason: "floor", at: now)
            return
        }
        boardRefreshDropsSinceRun = 0
        firstRefusalSinceRunAt = nil
        lastBoardRefreshAt = now
        // Debug-level, so it prints on a development build and is filtered out of
        // the shipped log stream. One line per bundle is how the 2026-09-01 loop
        // would have been named in seconds instead of read out of a server log.
        AppLog.debug("tasks", "board refresh", ["origin": origin.rawValue])
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            async let tasksReq: Void = self.loadTasks()
            async let sessionsReq: Void = self.loadSessions()
            async let tiersReq: Void = self.loadFocusTiers()
            async let foldersReq: Void = self.loadTaskFolders()
            _ = await (tasksReq, sessionsReq, tiersReq, foldersReq)
        }
        boardRefreshTask = task
        await task.value
        // Awaiting a non-throwing Task cannot itself throw or be skipped, so the
        // handle is always cleared — a leaked non-nil handle would turn every
        // later ask into a join on a finished task, i.e. a board that never
        // refreshes again.
        boardRefreshTask = nil
    }

    /// Count a refused ask — from EITHER gate — and report a run of them that came
    /// in too fast to be a person.
    ///
    /// Counting both gates is the correction to a version that only counted the
    /// floor's refusals. Because `boardAppeared` and `coldStart`/`foreground` all
    /// carry a `minimumAge` at or above the floor, the freshness gate always returns
    /// first for them, so their refusals never reached the counter at all — and the
    /// warning could only ever name `poll`, while its own reason for existing was to
    /// tell `board-appeared` (a view/framework bug) apart from `poll` (a timer bug)
    /// and `foreground` (a lifecycle bug). Worse, the one shape it most needed to
    /// catch was invisible: a re-armed appearance loop that the freshness window
    /// answers makes NO requests, so nothing downstream sees it either, and it can
    /// still burn the MainActor at whatever rate the framework re-arms it.
    ///
    /// The report is gated on RATE, not on count alone, and that is what keeps it
    /// meaningful now that ordinary refusals are counted too. A person switching
    /// tabs accumulates a few refusals between bundles; a loop accumulates ten in
    /// under two seconds. Requiring both makes the warning mean "nobody could have
    /// done this by hand".
    private func noteBoardRefreshRefused(
        _ origin: BoardRefreshOrigin, reason: String, at now: Date
    ) {
        boardRefreshDropsSinceRun += 1
        boardRefreshDropsTotal += 1
        let firstAt = firstRefusalSinceRunAt ?? now
        firstRefusalSinceRunAt = firstAt
        guard boardRefreshDropsSinceRun % Self.boardRefreshDropReportEvery == 0 else { return }
        let span = now.timeIntervalSince(firstAt)
        guard span < Self.boardRefreshBurstSeconds else { return }
        AppLog.warn("tasks", "board refresh asked far faster than it can be used", [
            "origin": origin.rawValue,
            "refusedBy": reason,
            "refused": String(boardRefreshDropsSinceRun),
            "refusedTotal": String(boardRefreshDropsTotal),
            "spanSeconds": String(format: "%.2f", span),
        ])
    }

    /// Test seam: total drops this store has seen.
    var _boardRefreshDropsForTesting: Int { boardRefreshDropsTotal }
}
