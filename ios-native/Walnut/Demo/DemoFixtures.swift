import Foundation

/// The demo's starting data: one believable, busy week of a person who uses
/// Walnut for a side-project app, a website redesign, home chores and a trip.
///
/// Every name here is invented and generic on purpose (projects, hosts, paths,
/// people): this data ships in a public app.
enum DemoFixtures {
    /// Model ids and labels as `src/model/providers/model-catalog.ts` lists them
    /// (Anthropic API ids): the newest of each family, the default first.
    static let mainModel = "claude-opus-5-5"
    static let fastModel = "claude-haiku-5-5"
    /// What the API uses when no effort is sent (`DEFAULT_SESSION_EFFORT`).
    static let defaultEffort = "high"
    static let macCodeRoot = "/Users/demo/code"
    static let buildBoxRoot = "/home/demo"
    static let buildBoxAlias = "build-box"
    /// The hand-arranged project order the board follows (`GET /ordering`).
    static let projectOrder = ["Pebble", "Acme Website", "Home", "Travel", "Learning"]
    /// The build box's display name, the one label for it everywhere the demo
    /// names a host: `/config` hosts (Settings), the launch options and the
    /// directory list. A header that resolves a host alias to its label reads
    /// this same word.
    static let buildBoxLabel = "Build box"

    /// The sentence demo voice input "hears": a reminder for the next work day's
    /// morning, named as the demo's clock reads it ("tomorrow morning", or "on
    /// Monday morning" said on a Friday or a Saturday). A fixed "on Friday
    /// morning" read oddly on most days (App Store gate, 2026-10-09).
    static func transcriptionSentence(_ c: DemoClock) -> String {
        let next = c.workday(after: 0)
        let when = next == 1 ? "tomorrow morning" : "on \(c.weekdayName(next)) morning"
        return "Remind me to send the counter quotes to the contractor \(when)."
    }

    static func seed(_ clock: DemoClock = DemoClock()) -> DemoState {
        var state = DemoState()
        state.tasks = tasks(clock)
        // The board's order is the fixture order: each pin takes the next slot.
        var slot = 0
        for i in state.tasks.indices where state.tasks[i].pinned {
            state.tasks[i].pinOrder = slot
            slot += 1
        }
        state.folders = folders
        state.sessions = DemoFixtureText.sessions(clock)
        state.conversations = DemoFixtureText.conversations(clock)
        state.letters = DemoFixtureText.letters(clock)
        state.notes = DemoFixtureText.notes(clock)
        state.noteFolders = ["Pebble", "Home", "Travel", "Journal"]
        state.favorites = ["Pebble/Release 2.4 plan.md", "Home/Kitchen remodel.md"]
        state.routines = routines(clock)
        // One session is blocked on a permission prompt, so the Allow / Deny card
        // has something to show.
        state.pendingPermissions["s-uptime"] = DemoFixtureText.uptimePermission()
        state.liveTurns["s:s-uptime"] = DemoFixtureText.uptimePendingText
        // Link each session into its task's `session_ids`, oldest first, the way
        // the server appends them.
        for session in state.sessions.sorted(by: { $0.startedAt < $1.startedAt }) {
            guard let taskId = session.taskId, let i = state.taskIndex(taskId) else { continue }
            state.tasks[i].sessionIds.append(session.id)
        }
        return state
    }

    // MARK: - Folders

    static let folders: [TaskFolder] = [
        TaskFolder(groupId: "g-release", label: "Release 2.4", project: "Pebble"),
        TaskFolder(groupId: "g-bugs", label: "Bugs", project: "Pebble"),
        TaskFolder(groupId: "g-redesign", label: "Redesign", project: "Acme Website"),
        TaskFolder(groupId: "g-kitchen", label: "Kitchen remodel", project: "Home"),
    ]

    // MARK: - Tasks

