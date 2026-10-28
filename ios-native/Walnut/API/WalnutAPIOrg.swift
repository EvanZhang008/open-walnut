import Foundation

/// A task's own MEMORY.md (`GET /api/v1/tasks/:id/agent-memory`): the working memory the CEO or a
/// VP writes for itself. Read only here: the agent owns it.
struct AgentMemoryView: Codable {
    struct Memory: Codable {
        struct Refused: Codable {
            let at: String?
            let chars: Int
        }
        let text: String
        let at: String?
        let refused: Refused?
    }

    /// nil: it has written none.
    let memory: Memory?
    let chars: Int
    let softLimit: Int
    let limit: Int

    private enum CodingKeys: String, CodingKey {
        case memory, chars, limit
        case softLimit = "soft_limit"
    }
}

extension WalnutAPI {
    func agentMemory(taskId: String) async throws -> AgentMemoryView {
        try await get("/tasks/\(escape(taskId))/agent-memory")
    }

    /// The user's own standing instructions for the CEO or a VP; "" clears them. The agent reads
    /// them with its next message. Only the Mac writes them (a companion answers 501).
    func setOrgInstructions(taskId: String, text: String) async throws {
        struct Ack: Codable {}
        let _: Ack = try await send("PUT", "/org/nodes/\(escape(taskId))", body: ["instructions": text])
    }
}

/// `GET /api/v1/org` (additive, 2026-10): the org above the work, the CEO (Main) and one node per
/// project with its VP (lead). Only what the Chat drawer's org view reads; the teams under each
/// project are not decoded (their counts already are).
struct OrgTreeResponse: Decodable {
    let tree: OrgTreeWire
}

struct OrgTreeWire: Decodable, Equatable {
    var main: OrgNodeRefWire?
    var projects: [OrgProjectWire]
    var counts: OrgCountsWire
}

/// By the user's status (`src/core/user-status.ts`), the numbers every surface shows.
struct OrgCountsWire: Decodable, Equatable {
    var open = 0
    var running = 0
    var needsYou = 0
    var waiting = 0

    static func + (a: OrgCountsWire, b: OrgCountsWire) -> OrgCountsWire {
        OrgCountsWire(open: a.open + b.open, running: a.running + b.running,
                      needsYou: a.needsYou + b.needsYou, waiting: a.waiting + b.waiting)
    }
}

struct OrgNodeRefWire: Decodable, Equatable {
    let id: String
    let title: String
    let phase: String
    var hasSession: Bool? = nil
    /// The name the user gave a VP on the Org page (Task.org_name).
    var name: String? = nil
}

struct OrgProjectWire: Decodable, Equatable {
    /// "" = the Inbox.
    let project: String
    var lead: OrgNodeRefWire? = nil
    var needsLead: Bool? = nil
    /// Who the CEO talks to here now: the lead, else the project's one team.
    var contactId: String? = nil
    /// Led by another project's VP: that VP's own project.
    var vp: String? = nil
    var counts: OrgCountsWire
    /// The open work under the project; only the ids are read (for the row's last move).
    var teams: [OrgTeamNodeWire]? = nil
}

/// One task in a project's team tree, with its workers.
struct OrgTeamNodeWire: Decodable, Equatable {
    let id: String
    var workers: [OrgTeamNodeWire]? = nil

    /// This node and every worker under it.
    var allIds: [String] { [id] + (workers ?? []).flatMap(\.allIds) }
}

/// `POST /org/contact` and `POST /org/main` answer with the node's task; only its id is read.
struct OrgNodeTaskReply: Decodable {
    struct Brief: Decodable { let id: String; let title: String }
    let task: Brief
}

/// `POST /tasks/:id/start`: the new session's id (absent for an engine that names its own).
struct TaskStartReply: Decodable {
    let taskId: String
    let title: String
    var sessionId: String? = nil
}

extension WalnutAPI {
    /// The org tree, or nil when this server has no org (an older Mac or companion answers the
    /// unknown route with a plain 404, the demo server with its own): the drawer then shows only
    /// its list. Every server that has the route answers it, so any 404 means "no org here".
    func orgTree() async throws -> OrgTreeWire? {
        do {
            let reply: OrgTreeResponse = try await get("/org")
            return reply.tree
        } catch let error as APIError where Self.isMissingEndpoint(error) || Self.isNotFound(error) {
            return nil
        }
    }

    static func isNotFound(_ error: APIError) -> Bool {
        if case .server(let status, _, _, _, _) = error { return status == 404 }
        return false
    }

    /// Who the CEO talks to for a project: its VP, made on first contact when it has none yet.
    func orgContact(project: String) async throws -> String {
        let reply: OrgNodeTaskReply = try await send("POST", "/org/contact", body: ["to": project], timeout: 30)
        return reply.task.id
    }

    /// Main's task, made once.
    func orgMain() async throws -> String {
        let reply: OrgNodeTaskReply = try await send("POST", "/org/main", body: [String: String](), timeout: 30)
        return reply.task.id
    }

    /// Start a session for an existing task with its first message; the server finds its folder.
    func startTask(taskId: String, message: String) async throws -> TaskStartReply {
        try await send("POST", "/tasks/\(escape(taskId))/start", body: ["message": message], timeout: 60)
    }
}
