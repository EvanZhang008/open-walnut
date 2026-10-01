import Foundation

/// The demo's longer text: session transcripts, chat history, letters and notes.
/// Kept apart from `DemoFixtures` so the structure (ids, phases, tiers) reads at
/// a glance there and the prose can be edited here without touching it.
enum DemoFixtureText {
    typealias Row = SessionTranscript.Message

    private static func user(_ text: String, _ at: String) -> Row {
        Row(role: "user", text: text, timestamp: at, kind: nil)
    }

    private static func say(_ text: String, _ at: String) -> Row {
        Row(role: "assistant", text: text, timestamp: at, kind: nil)
    }

    private static func think(_ line: String, _ full: String? = nil, _ at: String) -> Row {
        Row(role: "assistant", text: line, timestamp: at, kind: "thinking", thinkingText: full ?? line)
    }

    private static func tool(
        _ name: String, _ detail: String, input: String? = nil, result: String? = nil, _ at: String
    ) -> Row {
        Row(role: "assistant", text: name, timestamp: at, kind: "tool",
            detail: detail, resultPreview: result, inputPreview: input)
    }

    // MARK: - Sessions

    static func sessions(_ c: DemoClock) -> [DemoSession] {
        let pebble = "\(DemoFixtures.macCodeRoot)/pebble"
        let acme = "\(DemoFixtures.macCodeRoot)/acme-site"
        let infra = "\(DemoFixtures.buildBoxRoot)/infra"
        return [
            DemoSession(
                id: "s-crash", title: "Fix the shared album crash",
                taskId: "t-crash", host: "", processStatus: "idle",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.minutesAgo(52), lastActiveAt: c.minutesAgo(9),
                cwd: pebble, description: "Crash on opening a shared album from a notification.",
                transcript: [
                    user("The app crashes when I open a shared album from a notification. Can you find out why and fix it?", c.minutesAgo(52)),
                    think("Start with the newest crash log, then follow the notification route into the album screen.",
                          "Start with the newest crash log, then follow the notification route into the album screen.\n\nIf the stack ends in the view model, check what it assumes about the album at that moment.", c.minutesAgo(51.8)),
                    tool("Read", "CrashLogs/pebble-2.3.1.ips",
                         input: "file_path: \(pebble)/CrashLogs/pebble-2.3.1.ips",
                         result: "Exception Type: EXC_BREAKPOINT (SIGTRAP)\nThread 0 Crashed:\n0  Pebble  AlbumViewModel.load(albumID:) + 412\n1  Pebble  NotificationRouter.open(_:) + 88\n2  Pebble  AppDelegate.userNotificationCenter(_:didReceive:) + 164",
                         c.minutesAgo(51.6)),
                    tool("Grep", "albumID! in Sources",
                         input: "pattern: albumID!\npath: Sources",
                         result: "Sources/Albums/AlbumViewModel.swift:57:        let album = store.album(id: albumID!)",
                         c.minutesAgo(51.2)),
                    tool("Read", "Sources/Albums/AlbumViewModel.swift",
                         input: "file_path: \(pebble)/Sources/Albums/AlbumViewModel.swift",
                         result: "52    func load(albumID: Album.ID?) {\n53        isLoading = true\n54        defer { isLoading = false }\n55        // Called straight from the notification router, before the\n56        // shared album has synced to this phone.\n57        let album = store.album(id: albumID!)",
                         c.minutesAgo(51)),
                    say("Found it. When the app opens from a notification, `NotificationRouter` builds the album screen before the shared album has synced, so `albumID` is still nil and the force unwrap on line 57 crashes.\n\nI'll make the view model wait for the album instead of assuming it is already there.", c.minutesAgo(50.5)),
                    tool("Edit", "Sources/Albums/AlbumViewModel.swift",
                         input: "file_path: \(pebble)/Sources/Albums/AlbumViewModel.swift\nold_string: let album = store.album(id: albumID!)\nnew_string: album = await store.album(id: albumID, waitingUpTo: .seconds(10))",
                         result: "Updated AlbumViewModel.swift (+18, -4)",
                         c.minutesAgo(49)),
                    tool("Edit", "Tests/AlbumTests.swift",
                         input: "file_path: \(pebble)/Tests/AlbumTests.swift",
                         result: "Added testOpenFromNotificationBeforeSync",
                         c.minutesAgo(48)),
                    tool("Bash", "Run the album tests",
                         input: "command: swift test --filter AlbumTests\ndescription: Run the album tests",
                         result: "Test Suite 'AlbumTests' started\n...\nTest Suite 'AlbumTests' passed\n     Executed 24 tests, with 0 failures (0 unexpected) in 3.812 seconds",
                         c.minutesAgo(46)),
                    say("Fixed and tested.\n\n- **Cause:** a force unwrap on an album that had not synced yet.\n- **Fix:** the album screen shows a short loading state and opens as soon as the album arrives (up to 10 seconds, then a friendly error).\n- **Tests:** a new test opens an album from a notification before it syncs. All 24 album tests pass.\n\nWant me to open a pull request?", c.minutesAgo(45)),
                    user("Yes, open the PR and ask for a review.", c.minutesAgo(12)),
                    tool("Bash", "Push the branch and open a pull request",
                         input: "command: git push -u origin fix/shared-album-crash && gh pr create --fill\ndescription: Push the branch and open a pull request",
                         result: "Opened pull request #318: Fix crash when opening a shared album",
                         c.minutesAgo(10)),
                    say("Pull request **#318** is open and a review is requested. I'll let you know when it is approved, then we can ship it in the next TestFlight build.", c.minutesAgo(9)),
                ]
            ),
            DemoSession(
                id: "s-offline", title: "Offline photo grid",
                taskId: "t-offline", host: "", processStatus: "idle",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.hoursAgo(26), lastActiveAt: c.minutesAgo(41),
                cwd: pebble, description: "Keep the photo grid usable without a connection.",
                transcript: [
                    user("Make the photo grid work offline. Thumbnails the user has seen should still show.", c.hoursAgo(26)),
                    think("A bounded disk cache for thumbnails, keyed by asset id, read before the network.", nil, c.hoursAgo(25.9)),
                    tool("Read", "Sources/Grid/PhotoGrid.swift", input: "file_path: \(pebble)/Sources/Grid/PhotoGrid.swift", c.hoursAgo(25.8)),
                    tool("Edit", "Sources/Grid/ThumbnailCache.swift", input: "file_path: \(pebble)/Sources/Grid/ThumbnailCache.swift", result: "Created ThumbnailCache.swift (+96)", c.hoursAgo(25.2)),
                    tool("Bash", "Run the grid tests", input: "command: swift test --filter GridTests", result: "Executed 31 tests, with 0 failures in 5.106 seconds", c.hoursAgo(25)),
                    say("The grid now keeps the last **500 thumbnails** on disk (about 40 MB) and shows them first, then refreshes from the network when it can. Offline, unseen photos show a soft placeholder instead of a spinner.", c.hoursAgo(24.9)),
                    user("Looks good. Can you also show a small banner when we're offline?", c.minutesAgo(48)),
                    tool("Edit", "Sources/Grid/PhotoGrid.swift", input: "file_path: \(pebble)/Sources/Grid/PhotoGrid.swift", result: "Updated PhotoGrid.swift (+22, -3)", c.minutesAgo(44)),
                    say("Added an **Offline** banner at the top of the grid. It slides away when the connection is back. The branch is ready to merge whenever you are.", c.minutesAgo(41)),
                ]
            ),
            DemoSession(
                id: "s-copy", title: "Onboarding headline options",
                taskId: "t-copy", host: "", processStatus: "idle",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.hoursAgo(3), lastActiveAt: c.hoursAgo(1.5),
                cwd: pebble, description: "Tighten the first-run screens.",
                transcript: [
                    user("Our onboarding headline feels generic. Draft a few better options, short and friendly.", c.hoursAgo(3)),
                    tool("Read", "Sources/Onboarding/WelcomeView.swift", input: "file_path: \(pebble)/Sources/Onboarding/WelcomeView.swift", c.hoursAgo(2.9)),
                    say("Here are three options, each under six words:\n\n1. **Share moments, not files**\n2. **Your photos, together**\n3. **Albums for the people in them**\n\nI sent them to your Inbox so you can pick one with a tap. I'll update the welcome screen and the App Store text once you choose.", c.hoursAgo(1.5)),
                ]
            ),
            DemoSession(
                id: "s-cache", title: "Image cache upgrade",
                taskId: "t-cache", host: "", processStatus: "stopped",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.hoursAgo(23), lastActiveAt: c.hoursAgo(19),
                cwd: pebble, description: "Move to the new major version of the image cache.",
                transcript: [
                    user("Upgrade the image cache library to the new major version and fix whatever breaks.", c.hoursAgo(23)),
                    tool("Bash", "Update the dependency", input: "command: swift package update ImageCache", result: "Updating ImageCache 4.2.0 -> 5.0.1", c.hoursAgo(22.8)),
                    tool("Bash", "Build", input: "command: swift build", result: "error: 'CacheOptions.memoryLimit' was renamed to 'CacheOptions.memoryBudget'\nerror: 'ImagePipeline.shared' is unavailable", c.hoursAgo(22.6)),
                    tool("Edit", "Sources/Grid/ThumbnailCache.swift", result: "Updated 3 call sites", c.hoursAgo(22)),
                    tool("Bash", "Run all tests", input: "command: swift test", result: "Executed 212 tests, with 0 failures in 41.2 seconds", c.hoursAgo(20)),
                    say("Done. The upgrade needed three small changes (two renamed options and the shared pipeline). All 212 tests pass, and memory use while scrolling a 2,000 photo album dropped by **38%**. I wrote it up in your Inbox.", c.hoursAgo(19)),
                ]
            ),
            DemoSession(
                id: "s-pricing", title: "Pricing page rebuild",
                taskId: "t-pricing", host: "", processStatus: "stopped",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.hoursAgo(7), lastActiveAt: c.hoursAgo(3),
                cwd: acme, description: "New pricing page with a monthly and yearly toggle.",
                transcript: [
                    user("Rebuild the pricing page: three plans, a monthly and yearly toggle, and a short FAQ.", c.hoursAgo(7)),
                    tool("Read", "src/pages/pricing.tsx", input: "file_path: \(acme)/src/pages/pricing.tsx", c.hoursAgo(6.9)),
                    tool("Edit", "src/pages/pricing.tsx", result: "Rewrote pricing.tsx (+184, -97)", c.hoursAgo(5)),
                    tool("Bash", "Deploy to the preview site", input: "command: npm run deploy:preview", result: "Preview ready", c.hoursAgo(3.2)),
                    say("The new pricing page is on the preview site. Three plans, a yearly toggle that shows the saving, and a five-question FAQ. I sent a review letter with the details.", c.hoursAgo(3)),
                ]
            ),
            DemoSession(
                id: "s-uptime", title: "Uptime alerts for site and API",
                taskId: "t-uptime", host: DemoFixtures.buildBoxAlias, processStatus: "running",
                model: DemoFixtures.mainModel, mode: "default",
                startedAt: c.minutesAgo(30), lastActiveAt: c.minutesAgo(4),
                cwd: infra, description: "Alert when the website or the API stops answering.",
                transcript: [
                    user("Set up uptime alerts for the website and the API. Page me only if it is down for more than two minutes.", c.minutesAgo(30)),
                    tool("Read", "alerts/rules.yml", input: "file_path: \(infra)/alerts/rules.yml", c.minutesAgo(28)),
                    tool("Edit", "alerts/rules.yml", input: "file_path: \(infra)/alerts/rules.yml", result: "Added 2 rules: site-down, api-down (for: 2m)", c.minutesAgo(20)),
                    say("I added two rules, **site-down** and **api-down**, that fire after two minutes without an answer. To load them, the alert agent on this machine has to restart.", c.minutesAgo(5)),
                ]
            ),
        ]
    }