    static func tasks(_ c: DemoClock) -> [DemoTask] {
        func task(
            _ id: String, _ title: String, project: String, phase: String = "TODO",
            priority: String = "none", pinned: Bool = true, tier: String? = nil,
            folder: String? = nil, due: String? = nil, start: String? = nil, end: String? = nil,
            created: String, updated: String, completed: String? = nil,
            tags: [String]? = nil, summary: String? = nil, description: String? = nil,
            note: String? = nil, parent: String? = nil
        ) -> DemoTask {
            DemoTask(
                id: id, title: title, phase: phase, priority: priority, project: project,
                dueDate: due, startDate: start, endDate: end, createdAt: created,
                updatedAt: updated, completedAt: completed, pinned: pinned, focusTier: tier,
                tags: tags, summary: summary, description: description, note: note,
                parentId: parent, groupId: folder
            )
        }
        // The chat's plan names these two times, so both come from one place.
        let plan = c.plan()
        return [
            // Pebble, the photo-sharing app
            task("t-crash", "Fix the shared album crash", project: "Pebble",
                 phase: "IN_PROGRESS", priority: "immediate", tier: "focus", folder: "g-bugs",
                 start: DemoClock.iso(plan.review), end: DemoClock.iso(plan.review.addingTimeInterval(3600)),
                 created: c.daysAgo(1.2), updated: c.minutesAgo(17), tags: ["crash", "ios"],
                 summary: "Cause found: a force unwrap on an album that has not synced yet. Fix and tests are ready for review.",
                 description: "Crash reports since 2.3.1: opening a shared album from a notification closes the app. Reproduce, fix, add a test."),
            task("t-offline", "Add offline mode to the photo grid", project: "Pebble",
                 phase: "IN_PROGRESS", priority: "important", tier: "focus", folder: "g-release",
                 created: c.daysAgo(4), updated: c.minutesAgo(41),
                 summary: "Grid caches the last 500 thumbnails. Branch is ready to merge after one more review."),
            task("t-copy", "Review the onboarding copy changes", project: "Pebble",
                 phase: "NEED_ACTION", priority: "important", tier: "focus", folder: "g-release",
                 created: c.daysAgo(2), updated: c.hoursAgo(1.5),
                 summary: "Three headline options drafted. Waiting for your pick."),
            task("t-notes", "Write release notes for 2.4", project: "Pebble",
                 phase: "IN_PROGRESS", priority: "important", tier: "focus", folder: "g-release", due: c.day(1),
                 created: c.daysAgo(3), updated: c.minutesAgo(3),
                 summary: "First draft written. It gets the crash fix and offline mode once they merge."),
            task("t-testflight", "Ship the TestFlight build to beta testers", project: "Pebble",
                 priority: "important", tier: "wait", folder: "g-release",
                 start: c.at(day: c.shipDay(plan), hour: 11), end: c.at(day: c.shipDay(plan), hour: 11, minute: 30),
                 created: c.daysAgo(10), updated: c.hoursAgo(26),
                 summary: "Waiting on the crash fix and the onboarding copy."),
            task("t-coldstart", "Investigate slow cold start on older phones", project: "Pebble",
                 priority: "backlog", tier: "backlog", folder: "g-bugs",
                 created: c.daysAgo(9), updated: c.daysAgo(6)),
            task("t-l10n", "Localize the settings screen", project: "Pebble",
                 folder: "g-release", created: c.daysAgo(8), updated: c.daysAgo(5)),
            task("t-cache", "Upgrade the image cache library", project: "Pebble",
                 phase: "COMPLETE", priority: "important", pinned: false, folder: "g-release",
                 created: c.daysAgo(5), updated: c.hoursAgo(19), completed: c.hoursAgo(19),
                 summary: "Upgraded to the new major version. Memory use while scrolling is down 38%."),

            // Acme Website
            task("t-pricing", "Redesign the pricing page", project: "Acme Website",
                 phase: "IN_PROGRESS", priority: "important", folder: "g-redesign",
                 created: c.daysAgo(6), updated: c.hoursAgo(3),
                 summary: "Draft is live on the preview site. Review requested."),
            task("t-uptime", "Set up uptime alerts", project: "Acme Website",
                 phase: "IN_PROGRESS", priority: "important",
                 created: c.daysAgo(1), updated: c.minutesAgo(4),
                 summary: "Alert rules written. Waiting for permission to restart the alert agent."),
            task("t-hero", "Compress the hero images", project: "Acme Website",
                 priority: "backlog", tier: "backlog", folder: "g-redesign",
                 created: c.daysAgo(6), updated: c.daysAgo(6)),
            task("t-links", "Fix broken links in the docs footer", project: "Acme Website",
                 phase: "COMPLETE", pinned: false, created: c.daysAgo(4),
                 updated: c.daysAgo(2), completed: c.daysAgo(2)),

            // Home
            task("t-quotes", "Get three quotes for the kitchen counters", project: "Home",
                 priority: "important", tier: "focus", folder: "g-kitchen", due: c.day(DemoClock.quotesDueInDays),
                 created: c.daysAgo(5), updated: c.hoursAgo(5), tags: ["kitchen"],
                 summary: "Two quotes in. Stone & Co still has to call back."),
            task("t-plumber", "Book a plumber for the dishwasher line", project: "Home",
                 priority: "immediate", folder: "g-kitchen", due: c.day(1),
                 created: c.daysAgo(2), updated: c.hoursAgo(22)),
            task("t-car", "Renew the car registration", project: "Home",
                 priority: "important", due: c.day(5),
                 created: c.daysAgo(10), updated: c.daysAgo(3)),
            task("t-meals", "Plan meals for the weekend", project: "Home",
                 start: c.at(day: 0, hour: 18), end: c.at(day: 0, hour: 18, minute: 30),
                 created: c.daysAgo(1), updated: c.hoursAgo(8)),

            // Travel
            task("t-train", "Book train tickets to the coast", project: "Travel",
                 priority: "important", due: c.day(DemoClock.trainDueInDays),
                 created: c.daysAgo(3), updated: c.daysAgo(1)),
            task("t-pack", "Make a packing list for the coast trip", project: "Travel",
                 priority: "backlog", tier: "backlog",
                 created: c.daysAgo(4), updated: c.daysAgo(4)),

            // Inbox (no project)
            task("t-dentist", "Call the dentist to reschedule", project: "",
                 priority: "important", start: DemoClock.iso(plan.call),
                 end: DemoClock.iso(plan.call.addingTimeInterval(15 * 60)),
                 created: c.daysAgo(1), updated: c.hoursAgo(10)),
            task("t-article", "Read the article on habit tracking", project: "",
                 pinned: false, created: c.daysAgo(7), updated: c.daysAgo(7)),
            task("t-library", "Return the library books", project: "",
                 phase: "COMPLETE", pinned: false, created: c.daysAgo(3),
                 updated: c.hoursAgo(4), completed: c.hoursAgo(4)),
            task("t-course", "Finish chapter 4 of the design systems course", project: "Learning",
                 pinned: false, created: c.daysAgo(12), updated: c.daysAgo(2)),

            // Finished weeks ago, so outside the task list's 14 days (`listedTasks`):
            // only search finds them, the way the real server's answer names them
            // (`tasks=1`). Four crash fixes, so a search for "crash" shows three of
            // them inline and the fourth behind "Completed (1)".
            task("t-upload-crash", "Fix crash when uploading photos on a weak signal", project: "Pebble",
                 phase: "COMPLETE", pinned: false, folder: "g-bugs", created: c.daysAgo(19),
                 updated: c.daysAgo(16), completed: c.daysAgo(16),
                 summary: "Uploads now pause on a weak signal and resume when it comes back."),
            task("t-delete-crash", "Fix crash when deleting the last photo in an album", project: "Pebble",
                 phase: "COMPLETE", pinned: false, folder: "g-bugs", created: c.daysAgo(25),
                 updated: c.daysAgo(23), completed: c.daysAgo(23),
                 summary: "An empty album now keeps its place and shows an empty state."),
            task("t-restore-crash", "Fix crash on first launch after restoring from a backup", project: "Pebble",
                 phase: "COMPLETE", pinned: false, folder: "g-bugs", created: c.daysAgo(34),
                 updated: c.daysAgo(31), completed: c.daysAgo(31),
                 summary: "The photo index is rebuilt in the background instead of at launch."),
            task("t-widget-crash", "Fix crash in the home screen widget with no photos", project: "Pebble",
                 phase: "COMPLETE", pinned: false, folder: "g-bugs", created: c.daysAgo(44),
                 updated: c.daysAgo(40), completed: c.daysAgo(40),
                 summary: "The widget shows a placeholder until the first photo syncs."),
        ]
    }

