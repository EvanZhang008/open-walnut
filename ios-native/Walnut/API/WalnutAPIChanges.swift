import Foundation

// MARK: - The Changed page (/api/v1/sessions/:id/changes*, docs/reference/api-v1.md)

/// What a diff compares against. `.session` (the default) is this session's own
/// edits; the rest are git comparisons of the repos the session touched.
enum DiffCompare: Codable, Hashable {
    case session
    case uncommitted
    case remote
    case previous
    /// The branch since it split from `ref` (nil: the repo's default branch).
    case branch(ref: String?)
    /// One commit against its first parent.
    case commit(sha: String)

    var base: String {
        switch self {
        case .session: return "session"
        case .uncommitted: return "uncommitted"
        case .remote: return "remote"
        case .previous: return "previous"
        case .branch: return "branch"
        case .commit: return "commit"
        }
    }

    /// A branch or a commit spans the whole repo: its list is names only, and
    /// each file's diff is read from git on its own.
    var isWholeRepo: Bool {
        switch self {
        case .branch, .commit: return true
        default: return false
        }
    }

    /// The query a comparison adds ("" for the session's own edits).
    var queryItems: [(String, String)] {
        switch self {
        case .session: return []
        case .branch(let ref):
            return [("base", "branch")] + (ref.map { [("ref", $0)] } ?? [])
        case .commit(let sha): return [("base", "commit"), ("commit", sha)]
        default: return [("base", base)]
        }
    }

    /// Stable key for caches.
    var cacheKey: String {
        switch self {
        case .branch(let ref): return "branch:\(ref ?? "")"
        case .commit(let sha): return "commit:\(sha)"
        default: return base
        }
    }

    /// The label the Changed page shows for it.
    func label(defaultRef: String?) -> String {
        switch self {
        case .session: return "What this session changed"
        case .uncommitted: return "Uncommitted changes"
        case .remote: return "Not yet pushed"
        case .previous: return "Last commit and uncommitted"
        case .branch(let ref):
            let name = ref ?? defaultRef
            return name.map { "Branch vs \($0)" } ?? "Branch vs default branch"
        case .commit(let sha): return "Commit \(String(sha.prefix(7)))"
        }
    }
}

extension WalnutAPI {
    /// The files a session changed under `compare`, light: names and line counts,
    /// no content (each diff comes from `sessionFileChange`), so a lockfile in the
    /// working tree never rides along with the list.
    func sessionChanges(id: String, compare: DiffCompare, refresh: Bool = false) async throws -> SessionChangesResponse {
        var items = compare.queryItems
        items.append(("light", "1"))
        if refresh { items.append(("refresh", "1")) }
        return try await send("GET", "/sessions/\(escape(id))/changes\(Self.changesQuery(items))",
                              body: nil as [String: String]?, timeout: 60)
    }

    /// One file's full before/after. `repoRoot` is the list group's root (git comparisons).
    func sessionFileChange(id: String, path: String, compare: DiffCompare, repoRoot: String?) async throws -> SessionFileChangeResponse {
        var items: [(String, String)] = [("path", path)]
        if compare != .session {
            items += compare.queryItems
            if let repoRoot, !repoRoot.isEmpty { items.append(("repo", repoRoot)) }
        }
        return try await send("GET", "/sessions/\(escape(id))/changes/file\(Self.changesQuery(items))",
                              body: nil as [String: String]?, timeout: 60)
    }

    /// The branches and recent commits a comparison can pick.
    func sessionGitRefs(id: String) async throws -> SessionGitRefs {
        try await send("GET", "/sessions/\(escape(id))/changes/refs", body: nil as [String: String]?, timeout: 45)
    }

    /// `?a=1&b=2`, each value fully escaped ("" when there is nothing).
    static func changesQuery(_ items: [(String, String)]) -> String {
        guard !items.isEmpty else { return "" }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return "?" + items.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
        }.joined(separator: "&")
    }
}
