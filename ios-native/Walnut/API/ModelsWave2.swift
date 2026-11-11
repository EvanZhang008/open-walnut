import Foundation

// MARK: - Wave 2 models (additive /api/v1 endpoints, docs/reference/api-v1.md)
//
// Routines management, provider-neutral session controls, queued messages,
// plan/side-question reads, NL quick-parse, config projection, chat stats,
// and session file browsing. All decode leniently: absent fields are optional
// so a newer server never breaks an older app.

// MARK: - Routines

/// One routine (cron job) from GET /v1/routines. The server row is the full
/// CronJob; only what the phone renders decodes, everything else is ignored.
struct RoutineJob: Codable, Identifiable, Equatable {
    /// Trigger — one of three kinds ("cron" | "every" | "at"); fields are a
    /// union so all are optional.
    struct Schedule: Codable, Equatable {
        let kind: String
        let expr: String?     // kind == "cron"
        let tz: String?       // kind == "cron" (optional)
        let everyMs: Double?  // kind == "every"
        let at: String?       // kind == "at" (ISO date)

        /// Human line for the row ("0 9 * * 1-5", "Every 30m", "At Jul 8, 9:00").
        var display: String {
            switch kind {
            case "cron":
                guard let expr else { return "cron" }
                return tz.map { "\(expr) · \($0)" } ?? expr
            case "every":
                guard let everyMs, everyMs > 0 else { return "interval" }
                return "Every \(Self.duration(ms: everyMs))"
            case "at":
                guard let at, let date = WalnutTask.parseISO(at) else { return "once" }
                return "At \(date.formatted(date: .abbreviated, time: .shortened))"
            default:
                return kind
            }
        }

        /// "90000" → "1.5m"-style compact duration (m under an hour, h above).
        static func duration(ms: Double) -> String {
            let minutes = ms / 60_000
            if minutes < 60 {
                let rounded = (minutes * 10).rounded() / 10
                return rounded == rounded.rounded() ? "\(Int(rounded))m" : "\(rounded)m"
            }
            let hours = minutes / 60
            let rounded = (hours * 10).rounded() / 10
            return rounded == rounded.rounded() ? "\(Int(rounded))h" : "\(rounded)h"
        }
    }

    /// Which executor runs the routine ("main-agent" | "walnut-agent" |
    /// "claude-code" | future types).
    struct Executor: Codable, Equatable {
        let type: String

        var label: String {
            switch type {
            case "main-agent": return "Personal AI"
            case "walnut-agent": return "Isolated agent"
            case "claude-code": return "Claude Code"
            default: return type
            }
        }
    }

    /// Runtime state — timestamps are epoch milliseconds.
    struct State: Codable, Equatable {
        let nextRunAtMs: Double?
        let lastRunAtMs: Double?
        let lastStatus: String? // "ok" | "error" | "skipped"
        let lastError: String?
        let lastDurationMs: Double?

        var lastRunDate: Date? { lastRunAtMs.map { Date(timeIntervalSince1970: $0 / 1000) } }
        var nextRunDate: Date? { nextRunAtMs.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }

    let id: String
    let name: String
    let description: String?
    let enabled: Bool
    let schedule: Schedule
    let executor: Executor?
    let state: State?
}

/// GET /v1/routines → { jobs }.
struct RoutinesResponse: Codable {
    let jobs: [RoutineJob]
}

/// POST /v1/routines/:id/toggle (and PATCH) → { job }.
struct RoutineEnvelope: Codable {
    let job: RoutineJob
}

/// POST /v1/routines/:id/run → { result } — shape is executor-specific; the
/// phone only needs the 200 (then reloads the list for fresh state).
struct RoutineRunAck: Codable {}

// MARK: - Session controls (provider-neutral)

/// GET/POST /v1/sessions/:id/controls → { engine, controls }. Currently the
/// mode select for Claude sessions; the native control set for Codex/ACP.
struct SessionControlsPayload: Codable, Equatable {
    struct Option: Codable, Equatable, Identifiable {
        let value: String
        let name: String?
        var id: String { value }
        var label: String { name ?? value }
    }

