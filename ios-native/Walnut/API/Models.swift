import Foundation

// MARK: - Models for the frozen /api/v1 REST+SSE contract (docs/api-v1.md)

struct ServerStatus: Codable, Equatable {
    enum Mode: String, Codable {
        case live = "LIVE"
        case replica = "REPLICA"
    }

    let mode: Mode
    let cloud: Bool
    let version: String
    let serverTime: String
    let lastSyncAt: String?
}

struct ConversationSummary: Codable, Identifiable, Equatable {
    let id: String
    let title: String?
    let updatedAt: String
    let messageCount: Int
}

/// One console agent from GET /api/v1/agents (additive endpoint).
struct AgentSummary: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let isMain: Bool
}

/// One image attached to an outgoing message. Base64 JPEG/PNG bytes + its media
/// type — the additive `images` field on the two message POST endpoints.
struct ImagePayload: Codable, Equatable {
    let data: String       // raw base64
    let mediaType: String  // "image/jpeg", "image/png", …
}

struct ChatMessage: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case tool
        case thinking
        case notification
    }

    let id: String
    let role: String // "user" | "assistant"
    let text: String
    let createdAt: String
    let kind: Kind?
    /// Notification provenance ("session-error", "cron", …) — drives card styling.
    let source: String?

    // Client-only flags for optimistic user bubbles (not part of the wire format).
    var pending: Bool? = nil
    /// Send failed — the bubble stays in the timeline (tap to retry / copy /
    /// delete) so composed text is never lost to a network error.
    var failed: Bool? = nil
    /// Client-only thumbnails (JPEG datas) for images the user attached to THIS
    /// message. Local to the current app session — server history carries no
    /// image references, so historical messages never show these. Excluded from
    /// Codable so it never rides the wire or the disk cache.
    var localImages: [Data]? = nil

    private enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, kind, source
    }

    init(id: String, role: String, text: String, createdAt: String, kind: Kind?, source: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.kind = kind
        self.source = source
    }

    var isUser: Bool { role == "user" }
}

struct NoteTreeNode: Codable, Identifiable, Equatable {
    enum NodeType: String, Codable {
        case file
        case folder
    }

    let name: String
    let path: String
    let type: NodeType
    let kind: String? // "note" | "attachment" (files only)
    let children: [NoteTreeNode]?

    var id: String { path }
    var isAttachment: Bool { kind == "attachment" }
}

struct NoteContent: Codable {
    let content: String
    let contentHash: String
    let updatedAt: String
}

struct NoteWriteResult: Codable {
    let contentHash: String
    let updatedAt: String
}

// MARK: - Notes search (/api/notes-v2/search)

struct NoteSearchResult: Codable, Identifiable, Equatable {
    let id: String
    let path: String
    let title: String
    /// May contain `<mark>` tags around query matches.
    let snippet: String
    let matchType: String
}

struct NoteSearchResponse: Codable {
    let results: [NoteSearchResult]
    let degraded: String?
}

// MARK: - Favorites (/api/favorites — the bookmark store shared with the web UI)

struct FavoritesResponse: Codable {
    let notes: [String]
}

// MARK: - Attachment upload (/api/notes-v2/attachment — flat error shape, not v1)

struct AttachmentUploadBody: Codable {
    let notePath: String
    let data: String
    let mediaType: String
}

struct AttachmentUploadResult: Codable {
    let ok: Bool
    let path: String
    let name: String
}

/// This endpoint's error body is `{error: string}`, not the v1 `{error:{code,message}}` envelope.
struct FlatErrorEnvelope: Codable {
    let error: String
}

// MARK: - Tasks (read-only /api/v1/tasks projection)

/// One task from the frozen projection. All timestamps are ISO-8601 strings
/// (decoded lazily to `Date` via the computed helpers below) to match the rest
/// of this file, which keeps wire dates as strings and parses on demand.
struct WalnutTask: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let status: String   // "todo" | "in_progress" | "done"
    let phase: String     // "TODO" | "IN_PROGRESS" | "AGENT_COMPLETE" | …
    let priority: String  // "immediate" | "important" | "backlog" | "none"
    let category: String
    let project: String
    let dueDate: String?
    // Optional: pre-migration tasks in the projection can lack these stamps.
    let createdAt: String?
    let updatedAt: String?
    let completedAt: String?
    let starred: Bool?
    let pinned: Bool?
    let tags: [String]?
    let summary: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, status, phase, priority, category, project
        case dueDate = "due_date"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
        case starred, pinned, tags, summary
    }
}