    /// The live region of the session blocked on a permission prompt, as the
    /// stream's attach snapshot carries it.
    static let uptimePendingText = "Restarting the alert agent so the new rules take effect."

    static func uptimePermission() -> PendingPermission {
        PendingPermission(
            requestId: "perm-uptime-restart",
            toolName: "Bash",
            input: [
                "command": .string("sudo systemctl restart alert-agent"),
                "description": .string("Restart the alert agent to load the new rules"),
            ],
            reason: nil
        )
    }

    // MARK: - Personal AI conversations

    static func conversations(_ c: DemoClock) -> [DemoConversation] {
        var counter = 0
        func msg(_ role: String, _ text: String, _ at: String, kind: ChatMessage.Kind? = nil,
                 detail: String? = nil, result: String? = nil, thinking: String? = nil) -> ChatMessage {
            counter += 1
            return ChatMessage(
                id: "m\(counter)", role: role, text: text, createdAt: at, kind: kind,
                detail: detail, resultPreview: result, thinkingText: thinking
            )
        }
        let today = DemoConversation(
            id: "c-today", agentID: "general", title: "Plan for today",
            updatedAt: c.minutesAgo(6),
            messages: [
                msg("user", "What should I focus on today?", c.minutesAgo(14)),
                msg("assistant", "Checking the board and the calendar for today.", c.minutesAgo(13.9),
                    kind: .thinking, thinking: "Checking the board and the calendar for today.\n\nFocus has five tasks; two have sessions waiting on a human. The dentist call is at 10:30 and the crash review block is at 2:00."),
                msg("assistant", "task_list", c.minutesAgo(13.8), kind: .tool,
                    detail: "Pinned tasks in Focus", result: "5 tasks: Fix crash when opening a shared album · Add offline mode to the photo grid · Review the onboarding copy changes · Write release notes for 2.4 · Get three quotes for the kitchen counters"),
                msg("assistant", """
                    Here is a realistic plan for today:

                    1. **Review the shared album crash fix** (Pebble). The session found the cause and opened pull request #318. About 20 minutes, blocked out at 2:00.
                    2. **Pick an onboarding headline.** Three options are waiting in your Inbox; it takes one tap.
                    3. **Call the dentist** at 10:30 to move the appointment.
                    4. **Kitchen counters:** two quotes are in, one shop still has to call back before Friday.

                    If you have energy left, I can start a first draft of the 2.4 release notes while you review the fix.
                    """, c.minutesAgo(13.5)),
                msg("user", "Yes, start the release notes draft. Keep it short.", c.minutesAgo(7)),
                msg("assistant", "session_start", c.minutesAgo(6.8), kind: .tool,
                    detail: "Write release notes for 2.4", result: "Session started in ~/code/pebble"),
                msg("assistant", "Started a session on **Write release notes for 2.4**. It will collect the changes merged since 2.3 and leave a short draft on the task. I'll send it to your Inbox when it is ready.", c.minutesAgo(6)),
            ]
        )
        let kitchen = DemoConversation(
            id: "c-kitchen", agentID: "general", title: "Kitchen remodel budget",
            updatedAt: c.hoursAgo(20),
            messages: [
                msg("user", "Help me keep the kitchen remodel under budget. What usually runs over?", c.hoursAgo(21)),
                msg("assistant", "The usual overruns are counters, plumbing moves and anything behind the walls. A simple rule: hold back **15%** of the budget for surprises, and get at least three quotes for counters and cabinets.\n\nI added a task for the counter quotes and pinned it to Focus.", c.hoursAgo(20.9)),
                msg("user", "Good idea. Remind me to book the plumber too.", c.hoursAgo(20.2)),
                msg("assistant", "Done: **Book a plumber for the dishwasher line** is due tomorrow.", c.hoursAgo(20)),
            ]
        )
        let trip = DemoConversation(
            id: "c-trip", agentID: "general", title: "Ideas for the October trip",
            updatedAt: c.daysAgo(3),
            messages: [
                msg("user", "Three days on the coast in October. What should we not miss?", c.daysAgo(3.1)),
                msg("assistant", "For three days I would keep it simple:\n\n- **Day 1:** arrive by train, walk the harbour front at sunset.\n- **Day 2:** the cliff path in the morning, a long lunch, the old lighthouse.\n- **Day 3:** the Saturday market, then home.\n\nTrain tickets are cheaper if you book this week. I added a task.", c.daysAgo(3)),
            ]
        )
        let summary = DemoConversation(
            id: "c-crash", agentID: "general", title: "What changed in Pebble this week",
            updatedAt: c.daysAgo(1.8),
            messages: [
                msg("user", "Summarize what changed in Pebble this week.", c.daysAgo(1.9)),
                msg("assistant", "This week in Pebble:\n\n- The image cache upgrade is done; scrolling uses 38% less memory.\n- Offline mode for the photo grid is nearly ready.\n- A crash when opening shared albums from a notification is being fixed.\n\nNext up is the 2.4 TestFlight build.", c.daysAgo(1.8)),
            ]
        )
        let books = DemoConversation(
            id: "c-books", agentID: "general", title: "Books for a long flight",
            updatedAt: c.daysAgo(6),
            messages: [
                msg("user", "Suggest two easy books for a long flight.", c.daysAgo(6.1)),
                msg("assistant", "Two light but good picks: a short mystery novel you can finish in one sitting, and a collection of travel essays you can dip in and out of. I added them to your Reading list note.", c.daysAgo(6)),
            ]
        )
        let mentor = DemoConversation(
            id: "c-mentor", agentID: "mentor", title: "Weekly check-in",
            updatedAt: c.daysAgo(2),
            messages: [
                msg("user", "I keep starting side projects and not finishing them. Any advice?", c.daysAgo(2.1)),
                msg("assistant", "Pick one finish line you can reach in two weeks, write it down, and say no to anything that does not move it. Shipping something small beats polishing something big.", c.daysAgo(2)),
            ]
        )
        return [today, kitchen, trip, summary, books, mentor]
    }

