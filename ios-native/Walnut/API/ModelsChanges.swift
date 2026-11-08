import Foundation

// MARK: - The Changed page's wire shapes (/api/v1/sessions/:id/changes*)

/// GET /v1/sessions/:id/changes: the files a session changed, grouped by repo.
/// A light list (`light: true`) carries no `before`/`after`; each file's diff
/// comes from `changes/file`.
struct SessionChangesResponse: Codable, Equatable {
    let sessionId: String?
    let groups: [SessionChangeGroup]
    let fileCount: Int?
    let anyPartial: Bool?
    /// Served from the server's last copy while it recomputes: ask again soon.
    let stale: Bool?
    let light: Bool?

    init(sessionId: String?, groups: [SessionChangeGroup], fileCount: Int? = nil, anyPartial: Bool? = nil,
         stale: Bool? = nil, light: Bool? = nil) {
        self.sessionId = sessionId
        self.groups = groups
        self.fileCount = fileCount
        self.anyPartial = anyPartial
        self.stale = stale
        self.light = light
    }

    var files: [SessionChangedFile] { groups.flatMap(\.files) }
}

/// One repo's changed files.
struct SessionChangeGroup: Codable, Equatable {
    let repoRoot: String
    let label: String
    let kind: String?
    let files: [SessionChangedFile]
    /// Branch and commit comparisons: what the comparison resolved to.
    let compare: SessionGitCompareInfo?
}

struct SessionGitCompareInfo: Codable, Equatable {
    let base: String
    let ref: String?
    let isDefault: Bool?
    let baseSha: String?
    let commit: SessionGitCommit?
}

/// One changed file. `before`/`after` are "" on a light list.
struct SessionChangedFile: Codable, Equatable, Hashable, Identifiable {
    let filePath: String
    let relPath: String
    var before: String
    var after: String
    /// added | modified | deleted | renamed
    let status: String
    let oldRelPath: String?
    /// The session's before/after could not be fully rebuilt (the file changed
    /// on disk after the edit): its diff is a best effort.
    var partial: Bool?
    /// Line counts ("+12 -3"); absent when the server had no content to count.
    let additions: Int?
    let deletions: Int?
    /// Every change in this file is whitespace (a git comparison's names-only list).
    let wsOnly: Bool?

    var id: String { filePath }

    init(filePath: String, relPath: String, before: String = "", after: String = "", status: String,
         oldRelPath: String? = nil, partial: Bool? = nil, additions: Int? = nil, deletions: Int? = nil,
         wsOnly: Bool? = nil) {
        self.filePath = filePath
        self.relPath = relPath
        self.before = before
        self.after = after
        self.status = status
        self.oldRelPath = oldRelPath
        self.partial = partial
        self.additions = additions
        self.deletions = deletions
        self.wsOnly = wsOnly
    }

    private enum CodingKeys: String, CodingKey {
        case filePath, relPath, before, after, status, oldRelPath, partial, additions, deletions, wsOnly
    }

    /// Tolerant: a field an older server leaves out never fails the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        filePath = try c.decode(String.self, forKey: .filePath)
        relPath = (try? c.decodeIfPresent(String.self, forKey: .relPath))
            ?? (filePath as NSString).lastPathComponent
        before = (try? c.decodeIfPresent(String.self, forKey: .before)) ?? ""
        after = (try? c.decodeIfPresent(String.self, forKey: .after)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "modified"
        oldRelPath = try? c.decodeIfPresent(String.self, forKey: .oldRelPath)
        partial = try? c.decodeIfPresent(Bool.self, forKey: .partial)
        additions = try? c.decodeIfPresent(Int.self, forKey: .additions)
        deletions = try? c.decodeIfPresent(Int.self, forKey: .deletions)
        wsOnly = try? c.decodeIfPresent(Bool.self, forKey: .wsOnly)
    }

    var fileName: String { (relPath as NSString).lastPathComponent }

    /// The folder part of the repo-relative path ("" at the repo root).
    var directory: String {
        let dir = (relPath as NSString).deletingLastPathComponent
        return dir == "." ? "" : dir
    }

    /// The same file with its content (the per-file read's answer, whose
    /// `partial` is the one that holds for that content).
    func withContent(before: String, after: String, partial: Bool? = nil) -> SessionChangedFile {
        var copy = self
        copy.before = before
        copy.after = after
        if let partial { copy.partial = partial }
        return copy
    }

    /// A NUL byte means binary content: no line diff of it means anything.
    var isBinary: Bool { before.contains("\0") || after.contains("\0") }
}

/// GET /v1/sessions/:id/changes/file
struct SessionFileChangeResponse: Codable, Equatable {
    let sessionId: String?
    let repoRoot: String?
    let file: SessionChangedFile
}

/// GET /v1/sessions/:id/changes/refs: what a branch or commit comparison can use.
struct SessionGitRefs: Codable, Equatable {
    let repoRoot: String?
    let current: String?
    let head: String?
    let defaultRef: String?
    let refs: [SessionGitRef]
    let commits: [SessionGitCommit]

    init(repoRoot: String?, current: String?, head: String?, defaultRef: String?,
         refs: [SessionGitRef], commits: [SessionGitCommit]) {
        self.repoRoot = repoRoot
        self.current = current
        self.head = head
        self.defaultRef = defaultRef
        self.refs = refs
        self.commits = commits
    }

    private enum CodingKeys: String, CodingKey { case repoRoot, current, head, defaultRef, refs, commits }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repoRoot = try? c.decodeIfPresent(String.self, forKey: .repoRoot)
        current = try? c.decodeIfPresent(String.self, forKey: .current)
        head = try? c.decodeIfPresent(String.self, forKey: .head)
        defaultRef = try? c.decodeIfPresent(String.self, forKey: .defaultRef)
        refs = (try? c.decodeIfPresent([SessionGitRef].self, forKey: .refs)) ?? []
        commits = (try? c.decodeIfPresent([SessionGitCommit].self, forKey: .commits)) ?? []
    }
}

struct SessionGitRef: Codable, Equatable, Hashable {
    let name: String
    /// local | remote
    let kind: String?
    let sha: String?
    /// Unix seconds.
    let time: Double?
}

struct SessionGitCommit: Codable, Equatable, Hashable {
    let sha: String
    let parent: String?
    let parents: Int?
    let author: String?
    /// Committer time, unix seconds.
    let time: Double?
    let subject: String?
    /// On this branch, not yet on the default branch.
    let onBranch: Bool?
}