struct TasksResponse: Codable {
    let tasks: [WalnutTask]
    let syncedAt: String
}

/// Coarse status used for the circle indicator and the smart-list filters.
enum TaskStatus {
    case todo, inProgress, done, unknown
    init(_ raw: String) {
        switch raw {
        case "todo": self = .todo
        case "in_progress": self = .inProgress
        case "done": self = .done
        default: self = .unknown
        }
    }
}

/// Priority, with a rank for section sorting (lower = higher priority).
enum TaskPriority {
    case immediate, important, backlog, none, unknown
    init(_ raw: String) {
        switch raw {
        case "immediate": self = .immediate
        case "important": self = .important
        case "backlog": self = .backlog
        case "none": self = .none
        default: self = .unknown
        }
    }

    var sortRank: Int {
        switch self {
        case .immediate: return 0
        case .important: return 1
        case .backlog: return 2
        case .none, .unknown: return 3
        }
    }
}

extension WalnutTask {
    /// ISO-8601 parse tolerant of fractional seconds (same shape as NotesStore).
    static func parseISO(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    var statusKind: TaskStatus { TaskStatus(status) }
    var priorityKind: TaskPriority { TaskPriority(priority) }
    var isDone: Bool { statusKind == .done }

    var dueDateValue: Date? { Self.parseISO(dueDate) }
    var createdAtValue: Date? { Self.parseISO(createdAt) }
    var updatedAtValue: Date? { Self.parseISO(updatedAt) }
    var completedAtValue: Date? { Self.parseISO(completedAt) }

    /// Due before the start of today (and still open).
    var isOverdue: Bool {
        guard !isDone, let due = dueDateValue else { return false }
        return due < Calendar.current.startOfDay(for: Date())
    }

    var isDueToday: Bool {
        guard let due = dueDateValue else { return false }
        return Calendar.current.isDateInToday(due)
    }

    /// Open-task order: pinned first, then priority, then most-recently updated.
    static func openSort(_ a: WalnutTask, _ b: WalnutTask) -> Bool {
        let ap = a.pinned == true, bp = b.pinned == true
        if ap != bp { return ap }
        if a.priorityKind.sortRank != b.priorityKind.sortRank {
            return a.priorityKind.sortRank < b.priorityKind.sortRank
        }
        return (a.updatedAtValue ?? .distantPast) > (b.updatedAtValue ?? .distantPast)
    }

    /// Done-task order: most-recently completed first.
    static func doneSort(_ a: WalnutTask, _ b: WalnutTask) -> Bool {
        (a.completedAtValue ?? a.updatedAtValue ?? .distantPast)
            > (b.completedAtValue ?? b.updatedAtValue ?? .distantPast)
    }
}

// MARK: - Sessions (read-only /api/v1/sessions projection)

/// One agent session from the frozen projection — same wire conventions as
/// WalnutTask (snake_case keys, ISO strings parsed on demand).
struct WalnutSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String?
    let taskId: String?
    let taskTitle: String?
    let category: String?
    let project: String?
    /// "" = the primary box (Mac); otherwise the remote host alias.
    let host: String
    let processStatus: String // "running" | "idle" | "stopped" | "error"
    let model: String?
    let mode: String?
    let startedAt: String
    let lastActiveAt: String
    let messageCount: Int
    let cwd: String?
    let pinned: Bool?
    let focusTier: String?
    let description: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, category, project, host, model, mode, cwd, pinned, description
        case taskId = "task_id"
        case taskTitle = "task_title"
        case processStatus = "process_status"
        case startedAt = "started_at"
        case lastActiveAt = "last_active_at"
        case messageCount = "message_count"
        case focusTier = "focus_tier"
    }
}

struct SessionsResponse: Codable {
    let sessions: [WalnutSession]
    let syncedAt: String
}

/// Slim transcript tail for one session (`/api/v1/sessions/:id/transcript`).
struct SessionTranscript: Codable {
    struct Message: Codable, Equatable {
        let role: String
        let text: String
        let timestamp: String
        let kind: String? // "tool" | "thinking" | nil
    }

    let sessionId: String
    let exportedAt: String
    let truncated: Bool
    let messages: [Message]
}

/// Coarse session status for the indicator dot + grouping.
enum SessionStatus {
    case running, idle, stopped, error, unknown
    init(_ raw: String) {
        switch raw {
        case "running": self = .running
        case "idle": self = .idle
        case "stopped": self = .stopped
        case "error": self = .error
        default: self = .unknown
        }
    }

