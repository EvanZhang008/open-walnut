import Foundation
import os

// MARK: - Models for the frozen /api/v1 REST+SSE contract (docs/reference/api-v1.md)

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
    /// kind == .tool only — one-line input summary ("ls docs/"), additive.
    let detail: String?
    /// kind == .tool only — clipped tool output for the expanded card, additive.
    let resultPreview: String?
    /// kind == .tool only — subagent name for Task/Agent delegation rows
    /// (session transcripts, additive 2026-08); nil on plain tool rows.
    let agent: String?

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
        case id, role, text, createdAt, kind, source, detail, resultPreview, agent
    }

    init(id: String, role: String, text: String, createdAt: String, kind: Kind?, source: String? = nil,
         detail: String? = nil, resultPreview: String? = nil, agent: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.kind = kind
        self.source = source
        self.detail = detail
        self.resultPreview = resultPreview
        self.agent = agent
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

// MARK: - Notes search (GET /api/v1/notes/search)

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

// MARK: - Favorites (GET /api/v1/favorites — the bookmark store shared with the web UI)

struct FavoritesResponse: Codable {
    let notes: [String]
}

// MARK: - Attachment upload (POST /api/v1/notes/attachment)

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
    /// The single grouping layer. "" = Inbox (no project).
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
    /// Additive (projection ships them since Wave 1): "when to begin" /
    /// "when it ends" — the Calendar view places tasks by these + due_date.
    /// `var … = nil` keeps the synthesized memberwise init source-compatible
    /// with pre-existing call sites (they simply leave the dates nil).
    var startDate: String? = nil
    var endDate: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, title, status, phase, priority, project
        case dueDate = "due_date"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
        case starred, pinned, tags, summary
        case startDate = "start_date"
        case endDate = "end_date"
    }
}

struct TasksResponse: Codable {
    let tasks: [WalnutTask]
    let syncedAt: String
}

