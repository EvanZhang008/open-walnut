import Foundation

// MARK: - Task mutation transport (mock seam for WalnutTests)
//
// The stores drive every task/session mutation through this narrow protocol
// instead of concrete WalnutAPI calls, so WalnutTests can exercise the REAL
// optimistic apply/rollback state machines against a scripted transport
// (success, failure → revert, slow round trip, partial batch failure) without
// a network. WalnutAPI is the live implementation — the requirements match
// its existing endpoint methods 1:1, so conformance is an empty extension.

protocol WalnutTaskTransport {
    // Task list + edits
    func tasks() async throws -> TasksResponse
    /// Create. `pin` carries the create-time placement (`pinned` + `focus_tier`
    /// per TaskPinChoice) so tests can assert WHAT a header `+` sent — the
    /// difference between a task born in Focus and one silently filed in
    /// Satellite is exactly one field on this call.
    func createTask(
        title: String, project: String?, priority: String?,
        dueDate: String?, startDate: String?, endDate: String?,
        description: String?, pin: TaskPinChoice
    ) async throws -> WalnutTask
    func updateTask(
        id: String, status: String?, priority: String?, dueDate: String?,
        startDate: String?, endDate: String?,
        project: String?, title: String?, description: String?
    ) async throws -> WalnutTask
    func batchSetPhase(taskIds: [String], phase: String) async throws -> BatchPhaseResult
    func batchDeleteTasks(taskIds: [String], force: Bool) async throws -> BatchDeleteResult

    // Detail plane (star / delete / long-text fields)
    func taskDetail(id: String) async throws -> TaskDetail
    func deleteTask(id: String, force: Bool) async throws
    func toggleTaskStar(id: String) async throws -> Bool
    func setTaskField(id: String, field: String, content: String) async throws

    // Focus pins + tiers
    func pinTask(id: String) async throws -> [String]
    func unpinTask(id: String) async throws -> [String]
    func setTaskFocusTier(id: String, tier: String) async throws -> FocusTierResult
    func focusTasks() async throws -> FocusTierResult
    func focusTiers() async throws -> [FocusTierInfo]

    // The project→folder hierarchy (read-only on the phone; see TaskFolder)
    func taskFolders() async throws -> [TaskFolder]

    // Session metadata (rename / archive)
    func patchSession(id: String, title: String?, archived: Bool?, mode: String?) async throws -> SessionPatched
}

extension WalnutTaskTransport {
    /// Default: NO folders, i.e. the flat by-project board.
    ///
    /// A default rather than a requirement every conformer must restate, because
    /// "no hierarchy" is the correct answer for a transport that does not have one
    /// (a scripted test transport, or a server predating the endpoint) and it is the
    /// same answer the live path degrades to when the request fails. The board's
    /// fallback is therefore exercised by every existing store test for free.
    func taskFolders() async throws -> [TaskFolder] { [] }
}

/// One custom tier from `GET /v1/focus/tiers` → `{ "tiers": [ { id, label } ] }`.
/// `id` is a `ct_*` stable id; tasks reference it via `focus_tier`.
struct FocusTierInfo: Codable, Equatable, Identifiable {
    let id: String
    let label: String
}

/// One FOLDER from `GET /api/v1/tasks/groups` → `{ "groups": [ … ] }`.
///
/// This is the whole task hierarchy, and it is the ONLY place the phone can read it:
/// the slim task projection (`GET /v1/tasks` → `WalnutTask`) carries no `group_id`, so
/// task→folder is answered by INVERTING `memberIds` (see `BoardFolderIndex`), never by
/// a field on the row.
///
/// The shape the server stores, stated once so nothing downstream has to guess:
///
///  - `project` is the folder→PROJECT edge, and a folder belongs to exactly ONE project
///    (`""` = Inbox). Moving a task to another project clears its folder server-side, so
///    a folder never follows a task out of its project. That is why the board nests
///    projects OUTSIDE folders and not the other way round.
///  - `parentId` is the folder→folder edge (nesting, server-capped). The phone reads it
///    but draws ONE folder level today: every folder in the field data has no parent, and
///    a depth the data does not exercise would be untested chrome. It is decoded so the
///    day it is used, the wire shape does not have to change.
///  - `memberIds` is the folder→tasks edge, and an EMPTY folder is valid (the server
///    returns the union of the registry and membership, so a created-but-unfilled folder
///    is listed). The pinned board draws no band for one — it has no rows to show and no
///    create ring that could file INTO it (see below).
///  - `hidden` is the desktop list's "collapse this folder into a chip" affordance. The
///    phone decodes it and deliberately does NOT drop the rows: this board's contract is
///    that a pinned task always has a row somewhere, and honouring `hidden` would break
///    that in the one place nobody would look.
///
/// WRITES are not part of this: v1 has no folder write at all (the console's own router
/// owns create/re-parent/delete), and on a REPLICA every folder write answers 501. So on
/// the phone the hierarchy is strictly read-only, which is exactly why a folder band on
/// the board carries no create affordance.
///
/// Decoding is defensive on every field except `groupId`: a server that omits `hidden` or
/// `member_ids` should cost the phone that ONE fact, not the entire hierarchy (a thrown
/// decode error blanks all 60 folders and silently degrades the board to flat).
struct TaskFolder: Codable, Equatable, Identifiable {
    let groupId: String
    let label: String
    let hidden: Bool
    let memberIds: [String]
    /// The project this folder lives in. `""` = Inbox.
    let project: String
    /// Parent folder id, when this folder is nested.
    let parentId: String?

    var id: String { groupId }

    private enum CodingKeys: String, CodingKey {
        case groupId = "group_id"
        case label
        case hidden
        case memberIds = "member_ids"
        case project
        case parentId = "parent_id"
    }

    init(
        groupId: String, label: String, hidden: Bool = false,
        memberIds: [String] = [], project: String = "", parentId: String? = nil
    ) {
        self.groupId = groupId
        self.label = label
        self.hidden = hidden
        self.memberIds = memberIds
        self.project = project
        self.parentId = parentId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupId = try container.decode(String.self, forKey: .groupId)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        memberIds = try container.decodeIfPresent([String].self, forKey: .memberIds) ?? []
        project = try container.decodeIfPresent(String.self, forKey: .project) ?? ""
        parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
    }
}

extension WalnutAPI {
    /// GET /api/v1/focus/tiers — the custom tier registry (ordered). Built-in
    /// tiers (focus/satellite/backlog/wait) are implicit and never listed here.
    func focusTiers() async throws -> [FocusTierInfo] {
        struct Wrapper: Codable { let tiers: [FocusTierInfo] }
        let wrapper: Wrapper = try await get("/focus/tiers")
        return wrapper.tiers
    }

    /// GET /api/v1/tasks/groups — every folder, empty ones included.
    ///
    /// ONE request for the WHOLE hierarchy, which is the reason this endpoint is
    /// usable from a phone at all: the alternative (ask each task which folder it is
    /// in) does not exist on the wire, and inventing it per row would be a fan-out
    /// over the pinned set on every refresh.
    ///
    /// Reads work on a REPLICA as well as on a primary, so a phone paired to the cloud
    /// companion gets the same tree the Mac console draws.
    func taskFolders() async throws -> [TaskFolder] {
        struct Wrapper: Codable { let groups: [TaskFolder] }
        let wrapper: Wrapper = try await get("/tasks/groups")
        return wrapper.groups
    }
}

extension WalnutAPI: WalnutTaskTransport {}
