import Foundation

// MARK: - Wave 1 models (additive /api/v1 endpoints, docs/reference/api-v1.md)
//
// Session lifecycle (detail/patch/terminate/restart/retry/permission), task
// detail + batch + focus pins, Personal AI conversation management, and global
// search. All decode leniently: absent fields are optional so a newer server
// never breaks an older app.

// MARK: - Minimal JSON value (permission-request tool input is arbitrary JSON)

/// Tiny recursive JSON value used only where the wire shape is open-ended
/// (pending permission `input`). Not a general-purpose AnyCodable: it exists
/// so decode never fails on unknown structures and the UI can derive a short
/// human summary.
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let b = try? container.decode(Bool.self) { self = .bool(b) }
        else if let n = try? container.decode(Double.self) { self = .number(n) }
        else if let s = try? container.decode(String.self) { self = .string(s) }
        else if let o = try? container.decode([String: JSONValue].self) { self = .object(o) }
        else if let a = try? container.decode([JSONValue].self) { self = .array(a) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Non-empty string only — the shape most callers actually want (a blank
    /// `header` or `description` is the same as an absent one).
    var nonEmptyString: String? {
        guard let s = stringValue, !s.isEmpty else { return nil }
        return s
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}

// MARK: - Session lifecycle

/// One live tool-permission prompt from GET /v1/sessions/:id.
struct PendingPermission: Codable, Identifiable, Equatable {
    let requestId: String
    let toolName: String?
    let input: [String: JSONValue]?
    let reason: String?

    var id: String { requestId }

    /// Keys tried for the one-line input summary, mirroring the server's
    /// tool-summary heuristic (command/path/url first, generic text after).
    private static let summaryKeys = [
        "command", "description", "file_path", "path", "url", "query",
        "pattern", "prompt", "text", "title", "message",
    ]

    /// Parsed AskUserQuestion payload, or nil for every other tool. Non-nil
    /// means the card must render the full ask (and answer via `answers`), NOT
    /// the generic Allow/Deny pair.
    var askQuestions: [AskQuestion]? {
        guard toolName == AskUserQuestion.toolName else { return nil }
        return AskUserQuestion.parse(input)
    }

    /// Short human summary of what the tool wants to do ("ls docs/").
    /// Nil for a parseable AskUserQuestion: its card renders every question in
    /// full, and a one-line summary next to that is just noise.
    var inputSummary: String? {
        guard let input else { return nil }
        if askQuestions != nil { return nil }
        for key in Self.summaryKeys {
            if let value = input[key]?.stringValue, !value.isEmpty {
                let oneLine = value.replacingOccurrences(of: "\n", with: " ")
                return oneLine.count > 160 ? String(oneLine.prefix(160)) + "…" : oneLine
            }
        }
        return nil
    }
}

// MARK: - AskUserQuestion (the CLI's multiple-choice tool)
//
// `AskUserQuestion` is a requiresUserInteraction tool: its permission check
// ALWAYS returns 'ask' (even under bypassPermissions), and the tool echoes the
// `answers` field back out of the permission response's `updatedInput`. So
// answering it is not "allow vs deny" — the ALLOW response IS the answer
// payload, and an allow with no `answers` tells the model the user answered
// nothing. A phone that only rendered Allow/Deny therefore both hid the
// question and, on Allow, told the agent "no answer".
//
// Parsing + `answers` construction here MIRROR the web console's
// web/src/components/sessions/ask-user-question.ts so both surfaces put the
// same bytes on the wire.

struct AskQuestionOption: Equatable, Identifiable {
    let label: String
    let description: String?

    var id: String { label }
}

struct AskQuestion: Equatable, Identifiable {
    let question: String
    let header: String?
    let options: [AskQuestionOption]
    let multiSelect: Bool

    /// The `answers` map is keyed by question TEXT (that is the wire contract),
    /// so the text is also the stable identity for ForEach.
    var id: String { question }
}

enum AskUserQuestion {
    /// Tool name the CLI uses. Matching is exact — the server forwards
    /// `request.tool_name` verbatim.
    static let toolName = "AskUserQuestion"

    /// Parse an AskUserQuestion tool input into questions, or nil when the input
    /// doesn't look like one (then the generic Allow/Deny card renders instead).
    /// A question with blank text is dropped: it has no usable `answers` key.
    /// An option with a blank label is dropped: it can't be picked.
    static func parse(_ input: [String: JSONValue]?) -> [AskQuestion]? {
        guard let raw = input?["questions"]?.arrayValue else { return nil }
        let parsed: [AskQuestion] = raw.compactMap { entry in
            guard let q = entry.objectValue else { return nil }
            guard let text = q["question"]?.nonEmptyString else { return nil }
            let options: [AskQuestionOption] = (q["options"]?.arrayValue ?? []).compactMap { opt in
                guard let o = opt.objectValue, let label = o["label"]?.nonEmptyString else { return nil }
                return AskQuestionOption(label: label, description: o["description"]?.nonEmptyString)
            }
            return AskQuestion(
                question: text,
                header: q["header"]?.nonEmptyString,
                options: options,
                multiSelect: q["multiSelect"]?.boolValue == true
            )
        }
        return parsed.isEmpty ? nil : parsed
    }

    /// Build the `answers` map (question text → answer string) the server merges
    /// into the tool's input. Free text WINS over the option pills (an "Other"
    /// answer is a deliberate override); multi-select options join with ", " the
    /// way the CLI's own multi-select summary reads. Questions left entirely
    /// blank are OMITTED rather than sent as "" — the tool then reports only
    /// real answers.
    static func buildAnswers(
        questions: [AskQuestion],
        selections: [String: [String]],
        otherText: [String: String]
    ) -> [String: String] {
        var answers: [String: String] = [:]
        for q in questions {
            let custom = (otherText[q.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let picked = (selections[q.question] ?? []).filter { !$0.isEmpty }
            let answer = custom.isEmpty ? picked.joined(separator: ", ") : custom
            if !answer.isEmpty { answers[q.question] = answer }
        }
        return answers
    }

    /// True when every question has an answer — gates the Submit button.
    static func allAnswered(
        questions: [AskQuestion],
        selections: [String: [String]],
        otherText: [String: String]
    ) -> Bool {
        let answers = buildAnswers(questions: questions, selections: selections, otherText: otherText)
        return !questions.isEmpty && questions.allSatisfy { answers[$0.question] != nil }
    }

    /// Apply a tap on an option pill. Single-select replaces the selection (and
    /// tapping the selected pill again clears it); multi-select toggles.
    static func toggleSelection(
        current: [String]?,
        label: String,
        multiSelect: Bool
    ) -> [String] {
        let cur = current ?? []
        if multiSelect {
            return cur.contains(label) ? cur.filter { $0 != label } : cur + [label]
        }
        return cur.first == label ? [] : [label]
    }
}

/// GET /v1/sessions/:id → { session, pendingPermissions }. The record is the
/// full server-side SessionRecord; only the fields the phone renders decode.
///
/// This is also the app's ONLY way to reach a session the session LIST does not carry
/// (one that aged out of the projection), which is why the block below grew past the
/// four fields the permission card needs: those extra fields are what let the phone
/// build a list-shaped row for a by-id lookup and push the conversation page
/// (`WalnutSession.fromDetail`). They match `SessionRecord`'s own spelling on the wire
/// — camelCase everywhere except `process_status`.
///
/// EVERY added field is optional, and that is not defensive habit: the cloud
/// companion answers this route from a DEGRADED path when its bridge to the primary is
/// down, and that reply carries only `claudeSessionId` / `process_status` / `title` /
/// `mode`. A required field would turn "the Mac is asleep" into a decode failure.
struct SessionDetail: Codable {
    struct Record: Codable {
        let claudeSessionId: String
        let processStatus: String?
        let title: String?
        let mode: String?
        let archived: Bool?
        // Additive (2026-08) — `var … = nil` keeps the memberwise initializer
        // source-compatible with the call sites that build a Record from a PATCH reply.
        var taskId: String? = nil
        var project: String? = nil
        /// "" = the primary box; otherwise a host alias (same meaning as WalnutSession).
        var host: String? = nil
        var cwd: String? = nil
        var startedAt: String? = nil
        var lastActiveAt: String? = nil
        var messageCount: Int? = nil
        var model: String? = nil
        var description: String? = nil

        private enum CodingKeys: String, CodingKey {
            case claudeSessionId, title, mode, archived
            case processStatus = "process_status"
            case taskId, project, host, cwd, startedAt, lastActiveAt, messageCount
            case model, description
        }
    }

    let session: Record
    let pendingPermissions: [PendingPermission]
}

/// POST /v1/sessions/:id/terminate → 200.
struct SessionTerminated: Codable {
    let status: String // "terminated"
    let sessionId: String
    let tookMs: Int?
}

/// POST /v1/sessions/:id/restart → 200.
struct SessionRestarted: Codable {
    let status: String // "restarted"
    let sessionId: String
    let pendingMessages: Int
}

/// POST /v1/sessions/:id/retry → 200 (three shapes share one struct).
struct SessionRetried: Codable {
    let status: String // "reconnected" | "resuming" | "pending"
    let sessionId: String?
    let taskId: String?
    let oldSessionId: String?
    let restoredMessages: Int?
}

/// POST /v1/sessions/:id/permission → 200.
struct PermissionResolved: Codable {
    let status: String // "resolved"
    let requestId: String
    let allow: Bool
}

/// PATCH /v1/sessions/:id → 200 { session }.
struct SessionPatched: Codable {
    let session: SessionDetail.Record
}

// MARK: - Task detail / batch / focus

/// GET /v1/tasks/:id → the FULL task row + relation decorations. This is the
/// description/note READBACK the slim list projection deliberately omits.
struct TaskDetail: Codable {
    struct Relative: Codable, Identifiable, Equatable {
        let id: String
        let title: String
        let phase: String?
        let status: String?
    }

    let id: String
    let title: String
    let status: String?
    let phase: String?
    let priority: String?
    let project: String?
    let description: String?
    let summary: String?
    let note: String?
    let tags: [String]?
    let starred: Bool?
    let pinned: Bool?
    let dependsOn: [String]?
    let isBlocked: Bool?
    let resolvedDependencies: [Relative]?
    let dependents: [Relative]?
    let children: [Relative]?
    let parent: Relative?
    let sessionIds: [String]?

    private enum CodingKeys: String, CodingKey {
        case id, title, status, phase, priority, project
        case description, summary, note, tags, starred, pinned
        case dependsOn = "depends_on"
        case isBlocked = "is_blocked"
        case resolvedDependencies = "resolved_dependencies"
        case dependents, children, parent
        case sessionIds = "session_ids"
    }
}

/// Envelope for the endpoints answering { task: <full row> }.
struct TaskDetailEnvelope: Codable {
    let task: TaskDetail
}

/// POST /v1/tasks/:id/star → { task, starred }.
struct TaskStarred: Codable {
    let starred: Bool
}

/// Rows in batch results decode leniently (the server sends full core rows).
struct BatchTaskRow: Codable {
    let id: String
    let title: String?
}

struct BatchFailure: Codable {
    let id: String?
    let error: String?
}

/// POST /v1/tasks/batch/phase → partial success by design.
struct BatchPhaseResult: Codable {
    let changed: [BatchTaskRow]
    let failed: [BatchFailure]
    let syncFailed: [String]?
}

/// POST /v1/tasks/batch/delete → partial success by design.
struct BatchDeleteResult: Codable {
    let deleted: [BatchTaskRow]
    let failed: [BatchFailure]
}

/// GET /v1/focus/tasks (and the reorder/tier setters) → tier split of task ids.
struct FocusTierResult: Codable {
    let pinnedTasks: [String]
    let focusTasks: [String]?
    let satelliteTasks: [String]?
    let backlogTasks: [String]?
    let waitTasks: [String]?
    let customTierTasks: [String: [String]]?

    private enum CodingKeys: String, CodingKey {
        case pinnedTasks = "pinned_tasks"
        case focusTasks = "focus_tasks"
        case satelliteTasks = "satellite_tasks"
        case backlogTasks = "backlog_tasks"
        case waitTasks = "wait_tasks"
        case customTierTasks = "custom_tier_tasks"
    }
}

/// POST/DELETE /v1/focus/tasks/:id → { pinned_tasks }.
struct FocusPinResult: Codable {
    let pinnedTasks: [String]

    private enum CodingKeys: String, CodingKey {
        case pinnedTasks = "pinned_tasks"
    }
}

// MARK: - Personal AI conversation management

/// PATCH /v1/conversations/:id → { conversation } (lenient subset).
struct ConversationPatched: Codable {
    struct Meta: Codable {
        let id: String
        let title: String?
        let pinned: Bool?
    }

    let conversation: Meta
}

/// POST /v1/conversations/:id/stop → { stopped, questionCancelled }.
struct ConversationStopped: Codable {
    let stopped: Int
    let questionCancelled: Bool
}

// MARK: - Global search

/// GET /v1/search → { results } (REPLICA answers 501 not_supported_cloud).
struct GlobalSearchResult: Codable, Identifiable, Equatable {
    let type: String // "task" | "memory" | "session"
    let resultId: String?
    let title: String
    let snippet: String?
    let score: Double?

    private enum CodingKeys: String, CodingKey {
        case type, title, snippet, score
        // The doc says `id?` but the live server emits typed keys.
        case genericId = "id"
        case taskId, sessionId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        title = try c.decode(String.self, forKey: .title)
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet)
        score = try c.decodeIfPresent(Double.self, forKey: .score)
        resultId = try c.decodeIfPresent(String.self, forKey: .genericId)
            ?? c.decodeIfPresent(String.self, forKey: .taskId)
            ?? c.decodeIfPresent(String.self, forKey: .sessionId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(snippet, forKey: .snippet)
        try c.encodeIfPresent(score, forKey: .score)
        try c.encodeIfPresent(resultId, forKey: .genericId)
    }

    init(type: String, resultId: String?, title: String, snippet: String?, score: Double?) {
        self.type = type
        self.resultId = resultId
        self.title = title
        self.snippet = snippet
        self.score = score
    }

    // Search results have no guaranteed id — synthesize a stable-enough one.
    var id: String { "\(type)|\(resultId ?? title)" }
}

struct GlobalSearchResponse: Codable {
    let results: [GlobalSearchResult]
}

// MARK: - Error helpers (Wave 1 codes)

extension APIError {
    /// 409 — the session owns armed recurring crons; retry terminate with force.
    var isCronOwner: Bool { code == "cron_owner" }
    /// 501 — the endpoint can't run on a cloud REPLICA (needs the Mac online).
    var isNotSupportedCloud: Bool { code == "not_supported_cloud" }
}