    /// How long the phone's task list keeps a completed task, as the real server's
    /// projection does (`DONE_RETENTION_DAYS` in `src/core/task-projection.ts`).
    static let listedDoneDays: Double = 14

    // MARK: - Recently opened

    /// What the Tasks tab's "Recently opened" drawer holds when the demo starts, newest
    /// first: a few things looked at earlier today, so the drawer shows what it is for
    /// the first time it opens. Two conversations (the crash fix, the headline drafts)
    /// and two task pages (the kitchen quotes, and the cache upgrade that is done).
    static func recentOpens(_ state: DemoState, _ c: DemoClock) -> [RecentOpen] {
        let visits: [(task: String, session: String?, minutesAgo: Double)] = [
            ("t-crash", "s-crash", 15),
            ("t-copy", "s-copy", 80),
            ("t-quotes", nil, 4 * 60),
            ("t-cache", nil, 18 * 60),
        ]
        return visits.compactMap { visit in
            guard let task = state.tasks.first(where: { $0.id == visit.task }) else { return nil }
            let session = visit.session.flatMap { id in state.sessions.first { $0.id == id } }
                .map { state.wireSession($0) }
            return RecentOpen(
                id: task.id, taskId: task.id, task: session == nil ? task.wire : nil,
                session: session, openedAt: c.past(visit.minutesAgo * 60)
            )
        }
    }

