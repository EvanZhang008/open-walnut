import Foundation

/// What `ThreadPushLiveUITests` adds to `ChatPlaceFixtureServer`: an Org with one VP ("Growth
/// lead", shown as Growth VP) that has a chat, fourteen open threads for the user (the newest one
/// waiting on him, the rest answered, so the list runs several screens), one worker with a
/// session under it for the Tasks view, and a Brief. Field names follow the server's routes
/// (`src/web/routes/org-threads-v1.ts`, `brief-v1.ts`, `api-v1.ts`) and the app's decoders. The
/// data never changes: a push names a thread that is already on the page.
enum OrgThreadsFixture {
    static let vpTaskID = "task-fixture-vp"
    static let vpSessionID = "sess-fixture-vp"
    static let vpTitle = "Growth lead"
    /// What the app calls it (`TaskMentions.shownTitle`: a lead's " lead" reads " VP").
    static let vpName = "Growth VP"
    static let workerTaskID = "task-fixture-worker"
    static let workerSessionID = "sess-fixture-worker"
    static let workerTitle = "Draft the launch post"

    /// Newest first, the order the page shows them in. Ids follow `THREAD_ID_RE`.
    static let threadIDs: [String] = (0..<14).map { String(format: "th-7e%06lx", 0xa0 + $0) }

    /// A thread closed weeks ago, past the newest closed ones a list read brings: no list holds
    /// it, but the server answers it by its id.
    static let oldClosedThreadID = "th-7e0000c0"
    static let oldClosedTitle = "Last quarter's roadmap"

    /// A second VP with a chat and threads of its own ("Design lead", shown as Design VP).
    static let vp2TaskID = "task-fixture-vp2"
    static let vp2SessionID = "sess-fixture-vp2"
    static let vp2Title = "Design lead"
    static let vp2Name = "Design VP"
    static let vp2ThreadIDs: [String] = (0..<6).map { String(format: "th-7f%06lx", 0xb0 + $0) }

    /// A VP the phone holds no chat row for, whose task the server answers slowly
    /// (`slowAnswer`): a push for it waits on that read.
    static let slowTaskID = "task-fixture-slow"
    static let slowSessionID = "sess-fixture-slow"
    static let slowTitle = "Support lead"
    static let slowSeconds: TimeInterval = 5

    /// `ChatPlaceFixtureServer.answerDelay`: the slow VP's task read waits.
    static func slowAnswer(method: String, path: String) -> TimeInterval {
        path == "/api/v1/tasks/\(slowTaskID)" ? slowSeconds : 0
    }

    /// How long a Follow up's send waits for its receipt under `slowSend`.
    static let sendSeconds: TimeInterval = 6

    /// `slowAnswer`, and a message sent into the VP's chat (a Follow up) gets its receipt late.
    static func slowSend(method: String, path: String) -> TimeInterval {
        if method == "POST", path == "/api/v1/sessions/\(vpSessionID)/messages" { return sendSeconds }
        return slowAnswer(method: method, path: path)
    }

    /// The defaults the Memory & instructions sheet reads before it lets him type.
    static let defaultLeadInstructions = "Run the team, decide what is yours to decide."
    private static let vp2Titles = [
        "Pick the icon set", "Colors for dark mode", "Review the onboarding screens",
        "Font licence", "Hand-off notes for the web team", "Illustrations for the store page",
    ]

    private static let titles = [
        "Approve the launch post", "Pricing page copy", "Which beta testers to invite",
        "Status of the onboarding emails", "Logo files for the press kit", "Weekly numbers",
        "Move the demo to Thursday", "Feedback from the design review", "Budget for ads",
        "The FAQ draft", "Partner intro list", "Screenshots for the store page",
        "Survey results", "Next month's plan",
    ]