    struct Control: Codable, Equatable, Identifiable {
        let id: String
        let name: String?
        let type: String?
        let currentValue: String?
        let options: [Option]?

        private enum CodingKeys: String, CodingKey {
            case id, name, type, currentValue, options
        }

        init(id: String, name: String?, type: String?, currentValue: String?, options: [Option]?) {
            self.id = id
            self.name = name
            self.type = type
            self.currentValue = currentValue
            self.options = options
        }

        /// Lenient: a Codex control may carry a non-string currentValue —
        /// decode must never throw on an unknown control shape.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try? c.decodeIfPresent(String.self, forKey: .name)
            type = try? c.decodeIfPresent(String.self, forKey: .type)
            currentValue = try? c.decodeIfPresent(String.self, forKey: .currentValue)
            options = try? c.decodeIfPresent([Option].self, forKey: .options)
        }
    }

    let engine: String
    let controls: [Control]
}

// MARK: - Queued messages

/// One queued (not yet delivered) session message from GET /v1/sessions/:id/queue.
///
/// Every field past `enqueuedAt` is additive (2026-11-06) and optional, so an older
/// server's row decodes as it always did, and a row from a newer server with a value
/// this build does not know (a new `stage`) still decodes.
struct SessionQueuedMessage: Codable, Identifiable, Equatable {
    let id: String
    /// The stored text as the session will receive it: the attachment headers and their
    /// paths included. Undo, a resend and words put back in the message box use it as it
    /// is, so a picture is never lost on the way; the tray shows `words` (or this text
    /// with the headers taken off, `shownText`).
    var message: String
    let status: String // "pending" | "processing" | "parked" | "held"
    var enqueuedAt: String?
    /// The stored text as the session will receive it (headers, notes in front).
    var rawMessage: String? = nil
    /// Only the words the person typed (additive 2026-11-06): no notes in front, no
    /// attachment headers. nil on an older server, where `shownText` reads them off `message`.
    var words: String? = nil
    /// Who sent it: "person" for words someone typed, "agent" for everything Walnut or
    /// another task sent. nil on an older server (and on a row written without a source).
    var sentBy: String? = nil
    /// Pictures sent with it: the saved path, and the URL path that serves the bytes.
    var images: [QueuedImage]? = nil
    /// Files sent with it.
    var files: [QueuedFile]? = nil
    /// How far the line got: "waiting" (not written yet), "written" (written to the CLI,
    /// which reads it after its current step), "taken" (the CLI took it). nil on an older
    /// server; see `QueueStage`.
    var stage: String? = nil
    /// True once the CLI took it (stage "taken"): the row is gone from the person's point
    /// of view, and its bubble belongs in the conversation.
    var delivered: Bool? = nil

    struct QueuedImage: Codable, Equatable {
        let path: String
        let url: String?

        init(path: String, url: String? = nil) {
            self.path = path
            self.url = url
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
            url = try? c.decodeIfPresent(String.self, forKey: .url)
        }

        private enum CodingKeys: String, CodingKey { case path, url }
    }

    struct QueuedFile: Codable, Equatable {
        let path: String
        let name: String?

        init(path: String, name: String? = nil) {
            self.path = path
            self.name = name
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
            name = try? c.decodeIfPresent(String.self, forKey: .name)
        }

        private enum CodingKeys: String, CodingKey { case path, name }

        var shownName: String {
            if let name, !name.isEmpty { return name }
            return (path as NSString).lastPathComponent
        }
    }

    var enqueuedDate: Date? { WalnutTask.parseISO(enqueuedAt) }

