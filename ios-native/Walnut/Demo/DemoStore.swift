import Foundation

// MARK: - The demo server's in-memory state
//
// Plain mutable value types, seeded from `DemoFixtures` and changed by the routes
// in `DemoServer`. Each one renders itself as the app's OWN wire model (`wire`),
// so a fixture is encoded by exactly the Codable the app decodes it with: a field
// the app renames or retypes breaks the demo's unit tests, not a reviewer's run.

struct DemoTask {
    var id: String
    var title: String
    var phase: String
    var priority: String
    var project: String
    var dueDate: String?
    var startDate: String?
    var endDate: String?
    var createdAt: String
    var updatedAt: String
    var completedAt: String?
    var pinned: Bool
    /// "focus" | "backlog" | "wait" | nil (= Satellite, the default pin tier).
    var focusTier: String?
    var tags: [String]?
    var summary: String?
    var description: String?
    var note: String?
    var sessionIds: [String] = []
    var parentId: String?
    var groupId: String?
    var starred = false
    /// Place on the pinned board, as the server's `pin_order`: a new pin takes
    /// max + 1 (the foot), an unpin drops it and closes the gap, a tier move
    /// keeps it. nil while unpinned.
    var pinOrder: Int? = nil

    /// The coarse status the projection derives from the phase.
    var status: String {
        switch phase {
        case "TODO": return "todo"
        case "COMPLETE": return "done"
        default: return "in_progress"
        }
    }

    var wire: WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: phase, priority: priority,
            project: project, dueDate: dueDate, createdAt: createdAt, updatedAt: updatedAt,
            completedAt: completedAt, starred: starred, pinned: pinned, tags: tags,
            summary: summary, startDate: startDate, endDate: endDate
        )
    }
}

struct DemoSession {
    var id: String
    var title: String
    var taskId: String?
    var host: String
    var processStatus: String
    var model: String
    var mode: String
    var startedAt: String
    var lastActiveAt: String
    var cwd: String
    var description: String?
    var transcript: [SessionTranscript.Message]
    var archived = false
    var humanNote: String? = nil
}

struct DemoConversation {
    var id: String
    var agentID: String
    var title: String?
    var pinned = false
    var updatedAt: String
    var messages: [ChatMessage]
}

struct DemoNote {
    /// Vault-relative, WITH the `.md` extension, which is how the real tree
    /// names a note (`Folder/Note.md`); the content routes accept it either way.
    var path: String
    var content: String
    var updatedAt: String

    /// A content hash (FNV-1a), so an unchanged note keeps its hash and a save
    /// that quotes an old one is a real conflict, as on the server.
    var contentHash: String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in content.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(format: "%016llx", hash)
    }
}

struct DemoRoutine {
    var job: RoutineJob
}

/// Everything the demo server knows. Guarded by `DemoServer`'s lock; never
/// touched from two threads at once.
struct DemoState {
    var tasks: [DemoTask] = []
    var sessions: [DemoSession] = []
    var folders: [TaskFolder] = []
    var conversations: [DemoConversation] = []
    var letters: [Letter] = []
    var notes: [DemoNote] = []
    var noteFolders: [String] = []
    var favorites: [String] = []
    var routines: [RoutineJob] = []
    /// Permission prompts a session is blocked on, by session id.
    var pendingPermissions: [String: PendingPermission] = [:]
    /// Side questions asked of a session, by session id.
    var sideQuestions: [String: [SideQuestion]] = [:]
    /// Reasoning effort per session (the model lives on the session).
    var sessionEfforts: [String: String] = [:]
    /// The chat's lane session (`DemoServer.laneSessionID`): its model, effort
    /// and permission mode.
    var chatModel = DemoFixtures.mainModel
    var chatEffort = DemoFixtures.defaultEffort
    var chatMode = "bypass"
    /// Channels with a scripted turn in flight, and the text streamed so far.
    var liveTurns: [String: String] = [:]
    /// The turn id of each chat turn in flight, by channel key.
    var liveTurnIDs: [String: String] = [:]
    /// Messages sent to a session while its turn runs, delivered in order after.
    var sessionQueue: [String: [String]] = [:]
    /// Bumped by every create so ids never collide inside one demo run.
    var serial = 0
    /// Apple Health (DemoServerHealth.swift): the Mac's store id, its pause
    /// switch, and how many times its data was deleted.
    var healthStoreId = "hs-demo"
    var healthPaused = false
    var healthDeletes = 0

    mutating func nextID(_ prefix: String) -> String {
        serial += 1
        return "\(prefix)-\(serial)-\(UUID().uuidString.prefix(6).lowercased())"
    }

    func taskIndex(_ id: String) -> Int? { tasks.firstIndex { $0.id == id } }
    func sessionIndex(_ id: String) -> Int? { sessions.firstIndex { $0.id == id } }
    func conversationIndex(_ id: String) -> Int? { conversations.firstIndex { $0.id == id } }
    func letterIndex(_ id: String) -> Int? { letters.firstIndex { $0.id == id } }
    func noteIndex(_ path: String) -> Int? { notes.firstIndex { $0.path == path } }

    // MARK: - Projections