    // MARK: - Story moments

    /// When the second counter quote came in: yesterday afternoon. The journal
    /// (yesterday evening), the comparison letter, the kitchen note and the plan
    /// all report both quotes, so each is dated after this.
    static func quotesArrived(_ c: DemoClock) -> Date {
        c.date(day: -1, hour: 16)
    }

    /// When yesterday's journal entry was written: early that evening, inside
    /// waking hours (8:00 AM to 9:00 PM) like every other past time.
    static func journalWritten(_ c: DemoClock) -> Date {
        c.date(day: -1, hour: 18, minute: 30)
    }

    // MARK: - Routines

    /// When the weekly review last ran (Fridays at 4:00 PM): its letter is dated then.
    static func weeklyReviewRun(_ c: DemoClock) -> (ago: TimeInterval, ahead: TimeInterval) {
        c.lastAndNextRun(hour: 16, weekdays: [6])
    }

    static func routines(_ c: DemoClock) -> [RoutineJob] {
        // Last and next runs follow each schedule, so the two never disagree.
        let briefing = c.lastAndNextRun(hour: 8, weekdays: [2, 3, 4, 5, 6])
        let weekly = weeklyReviewRun(c)
        // A daily daytime check, so its last run is in waking hours like every
        // other past time (an every-6-hours job ran at 3:00 AM).
        let crashes = c.lastAndNextRun(hour: 13, weekdays: [1, 2, 3, 4, 5, 6, 7])
        func job(
            _ id: String, _ name: String, _ description: String, enabled: Bool,
            schedule: RoutineJob.Schedule, executor: String,
            lastRun: TimeInterval?, nextRun: TimeInterval?, status: String? = "ok"
        ) -> RoutineJob {
            RoutineJob(
                id: id, name: name, description: description, enabled: enabled,
                schedule: schedule, executor: RoutineJob.Executor(type: executor),
                state: RoutineJob.State(
                    nextRunAtMs: nextRun.map { c.msFromNow($0) },
                    lastRunAtMs: lastRun.map { c.msAgo($0) },
                    lastStatus: lastRun == nil ? nil : status,
                    lastError: nil, lastDurationMs: lastRun == nil ? nil : 42_000
                )
            )
        }
        return [
            job("r-briefing", "Morning briefing",
                "Summarize today's calendar, due tasks and new letters.",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 8 * * 1-5", tz: nil, everyMs: nil, at: nil),
                executor: "main-agent", lastRun: briefing.ago, nextRun: briefing.ahead),
            job("r-weekly", "Weekly review",
                "Close out the week: what got done, what slipped, what is next.",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 16 * * 5", tz: nil, everyMs: nil, at: nil),
                executor: "main-agent", lastRun: weekly.ago, nextRun: weekly.ahead),
            job("r-crashes", "Check beta crash reports",
                "Look for new crash groups in the beta and file a task for each one.",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 13 * * *", tz: nil, everyMs: nil, at: nil),
                executor: "claude-code", lastRun: crashes.ago, nextRun: crashes.ahead),
            job("r-plants", "Water the plants",
                "A Sunday morning nudge.", enabled: false,
                schedule: .init(kind: "cron", expr: "0 9 * * 0", tz: nil, everyMs: nil, at: nil),
                executor: "main-agent", lastRun: nil, nextRun: nil),
        ]
    }

    // MARK: - Server-wide answers

    static func status(_ now: Date) -> [String: Any] {
        [
            "mode": "LIVE", "cloud": false, "version": "0.6.0",
            "serverTime": DemoClock.iso(now), "capabilities": ["asks"],
        ]
    }

    static let agents: [AgentSummary] = [
        AgentSummary(id: "general", name: "Walnut", description: nil, isMain: true),
        AgentSummary(
            id: "mentor", name: "Mentor",
            description: "A coach for career and growth questions.", isMain: false
        ),
    ]

