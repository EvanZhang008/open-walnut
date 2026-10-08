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

    /// The fixed sentence demo voice input "hears".
    static let transcriptionSentence = "Remind me to send the counter quotes to the contractor on Friday morning."

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
        let friday = c.nextWeekday(6)
        return [
            // Pebble, the photo-sharing app
            task("t-crash", "Fix crash when opening a shared album", project: "Pebble",
                 phase: "IN_PROGRESS", priority: "immediate", tier: "focus", folder: "g-bugs",
                 start: c.at(day: 0, hour: 14), end: c.at(day: 0, hour: 15),
                 created: c.daysAgo(1.2), updated: c.minutesAgo(9), tags: ["crash", "ios"],
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
                 priority: "important", tier: "focus", folder: "g-release", due: c.day(1),
                 created: c.daysAgo(3), updated: c.hoursAgo(20)),
            task("t-testflight", "Ship the TestFlight build to beta testers", project: "Pebble",
                 priority: "important", tier: "wait", folder: "g-release",
                 start: c.at(day: 1, hour: 11), end: c.at(day: 1, hour: 11, minute: 30),
                 created: c.daysAgo(3), updated: c.hoursAgo(26),
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
                 priority: "important", tier: "focus", folder: "g-kitchen", due: c.day(friday),
                 created: c.daysAgo(5), updated: c.hoursAgo(5), tags: ["kitchen"],
                 summary: "Two quotes in. One shop still has to call back."),
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
                 priority: "important", due: c.day(3),
                 created: c.daysAgo(4), updated: c.daysAgo(1)),
            task("t-pack", "Make a packing list for the October trip", project: "Travel",
                 priority: "backlog", tier: "backlog",
                 created: c.daysAgo(4), updated: c.daysAgo(4)),

            // Inbox (no project)
            task("t-dentist", "Call the dentist to reschedule", project: "",
                 priority: "important", start: c.at(day: 0, hour: 10, minute: 30),
                 end: c.at(day: 0, hour: 10, minute: 45),
                 created: c.daysAgo(1), updated: c.hoursAgo(10)),
            task("t-article", "Read the article on habit tracking", project: "",
                 pinned: false, created: c.daysAgo(7), updated: c.daysAgo(7)),
            task("t-library", "Return the library books", project: "",
                 phase: "COMPLETE", pinned: false, created: c.daysAgo(3),
                 updated: c.hoursAgo(4), completed: c.hoursAgo(4)),
            task("t-course", "Finish chapter 4 of the design systems course", project: "Learning",
                 pinned: false, created: c.daysAgo(12), updated: c.daysAgo(2)),
        ]
    }

    // MARK: - Routines

    static func routines(_ c: DemoClock) -> [RoutineJob] {
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
                "Summarize today's calendar, due tasks and overnight letters.",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 8 * * 1-5", tz: nil, everyMs: nil, at: nil),
                executor: "main-agent", lastRun: 3 * 3600, nextRun: 21 * 3600),
            job("r-weekly", "Weekly review",
                "Close out the week: what got done, what slipped, what is next.",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 16 * * 5", tz: nil, everyMs: nil, at: nil),
                executor: "main-agent", lastRun: 6 * 86_400, nextRun: 2 * 86_400),
            job("r-crashes", "Check beta crash reports",
                "Look for new crash groups in the beta and file a task for each one.",
                enabled: true,
                schedule: .init(kind: "every", expr: nil, tz: nil, everyMs: 6 * 3_600_000, at: nil),
                executor: "claude-code", lastRun: 2 * 3600, nextRun: 4 * 3600),
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

    static var launchOptions: SessionLaunchOptions {
        SessionLaunchOptions(
            hosts: [
                .init(alias: "", label: "Mac"),
                .init(alias: buildBoxAlias, label: "Build box"),
            ],
            dirs: [
                .init(cwd: "\(macCodeRoot)/pebble", host: "", hostLabel: "Mac",
                      lastUsed: DemoClock.iso(Date().addingTimeInterval(-600)), count: 42),
                .init(cwd: "\(macCodeRoot)/acme-site", host: "", hostLabel: "Mac",
                      lastUsed: DemoClock.iso(Date().addingTimeInterval(-10_800)), count: 17),
                .init(cwd: "\(buildBoxRoot)/infra", host: buildBoxAlias, hostLabel: "Build box",
                      lastUsed: DemoClock.iso(Date().addingTimeInterval(-240)), count: 9),
            ]
        )
    }

    static var serverConfig: [String: Any] {
        [
            "config": [
                "user": ["name": "Demo"],
                "provider": ["type": "anthropic", "model": mainModel],
                "agent": ["main_model": mainModel, "fast_model": fastModel],
                "hosts": [buildBoxAlias: ["label": "Build box", "enabled": true]],
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