    /// The words and attachments the row stands for, read from whatever the server sent:
    /// the separate fields of a current server, or the headers in the text of an older one.
    private var sent: (words: String, imagePaths: [String], filePaths: [String]) {
        var imagePaths = (images ?? []).map(\.path).filter { !$0.isEmpty }
        var filePaths = (files ?? []).map(\.path).filter { !$0.isEmpty }
        let ownWords = PeerMessagePresentation.ownWords(message)
        let parts = MessageRow.attachmentSendParts(ownWords)
        if let typed = words.map({ PeerMessagePresentation.ownWords($0) }) {
            // A current server: the words as typed; the pictures from its fields, else
            // from the headers still in `message`.
            if imagePaths.isEmpty { imagePaths = parts?.imagePaths ?? [] }
            if filePaths.isEmpty { filePaths = parts?.filePaths ?? [] }
            return (typed, imagePaths, filePaths)
        }
        let words = ownWords
        if let parts {
            // An older server: the headers are still in the text.
            if imagePaths.isEmpty { imagePaths = parts.imagePaths }
            if filePaths.isEmpty { filePaths = parts.filePaths }
            return (parts.text, imagePaths, filePaths)
        }
        return (words, imagePaths, filePaths)
    }

    /// The pictures the tray shows as thumbnails (a file that is a picture included).
    var shownImagePaths: [String] {
        let s = sent
        return s.imagePaths + s.filePaths.filter { MarkdownParser.isImagePath($0) }
    }

    /// The files the tray names (pictures aside).
    var shownFileNames: [String] {
        let named = Dictionary((files ?? []).map { ($0.path, $0.shownName) }, uniquingKeysWith: { a, _ in a })
        return sent.filePaths.filter { !MarkdownParser.isImagePath($0) }
            .map { named[$0] ?? ($0 as NSString).lastPathComponent }
    }

    /// What a queued row shows: the words the person wrote, without the Walnut
    /// notes that ride in front of them (a changed-instructions notice, a peer's
    /// envelope) and without the attachment headers. A row of Walnut notes alone
    /// names them instead; a picture with no words reads "Photo", never the header.
    var shownText: String {
        let s = sent
        let words = s.words.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { return words }
        let pictures = s.imagePaths.count + s.filePaths.filter { MarkdownParser.isImagePath($0) }.count
        let others = s.filePaths.filter { !MarkdownParser.isImagePath($0) }
        if pictures > 0 || !others.isEmpty {
            var parts: [String] = []
            if pictures > 0 { parts.append(pictures == 1 ? "Photo" : "\(pictures) photos") }
            if !others.isEmpty { parts.append(others.count == 1 ? shownFileNames.first ?? "File" : "\(others.count) files") }
            return parts.joined(separator: " \u{00B7} ")
        }
        if let segments = PeerMessagePresentation.segments(message) {
            let notes = segments.compactMap { segment -> String? in
                if case .message(let note) = segment { return note.accessibilityLabel }
                return nil
            }
            if !notes.isEmpty { return notes.joined(separator: "\n") }
        }
        return message
    }
    /// What the edit box opens with, and so what a save sends: a current server's typed
    /// `words` (it keeps the pictures and files itself), else the stored text whole, headers
    /// included, so an older server never loses a picture to an edit.
    var editableText: String { words ?? message }

    /// The box holds words to save: not empty, and not what the row already holds.
    func isChanged(by text: String) -> Bool {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !typed.isEmpty && typed != editableText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Only still-pending messages can be edited/deleted (409 otherwise).
    var isPending: Bool { status == "pending" }
}

struct SessionQueueResponse: Codable {
    let messages: [SessionQueuedMessage]
}

// MARK: - Plan / side questions

/// GET /v1/sessions/:id/plan → the plan markdown; 404 when the session has none.
struct SessionPlanPayload: Codable {
    let content: String
    let planFile: String?
    let sourceSessionId: String?

    func linkSource(requestedSessionID: String) -> LinkSource {
        LinkSource(sessionID: sourceSessionId ?? requestedSessionID)
    }
}

/// One side-question Q&A from GET /v1/sessions/:id/side-questions.
struct SideQuestion: Codable, Identifiable, Equatable {
    let id: String
    let question: String
    let answer: String
    let createdAt: String?
    let promotedTaskId: String?

