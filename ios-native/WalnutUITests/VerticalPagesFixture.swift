import Foundation

/// What `VerticalPagesSidewaysDragUITests` adds to `ChatPlaceFixtureServer`: every page that
/// should only scroll up and down, holding `WideText`'s shapes of the user's longest texts. Main's
/// chat history, its Threads (one long thread), its Tasks (a project whose team has two long
/// tasks), its Brief, three letters (one with a thread), a note, and the server info Settings
/// shows. Field names follow the server's routes and the app's decoders. Nothing here records
/// what the app sends; a write is answered and forgotten.
enum VerticalPagesFixture {
    static let threadID = "th-7e0000d1"
    static let letterIDs = ["letter-wide-1", "letter-wide-2", "letter-wide-3"]
    static let teamTaskIDs = ["task-wide-team", "task-wide-worker"]
    static let noteName = "top-thread-video-notes"
    static let notePath = "\(noteName).md"
    /// The words that start the newest message in Main's chat: the chat's marker.
    static let chatMarker = "Wide check from the fixture"

    static func at(_ minutesAgo: Double) -> String { WideText.isoAgo(minutesAgo) }

    // MARK: - Main's chat and its tasks

    static func options() -> ChatPlaceFixtureServer.Options {
        var options = ChatPlaceFixtureServer.Options()
        let time = { (minute: Int) in String(format: "2026-11-20T08:%02d:00.000Z", minute) }
        var rows: [[String: Any]] = []
        for i in 0..<3 {
            rows.append(ChatPlaceFixtureServer.historyRow(role: "user", text: WideText.followUp, at: time(i * 10)))
            rows.append(["role": "assistant", "text": "Bash", "timestamp": time(i * 10 + 1), "kind": "tool",
                         "detail": WideText.codeLine, "resultPreview": WideText.unbrokenPath + "\n" + WideText.pathThenCJK])
            rows.append(ChatPlaceFixtureServer.historyRow(role: "assistant", text: WideText.markdown, at: time(i * 10 + 2)))
        }
        rows.append(ChatPlaceFixtureServer.historyRow(
            role: "assistant", text: "\(chatMarker). " + WideText.plain + "\n\n" + WideText.taskRefSentence, at: time(40)))
        options.history = [ChatPlaceFixtureServer.mainSessionID: rows]
        options.tasks = teamTaskIDs.enumerated().map { i, id in
            var row = ChatPlaceFixtureServer.taskRow(id: id, title: WideText.threadTitle + " " + WideText.unbrokenPath, phase: "IN_PROGRESS")
            row["project"] = "Walnut"
            row["summary"] = WideText.plain
            row["user_status"] = i == 0
                ? ["state": "working", "now": WideText.plain, "at": at(10)]
                : ["state": "needs", "ask": WideText.followUp, "at": at(5)]
            return row
        }
        return options
    }

    /// Main with one project whose team holds the two long tasks, so Main's Tasks lists them.
    private static var orgTree: [String: Any] {
        ["tree": [
            "main": ["id": ChatPlaceFixtureServer.mainTaskID, "title": "Main", "phase": "IN_PROGRESS", "hasSession": true, "name": "Main"],
            "projects": [[
                "project": "Walnut", "counts": ["open": 2, "running": 1, "needsYou": 1, "waiting": 0],
                "teams": [["id": teamTaskIDs[0], "workers": [["id": teamTaskIDs[1]]]]],
            ]],
            "counts": ["open": 2, "running": 1, "needsYou": 1, "waiting": 0],
        ]]
    }

    // MARK: - Threads and Brief

    private static var thread: [String: Any] {
        [
            "id": threadID, "title": WideText.threadTitle,
            "state": "answered", "reply": WideText.markdown, "tasks": [ChatPlaceFixtureServer.askTaskID],
            "createdAt": at(90), "updatedAt": at(5), "shown": true,
            "messages": [[
                "id": "tm-0000000d01", "at": at(30), "via": "follow-up", "text": WideText.followUp,
                "answer": ["text": "Handed back with two changes:\n\n- **Folders**: \(WideText.pathThenCJK)\n- \(WideText.commitURLs)\n\n"
                    + WideText.taskRefSentence, "at": at(29)],
            ]],
        ]
    }

    /// The letter with the head that says how current it is (`fresh`), its words long too.
    private static var brief: [String: Any] {
        [
            "brief": ["text": "### Needs you\n- \(WideText.taskRefSentence)\n### Working\n\(WideText.markdown)\n### Waiting / snoozed\n- nothing",
                      "at": at(10)],
            "fresh": ["writtenAt": at(10), "moved": [] as [Any], "finished": [] as [Any], "newAsks": [] as [Any],
                      "stale": true, "words": "3 lines moved since " + WideText.pathThenCJK],
        ]
    }

