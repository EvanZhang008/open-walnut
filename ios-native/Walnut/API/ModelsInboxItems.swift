import Foundation

@propertyWrapper
struct LossyInboxItems: Codable, Equatable {
    var wrappedValue: [InboxEmailItem]? = nil
    init(wrappedValue: [InboxEmailItem]? = nil) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws {
        guard var list = try? decoder.unkeyedContainer() else { return }
        var items: [InboxEmailItem] = []
        while !list.isAtEnd {
            let item = try InboxEmailItem(from: list.superDecoder())
            items.append(item)
        }
        let duplicates = Set(Dictionary(grouping: items, by: \.id).filter { $0.value.count > 1 }.keys)
        wrappedValue = items.map { item in
            var value = item
            if duplicates.contains(item.id) { value.unavailableReason = "Duplicate email item ID" }
            return value
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer(); try c.encode(wrappedValue)
    }
}
extension KeyedDecodingContainer {
    func decode(_ type: LossyInboxItems.Type, forKey key: Key) throws -> LossyInboxItems {
        (try? decodeIfPresent(type, forKey: key)) ?? LossyInboxItems()
    }
}
struct InboxLossyReceipts: Decodable {
    let values: [InboxItemReceipt]
    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer(); var values: [InboxItemReceipt] = []
        while !c.isAtEnd {
            let child = try c.superDecoder()
            if let value = try? InboxItemReceipt(from: child) { values.append(value) }
        }
        self.values = values
    }
}