    private static func at(_ minutesAgo: Int) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-Double(minutesAgo) * 60))
    }

    static func thread(_ i: Int) -> [String: Any] {
        let id = threadIDs[i]
        let asked = at(30 + i * 20)
        let answered = at(20 + i * 20)
        var t: [String: Any] = [
            "id": id, "title": titles[i], "state": i == 0 ? "needs" : "answered",
            "reply": "Latest: the team looked at \(titles[i].lowercased()) today and wrote down what is left. "
                + "Background: you asked for this last week.",
            "messages": [[
                "id": "msg-\(id)", "at": asked, "text": "Where are we on \(titles[i].lowercased())?", "via": "chat",
                "answer": ["text": "Here is where it stands. Two parts are done and one waits on a reply.", "at": answered],
            ]],
            "createdAt": asked, "updatedAt": answered, "shown": true,
        ]
        if i == 0 {
            t["ask"] = "Say yes or no to the launch post so it can go out."
            t["tasks"] = [workerTaskID]
        }
        return t
    }

    private static func sessionRow(_ id: String, task: String, title: String) -> [String: Any] {
        [
            "id": id, "title": title, "task_id": task, "task_title": title, "host": "",
            "process_status": "idle", "started_at": at(600), "last_active_at": at(5), "message_count": 2,
        ]
    }

    private static func sessionDetail(_ id: String, task: String, title: String) -> [String: Any] {
        [
            "session": [
                "claudeSessionId": id, "taskId": task, "title": title, "process_status": "idle",
                "host": "", "startedAt": at(600), "lastActiveAt": at(5), "messageCount": 2,
            ],
            "pendingPermissions": [] as [Any],
        ]
    }

    static func vp2Thread(_ i: Int) -> [String: Any] {
        let id = vp2ThreadIDs[i]
        let asked = at(40 + i * 25)
        return [
            "id": id, "title": vp2Titles[i], "state": i == 0 ? "needs" : "answered",
            "reply": "Latest: the design team has a first pass of \(vp2Titles[i].lowercased()). Background: asked this week.",
            "messages": [[
                "id": "msg-\(id)", "at": asked, "text": "How is \(vp2Titles[i].lowercased()) going?", "via": "chat",
                "answer": ["text": "A first pass is ready for you to look at.", "at": at(30 + i * 25)],
            ]],
            "createdAt": asked, "updatedAt": at(30 + i * 25), "shown": true,
        ]
    }

    static var oldClosedThread: [String: Any] {
        let asked = at(60 * 24 * 40)
        return [
            "id": oldClosedThreadID, "title": oldClosedTitle, "state": "answered",
            "reply": "Closed: the roadmap went out to the team.",
            "messages": [[
                "id": "msg-\(oldClosedThreadID)", "at": asked, "text": "Send the roadmap round.", "via": "chat",
                "answer": ["text": "Sent to everyone.", "at": at(60 * 24 * 39)],
            ]],
            "closed": ["how": "acked", "at": at(60 * 24 * 38), "by": "human"],
            "createdAt": asked, "updatedAt": at(60 * 24 * 38), "shown": false,
        ]
    }

    private static var vp2Row: [String: Any] {
        [
            "id": vp2TaskID, "title": vp2Title, "status": "in_progress", "phase": "IN_PROGRESS",
            "priority": "none", "project": "Design", "org_role": "lead",
            "created_at": at(6000), "updated_at": at(6),
            "user_status": [
                "state": "waiting", "waitingOn": "its teams", "at": at(6),
                "threads": ["shown": vp2ThreadIDs.count, "needs": 1, "title": vp2Titles[0], "id": vp2ThreadIDs[0]],
            ],
        ]
    }

    private static var vpRow: [String: Any] {
        [
            "id": vpTaskID, "title": vpTitle, "status": "in_progress", "phase": "IN_PROGRESS",
            "priority": "none", "project": "Growth", "org_role": "lead",
            "created_at": at(6000), "updated_at": at(5),
            "user_status": [
                "state": "waiting", "waitingOn": "its teams", "at": at(5),
                "threads": ["shown": threadIDs.count, "needs": 1, "title": titles[0], "id": threadIDs[0]],
            ],
        ]
    }

    private static var workerRow: [String: Any] {
        [
            "id": workerTaskID, "title": workerTitle, "status": "in_progress", "phase": "IN_PROGRESS",
            "priority": "none", "project": "Growth", "parent_task_id": vpTaskID,
            "created_at": at(3000), "updated_at": at(10),
            "user_status": ["state": "working", "now": "Writing the second draft", "at": at(10)],
        ]
    }

    private static func detail(_ id: String, title: String, session: String, role: String?) -> [String: Any] {
        var t: [String: Any] = [
            "id": id, "title": title, "phase": "IN_PROGRESS", "status": "in_progress", "priority": "none",
            "project": "Growth", "session_ids": [session], "session_id": session,
        ]
        if let role { t["org_role"] = role }
        return ["task": t]
    }

    /// `ChatPlaceFixtureServer.extraRoute`: these answers first, everything else as before.
    static func route(method: String, path: String) -> (Int, Any)? {
        let v1 = "/api/v1"
        guard path.hasPrefix(v1) else { return nil }
        let p = String(path.dropFirst(v1.count))
        // A message into a chat (a Follow up): its receipt.
        if method == "POST", p.hasPrefix("/sessions/"), p.hasSuffix("/messages") {
            return (200, ["messageId": "msg-fixture-\(UUID().uuidString.prefix(8))", "queued": false])
        }
        guard method == "GET" else { return nil }
        let vp = "/tasks/\(vpTaskID)"
        switch p {
        case "/tasks":
            return (200, ["tasks": [vpRow, workerRow, vp2Row], "syncedAt": at(0)])
        case vp:
            return (200, detail(vpTaskID, title: vpTitle, session: vpSessionID, role: "lead"))
        case "/tasks/\(vp2TaskID)":
            return (200, detail(vp2TaskID, title: vp2Title, session: vp2SessionID, role: "lead"))
        case "/tasks/\(vp2TaskID)/threads":
            return (200, ["threads": vp2ThreadIDs.indices.map(vp2Thread), "closed_count": 0, "shown_count": vp2ThreadIDs.count])
        case "/tasks/\(slowTaskID)":
            return (200, detail(slowTaskID, title: slowTitle, session: slowSessionID, role: "lead"))
        case "/tasks/\(slowTaskID)/threads":
            return (200, ["threads": [] as [Any], "closed_count": 0, "shown_count": 0])
        case "/sessions/\(slowSessionID)":
            return (200, sessionDetail(slowSessionID, task: slowTaskID, title: slowTitle))
        case "/tasks/\(vp2TaskID)/brief":
            return (200, ["brief": ["text": "### Needs you\n- \(vp2Titles[0])\n### Working\n- nothing\n### Waiting / snoozed\n- nothing", "at": at(20)]])
        case "/tasks/\(workerTaskID)":
            return (200, detail(workerTaskID, title: workerTitle, session: workerSessionID, role: nil))
        case "\(vp)/threads":
            return (200, ["threads": threadIDs.indices.map(thread), "closed_count": 0, "shown_count": threadIDs.count])
        case "\(vp)/brief":
            return (200, ["brief": [
                "text": "### Needs you\n- \(titles[0]): say yes or no.\n### Working\n- \(workerTitle)\n### Waiting / snoozed\n- nothing",
                "at": at(15),
            ]])
        case "/org/settings":
            return (200, ["defaultInstructions": ["main": "Lead the org.", "lead": defaultLeadInstructions]])
        case "/tasks/\(vpTaskID)/agent-memory", "/tasks/\(vp2TaskID)/agent-memory":
            return (200, ["memory": NSNull(), "chars": 0, "soft_limit": 4000, "limit": 8000])
        case "/org":
            return (200, ["tree": [
                "main": ["id": ChatPlaceFixtureServer.mainTaskID, "title": "Main", "phase": "IN_PROGRESS", "hasSession": true, "name": "Main"],
                "projects": [[
                    "project": "Growth",
                    "lead": ["id": vpTaskID, "title": vpTitle, "phase": "IN_PROGRESS", "hasSession": true, "name": vpName],
                    "counts": ["open": 1, "running": 1, "needsYou": 0, "waiting": 0],
                    "teams": [["id": workerTaskID]],
                ], [
                    "project": "Design",
                    "lead": ["id": vp2TaskID, "title": vp2Title, "phase": "IN_PROGRESS", "hasSession": true, "name": vp2Name],
                    "counts": ["open": 0, "running": 0, "needsYou": 0, "waiting": 0],
                    "teams": [] as [Any],
                ]],
                "counts": ["open": 1, "running": 1, "needsYou": 0, "waiting": 0],
            ]])
        case "/sessions":
            return (200, ["syncedAt": at(0), "sessions": [
                sessionRow(ChatPlaceFixtureServer.mainSessionID, task: ChatPlaceFixtureServer.mainTaskID, title: "Main"),
                sessionRow(ChatPlaceFixtureServer.askSessionID, task: ChatPlaceFixtureServer.askTaskID, title: "Compare two laptops"),
                sessionRow(vpSessionID, task: vpTaskID, title: vpTitle),
                sessionRow(workerSessionID, task: workerTaskID, title: workerTitle),
                sessionRow(vp2SessionID, task: vp2TaskID, title: vp2Title),
            ]])
        case "/sessions/\(vpSessionID)":
            return (200, sessionDetail(vpSessionID, task: vpTaskID, title: vpTitle))
        case "/sessions/\(workerSessionID)":
            return (200, sessionDetail(workerSessionID, task: workerTaskID, title: workerTitle))
        case "/sessions/\(vp2SessionID)":
            return (200, sessionDetail(vp2SessionID, task: vp2TaskID, title: vp2Title))
        default:
            if p.hasPrefix("\(vp)/threads/") {
                let id = String(p.dropFirst("\(vp)/threads/".count))
                if id == oldClosedThreadID { return (200, ["thread": oldClosedThread]) }
                guard let i = threadIDs.firstIndex(of: id) else { return nil }
                return (200, ["thread": thread(i)])
            }
            if p.hasPrefix("/tasks/\(vp2TaskID)/threads/") {
                let id = String(p.dropFirst("/tasks/\(vp2TaskID)/threads/".count))
                guard let i = vp2ThreadIDs.firstIndex(of: id) else { return nil }
                return (200, ["thread": vp2Thread(i)])
            }
            return nil
        }
    }
}
