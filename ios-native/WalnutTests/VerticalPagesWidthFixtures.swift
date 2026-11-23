import Foundation
@testable import Walnut

/// The data `VerticalPagesWidthTests` lays each page out with: every row, card and body holds
/// `WideText`'s shapes of the user's longest real texts.
enum VerticalPagesWidthFixtures {
    static let vpTaskId = "task-fixture-vp"
    static let name = "Growth VP"

    // MARK: - Org Threads

    /// The 2026-11-15 report's shape, kept from the first Threads width test: a wide table, a
    /// 160-character run, a long URL and a code line.
    private static let legacyURL = "https://example.com/a/very/long/address/without/any/spaces/" + String(repeating: "segment-", count: 12) + "end"
    private static var legacyReply: String {
        """
        Shipped: the router settings now open in one dialog in the middle of the screen. \(WideText.cjkAllLive)\u{FF1A}router

        - Open the dialog, the folders load, tick two, save, open again: \(WideText.path)
        - \(legacyURL)
        - \(String(repeating: "x", count: 160))

        ```
        walnut tools call task_send '{"in_reply_to":"rq-7a39ea3b2791","title":"\(String(repeating: "long ", count: 30))"}'
        ```

        | Video | Path | Note |
        |---|---|---|
        | folders | \(WideText.path) | \(String(repeating: "wide ", count: 20)) |
        """
    }

    static let closedThreadId = "th-7e0000a5"

    /// One thread in every place the page lists: two open (answered, needs), one snoozed, one in
    /// progress, one closed. Each has the long title, the long summary and a follow-up with its answer.
    static func threads() throws -> [OrgThread] {
        let at = WideText.isoAgo
        func thread(_ id: String, _ state: String, reply: String, extra: [String: Any] = [:]) -> [String: Any] {
            var t: [String: Any] = [
                "id": id, "title": WideText.threadTitle, "state": state, "reply": reply,
                "tasks": [WideText.taskId, "51f06886-908d-5ed0-a367-2c2f05e6d7b7"],
                "createdAt": at(90), "updatedAt": at(5),
                "messages": [[
                    "id": "tm-\(id.suffix(8))01", "at": at(30), "via": "follow-up", "text": WideText.followUp,
                    "answer": ["text": "Handed back to <task-ref id=\"\(WideText.taskId)\"/>. Two changes:\n\n- **Folders**: "
                        + WideText.pathThenCJK + "\n- " + WideText.commitURLs + "\n\n" + WideText.taskRefSentence, "at": at(29)],
                ]],
            ]
            t.merge(extra) { $1 }
            return t
        }
        let all: [[String: Any]] = [
            thread("th-7e0000a1", "answered", reply: WideText.markdown, extra: ["shown": true]),
            thread("th-7e0000a2", "needs", reply: legacyReply, extra: ["shown": true]),
            thread("th-7e0000a3", "answered", reply: WideText.markdown,
                   extra: ["shown": false, "snoozed": ["until": WideText.isoAgo(-600), "at": at(1)]]),
            thread("th-7e0000a4", "working", reply: WideText.plain, extra: ["shown": false]),
            thread(closedThreadId, "answered", reply: WideText.markdown,
                   extra: ["closed": ["how": "done", "at": at(2), "by": "human"]]),
        ]
        let data = try JSONSerialization.data(withJSONObject: all)
        return try JSONDecoder().decode([OrgThread].self, from: data)
    }

    // MARK: - Org Tasks