/// JSON is display-only. Execution requests never contain these operation arguments.
indirect enum InboxJSON: Codable, Equatable {
    case object([String: InboxJSON]), array([InboxJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: InboxJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([InboxJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var pretty: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "Unavailable"
    }
}

struct InboxItemCapabilities: Codable, Equatable {
    var itemActions: Bool? = nil
    var markRead: String? = nil
}
struct InboxItemAttempt: Codable, Equatable {
    let requestId: String; let status: String; let updatedAt: String; let execution: String?; let reason: String?
}
struct InboxItemReceipt: Codable, Equatable {
    let actionId: String; let requestId: String; let planId: String; let planVersion: Int; let revision: Int; let updatedAt: String
    let status: String; let intent: String; let source: InboxMailSource; let input: InboxFrozenInput; let stage: String
    let taskId: String?; let messageId: String?; let startAttemptId: String?; let execution: String?; let startedAt: String?
    let delivery: String?; let reason: String?; let code: String?; let recovery: [String]; let attempts: [InboxItemAttempt]?
    var requestIds: [String]? = nil
    var taskCreated: Bool? = nil
    var hasCreatedTask: Bool { taskId != nil && taskCreated != false }
    var canReviewStartRecovery: Bool { status == "failure" && code == "start_recovery_required" && recovery.contains("retry_start") }
    var canRetryRead: Bool { status == "failure" && intent == "mark_read" && recovery.contains("retry_mark_read") }
    var needsQuery: Bool { status == "pending" || execution == "unconfirmed" || delivery == "unconfirmed" || recovery.contains("check_status") }
    var label: String {
        if intent == "mark_read" {
            if status == "success" { return "Marked read at \(startedAt ?? updatedAt)" }
            if status != "pending", recovery.contains("check_status") { return "Read status unconfirmed" }
            return status == "pending" ? "Working…" : "Could not mark read"
        }
        if intent == "reply_ai" {
            switch delivery {
            case "queued": return "Sent to the agent"
            case "deferred": return "Waiting for permission"
            case "skipped": return "Saved. Nothing was sent to the agent."
            case "unconfirmed": return "Delivery unconfirmed"
            default: return status == "pending" ? "Working…" : "Could not send to the agent"
            }
        }
        if intent == "create_task", taskCreated == false {
            return status == "failure" ? "Could not create task" : "Creating…"
        }
        if delivery == "unconfirmed" { return "Attachment unconfirmed" }
        if delivery == "deferred" { return "Attached. Waiting for permission" }
        if delivery == "queued" { return "Attached. Work queued" }
        if execution == "unconfirmed" { return intent == "create_task" && taskId != nil ? "Task created. Start unconfirmed." : "Start unconfirmed" }
        if execution == "running" { return startedAt.map { "Started at \($0)" } ?? "Started (time unavailable)" }
        if let startedAt, status == "success" { return "Started at \(startedAt)" }
        if execution == "not_started" {
            return intent == "create_task" && taskId != nil && status == "failure" ? "Task created. Could not start." : "Task saved. Not started."
        }
        if stage == "creating" { return "Creating…" }
        if stage == "starting" || execution == "starting" { return "Starting…" }
        return status == "pending" ? "Working…" : "Could not attach"
    }
}
struct InboxItemPrepareRequest: Encodable {
    let actionId: String; let goal: String?; let title: String?; let project: String?; let selectedTaskId: String?
    let retryStart: Bool?; let markReadAgain: Bool?
    init(actionId: String, input: InboxFrozenInput) {
        self.actionId = actionId; goal = input.goal; title = input.title; project = input.project
        selectedTaskId = input.selectedTaskId; retryStart = input.retryStart; markReadAgain = input.markReadAgain
    }
}
struct InboxItemPrepareResponse: Decodable {
    struct Project: Codable, Equatable { let name: String }
    let plan: InboxItemPlan?; let projects: [Project]; let source: InboxMailSource; let existingWork: InboxExistingWork?
    let restrictions: [InboxActionRestriction]; let receipts: [InboxItemReceipt]; let currentTask: InboxCurrentTaskStatus?
}
struct InboxItemExecuteRequest: Codable, Equatable {
    let actionId: String; let requestId: String; let confirmed: Bool; let planId: String; let planVersion: Int
}
struct InboxItemExecutionResponse: Decodable {
    let itemId: String; let receipts: [InboxItemReceipt]; let currentTask: InboxCurrentTaskStatus?
    let readObservation: InboxReadObservation?; let restrictions: [InboxActionRestriction]
    let receipt: InboxItemReceipt?
}

struct InboxFrozenInput: Codable, Equatable {
    var goal: String? = nil
    var title: String? = nil
    var project: String? = nil
    var selectedTaskId: String? = nil
    var retryStart: Bool? = nil
    var markReadAgain: Bool? = nil
}
struct InboxLaunchParameters: Codable, Equatable { let host: String; let cwd: String; let engine: String; let model: String; let mode: String }
struct InboxPlannedOp: Codable, Equatable { let tool: String; let args: InboxJSON }
struct InboxTaskCandidate: Codable, Equatable, Hashable, Identifiable {
    let id: String; let title: String; let project: String; let phase: String
    var canAttach: Bool { !id.isEmpty && ["TODO", "IN_PROGRESS", "NEED_ACTION", "WAITING"].contains(phase) }
    var phaseLabel: String {
        switch phase {
        case "TODO": return "To do"
        case "IN_PROGRESS": return "In progress"
        case "NEED_ACTION": return "Needs action"
        case "WAITING": return "Waiting"
        case "COMPLETE": return "Completed"
        default: return "Status unavailable"
        }
    }
    var projectLabel: String { project.isEmpty ? "Inbox" : InboxEmailItem.safe(project) }
}
struct InboxTaskPreview: Codable, Equatable, Identifiable {
    struct Activity: Codable, Equatable { let text: String; let at: String? }
    let id: String; let title: String; let project: String; let phase: String
    let description: String?; let summary: String?; let activity: [Activity]?; let updatedAt: String?
    var candidate: InboxTaskCandidate { .init(id: id, title: title, project: project, phase: phase) }
}
struct InboxTaskPage: Codable, Equatable {
    let tasks: [InboxTaskCandidate]; let total: Int; let offset: Int; let limit: Int; let hasMore: Bool
}
struct InboxCurrentTaskStatus: Codable, Equatable {
    let taskId: String; let phase: String?; let status: String; let observedAt: String; let sessionId: String?; let reason: String?
    var label: String {
        switch status {
        case "running": return "Running"
        case "starting": return "Starting"
        case "idle": return "Idle"
        case "stopped": return "Stopped"
        case "error": return "Error"
        case "waiting_permission": return "Waiting for permission"
        case "waiting_user": return "Needs action"
        case "waiting": return "Waiting"
        case "completed": return "Completed"
        case "deleted": return "Target deleted"
        default: return "Target unavailable"
        }
    }
}
struct InboxExistingWork: Codable, Equatable {
    let taskId: String; let task: InboxTaskPreview?; let status: String; let goal: String?; let intent: String?; let targetTaskId: String?
}
struct InboxActionRestriction: Codable, Equatable { let code: String; let message: String }
extension InboxItemPlan {
    func matchesHumanInput(_ requested: InboxFrozenInput) -> Bool {
        let goal = requested.goal?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.goal == goal, input.selectedTaskId == requested.selectedTaskId,
              input.retryStart == requested.retryStart, input.markReadAgain == requested.markReadAgain else { return false }
        if intent == "create_task", task == nil {
            if let title = requested.title, input.title != title.trimmingCharacters(in: .whitespacesAndNewlines) { return false }
            if let project = requested.project, input.project != project { return false }
        }
        return true
    }
    func isSafe(for key: InboxItemStore.Key, source expected: InboxMailSource?, action: InboxItemAction) -> Bool {
        guard letterId == key.letter, itemId == key.item, source == expected, actionId == action.id else { return false }
        if action.kind == "reply_ai" { return intent == "reply_ai" && ops.isEmpty }
        if action.intent == "mark_read" {
            let args: InboxJSON = .object(["account": .string(source.account), "messages": .array([.string(source.message)]), "read": .bool(true)])
            return intent == "mark_read" && ops.map(\.tool) == ["mail_mark_read"] && ops.first?.args == args
        }
        let tools = ops.map(\.tool)
        if task?.phase == "COMPLETE" { return false }
        for op in ops where op.tool == "task_start" || op.tool == "task_send" {
            guard case .object(let args) = op.args,
                  args[op.tool == "task_start" ? "id" : "to"] == taskId.map(InboxJSON.string) else { return false }
        }
        if action.intent == "find_task" || action.intent == "attach_task" {
            if input.retryStart == true && tools != ["task_start"] { return false }
            return intent == "attach_task" && taskId?.isEmpty == false && taskId == input.selectedTaskId && (tools == ["task_start"] || tools == ["task_send"])
        }
        if action.intent == "create_task" {
            if input.retryStart == true && tools != ["task_start"] { return false }
            if tools == ["task_send"] {
                guard let task, task.id == taskId, input.goal?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return false }
            }
            return intent == "create_task" && taskId?.isEmpty == false && (tools == ["task_create", "task_start"] || tools == ["task_start"] || tools == ["task_send"])
        }
        return false
    }
}
struct InboxItemPlan: Codable, Equatable {
    let id: String; let version: Int; let actionId: String; let intent: String; let letterId: String; let itemId: String
    let source: InboxMailSource; let input: InboxFrozenInput; let ops: [InboxPlannedOp]
    let taskId: String?; let messageId: String?; let idempotencyKey: String?; let launch: InboxLaunchParameters?; let task: InboxTaskPreview?
    let createdAt: String; let expiresAt: String
    func isExpired(at now: Date = Date()) -> Bool { InboxItemDate.parse(expiresAt).map { $0 <= now } ?? true }
    var consequence: String {
        if input.retryStart == true { return "Start the existing task. No new task will be created." }
        if ops.contains(where: { $0.tool == "task_create" }) { return "This creates one task and starts work. Only this email is linked." }
        if ops.contains(where: { $0.tool == "task_send" }) { return "This sends work to the selected task's conversation." }
        if ops.contains(where: { $0.tool == "task_start" }) { return "This starts work on the selected task." }
        if intent == "reply_ai" { return "Send this question to the letter's AI. No email or task operation runs." }
        return "Mark only this email as read. It stays in the mailbox."
    }
}

enum InboxItemDate {
    static func parse(_ value: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
struct InboxMailSource: Codable, Equatable {
    let kind: String
    let account: String
    let message: String
    var isValid: Bool { kind == "mail" && !account.isEmpty && !message.isEmpty }
    var copyText: String { "Account: \(account)\nMessage: \(message)" }
}
struct InboxItemDisplay: Codable, Equatable {
    struct Sender: Codable, Equatable { let name: String?; let address: String? }
    let sender: Sender?
    let sentAt: String?
    let accountLabel: String?
    let accountHint: String?
}
struct InboxReadObservation: Codable, Equatable { let read: Bool; let observedAt: String }
struct InboxItemAction: Codable, Equatable, Identifiable {
    let id: String
    let kind: String
    let intent: String?
    let label: String?
    let question: String?
    var invalid = false
    enum CodingKeys: String, CodingKey { case id, kind, intent, label, question, args, tool, target, selectedTaskId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); kind = try c.decode(String.self, forKey: .kind)
        intent = try c.decodeIfPresent(String.self, forKey: .intent)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        question = try c.decodeIfPresent(String.self, forKey: .question)
        invalid = [.args, .tool, .target, .selectedTaskId].contains { c.contains($0) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(intent, forKey: .intent); try c.encodeIfPresent(label, forKey: .label)
        try c.encodeIfPresent(question, forKey: .question)
    }
    var isSupported: Bool {
        !invalid && !id.isEmpty && ((kind == "op" && ["mark_read", "find_task", "create_task", "attach_task"].contains(intent ?? "") && label == nil && question == nil)
            || (kind == "reply_ai" && !(label ?? "").isEmpty && !(question ?? "").isEmpty))
    }
    var buttonLabel: String {
        if kind == "reply_ai" { return Self.aiLabel(InboxEmailItem.safe(label ?? "Question")) }
        switch intent {
        case "mark_read": return "Mark read"
        case "find_task", "attach_task": return "Find task"
        case "create_task": return "Create and start task"
        default: return "Action unavailable"
        }
    }
    static func aiLabel(_ label: String) -> String { label.hasPrefix("Ask AI:") ? label : "Ask AI: \(label)" }
}

/// Missing, future or corrupt item fields affect this card only, not its letter.
struct InboxEmailItem: Codable, Equatable, Identifiable {
    let id: String
    let subject: String
    let summary: String
    let source: InboxMailSource?
    let display: InboxItemDisplay?
    let readObservation: InboxReadObservation?
    let actions: [InboxItemAction]
    var unavailableReason: String?
    let receipts: [InboxItemReceipt]
    enum CodingKeys: String, CodingKey { case id, subject, summary, source, display, readObservation, actions, unavailableReason, receipts }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decode(String.self, forKey: .id)) ?? "invalid-\(decoder.codingPath.map(\.stringValue).joined(separator: "."))"
        subject = Self.safe((try? c?.decode(String.self, forKey: .subject)) ?? "Email unavailable")
        summary = Self.safe((try? c?.decode(String.self, forKey: .summary)) ?? "Email summary unavailable", limit: 4000)
        source = try? c?.decode(InboxMailSource.self, forKey: .source)
        display = try? c?.decode(InboxItemDisplay.self, forKey: .display)
        readObservation = try? c?.decode(InboxReadObservation.self, forKey: .readObservation)
        let decodedActions = try? c?.decode([InboxItemAction].self, forKey: .actions)
        actions = decodedActions ?? []
        receipts = (try? c?.decode(InboxLossyReceipts.self, forKey: .receipts).values) ?? []
        let explicit = try? c?.decode(String.self, forKey: .unavailableReason)
        let intents = actions.filter { $0.kind == "op" }.compactMap(\.intent)
        unavailableReason = explicit ?? ((decodedActions == nil || source?.isValid != true || id.hasPrefix("invalid-") || actions.contains { !$0.isSupported }
            || Set(actions.map(\.id)).count != actions.count || Set(intents).count != intents.count) ? "Email actions unavailable for this item" : nil)
    }
    static func safe(_ raw: String, limit: Int = 500) -> String {
        String(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) || $0 == "\n" }.prefix(limit))
    }
    var senderLabel: String {
        let name = Self.safe(display?.sender?.name ?? "")
        let address = Self.safe(display?.sender?.address ?? "")
        return name.isEmpty ? (address.isEmpty ? "Sender unavailable" : address) : (address.isEmpty ? name : "\(name) (\(address))")
    }
    var dateLabel: String {
        guard let raw = display?.sentAt, let date = InboxItemDate.parse(raw) else { return "Date unavailable" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    var accountLabel: String {
        let label = Self.safe(display?.accountLabel ?? "")
        let hint = Self.safe(display?.accountHint ?? "")
        return "\(label.isEmpty ? "Account label unavailable" : label)\(hint.isEmpty ? "" : " (\(hint))")"
    }
    var visibleActions: [InboxItemAction] {
        guard unavailableReason == nil else { return [] }
        return actions.filter { action in
            !(action.intent == "find_task" && actions.contains { $0.intent == "attach_task" })
        }
    }
}