/// POST /api/v1/tasks → 201 { task } — the created task in the same slim
/// ProjectedTask shape GET /tasks serves (additive endpoint, primary box only).
struct TaskCreated: Codable {
    let task: WalnutTask
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
    // Cached: parseISO runs inside sort comparators (recencySort) and
    // per-render filters, so per-call formatter allocation is thousands of
    // allocations per render with a few hundred sessions. The formatters are
    // documented thread-safe.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    /// Bare "YYYY-MM-DD" (the PATCH due_date contract accepts date-only) —
    /// ISO8601DateFormatter rejects it, so without this a mobile-set due date
    /// round-tripped as "no date" in the UI.
    private static let isoDayOnly: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current // a due DAY means the user's local day
        return f
    }()

    #if DEBUG
    /// Formatter-invocation counter for perf gates (TasksDerivedPerfTests):
    /// a formatter parse is ~26-59µs and sort comparators call parseISO
    /// O(n log n) times per pass, so the gate asserts a warm derived-list
    /// pass runs ZERO formatter parses. Counts MISSES only (cache hits are
    /// the point), so it directly measures the thing the budget depends on.
    static let isoFormatterParses = OSAllocatedUnfairLock(initialState: 0)
    #endif

    /// Memoized ISO string → Date. The wire keeps dates as strings and the
    /// derived Tasks/Sessions lists re-parse them inside sort comparators and
    /// per-render filters — measured 30,588 formatter parses / ~324ms for ONE
    /// TasksView body pass at field scale (766 tasks / 351 sessions) before
    /// this cache. Timestamps are heavily repeated across body evaluations,
    /// so a memo table turns the steady state into pure dictionary hits.
    /// Negative results are cached too (a malformed stamp must not re-run
    /// three formatters per render). Wholesale reset on overflow — cheaper
    /// than LRU bookkeeping and the working set (~4 stamps x rows) fits.
    private static let dateCache = OSAllocatedUnfairLock(initialState: [String: Date?]())
    private static let dateCacheLimit = 16_384

    /// ISO-8601 parse tolerant of fractional seconds (same shape as NotesStore)
    /// and of bare dates ("2026-08-08"), memoized (thread-safe).
    static func parseISO(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        if let hit = dateCache.withLock({ $0[iso] }) { return hit }
        #if DEBUG
        isoFormatterParses.withLock { $0 += 1 }
        #endif
        let parsed = isoFractional.date(from: iso)
            ?? isoPlain.date(from: iso)
            ?? isoDayOnly.date(from: iso)
        dateCache.withLock {
            if $0.count >= Self.dateCacheLimit { $0.removeAll(keepingCapacity: true) }
            $0[iso] = parsed
        }
        return parsed
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

    // Decorate-sort-undecorate versions of the comparators above. The
    // comparator forms compute their keys (incl. a parseISO) on EVERY
    // comparison — O(n log n) key computations per sort per body eval, the
    // dominant term of the Tasks tab's 300ms+ derived recompute (audit
    // MAIN-5). These extract keys once per row and compare cheap tuples.
    // Semantics are gated identical by TasksDerivedPerfTests.

    /// Same order as `openSort`, with O(n) key extraction.
    static func openSorted(_ tasks: [WalnutTask]) -> [WalnutTask] {
        tasks
            .map { (task: $0, pinned: $0.pinned == true, rank: $0.priorityKind.sortRank,
                    updated: $0.updatedAtValue ?? .distantPast) }
            .sorted { a, b in
                if a.pinned != b.pinned { return a.pinned }
                if a.rank != b.rank { return a.rank < b.rank }
                return a.updated > b.updated
            }
            .map(\.task)
    }

    /// Same order as `doneSort`, with O(n) key extraction.
    static func doneSorted(_ tasks: [WalnutTask]) -> [WalnutTask] {
        tasks
            .map { (task: $0, key: $0.completedAtValue ?? $0.updatedAtValue ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.task)
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
    /// The owning task's project — absent for Inbox / task-less sessions.
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
        case id, title, project, host, model, mode, cwd, pinned, description
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

/// GET /api/v1/sessions/launch-options — where a new session can run and the
/// user's frequent working directories (additive endpoint, primary box only).
struct SessionLaunchOptions: Codable {
    struct Host: Codable, Identifiable, Hashable {
        /// "" = the primary box (Mac); otherwise a config.hosts alias.
        let alias: String
        let label: String
        var id: String { alias }
    }

    struct Dir: Codable, Identifiable, Hashable {
        let cwd: String
        /// "" = the primary box — matches WalnutSession.host semantics.
        let host: String
        let hostLabel: String?
        let lastUsed: String
        let count: Int
        var id: String { "\(host)|\(cwd)" }
    }

    let hosts: [Host]
    let dirs: [Dir]
}

/// POST /api/v1/sessions → 201. The record is pre-seeded server-side, so the
/// app can open the conversation view with this id immediately.
struct SessionCreated: Codable {
    let sessionId: String
    let taskId: String
    let title: String
}

// MARK: - Session control (model / effort / fork — additive, 2026-08)

/// GET /api/v1/sessions/:id/model-options — the model picker's data.
struct SessionModelOptions: Codable {
    struct Model: Codable, Identifiable, Equatable {
        let id: String
        let label: String
        let supportsEffort: Bool?
        let supportedEffortLevels: [String]?
    }

    let models: [Model]
    /// Active row id (or the raw runtime model when not in the catalog).
    let current: String?
    /// The record's requested effort ("low"|"medium"|"high"|"xhigh"|"max").
    let currentEffort: String?
}

/// POST /api/v1/sessions/:id/model → 200.
struct SessionModelChange: Codable {
    let model: String
    let cliModel: String?
    let appliedLive: Bool?
    /// Codex/ACP sessions reply `{ applied: true, model }` (no appliedLive) —
    /// the switch took effect immediately there too.
    let applied: Bool?
    /// The CLI's read-back truth — may differ if it substituted the value.
    let effectiveModel: String?
}

/// POST /api/v1/sessions/:id/effort → 200.
struct SessionEffortChange: Codable {
    let effort: String
    let appliedLive: Bool?
    let effectiveEffort: String?
    /// True = the CLI is using a DIFFERENT level than requested (override).
    let overridden: Bool?
}

/// POST /api/v1/sessions/:id/fork → 201 (accepted, not spawned).
struct SessionForked: Codable {
    let sessionId: String
    let taskId: String
    let title: String
}

/// Slim transcript tail for one session (`/api/v1/sessions/:id/transcript`).
struct SessionTranscript: Codable {
    struct Message: Codable, Equatable {
        let role: String
        let text: String
        let timestamp: String
        let kind: String? // "tool" | "thinking" | nil
        /// kind == "tool" only — one-line input summary, additive.
        let detail: String?
        /// kind == "tool" only — clipped tool output, additive.
        let resultPreview: String?
        /// Task/Agent delegation rows only (additive, 2026-08) — the subagent's
        /// name, rendered as a badge on the tool chip.
        let agent: String?

        init(role: String, text: String, timestamp: String, kind: String?,
             detail: String? = nil, resultPreview: String? = nil, agent: String? = nil) {
            self.role = role
            self.text = text
            self.timestamp = timestamp
            self.kind = kind
            self.detail = detail
            self.resultPreview = resultPreview
            self.agent = agent
        }
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
    /// to the user. The session's own title ("Session: <project|dir> — <msg>") is
    /// boilerplate that surfaces the grouping, not the task, so it's never the
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

    /// Same order as `recencySort`, with O(n) key extraction (see
    /// WalnutTask.openSorted for why: comparator forms re-run parseISO per
    /// comparison; measured 466ms for one 351-session recency sort pre-cache).
    static func recencySorted(_ sessions: [WalnutSession]) -> [WalnutSession] {
        sessions
            .map { (session: $0, key: $0.lastActiveValue ?? Date.distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
    }

    /// "global.anthropic.claude-opus-4-8[1m]" → "Opus 4.8". Full version
    /// digits matter ("Opus 4.8", never a bare "Opus") — strip decorations
    /// like "[1m]" or "-v1" BEFORE parsing so they can't eat a version part.
    /// Shared by the session rows and the conversation nav subtitle.
    static func shortModelName(_ model: String) -> String {
        var lower = model.lowercased()
        while let bracket = lower.range(of: "[", options: .backwards) {
            lower = String(lower[..<bracket.lowerBound])
        }
        for family in ["opus", "sonnet", "haiku", "fable"] where lower.contains(family) {
            if let range = lower.range(of: family) {
                let tail = lower[range.upperBound...]
                let digits = tail.split(separator: "-")
                    .prefix(while: { !$0.isEmpty && $0.allSatisfy(\.isNumber) })
                    .prefix(2)
                let version = digits.joined(separator: ".")
                let name = family.prefix(1).uppercased() + family.dropFirst()
                return version.isEmpty ? name : "\(name) \(version)"
            }
        }
        return model
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
    /// Expected URLSession/task cancellation, never a reachability failure.
    case cancelled
    case network(underlying: Error)
    case unauthorized
    case rateLimited
    /// Server-provided v1 error (code + message + optional conflict extras).
    case server(status: Int, code: String, message: String, serverHash: String?, serverContent: String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Server not configured"
        case .cancelled: return "Request cancelled"
        case .network(let underlying):
            // Transient transport hiccups (TLS handshake, timeout, connection
            // lost) already got one automatic retry in WalnutAPI.perform —
            // reaching here means it failed twice. Say that in plain words
            // instead of surfacing Apple's raw "A TLS error caused…" text.
            let code = (underlying as NSError).code
            if (underlying as NSError).domain == NSURLErrorDomain,
               code == NSURLErrorSecureConnectionFailed
                || code == NSURLErrorTimedOut
                || code == NSURLErrorNetworkConnectionLost {
                return "Network hiccup — we retried automatically but it didn't go through. Please try again."
            }
            return underlying.localizedDescription
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

    var isCancelled: Bool {
        if case .cancelled = self { return true }
        return false
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