    // MARK: - Inbox

    private static func letter(_ index: Int, read: Bool = false, detail: Bool = false) -> [String: Any] {
        let ms = Date().timeIntervalSince1970 * 1000
        let sender: [String: String] = [
            "sessionId": "sess-wide-sender", "sessionTitle": WideText.threadTitle, "taskId": WideText.taskId,
            "taskTitle": WideText.threadTitle + " " + WideText.unbrokenPath, "project": "Walnut",
        ]
        var row: [String: Any] = [
            "id": letterIDs[index], "subject": WideText.threadTitle, "type": index == 0 ? "action_required" : "info",
            "bodyFormat": "markdown", "textPreview": WideText.plain, "createdAt": ms - Double(index + 1) * 600_000,
            "read": read, "pinned": false, "archived": false,
        ]
        row["sender"] = sender
        if index == 0 {
            let actions: [[String: String]] = [["id": "ship", "label": "Ship it: " + WideText.pathThenCJK], ["id": "hold", "label": "Hold"]]
            row["actions"] = actions
        }
        if detail {
            func turn(_ from: String, _ text: String, msAgo: Double) -> [String: Any] { ["from": from, "text": text, "at": ms - msAgo] }
            row["body"] = WideText.markdown
            row["thread"] = [
                turn("agent", WideText.markdown, msAgo: 300_000),
                turn("human", WideText.followUp, msAgo: 200_000),
                turn("agent", WideText.taskRefSentence + " " + WideText.commitURLs, msAgo: 100_000),
            ] as [[String: Any]]
        }
        return row
    }

    // MARK: - Notes and Settings

    private static var noteTree: [String: Any] {
        ["tree": [
            ["name": "Projects", "path": "Projects", "type": "folder", "children": [
                ["name": "\(WideText.taskId)-\(noteName).md", "path": "Projects/\(WideText.taskId)-\(noteName).md", "type": "file", "kind": "note"],
            ]],
            ["name": notePath, "path": notePath, "type": "file", "kind": "note"],
        ]]
    }

    private static var noteContent: [String: Any] {
        ["content": "# \(WideText.threadTitle)\n\n\(WideText.markdown)", "contentHash": "wide-note-hash", "updatedAt": at(15)]
    }

    private static var serverConfig: [String: Any] {
        ["config": [
            "provider": ["type": "bedrock", "model": "claude-model-with-a-long-name-" + WideText.taskId],
            "agent": ["main_model": "claude-model-with-a-long-name-" + WideText.taskId],
            "hosts": [
                "host-a": ["label": "someone-dev-desktop-" + WideText.unbrokenPath.replacingOccurrences(of: "/", with: "-"), "enabled": true],
                "host-b": ["label": "home-mac-" + WideText.cjkThreadVideo, "enabled": true],
            ],
        ], "cloud": false]
    }

    // MARK: - Routes

    /// The routes on top of `ChatPlaceFixtureServer`'s; nil passes to its own.
    static func route(_ method: String, _ target: String) -> (Int, Any)? {
        let split = target.split(separator: "?", maxSplits: 1).map(String.init)
        let path = split.first ?? target
        let query = split.count > 1 ? split[1] : ""
        let v1 = "/api/v1"
        let main = "\(v1)/tasks/\(ChatPlaceFixtureServer.mainTaskID)"
        if method == "POST", path.hasPrefix("\(v1)/human-inbox/"), path.hasSuffix("/read"),
           let index = letterIDs.firstIndex(where: { path == "\(v1)/human-inbox/\($0)/read" }) {
            return (200, ["letter": letter(index, read: true, detail: true)])
        }
        guard method == "GET" else { return nil }
        switch path {
        case "\(main)/threads": return (200, ["threads": [thread], "closed_count": 0, "shown_count": 1])
        case "\(main)/brief": return (200, brief)
        case "\(v1)/org": return (200, orgTree)
        case "\(v1)/human-inbox":
            let archived = query.contains("archived=1")
            return (200, ["letters": archived ? [] : letterIDs.indices.map { letter($0) }, "unreadCount": archived ? 0 : letterIDs.count])
        case "\(v1)/notes": return (200, noteTree)
        case "\(v1)/favorites": return (200, ["notes": [] as [Any]])
        case "\(v1)/config": return (200, serverConfig)
        default:
            if let index = letterIDs.firstIndex(where: { path == "\(v1)/human-inbox/\($0)" }) {
                return (200, ["letter": letter(index, detail: true)])
            }
            if path.hasPrefix("\(v1)/notes/content/") { return (200, noteContent) }
            return nil
        }
    }
}