    var createdDate: Date? { WalnutTask.parseISO(createdAt) }
}

struct SideQuestionsResponse: Codable {
    let sideQuestions: [SideQuestion]
}

/// POST /v1/sessions/:id/side-question → { sideQuestion } (synchronous answer).
struct SideQuestionEnvelope: Codable {
    let sideQuestion: SideQuestion
}

// MARK: - NL quick-parse

/// POST /v1/tasks/quick-parse → the structured parse of a natural-language
/// task note. Dates are LOCAL wall-clock strings ("2026-08-09" or
/// "2026-08-09T09:00:00") resolved against the submitted timeZone.
struct QuickParsedTask: Codable, Equatable {
    let title: String
    let dueDate: String?
    let startDate: String?
    /// End of the working block ("3-5pm" → start + end). Only ever present
    /// alongside `startDate`; the server never emits one without the other.
    let endDate: String?
    let priority: String?  // "immediate" | "important" | "backlog"
    let project: String?
    let projectIsNew: Bool?
    let pinTier: String?
    let starred: Bool?

    private enum CodingKeys: String, CodingKey {
        case title, priority, project, pinTier, starred
        case dueDate = "due_date"
        case startDate = "start_date"
        case endDate = "end_date"
        case projectIsNew = "project_is_new"
    }

    /// Parse the local wall-clock date string ("YYYY-MM-DD[THH:mm:ss]") in the
    /// user's current timezone — the same zone the parse was requested with.
    static func parseLocalDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formats = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"]
        for format in formats {
            let f = DateFormatter()
            f.dateFormat = format
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = .current
            if let date = f.date(from: raw) { return date }
        }
        return nil
    }
}

// MARK: - Config projection + chat stats

/// GET /v1/config → whitelist-only projection + box diagnostics. Credentials
/// and host connection details are structurally absent server-side.
struct ServerConfigInfo: Codable {
    struct HostInfo: Codable {
        let label: String?
        let enabled: Bool?
    }

    struct Provider: Codable {
        let type: String?
        let model: String?
        let bedrockRegion: String?

        private enum CodingKeys: String, CodingKey {
            case type, model
            case bedrockRegion = "bedrock_region"
        }
    }

    struct Agent: Codable {
        let mainModel: String?
        let fastModel: String?

        private enum CodingKeys: String, CodingKey {
            case mainModel = "main_model"
            case fastModel = "fast_model"
        }
    }

    struct UserInfo: Codable {
        let name: String?
    }

    struct Memory: Codable {
        let rssMb: Int?
        let heapUsedMb: Int?
        let uptimeSec: Int?
    }

    struct Payload: Codable {
        let user: UserInfo?
        let provider: Provider?
        let agent: Agent?
        let hosts: [String: HostInfo]?
        /// Additive 2026-10-29; a `var` so the memberwise shape stays as it was.
        var ui: UI? = nil
    }

    /// The server's `ui.show_walnut_additions`; false when it does not say (an
    /// older server), which is the server's own default.
    var showWalnutAdditions: Bool { config.ui?.showWalnutAdditions == true }

    /// `config.ui`: how the chat draws (additive 2026-10-29). nil on an older server.
    struct UI: Codable {
        /// Show what Walnut added to a person's message on every message.
        let showWalnutAdditions: Bool?

        private enum CodingKeys: String, CodingKey {
            case showWalnutAdditions = "show_walnut_additions"
        }
    }

    let config: Payload
    let cloud: Bool?
    let processNice: Int?
    let memory: Memory?

