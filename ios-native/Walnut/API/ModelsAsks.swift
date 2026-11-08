import Foundation

/// One agent's asks as `GET /api/v1/asks` answers them: exactly the list the web
/// console's Ask Walnut drawer shows for that agent (additive, 2026-09).
///
/// The phone does NOT sort, filter or retitle these rows. Membership, order,
/// title and state are one rule on the server (src/core/sessions/ask-list.ts,
/// the same module the Mac's drawer imports), so rendering `asks` in the order
/// given is what keeps the two drawers identical. A second copy of the rule here
/// would be a second thing to drift.
struct AskList: Codable, Equatable {
    let agentId: String
    /// The agent's `Ask <name>` project: the drawer's title on the Mac.
    let project: String
    /// Matches before the server's `limit`, so a capped answer is detectable.
    let total: Int
    /// The Mac behind this answer launches an ask from `POST /api/v1/sessions
    /// { walnutAgent }` (New chat). The primary sets it, so a replica relaying
    /// the list carries the Mac's own answer; a Mac that predates the field
    /// omits it.
    let launch: Bool?
    let asks: [AskSummary]

    /// Absent reads as "no": an older Mac answers an ask launch with
    /// "cwd is required".
    var canLaunch: Bool { launch == true }
}

/// Display only: asks stay stored under "Ask Walnut" / "Ask <agent>" and read as
/// "Quick question" (the web's `askProjectDisplay`). Requests keep the stored name.
enum AskProjectName {
    static let quickQuestion = "Quick question"

    /// "Ask Walnut" -> "Quick question", "Ask Mentor" -> "Quick question · Mentor".
    static func display(_ project: String) -> String {
        let trimmed = project.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let agent = agentName(trimmed) else { return project }
        return agent.lowercased() == "walnut" ? quickQuestion : "\(quickQuestion) · \(agent)"
    }

    /// Only a placeholder title (equal to its project) is renamed, never a real one;
    /// the Main task reads "CEO", as its org node does.
    static func displayTitle(_ title: String, project: String?, orgRole: String? = nil) -> String {
        if orgRole == "main" { return ChatOrgModel.ceoName }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard agentName(trimmed) != nil else { return title }
        let stored = (project ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if stored.lowercased() == trimmed.lowercased() { return display(trimmed) }
        // No project on the row: only the general agent's placeholder is certain.
        return project == nil && trimmed.lowercased() == "ask walnut" ? quickQuestion : title
    }

    // Keep launch project keys consistent with the server's askProjectFor.
    static func storedProject(agentID: String, agentName: String?) -> String {
        guard agentID != "general" else { return "Ask Walnut" }
        func safeName(_ raw: String) -> String {
            let folded = raw.replacingOccurrences(of: "[/\\\\\\u0000]", with: "-", options: .regularExpression)
                .replacingOccurrences(of: "\\.{2,}", with: ".", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return String(folded.prefix(60)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let name = safeName(agentName ?? "")
        let id = safeName(agentID)
        return "Ask \(!name.isEmpty ? name : !id.isEmpty ? id : "agent")"
    }

    private static func agentName(_ trimmed: String) -> String? {
        guard trimmed.count > 4, trimmed.prefix(4).lowercased() == "ask " else { return nil }
        let rest = trimmed.dropFirst(4).trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? nil : rest
    }
}

/// One row. `activityAt` is the stamp the row both SORTS by and PRINTS, so a
/// relative time rendered from it always reads in order down the list.
struct AskSummary: Codable, Equatable, Hashable, Identifiable {
    /// The task id.
    let id: String
    let title: String
    let state: AskState
    let activityAt: String
    let createdAt: String
    /// The session the conversation opens; absent while the ask has none yet.
    let sessionId: String?
    let phase: String?
    let unread: Bool?
    /// The chat this ask was written in (additive, 2026-10): the phone opens it
    /// there, with its whole history and the cloud fallback. Absent for an ask
    /// started on the Mac, which opens as its session.
    var conversationId: String? = nil
}

/// The row's dot, with the Mac's meaning: done = the task is complete, running =
/// its session is running a turn, idle = a conversation is attached and not
/// running, todo = no session yet. A state a newer server adds decodes as
/// `.other` instead of failing the whole list.
enum AskState: Equatable, Hashable, Codable {
    case running, idle, done, todo
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "running": self = .running
        case "idle": self = .idle
        case "done": self = .done
        case "todo": self = .todo
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .running: return "running"
        case .idle: return "idle"
        case .done: return "done"
        case .todo: return "todo"
        case .other(let raw): return raw
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
