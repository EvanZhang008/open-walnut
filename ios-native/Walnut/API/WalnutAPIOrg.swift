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

/// The org's settings (`GET /api/v1/org/settings`), only the part this app reads: Walnut's default
/// core instructions for the CEO and a VP (nil from a server older than them), and how Directors
/// show (additive, 2026-11-20; absent = off, `DirectorsSettings`).
struct OrgSettingsView: Codable {
    struct Defaults: Codable {
        let main: String
        let lead: String
    }
    let defaultInstructions: Defaults?
    var directorsEnabled: Bool? = nil
    /// `fold` or `sections`; an unknown word reads as `fold`.
    var directorsLayout: String? = nil
    var directorsShowProjects: Bool? = nil

    init(defaultInstructions: Defaults?, directorsEnabled: Bool? = nil, directorsLayout: String? = nil, directorsShowProjects: Bool? = nil) {
        self.defaultInstructions = defaultInstructions
        self.directorsEnabled = directorsEnabled
        self.directorsLayout = directorsLayout
        self.directorsShowProjects = directorsShowProjects
    }

    private enum CodingKeys: String, CodingKey {
        case defaultInstructions, directorsEnabled, directorsLayout, directorsShowProjects
    }

    /// Lenient: a field of another type (a newer server) reads as absent, never a failed read.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultInstructions = try c.decodeIfPresent(Defaults.self, forKey: .defaultInstructions)
        directorsEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .directorsEnabled)) ?? nil
        directorsLayout = (try? c.decodeIfPresent(String.self, forKey: .directorsLayout)) ?? nil
        directorsShowProjects = (try? c.decodeIfPresent(Bool.self, forKey: .directorsShowProjects)) ?? nil
    }
}

extension WalnutAPI {
    func orgSettings() async throws -> OrgSettingsView {
        try await get("/org/settings")
    }

    func agentMemory(taskId: String) async throws -> AgentMemoryView {
        try await get("/tasks/\(escape(taskId))/agent-memory")
    }

    /// The user's own core instructions for the CEO or a VP; "" clears them, and so do the role's
    /// default words (the role keeps following the default). The agent reads them with its next
    /// message. Only the Mac writes them (a companion answers 501).
    func setOrgInstructions(taskId: String, text: String) async throws {
        struct Ack: Codable {}
        let _: Ack = try await send("PUT", "/org/nodes/\(escape(taskId))", body: ["instructions": text])
    }
}

/// `GET /api/v1/org` (additive, 2026-10): the org above the work, the CEO (Main) and one node per
/// project with its VP (lead). Only what the Chat drawer's org view reads: the counts, and of the
/// teams under each project their ids and what its Directors show.
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
    /// To read: finished or answered with nothing asked (additive, 2026-11-02). Absent from an
    /// older server, which counts those tasks under `waiting`.
    var toRead: Int? = nil

    /// What there is to read; 0 from a server that sends no such count.
    var read: Int { toRead ?? 0 }

    private enum CodingKeys: String, CodingKey {
        case open, running, needsYou, waiting, toRead
        case readAlias = "read"
    }

    init(open: Int = 0, running: Int = 0, needsYou: Int = 0, waiting: Int = 0, toRead: Int? = nil) {
        self.open = open
        self.running = running
        self.needsYou = needsYou
        self.waiting = waiting
        self.toRead = toRead
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = try c.decode(Int.self, forKey: .open)
        running = try c.decode(Int.self, forKey: .running)
        needsYou = try c.decode(Int.self, forKey: .needsYou)
        waiting = try c.decode(Int.self, forKey: .waiting)
        // The server names it `toRead`; `read` is read too, so either spelling counts.
        toRead = (try? c.decodeIfPresent(Int.self, forKey: .toRead))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .readAlias)) ?? nil
    }

    static func + (a: OrgCountsWire, b: OrgCountsWire) -> OrgCountsWire {
        // Absent on both sides stays absent: an older server's counts never read "0 To read".
        let read: Int? = a.toRead == nil && b.toRead == nil ? nil : a.read + b.read
        return OrgCountsWire(open: a.open + b.open, running: a.running + b.running,
                             needsYou: a.needsYou + b.needsYou, waiting: a.waiting + b.waiting, toRead: read)
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
    /// What a Director row shows (additive; absent from an older server).
    var title: String? = nil
    var project: String? = nil
    var phase: String? = nil
    /// The server's user state word (`needs`, `read`, `working`, `waiting`, `done`).
    var userState: String? = nil
    /// A Director under its VP (additive, 2026-11-20; `DirectorRule`). Absent = not one.
    var director: Bool? = nil

    init(id: String, workers: [OrgTeamNodeWire]? = nil, title: String? = nil, project: String? = nil,
         phase: String? = nil, userState: String? = nil, director: Bool? = nil) {
        self.id = id
        self.workers = workers
        self.title = title
        self.project = project
        self.phase = phase
        self.userState = userState
        self.director = director
    }

    private enum CodingKeys: String, CodingKey {
        case id, workers, title, project, phase, userState, director
    }

    /// Lenient past the id: a field of another type reads as absent, so the org still loads.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workers = try c.decodeIfPresent([OrgTeamNodeWire].self, forKey: .workers)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? nil
        phase = (try? c.decodeIfPresent(String.self, forKey: .phase)) ?? nil
        userState = (try? c.decodeIfPresent(String.self, forKey: .userState)) ?? nil
        director = (try? c.decodeIfPresent(Bool.self, forKey: .director)) ?? nil
    }

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

// MARK: - Org avatars

extension WalnutAPI {
    /// The sizes the server draws (`GET /org/avatars/:taskId.png?size=`, clamped there too).
    static let orgAvatarPixels = 16...512

    /// `GET /api/v1/org/avatars/<taskId>.png?size=<px>`: the avatar the Org page shows for a task,
    /// drawn `pixels` wide. The id is one path segment, so a `/` in it is escaped too.
    static func orgAvatarURL(base: URL, taskId: String, pixels: Int) -> URL? {
        var segment = CharacterSet.urlPathAllowed
        segment.remove(charactersIn: "/")
        guard !taskId.isEmpty, let id = taskId.addingPercentEncoding(withAllowedCharacters: segment) else { return nil }
        var root = base.absoluteString
        while root.hasSuffix("/") { root.removeLast() }
        var components = URLComponents(string: root + "/api/v1/org/avatars/\(id).png")
        let size = min(max(pixels, orgAvatarPixels.lowerBound), orgAvatarPixels.upperBound)
        components?.queryItems = [URLQueryItem(name: "size", value: String(size))]
        return components?.url
    }

    /// The task's avatar PNG, or nil when the server has none to give (404: a plain task, which wears none, the task is gone,
    /// an older server without the route, or one where the avatars were still an experiment and off). Any other
    /// answer throws, so a caller can keep what it showed and ask again later.
    func orgAvatarPNG(taskId: String, pixels: Int) async throws -> Data? {
        guard let base = AppConfig.serverURL, let token = AppConfig.token,
              let url = Self.orgAvatarURL(base: base, taskId: taskId, pixels: pixels) else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.authorizeForWalnut(token: token)
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        switch http.statusCode {
        case 200: return data
        case 404: return nil
        default:
            throw APIError.server(status: http.statusCode, code: "http_error",
                                  message: "Server returned \(http.statusCode)", serverHash: nil, serverContent: nil)
        }
    }
}
