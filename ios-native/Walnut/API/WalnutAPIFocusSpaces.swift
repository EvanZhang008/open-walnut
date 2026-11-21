import Foundation

// MARK: - Focus spaces (server `src/core/focus-spaces/`, routes `focus-spaces-v1.ts`)
//
// A focus space names a few projects and tasks. While the person is in one, every list shows only
// the tasks inside it, and what is outside waits. The focus is ONE per person and held by the
// server, so the web and the phone see the same one. Behind the server experiment
// `focus_workspace`: off, every route answers `404 experiment_off`. Writes answer
// `501 not_supported_cloud` on the cloud companion. Doc: docs/reference/api-v1.md "Focus spaces".

/// What a focus lets through: project names and task ids (server `FocusScope`).
struct FocusSpaceScope: Codable, Equatable, Sendable {
    /// Project names, compared case-insensitively. The Inbox is "Inbox" ("" in older data).
    var projects: [String] = []
    /// Task ids; their subtasks (any depth, by `parent_task_id`) are inside too.
    var tasks: [String] = []

    init(projects: [String] = [], tasks: [String] = []) {
        self.projects = projects
        self.tasks = tasks
    }

    /// Tolerant: a missing list, or an element that is not a string, reads as nothing.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = Self.strings(c, .projects)
        tasks = Self.strings(c, .tasks)
    }

    private enum CodingKeys: String, CodingKey { case projects, tasks }

    private static func strings(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [String] {
        guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [String] = []
        while !list.isAtEnd {
            // superDecoder always moves to the next element, so one odd element is skipped.
            guard let element = try? list.superDecoder() else { break }
            if let value = try? String(from: element) { out.append(value) }
        }
        return out
    }

    // MARK: The scope rule (a port of server `taskInScope`, src/core/focus-spaces/scope.ts)

    /// What the rule needs of a task.
    struct Node: Equatable, Sendable {
        let project: String
        let parentTaskId: String?
    }

    /// Parent hops followed at most (the server's `SCOPE_MAX_HOPS`): a loop or a very deep tree
    /// stops here.
    static let maxHops = 12

    /// Is `taskId` inside? A task is inside when it is named, a subtask of a named task (any
    /// depth), or in a named project. A task the lookup does not know is outside unless it is
    /// named itself. A scope that names nothing lets nothing through.
    static func taskInScope(_ scope: FocusSpaceScope, taskId: String?, lookup: (String) -> Node?) -> Bool {
        Matcher(scope).contains(taskId, lookup: lookup)
    }

    /// The ids of `rows` inside the scope: one matcher and one id index for the whole list.
    static func insideIds(of rows: [WalnutTask], scope: FocusSpaceScope) -> Set<String> {
        var index: [String: Node] = [:]
        index.reserveCapacity(rows.count)
        for row in rows where index[row.id] == nil {
            index[row.id] = Node(project: row.project, parentTaskId: row.parentTaskId)
        }
        let matcher = Matcher(scope)
        var inside: Set<String> = []
        for row in rows where matcher.contains(row.id, lookup: { index[$0] }) {
            inside.insert(row.id)
        }
        return inside
    }

    /// One key per project: case-insensitive, and the Inbox's old "" is "inbox".
    static func projectKey(_ name: String) -> String {
        let key = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return key.isEmpty ? "inbox" : key
    }

    /// The scope's sets, built once for many questions.
    private struct Matcher {
        let tasks: Set<String>
        let projects: Set<String>

        init(_ scope: FocusSpaceScope) {
            tasks = Set(scope.tasks)
            projects = Set(scope.projects.map(FocusSpaceScope.projectKey))
        }

        func contains(_ taskId: String?, lookup: (String) -> Node?) -> Bool {
            guard let taskId, !taskId.isEmpty else { return false }
            if tasks.contains(taskId) { return true }
            var id: String? = taskId
            var seen: Set<String> = []
            var hop = 0
            while let current = id, !current.isEmpty, hop <= FocusSpaceScope.maxHops, !seen.contains(current) {
                seen.insert(current)
                if tasks.contains(current) { return true }
                guard let node = lookup(current) else { return false }
                if !projects.isEmpty, projects.contains(FocusSpaceScope.projectKey(node.project)) { return true }
                id = node.parentTaskId
                hop += 1
            }
            return false
        }
    }
}