    /// Alive = a CLI process still exists for this session.
    var isAlive: Bool { self == .running || self == .idle }
}

extension WalnutSession {
    var statusKind: SessionStatus { SessionStatus(processStatus) }
    var isPinned: Bool { pinned == true }
    /// Display name: session title, else the owning task's title, else the id.
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let taskTitle, !taskTitle.isEmpty { return taskTitle }
        return id
    }

    /// Strip fork/session boilerplate and count fork depth from a raw title.
    /// Server titles look like "Fork of Fork of Session: walnut — first message".
    private static func stripBoilerplate(_ raw: String) -> (forkDepth: Int, name: String, preview: String?) {
        var t = raw
        var forks = 0
        while t.hasPrefix("Fork of ") { forks += 1; t.removeFirst("Fork of ".count) }
        if t.hasPrefix("Session: ") { t.removeFirst("Session: ".count) }
        if let sep = t.range(of: " — ") {
            let name = String(t[..<sep.lowerBound]).trimmingCharacters(in: .whitespaces)
            let preview = String(t[sep.upperBound...]).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { return (forks, name, preview.isEmpty ? nil : preview) }
        }
        return (forks, t, nil)
    }

    /// The headline is the OWNING TASK'S name — that's what identifies the work
    /// to the user. The session's own title ("Session: <category> — <msg>") is
    /// boilerplate that surfaces the category, not the task, so it's never the
    /// headline; its first-message tail still makes a useful grey preview.
    private var parsedTitle: (forkDepth: Int, name: String, preview: String?) {
        // Fork depth + any first-message preview come from the session title.
        let fromSession = Self.stripBoilerplate(displayTitle)
        if let taskTitle, !taskTitle.isEmpty {
            return (fromSession.forkDepth, taskTitle, fromSession.preview)
        }
        return fromSession
    }
    var forkDepth: Int { parsedTitle.forkDepth }
    /// Headline for list rows / the nav bar — the task name (falls back to the
    /// session name only when the session has no owning task).
    var rowTitle: String { parsedTitle.name }
    /// First-message preview (the part after " — "), when the title carries one.
    var rowSubtitle: String? { parsedTitle.preview }

    var lastActiveValue: Date? { WalnutTask.parseISO(lastActiveAt) }
    var isLocal: Bool { host.isEmpty }

    /// Recency order — most recently active first.
    static func recencySort(_ a: WalnutSession, _ b: WalnutSession) -> Bool {
        (a.lastActiveValue ?? .distantPast) > (b.lastActiveValue ?? .distantPast)
    }
}

// NavigationLink(value:)/navigationDestination require Hashable. Hash by id only:
// Equatable stays full-field (auto-synthesized), but session metadata churns
// (processStatus, lastActiveAt, messageCount) — hashing by identity keeps a
// pushed conversation from popping when its list-row snapshot updates.
// (equal ⇒ same id ⇒ same hash still holds, so the Hashable contract is met.)
extension WalnutSession: Hashable {
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - Error envelope

/// Wire shape: `{ "error": { "code", "message" }, ...extras }`.
struct APIErrorEnvelope: Codable {
    struct Inner: Codable {
        let code: String
        let message: String
    }

    let error: Inner
    // Note-conflict extras ride at the top level of the envelope.
    let serverHash: String?
    let serverContent: String?
}

enum APIError: Error, LocalizedError {
    case notConfigured
    case network(underlying: Error)
    case unauthorized
    case rateLimited
    /// Server-provided v1 error (code + message + optional conflict extras).
    case server(status: Int, code: String, message: String, serverHash: String?, serverContent: String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Server not configured"
        case .network(let underlying): return underlying.localizedDescription
        case .unauthorized: return "Unauthorized — check your device token"
        case .rateLimited: return "Too many requests — try again in a moment"
        case .server(_, _, let message, _, _): return message
        case .badResponse: return "Unexpected server response"
        }
    }

    var code: String? {
        if case .server(_, let code, _, _, _) = self { return code }
        return nil
    }

    var isTurnActive: Bool { code == "turn_active" }
    var isConflict: Bool { code == "conflict" }
    /// 503 — the task projection hasn't synced yet on a fresh companion.
    var isUnavailable: Bool { code == "unavailable" }
    /// 503 — the primary box (this session's host) has no live bridge right now.
    var isBridgeOffline: Bool { code == "bridge_offline" }
    /// 409 — the session's CLI process is gone; can't accept new messages.
    var isSessionDead: Bool { code == "session_dead" }
}