    func wireSession(_ s: DemoSession) -> WalnutSession {
        let task = s.taskId.flatMap { id in tasks.first { $0.id == id } }
        let messageCount = s.transcript.filter { $0.kind == nil }.count
        return WalnutSession(
            id: s.id, title: s.title, taskId: s.taskId, taskTitle: task?.title,
            project: task.map { $0.project.isEmpty ? nil : $0.project } ?? nil,
            host: s.host, processStatus: s.processStatus, model: s.model, mode: s.mode,
            startedAt: s.startedAt, lastActiveAt: s.lastActiveAt,
            messageCount: messageCount, cwd: s.cwd,
            pinned: task?.pinned, focusTier: task?.focusTier, description: s.description
        )
    }

    /// Sessions newest first by last activity, the order the server's
    /// projection lists them in.
    var visibleSessions: [DemoSession] {
        sessions.filter { !$0.archived }.sorted { $0.lastActiveAt > $1.lastActiveAt }
    }

    /// The tier split `GET /focus/tasks` answers, as the server's `splitTiers`:
    /// every pinned task (a completed pin included, since completion no longer
    /// unpins) sorted by `pinOrder`, then bucketed by tier.
    var tierSplit: FocusTierResult {
        let pinned = tasks.enumerated()
            .filter { $0.element.pinned }
            .sorted { ($0.element.pinOrder ?? 0, $0.offset) < ($1.element.pinOrder ?? 0, $1.offset) }
            .map(\.element)
        func ids(_ tier: String?) -> [String] {
            pinned.filter { $0.focusTier == tier }.map(\.id)
        }
        return FocusTierResult(
            pinnedTasks: pinned.map(\.id),
            focusTasks: ids("focus"),
            satelliteTasks: ids(nil),
            backlogTasks: ids("backlog"),
            waitTasks: ids("wait"),
            customTierTasks: [:]
        )
    }

    /// Where the next pin goes: the foot of the pinned set (`nextPinOrder`).
    var nextPinOrder: Int {
        (tasks.filter(\.pinned).compactMap(\.pinOrder).max() ?? -1) + 1
    }

    /// Pin a task at the foot of the board. A task that is already pinned keeps
    /// its place, as the server's idempotent pin route does.
    mutating func pin(_ index: Int) {
        guard !tasks[index].pinned else { return }
        tasks[index].pinOrder = nextPinOrder
        tasks[index].pinned = true
    }

    /// Unpin a task and renumber the remaining pins 0..n-1 in their order.
    mutating func unpin(_ index: Int) {
        tasks[index].pinned = false
        tasks[index].pinOrder = nil
        tasks[index].focusTier = nil
        let order = tierSplit.pinnedTasks
        for (slot, id) in order.enumerated() {
            if let i = taskIndex(id) { tasks[i].pinOrder = slot }
        }
    }

    /// Folder membership, rebuilt from each task's `groupId`.
    var wireFolders: [TaskFolder] {
        folders.map { folder in
            TaskFolder(
                groupId: folder.groupId, label: folder.label, hidden: folder.hidden,
                memberIds: tasks.filter { $0.groupId == folder.groupId }.map(\.id),
                project: folder.project, parentId: folder.parentId
            )
        }
    }

    func taskDetail(_ t: DemoTask) -> TaskDetail {
        func relative(_ other: DemoTask) -> TaskDetail.Relative {
            TaskDetail.Relative(id: other.id, title: other.title, phase: other.phase, status: other.status)
        }
        let parent = t.parentId.flatMap { id in tasks.first { $0.id == id } }.map(relative)
        let children = tasks.filter { $0.parentId == t.id }.map(relative)
        return TaskDetail(
            id: t.id, title: t.title, status: t.status, phase: t.phase, priority: t.priority,
            project: t.project, description: t.description, summary: t.summary, note: t.note,
            tags: t.tags, starred: false, pinned: t.pinned, dependsOn: [], isBlocked: false,
            resolvedDependencies: [], dependents: [], children: children, parent: parent,
            sessionIds: t.sessionIds
        )
    }

    /// The notes vault as the nested tree `GET /notes` answers.
    var noteTree: [NoteTreeNode] {
        func build(prefix: String) -> [NoteTreeNode] {
            var folderNames: [String] = []
            var files: [NoteTreeNode] = []
            let allFolders = Set(noteFolders + notes.flatMap { note -> [String] in
                let parts = note.path.split(separator: "/").map(String.init)
                return (1..<max(parts.count, 1)).map { parts.prefix($0).joined(separator: "/") }
            })
            for folder in allFolders {
                let parent = folder.split(separator: "/").dropLast().joined(separator: "/")
                if parent == prefix { folderNames.append(folder) }
            }
            for note in notes {
                let parent = note.path.split(separator: "/").dropLast().joined(separator: "/")
                guard parent == prefix else { continue }
                let name = String(note.path.split(separator: "/").last ?? "")
                files.append(NoteTreeNode(
                    name: name, path: note.path, type: .file, kind: "note", children: nil
                ))
            }
            let folders = folderNames.sorted().map { path -> NoteTreeNode in
                let name = String(path.split(separator: "/").last ?? "")
                return NoteTreeNode(name: name, path: path, type: .folder, kind: nil, children: build(prefix: path))
            }
            return folders + files.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        return build(prefix: "")
    }
}