/// A saved focus space (server `FocusSpace`). Only what the phone shows: its per-app modes are
/// the web's business and are not read.
struct FocusSpace: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    var projects: [String] = []
    var tasks: [String] = []
    var createdAt: String? = nil
    var updatedAt: String? = nil

    init(id: String, name: String, projects: [String] = [], tasks: [String] = []) {
        self.id = id
        self.name = name
        self.projects = projects
        self.tasks = tasks
    }

    /// `id` and `name` are needed; everything else reads as empty when it is odd.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        let scope = (try? FocusSpaceScope(from: decoder)) ?? FocusSpaceScope()
        projects = scope.projects
        tasks = scope.tasks
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case id, name, createdAt, updatedAt }
}

/// The focus the person is in (server `ActiveFocus`).
struct ActiveFocusSpace: Decodable, Equatable, Sendable {
    /// The saved space, when it is one.
    var spaceId: String? = nil
    let name: String
    let scope: FocusSpaceScope
    /// Epoch ms.
    let since: Double
    /// Epoch ms; nil = until left.
    var until: Double? = nil
    /// person | block | quick-bar | agent
    var by: String = "person"
    /// Who entered it when that is not the person (a plugin): only it ends it.
    var owner: String? = nil

    init(spaceId: String? = nil, name: String, scope: FocusSpaceScope, since: Double,
         until: Double? = nil, by: String = "person", owner: String? = nil) {
        self.spaceId = spaceId
        self.name = name
        self.scope = scope
        self.since = since
        self.until = until
        self.by = by
        self.owner = owner
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = (try? c.decodeIfPresent(String.self, forKey: .spaceId)) ?? nil
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? "Focus"
        scope = ((try? c.decodeIfPresent(FocusSpaceScope.self, forKey: .scope)) ?? nil) ?? FocusSpaceScope()
        since = ((try? c.decodeIfPresent(Double.self, forKey: .since)) ?? nil) ?? 0
        until = (try? c.decodeIfPresent(Double.self, forKey: .until)) ?? nil
        by = ((try? c.decodeIfPresent(String.self, forKey: .by)) ?? nil) ?? "person"
        owner = (try? c.decodeIfPresent(String.self, forKey: .owner)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case spaceId, name, scope, since, until, by, owner }

    var untilDate: Date? { until.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// Past its end at `now`.
    func hasEnded(at now: Date) -> Bool {
        guard let untilDate else { return false }
        return now >= untilDate
    }
}

/// `GET /api/v1/focus-spaces`. A bad space is dropped, never the whole list.
struct FocusSpacesListing: Decodable, Equatable, Sendable {
    var spaces: [FocusSpace] = []
    var active: ActiveFocusSpace? = nil

    init(spaces: [FocusSpace] = [], active: ActiveFocusSpace? = nil) {
        self.spaces = spaces
        self.active = active
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var rows: [FocusSpace] = []
        if var list = try? c.nestedUnkeyedContainer(forKey: .spaces) {
            while !list.isAtEnd {
                guard let element = try? list.superDecoder() else { break }
                if let space = try? FocusSpace(from: element) { rows.append(space) }
            }
        }
        spaces = rows
        active = (try? c.decodeIfPresent(ActiveFocusSpace.self, forKey: .active)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case spaces, active }
}

extension APIError {
    /// The focus routes are not there for this server: the experiment is off (`404
    /// experiment_off`), or the server predates them (a plain 404).
    var meansFocusSpacesOff: Bool {
        if case .server(let status, _, _, _, _) = self { return status == 404 }
        return false
    }
}

extension WalnutAPI {
    /// GET /api/v1/focus-spaces → `{ spaces, active, apps }`.
    func focusSpaces() async throws -> FocusSpacesListing {
        try await get("/focus-spaces")
    }

    /// PUT /api/v1/focus-spaces/active `{ spaceId, until? }` → `{ active }`. `until` is epoch ms
    /// within 24 h; nil = until the person leaves.
    func enterFocusSpace(spaceId: String, until: Date?) async throws -> ActiveFocusSpace? {
        struct Body: Encodable {
            let spaceId: String
            let until: Int64?
        }
        struct Answer: Decodable { let active: ActiveFocusSpace? }
        let ms = until.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) }
        let answer: Answer = try await send("PUT", "/focus-spaces/active", body: Body(spaceId: spaceId, until: ms), timeout: 30)
        return answer.active
    }

    /// DELETE /api/v1/focus-spaces/active → `{ ended }`.
    func leaveFocusSpace() async throws {
        struct Answer: Decodable {}
        let _: Answer = try await send("DELETE", "/focus-spaces/active", body: nil as [String: String]?, timeout: 30)
    }
}