    // MARK: - Letters

    static func letters(_ c: DemoClock) -> [Letter] {
        func sender(_ session: String?, _ title: String, task: String?, taskTitle: String?, project: String?, host: String = "") -> LetterSender {
            LetterSender(sessionId: session, sessionTitle: title, taskId: task, taskTitle: taskTitle, project: project, host: host)
        }
        func letter(
            _ id: String, subject: String, type: String, preview: String, body: String,
            from: LetterSender, createdAgo: TimeInterval, read: Bool, pinned: Bool = false,
            archived: Bool = false, actions: [LetterAction]? = nil, taskRefs: [String]? = nil
        ) -> Letter {
            Letter(
                id: id, subject: subject, type: type, bodyFormat: "markdown",
                textPreview: preview, sender: from, createdAt: c.msAgo(createdAgo),
                read: read, readAt: read ? c.msAgo(createdAgo - 60) : nil,
                pinned: pinned, archived: archived, actions: actions, answered: nil,
                thread: [], taskRefs: taskRefs, body: body, bodyMissing: nil,
                bodyBytes: body.utf8.count, bodyDeferred: nil, bodyUrl: nil
            )
        }
        return [
            letter("l-headline", subject: "Which onboarding headline should ship?",
                   type: "action_required",
                   preview: "Three short options for the welcome screen. Pick one and I will update the app and the App Store text.",
                   body: """
                   I drafted three headlines for the first screen of Pebble. Each is under six words and tested for length on the smallest phone.

                   **A. Share moments, not files**
                   Warm and clear. Best if we lead with sharing.

                   **B. Your photos, together**
                   Shortest. Works well next to the album illustration.

                   **C. Albums for the people in them**
                   Most specific about what Pebble does.

                   My pick is **A**. Once you choose, I will update the welcome screen and the App Store subtitle.
                   """,
                   from: sender("s-copy", "Onboarding copy", task: "t-copy", taskTitle: "Review the onboarding copy changes", project: "Pebble"),
                   createdAgo: 1.5 * 3600, read: false,
                   actions: [
                       LetterAction(id: "a", label: "Ship option A", description: "Share moments, not files"),
                       LetterAction(id: "b", label: "Ship option B", description: "Your photos, together"),
                       LetterAction(id: "c", label: "Ship option C", description: "Albums for the people in them"),
                   ],
                   taskRefs: ["t-copy"]),
            letter("l-merge", subject: "Offline mode is ready to merge",
                   type: "action_required",
                   preview: "The photo grid now works offline with the last 500 thumbnails cached. Merge it into the 2.4 branch?",
                   body: """
                   Offline mode for the photo grid is done and tested.

                   - The last **500 thumbnails** stay on disk (about 40 MB).
                   - An **Offline** banner appears at the top of the grid and slides away when the connection is back.
                   - 31 grid tests pass.

                   Merge it into the 2.4 branch now, or wait for the crash fix to land first?
                   """,
                   from: sender("s-offline", "Offline photo grid", task: "t-offline", taskTitle: "Add offline mode to the photo grid", project: "Pebble"),
                   createdAgo: 41 * 60, read: false,
                   actions: [
                       LetterAction(id: "merge", label: "Merge now", description: nil),
                       LetterAction(id: "wait", label: "Wait for the crash fix", description: nil),
                   ],
                   taskRefs: ["t-offline"]),
            letter("l-pricing", subject: "Pricing page draft is ready for review",
                   type: "review",
                   preview: "Three plans, a yearly toggle that shows the saving, and a short FAQ. It is live on the preview site.",
                   body: """
                   The new pricing page is on the preview site.

                   **What changed**
                   - Three plans side by side, with the middle one highlighted.
                   - A monthly and yearly toggle; yearly shows the saving.
                   - A five-question FAQ under the plans.

                   **Worth a look**
                   - Is the yearly saving clear enough at a glance?
                   - Do we need a fourth plan for teams?

                   Reply here with any changes and I will make them.
                   """,
                   from: sender("s-pricing", "Pricing page", task: "t-pricing", taskTitle: "Redesign the pricing page", project: "Acme Website"),
                   createdAgo: 3 * 3600, read: false, taskRefs: ["t-pricing"]),
            letter("l-counters", subject: "Kitchen counter quotes, compared",
                   type: "completion",
                   preview: "Two of three quotes are in. The quartz option from the second shop is the best value so far.",
                   body: """
                   Two of the three quotes for the kitchen counters are in. The third shop promised to call back by Thursday.

                   | Shop | Material | Price | Lead time |
                   |---|---|---|---|
                   | Stone & Co | Quartz | 3,400 | 3 weeks |
                   | Counter Works | Quartz | 2,950 | 4 weeks |
                   | Oak Lane | Butcher block | 1,800 | 2 weeks |

                   **So far:** Counter Works is the best value for quartz. Butcher block is cheapest but needs oiling twice a year.

                   I will add the third quote when it arrives.
                   """,
                   from: sender(nil, "Walnut", task: "t-quotes", taskTitle: "Get three quotes for the kitchen counters", project: "Home"),
                   createdAgo: 5 * 3600, read: true, pinned: true, taskRefs: ["t-quotes"]),
            letter("l-cache", subject: "Image cache upgrade is done",
                   type: "completion",
                   preview: "Upgraded to the new major version. All 212 tests pass and scrolling uses 38% less memory.",
                   body: """
                   The image cache library is upgraded to the new major version.

                   - **3 call sites** changed (two renamed options and the shared pipeline).
                   - **212 tests** pass.
                   - Scrolling a 2,000 photo album uses **38% less memory**.

                   Nothing else needs your attention. The task is marked complete.
                   """,
                   from: sender("s-cache", "Image cache upgrade", task: "t-cache", taskTitle: "Upgrade the image cache library", project: "Pebble"),
                   createdAgo: 19 * 3600, read: true, taskRefs: ["t-cache"]),
            letter("l-weekly", subject: "Weekly review: 14 tasks done",
                   type: "info",
                   preview: "A good week: 14 tasks done, 3 carried over. Pebble 2.4 is on track for next week.",
                   body: """
                   **Done this week:** 14 tasks
                   **Carried over:** 3 (release notes, packing list, car registration)

                   **Highlights**
                   - Image cache upgrade shipped to the beta.
                   - Pricing page redesign reached review.
                   - Kitchen counter quotes started.

                   **Next week**
                   Pebble 2.4 to TestFlight, the October trip tickets, and the dentist.
                   """,
                   from: sender(nil, "Weekly review", task: nil, taskTitle: nil, project: nil),
                   createdAgo: 6 * 86_400, read: true),
            letter("l-links", subject: "Docs footer links are fixed",
                   type: "completion",
                   preview: "All 12 broken links in the docs footer now point to the right pages.",
                   body: "All 12 broken links in the docs footer now point to the right pages, and a link check runs on every deploy.",
                   from: sender(nil, "Docs links", task: "t-links", taskTitle: "Fix broken links in the docs footer", project: "Acme Website"),
                   createdAgo: 2 * 86_400, read: true, archived: true, taskRefs: ["t-links"]),
        ]
    }