    /// Enabled host labels, A→Z, for the one-line hosts row.
    var enabledHostLabels: [String] {
        (config.hosts ?? [:])
            .filter { $0.value.enabled != false }
            .map { $0.value.label ?? $0.key }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}

/// GET /v1/chat/stats → Personal AI conversation size (cached between turns).
struct ChatStats: Codable {
    let apiMessageCount: Int?
    let estimatedTotalTokens: Int?
    let contextWindow: Int?
    /// The window is an estimate (the configured model's catalog entry), not the one the
    /// conversation's Claude Code session reported. Absent from an older server.
    let contextWindowEstimate: Bool?
    let compacted: Bool?

    /// "34% of context" when both sides are known.
    var contextPercent: Int? {
        guard let estimatedTotalTokens, let contextWindow, contextWindow > 0 else { return nil }
        return Int((Double(estimatedTotalTokens) / Double(contextWindow) * 100).rounded())
    }
}

/// GET /v1/chat/engine → which engine answers a conversation, and on the lane
/// engine the id of the `claude` session behind it.
///
/// This is what lets the MAIN AGENT chat carry a model pill: on the lane engine
/// the answer is produced by a real CLI session, so its model/effort/mode are
/// the ordinary session-control endpoints' business. `sessionId` is nil until the
/// conversation has had its first turn (the endpoint never mints a lane, because
/// opening a picker must not spawn a CLI).
///
/// The in-process engine has no session, but it DOES have a per-conversation
/// model now: it reports `model` / `effort` / `models` and the picker writes
/// through `PUT /v1/chat/model`. Every one of those three is optional, because a
/// server predating that change sends only `model` — the pill stays selectable
/// with a one-row catalog in that case rather than going read-only, which is the
/// state the user reported ("this should ALWAYS be selectable").
///
/// A REPLICA that cannot reach the primary answers 503 `primary_unreachable`
/// rather than describing its OWN config, so this payload never carries a model
/// the user isn't actually talking to.
struct ChatEngineInfo: Codable, Equatable {
    let engine: String
    let sessionId: String?
    let cwd: String?
    /// "" = the primary box (matches ProjectedSession.host semantics).
    let host: String?
    /// The engine's current model (in-process: this conversation's model).
    let model: String?
    /// The current effort, when the model has an effort axis.
    let effort: String?
    /// The server saying whether the model can be switched at all. ABSENT = it is
    /// too old to say, which is NOT a "no" (see the type comment).
    let switchable: Bool?
    /// In-process: the pickable catalog, same row shape as
    /// `GET /v1/sessions/:id/model`. Absent on an older server.
    let models: [SessionModelOptions.Model]?

    /// A live lane session exists, so model/effort/mode are switchable through
    /// the ordinary session endpoints.
    var switchableSessionId: String? {
        guard engine == "lane", let sessionId, !sessionId.isEmpty else { return nil }
        return sessionId
    }

    /// Only an EXPLICIT `false` locks the pill. `nil` means an old server that
    /// never had the field.
    var isLockedByServer: Bool { switchable == false }

    private enum CodingKeys: String, CodingKey {
        case engine, sessionId, cwd, host, model, effort, switchable, models
    }

    init(
        engine: String,
        sessionId: String? = nil,
        cwd: String? = nil,
        host: String? = nil,
        model: String? = nil,
        effort: String? = nil,
        switchable: Bool? = nil,
        models: [SessionModelOptions.Model]? = nil
    ) {
        self.engine = engine
        self.sessionId = sessionId
        self.cwd = cwd
        self.host = host
        self.model = model
        self.effort = effort
        self.switchable = switchable
        self.models = models
    }

    /// Every field but `engine` decodes leniently: a mixed-version box sending a
    /// malformed additive value must not fail the whole lookup (which the
    /// composer would then read as "the box is unreachable").
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engine = try c.decode(String.self, forKey: .engine)
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        host = try? c.decodeIfPresent(String.self, forKey: .host)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        switchable = try? c.decodeIfPresent(Bool.self, forKey: .switchable)
        models = try? c.decodeIfPresent([SessionModelOptions.Model].self, forKey: .models)
    }
}