    static let models: [SessionModelOptions.Model] = [
        // Effort levels as the server's capability map gives them: Opus,
        // Sonnet and Haiku 5.5 take all five.
        .init(id: mainModel, label: "Opus 5.5", supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]),
        .init(id: "claude-sonnet-5-5", label: "Sonnet 5.5", supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]),
        .init(id: fastModel, label: "Haiku 5.5", supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]),
    ]

    /// Read when asked, from the demo's clock (waking hours, like the rest).
    static func launchOptions(_ c: DemoClock = DemoClock()) -> SessionLaunchOptions {
        SessionLaunchOptions(
            hosts: [
                .init(alias: "", label: "Mac"),
                .init(alias: buildBoxAlias, label: buildBoxLabel),
            ],
            dirs: [
                .init(cwd: "\(macCodeRoot)/pebble", host: "", hostLabel: "Mac",
                      lastUsed: c.minutesAgo(10), count: 42),
                .init(cwd: "\(macCodeRoot)/acme-site", host: "", hostLabel: "Mac",
                      lastUsed: c.hoursAgo(3), count: 17),
                .init(cwd: "\(buildBoxRoot)/infra", host: buildBoxAlias, hostLabel: buildBoxLabel,
                      lastUsed: c.minutesAgo(4), count: 9),
            ]
        )
    }

    static var serverConfig: [String: Any] {
        [
            "config": [
                "user": ["name": "Demo"],
                "provider": ["type": "anthropic", "model": mainModel],
                "agent": ["main_model": mainModel, "fast_model": fastModel],
                "hosts": [buildBoxAlias: ["label": buildBoxLabel, "enabled": true]],
            ],
            "cloud": false,
            "memory": ["rssMb": 212, "heapUsedMb": 96, "uptimeSec": 3 * 86_400 + 5 * 3600],
        ]
    }

    /// The small sample directory tree the session file browser can walk.
    static func files(in directory: String) -> [SessionFileEntry]? {
        let pebble = "\(macCodeRoot)/pebble"
        let tree: [String: [SessionFileEntry]] = [
            pebble: [
                .init(name: "Sources", path: nil, type: "dir", size: nil, hasChildren: true),
                .init(name: "Tests", path: nil, type: "dir", size: nil, hasChildren: true),
                .init(name: "README.md", path: nil, type: "file", size: 2_140, hasChildren: false),
                .init(name: "Package.swift", path: nil, type: "file", size: 912, hasChildren: false),
            ],
            "\(pebble)/Sources": [
                .init(name: "Albums", path: nil, type: "dir", size: nil, hasChildren: true),
                .init(name: "Grid", path: nil, type: "dir", size: nil, hasChildren: true),
                .init(name: "App.swift", path: nil, type: "file", size: 1_830, hasChildren: false),
            ],
            "\(pebble)/Sources/Albums": [
                .init(name: "AlbumViewModel.swift", path: nil, type: "file", size: 4_406, hasChildren: false),
                .init(name: "AlbumView.swift", path: nil, type: "file", size: 6_211, hasChildren: false),
                .init(name: "NotificationRouter.swift", path: nil, type: "file", size: 2_978, hasChildren: false),
            ],
            "\(pebble)/Sources/Grid": [
                .init(name: "PhotoGrid.swift", path: nil, type: "file", size: 5_102, hasChildren: false),
                .init(name: "ThumbnailCache.swift", path: nil, type: "file", size: 3_315, hasChildren: false),
            ],
            "\(pebble)/Tests": [
                .init(name: "AlbumTests.swift", path: nil, type: "file", size: 3_870, hasChildren: false),
            ],
        ]
        return tree[directory]
    }

    static func fileContent(at path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        switch name {
        case "AlbumViewModel.swift":
            return """
            import Foundation

            @MainActor
            final class AlbumViewModel: ObservableObject {
                @Published private(set) var album: Album?
                @Published private(set) var isLoading = false
                private let store: AlbumStore

                init(store: AlbumStore) {
                    self.store = store
                }

                /// Opens an album that may not have synced yet (a notification can
                /// arrive before the album does), so it waits instead of assuming.
                func load(albumID: Album.ID) async {
                    isLoading = true
                    defer { isLoading = false }
                    album = await store.album(id: albumID, waitingUpTo: .seconds(10))
                }
            }
            """
        case "README.md":
            return """
            # Pebble

            Share photo albums with the people in them.

            ## Build

            Open `Package.swift` in Xcode and run the `Pebble` scheme.
            """
        default:
            return "// \(name)\n// Sample file in the Walnut demo.\n"
        }
    }

    /// A tiny self-contained page for an HTML preview opened in demo mode, so the
    /// preview never asks WebKit to load anything from a network.
    static func htmlPreview(for url: URL) -> String {
        let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "path" })?.value
            .map { ($0 as NSString).lastPathComponent } ?? "Preview"
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font:-apple-system-body;margin:24px;color:#222}h1{font-size:22px}</style></head>
        <body><h1>\(name)</h1><p>This is a sample preview in the Walnut demo.</p></body></html>
        """
    }
}