    // MARK: - Notes

    static func notes(_ c: DemoClock) -> [DemoNote] {
        let yesterday = c.day(-1)
        return [
            DemoNote(path: "Pebble/Release 2.4 plan.md", content: """
                **Target:** TestFlight next week, App Store the week after.

                ## In the release
                - [x] Image cache upgrade
                - [ ] Offline mode for the photo grid
                - [ ] Fix the shared album crash
                - [ ] New onboarding headline

                ## Release checklist
                1. Bump the version and build number
                2. Write the release notes
                3. Send the build to beta testers
                4. Watch crash reports for two days
                """, updatedAt: c.hoursAgo(2)),
            DemoNote(path: "Pebble/Crash investigation.md", content: """
                Opening a shared album from a notification crashed the app.

                **Cause:** the notification router opened the album screen before the album had synced, and a force unwrap failed.

                **Fix:** wait for the album (up to 10 seconds), then show a friendly error. Pull request #318.
                """, updatedAt: c.minutesAgo(40)),
            DemoNote(path: "Pebble/Ideas.md", content: """
                - Shared album invites by QR code
                - A yearly recap video
                - Widgets for the most recent album
                """, updatedAt: c.daysAgo(5)),
            DemoNote(path: "Home/Kitchen remodel.md", content: """
                **Budget:** 18,000 with 15% held back for surprises.

                ## To do
                - [x] Measure the counters
                - [ ] Three quotes for the counters (two in)
                - [ ] Book the plumber for the dishwasher line
                - [ ] Pick the cabinet handles

                ## Notes
                Counter Works quoted 2,950 for quartz with a four week lead time.
                """, updatedAt: c.hoursAgo(5)),
            DemoNote(path: "Home/Meal ideas.md", content: """
                - Sheet pan vegetables with chickpeas
                - Lemon pasta with peas
                - Slow cooker chili for Sunday
                """, updatedAt: c.daysAgo(1)),
            DemoNote(path: "Travel/October trip.md", content: """
                Three days on the coast.

                - **Day 1:** train in the morning, harbour walk at sunset
                - **Day 2:** cliff path, long lunch, the old lighthouse
                - **Day 3:** Saturday market, then home

                Packing: rain jacket, walking shoes, a good book.
                """, updatedAt: c.daysAgo(3)),
            DemoNote(path: "Journal/\(yesterday).md", content: """
                Good focus day. Finished the image cache upgrade review and got two counter quotes. Tomorrow: crash fix review and the dentist.
                """, updatedAt: c.hoursAgo(15)),
            DemoNote(path: "Reading list.md", content: """
                - A short mystery novel for the flight
                - A collection of travel essays
                - The article on habit tracking
                """, updatedAt: c.daysAgo(6)),
            DemoNote(path: "Inbox.md", content: """
                Quick captures to sort later.

                - Ask about a bigger sink
                - Look into a family photo book for the holidays
                """, updatedAt: c.hoursAgo(9)),
        ]
    }
}