    /// A VP leading one project with two teams and a worker, as `OrgNodeTasksModelTests` builds it.
    static func tree() throws -> OrgTreeWire {
        let json = #"""
        {"main":{"id":"ceo","title":"Main","phase":"IN_PROGRESS"},
         "projects":[
          {"project":"Walnut","lead":{"id":"vp","title":"Walnut lead","phase":"IN_PROGRESS"},"counts":{"open":4,"running":1,"needsYou":1,"waiting":1},
           "teams":[{"id":"a","workers":[{"id":"a1"}]},{"id":"b"},{"id":"c"},{"id":"vp"}]}],
         "counts":{"open":4,"running":1,"needsYou":1,"waiting":1}}
        """#
        return try JSONDecoder().decode(OrgTreeWire.self, from: Data(json.utf8))
    }

    static func task(_ id: String, phase: String = "IN_PROGRESS", status: String = "in_progress",
                     user: WalnutUserStatus? = nil, completed: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: "\(WideText.threadTitle) \(WideText.unbrokenPath)", status: status, phase: phase, priority: "none",
            project: "Walnut", dueDate: nil, createdAt: WideText.isoAgo(600), updatedAt: WideText.isoAgo(20), completedAt: completed,
            starred: nil, pinned: nil, tags: nil, summary: WideText.plain, parentTaskId: nil, userStatus: user
        )
    }

    /// One row in each status section, every line the long one.
    static func teamTasks() -> [WalnutTask] {
        [
            task("a", user: .init(state: "working", now: WideText.plain)),
            task("a1", user: .init(state: "needs", ask: WideText.followUp)),
            task("b", phase: "WAITING", user: .init(state: "waiting", kind: "time", waitingOn: WideText.pathThenCJK)),
            task("c", phase: "COMPLETE", status: "done", completed: WideText.isoAgo(60)),
        ]
    }

    // MARK: - Brief

    static func brief() -> OrgBriefReply {
        let text = "### Needs you\n- " + WideText.taskRefSentence + "\n### Working\n" + WideText.markdown
            + "\n### Waiting\n- " + WideText.unbrokenPath
        let fresh = OrgBriefReply.Fresh(writtenAt: WideText.isoAgo(10), moved: [], finished: [], newAsks: [], stale: true,
                                        words: "3 lines moved since " + WideText.pathThenCJK)
        return OrgBriefReply(brief: .init(text: text, at: WideText.isoAgo(10)), fresh: fresh)
    }

    // MARK: - Inbox and a letter

    static let letterId = "letter-wide-1"

    static func letters() throws -> [Letter] {
        let ms = Date().timeIntervalSince1970 * 1000
        let sender: [String: String] = [
            "sessionId": "sess-wide-sender", "sessionTitle": WideText.threadTitle, "taskId": WideText.taskId,
            "taskTitle": WideText.threadTitle + " " + WideText.unbrokenPath, "project": "Walnut",
        ]
        func letter(_ id: String, type: String, minutesAgo: Double, extra: [String: Any] = [:]) -> [String: Any] {
            var json: [String: Any] = [
                "id": id, "subject": WideText.threadTitle, "type": type, "bodyFormat": "markdown",
                "textPreview": WideText.plain, "createdAt": ms - minutesAgo * 60_000,
                "read": false, "pinned": id == letterId, "archived": false, "taskRefs": [WideText.taskId],
            ]
            json["sender"] = sender
            json.merge(extra) { $1 }
            return json
        }
        func turn(_ from: String, _ text: String, minutesAgo: Double) -> [String: Any] {
            ["from": from, "text": text, "at": ms - minutesAgo * 60_000]
        }
        let actions: [[String: String]] = [["id": "ship", "label": "Ship it: " + WideText.pathThenCJK], ["id": "hold", "label": "Hold"]]
        let thread: [[String: Any]] = [
            turn("agent", WideText.markdown, minutesAgo: 4),
            turn("human", WideText.followUp, minutesAgo: 3),
            turn("agent", WideText.taskRefSentence + " " + WideText.commitURLs, minutesAgo: 2),
        ]
        let first = letter(letterId, type: "action_required", minutesAgo: 5,
                           extra: ["body": WideText.markdown, "actions": actions, "thread": thread])
        let rows: [[String: Any]] = [
            first,
            letter("letter-wide-2", type: "info", minutesAgo: 30, extra: ["body": WideText.plain]),
            letter("letter-wide-3", type: "review", minutesAgo: 90),
        ]
        let data = try JSONSerialization.data(withJSONObject: rows)
        return try JSONDecoder().decode([Letter].self, from: data)
    }

    // MARK: - A session

    static func transcript() -> SessionTranscript {
        var messages: [SessionTranscript.Message] = []
        for i in 0..<4 {
            let ts = String(format: "2026-11-20T08:%02d:00Z", i * 5)
            let later = String(format: "2026-11-20T08:%02d:30Z", i * 5)
            messages.append(.init(role: "user", text: WideText.followUp, timestamp: ts, kind: nil))
            messages.append(.init(role: "assistant", text: "Bash", timestamp: later, kind: "tool",
                                  detail: WideText.codeLine, resultPreview: WideText.unbrokenPath + "\n" + WideText.pathThenCJK))
            messages.append(.init(role: "assistant", text: WideText.markdown, timestamp: later, kind: nil))
            messages.append(.init(role: "assistant", text: WideText.plain + "\n\n" + WideText.taskRefSentence, timestamp: later, kind: nil))
        }
        return SessionTranscript(sessionId: "scripted-test-session", exportedAt: "2026-11-20T09:00:00Z", truncated: false,
                                 messages: messages)
    }

    // MARK: - Notes

    static let notePath = "Projects/\(WideText.cjkThreadVideo) \(WideText.taskId) top-thread-video-and-the-letter-reader-notes.md"

    static func noteTree() -> [NoteTreeNode] {
        let note = NoteTreeNode(name: (notePath as NSString).lastPathComponent, path: notePath, type: .file, kind: "note", children: nil)
        let longName = "\(WideText.cjkComplaint)-\(WideText.unbrokenPath.replacingOccurrences(of: "/", with: "-")).md"
        return [
            NoteTreeNode(name: "Projects", path: "Projects", type: .folder, kind: nil, children: [note]),
            NoteTreeNode(name: longName, path: longName, type: .file, kind: "note", children: nil),
            NoteTreeNode(name: "Daily.md", path: "Daily.md", type: .file, kind: "note", children: nil),
        ]
    }

    static var noteContent: NoteContent {
        NoteContent(content: "# " + WideText.threadTitle + "\n\n" + WideText.markdown, contentHash: "wide-note-hash",
                    updatedAt: WideText.isoAgo(15))
    }

    // MARK: - A task

    static func taskDetail() -> TaskDetail {
        TaskDetail(
            id: WideText.taskId, title: WideText.threadTitle, status: "in_progress", phase: "IN_PROGRESS",
            priority: "none", project: "Walnut \(WideText.cjkThreadVideo)", description: WideText.markdown,
            summary: WideText.plain, note: WideText.markdown, tags: [WideText.unbrokenPath], starred: nil, pinned: nil,
            dependsOn: nil, isBlocked: nil, resolvedDependencies: nil, dependents: nil,
            children: [.init(id: "child-1", title: WideText.threadTitle + WideText.unbrokenPath, phase: "TODO", status: "todo")],
            parent: .init(id: "parent-1", title: WideText.pathThenCJK, phase: "IN_PROGRESS", status: "in_progress"),
            sessionIds: nil
        )
    }
}