/// PUT /v1/chat/model → 200. The in-process engine's per-conversation model.
///
/// The read-back is the truth (the box may substitute a value), so the pill
/// adopts what comes back rather than what it asked for. `400 unknown_model`,
/// `409 lane_engine` (a lane conversation's model belongs to its session
/// endpoints) and `503 primary_unreachable` are the error shapes.
struct ChatModelChange: Codable, Equatable {
    let model: String?
    let effort: String?
}

/// GET /v1/sessions/list-dirs → one directory level for the path picker.
/// `exists: false` still arrives as HTTP 200 (the listed dir is absent), and old
/// servers may omit it, so decode leniently and default to true.
struct DirListing: Codable, Equatable {
    let dirs: [String]
    let parent: String
    let exists: Bool

    private enum CodingKeys: String, CodingKey { case dirs, parent, exists }

    init(dirs: [String], parent: String, exists: Bool) {
        self.dirs = dirs
        self.parent = parent
        self.exists = exists
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dirs = (try? c.decode([String].self, forKey: .dirs)) ?? []
        parent = (try? c.decode(String.self, forKey: .parent)) ?? ""
        exists = (try? c.decodeIfPresent(Bool.self, forKey: .exists)) ?? true
    }
}

// MARK: - Session file browsing

/// One row of GET /v1/files/list — a lazy single directory level.
/// CONTRACT GAP (verified live 2026-08-09): the doc promises `path` per entry
/// but the server omits it — clients must join parent dir + name themselves.
/// Decoded optional so either server shape works.
struct SessionFileEntry: Codable, Identifiable, Equatable {
    let name: String
    let path: String?
    let type: String // "dir" | "file"
    let size: Int?
    let hasChildren: Bool?

    var id: String { path ?? name }
    var isDirectory: Bool { type == "dir" }

    /// Absolute path of this entry, joining against the listed directory when
    /// the server didn't send one.
    func absolutePath(in directory: String) -> String {
        if let path, path.hasPrefix("/") { return path }
        return directory.hasSuffix("/") ? directory + name : directory + "/" + name
    }
}

struct SessionFileListResponse: Codable {
    /// The directory the server ACTUALLY listed. Not always what was asked for:
    /// ask for a file and the server lists its parent instead (and names the
    /// file in `selectedFile`), so a caller that keeps using the requested path
    /// builds every child path off a directory that does not exist.
    let path: String
    /// Set only when the requested path turned out to be a FILE inside `path`.
    /// The reason it is here at all: the caller asked about that one thing, and
    /// a listing of its neighbours with no mention of it is an answer to a
    /// different question.
    let selectedFile: String?
    let entries: [SessionFileEntry]
}

/// GET /v1/file-content → the FileViewer payload. A missing file is a 200
/// with `error` set (the viewer contract), not a 404.
struct SessionFileContent: Codable {
    let content: String?
    let size: Int?
    let truncated: Bool?
    let binary: Bool?
    let error: String?
}

/// GET /v1/files/locate → which host a tapped path lives on.
/// `host` nil = the primary itself. `elsewhere` = not the session's host, with
/// `hostName` its name. `missing` = no host has it (`checked` names the hosts
/// that answered, the session's first). `found: false` without `missing` = the
/// session's host could not answer now.
struct PathLocation: Codable, Equatable {
    let path: String
    let host: String?
    let hostName: String?
    let found: Bool
    let elsewhere: Bool?
    let missing: Bool?
    let checked: [String]?
    let via: String?
    let line: Int?
    let column: Int?
    let endLine: Int?
}

/// GET /v1/files/resolve-path → where a mentioned path really lives.
/// `resolved: false` means the server is handing back a cwd-joined GUESS, so a
/// caller must not present it as the file it asked for. `line`/`column`/
/// `endLine` come from the server's own parse of the decorated reference.
struct PathResolution: Codable {
    let path: String
    let resolved: Bool
    let via: String?
    let line: Int?
    let column: Int?
    let endLine: Int?
}
