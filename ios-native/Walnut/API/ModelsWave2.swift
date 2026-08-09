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
            case "main-agent": return "Butler"
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
struct SessionQueuedMessage: Codable, Identifiable, Equatable {
    let id: String
    let message: String
    let status: String // "pending" | "processing"
    let enqueuedAt: String?

    var enqueuedDate: Date? { WalnutTask.parseISO(enqueuedAt) }
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
    let priority: String?  // "immediate" | "important" | "backlog"
    let project: String?
    let projectIsNew: Bool?
    let pinTier: String?
    let starred: Bool?

    private enum CodingKeys: String, CodingKey {
        case title, priority, project, pinTier, starred
        case dueDate = "due_date"
        case startDate = "start_date"
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

/// GET /v1/chat/stats → butler conversation size (cached between turns).
struct ChatStats: Codable {
    let apiMessageCount: Int?
    let estimatedTotalTokens: Int?
    let contextWindow: Int?
    let compacted: Bool?

    /// "34% of context" when both sides are known.
    var contextPercent: Int? {
        guard let estimatedTotalTokens, let contextWindow, contextWindow > 0 else { return nil }
        return Int((Double(estimatedTotalTokens) / Double(contextWindow) * 100).rounded())
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
    let path: String
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
