import Foundation

/// Path picking logic for the session launcher: fuzzy scoring, frecency, one
/// ranker for every input state, section building, and the identity helpers the
/// chips are keyed by.
///
/// This is a PORT. The web console owns the behavior and these are the source
/// files it must stay byte-for-byte compatible with:
///   web/src/utils/fuzzy.ts                                  (tokenize, isSubsequence, fuzzyScore, matchQuality)
///   web/src/components/sessions/path-selector/ranking.ts    (frecencyScore, rankCandidates, buildSections)
///   web/src/components/sessions/path-selector/input-model.ts (classifyInput, parentDirOf, deleteLastSegment, resolveSpaceAmbiguity)
///   web/src/components/sessions/DraftLaunchBar.tsx          (chipKey, basename, pathLabel)
/// Change one side, change the other, or the phone and the console will rank
/// the same directories differently.
///
/// Everything here is pure: no SwiftUI, no networking, no clock of its own
/// (callers inject `now`), and every type is a Sendable value type.

// MARK: - Fuzzy primitives (fuzzy.ts)

enum PathFuzzy {

    /// Lowercase alphanumeric tokens. Path separators and all punctuation are
    /// boundaries, so "a/b-c_d" becomes ["a","b","c","d"]. Mirrors the TS
    /// `s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)`: the input is
    /// lowercased first, so anything outside a-z0-9 (including non-ASCII) splits.
    static func tokenize(_ s: String) -> [String] {
        s.lowercased().split(whereSeparator: { !isTokenChar($0) }).map(String.init)
    }

    /// Exactly the TS character class: a-z and 0-9 after lowercasing. Checked by
    /// ASCII value so a non-ASCII letter (which `[^a-z0-9]` also splits on) is a
    /// separator here too.
    private static func isTokenChar(_ c: Character) -> Bool {
        guard let a = c.asciiValue else { return false }
        return (a >= 97 && a <= 122) || (a >= 48 && a <= 57)
    }

    /// Does `q` appear in order (not necessarily contiguously) within `p`?
    static func isSubsequence(_ q: String, _ p: String) -> Bool {
        if q.isEmpty { return true }
        var qi = q.startIndex
        for ch in p where ch == q[qi] {
            qi = q.index(after: qi)
            if qi == q.endIndex { return true }
        }
        return false
    }

    /// Token-aware relevance, 0 = no signal. Signals are CUMULATIVE (a path can
    /// earn several at once), weights strongest first:
    ///   +10 whole query is a substring of the full path
    ///   +6  whole query is a substring of the last segment
    ///   +4  per query token equal to a path token, ELSE +2 per token that is a
    ///       substring of some path token
    ///   +2  per query token present in the last segment's tokens (independent
    ///       of the +4/+2 branch above, so it stacks)
    ///   +1  loose subsequence fallback, only when nothing else scored
    static func fuzzyScore(_ query: String, _ path: String) -> Int {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return 0 }
        let p = path.lowercased()
        let lastSeg = suffixAfterLastSlash(p)

        var score = 0
        if p.contains(q) { score += 10 }
        if lastSeg.contains(q) { score += 6 }

        let qTokens = tokenize(query)          // array, so a repeated token counts twice
        let pTokens = Set(tokenize(path))
        let lastTokens = Set(tokenize(lastSeg))
        for qt in qTokens {
            if pTokens.contains(qt) { score += 4 }
            else if pTokens.contains(where: { $0.contains(qt) }) { score += 2 }
            if lastTokens.contains(qt) { score += 2 }
        }

        if score == 0, isSubsequence(q, p) { score += 1 }
        return score
    }

    /// Everything after the last "/" (the whole string when there is none). No
    /// trailing-slash trimming: this matches the TS slice exactly, so a path
    /// ending in "/" has an EMPTY last segment here.
    static func suffixAfterLastSlash(_ s: String) -> String {
        guard let i = s.lastIndex(of: "/") else { return s }
        return String(s[s.index(after: i)...])
    }
}

/// How well a needle matches a haystack, best to worst. Case-insensitive, and
/// an empty needle counts as `.prefix` (it matches everything).
enum MatchQuality: String, Sendable {
    case prefix, substring, subsequence, none

    var rank: Int {
        switch self {
        case .prefix: return 3
        case .substring: return 2
        case .subsequence: return 1
        case .none: return 0
        }
    }

    static func of(needle: String, hay: String) -> MatchQuality {
        let n = needle.lowercased()
        let h = hay.lowercased()
        if n.isEmpty { return .prefix }
        if h.hasPrefix(n) { return .prefix }
        if h.contains(n) { return .substring }
        if PathFuzzy.isSubsequence(n, h) { return .subsequence }
        return Self.none   // qualified: a bare `.none` reads as Optional.none to the compiler
    }
}

// MARK: - Input classification (input-model.ts)

/// The four input states of the path field:
///   browse        "walnut"          no "/" or "~", fuzzy over history only
///   dirBrowse     "/a/b/c/"         trailing slash, list every child of c/
///   segment       "/a/b/c"          last segment completes against b/'s children
///   scopedSearch  "/a/b keyword"    keyword searched under base /a/b
enum PathInputState: Equatable, Sendable {
    case browse(query: String)
    case dirBrowse(dir: String)
    case segment(dir: String, partial: String)
    case scopedSearch(base: String, keyword: String)
}

enum PathInput {

    private static func isPathLike(_ raw: String) -> Bool {
        raw.hasPrefix("/") || raw.hasPrefix("~")
    }

    /// Space rule: the token after the LAST space is a keyword only when it holds
    /// no "/", because directory names may contain spaces. `lastSpace > 0` in the
    /// TS means a leading space never triggers the keyword split, so a space at
    /// index 0 falls through to the path branches.
    static func classifyInput(_ raw: String) -> PathInputState {
        guard isPathLike(raw) else { return .browse(query: raw) }

        if let space = raw.lastIndex(of: " "), space != raw.startIndex {
            let before = String(raw[raw.startIndex..<space])
            let after = String(raw[raw.index(after: space)...])
            if !after.isEmpty, !after.contains("/"), isPathLike(before) {
                let base = before.hasSuffix("/") ? before : before + "/"
                return .scopedSearch(base: base, keyword: after)
            }
        }

        if raw.hasSuffix("/") { return .dirBrowse(dir: raw) }

        guard let slash = raw.lastIndex(of: "/") else { return .browse(query: raw) }
        let cut = raw.index(after: slash)
        return .segment(dir: String(raw[raw.startIndex..<cut]), partial: String(raw[cut...]))
    }

    /// Once the base's live children are known, a space may turn out to be part
    /// of a real directory name. An exact hit becomes dirBrowse, a child that
    /// merely EXTENDS the spaced string means the user is mid-typing that name.
    static func resolveSpaceAmbiguity(state: PathInputState, childrenOfBase: [String]) -> PathInputState {
        guard case .scopedSearch(let base, let keyword) = state else { return state }
        // Only ONE trailing slash is stripped here (the TS regex is /\/$/).
        let literal = (base.hasSuffix("/") ? String(base.dropLast()) : base) + " " + keyword
        let literalLower = literal.lowercased()
        for child in childrenOfBase {
            let childLower = (child.hasSuffix("/") ? String(child.dropLast()) : child).lowercased()
            if childLower == literalLower {
                return .dirBrowse(dir: child.hasSuffix("/") ? child : child + "/")
            }
            if childLower.hasPrefix(literalLower) {
                guard let slash = literal.lastIndex(of: "/") else {
                    return .segment(dir: "", partial: literal)
                }
                let cut = literal.index(after: slash)
                return .segment(dir: String(literal[literal.startIndex..<cut]),
                                partial: String(literal[cut...]))
            }
        }
        return state
    }

    /// Option+Backspace: drop the last segment, keep the trailing slash.
    /// "/a/b/c" and "/a/b/c/" both give "/a/b/", "/a" gives "/", "/" stays "/",
    /// and a string with no slash at all clears to "".
    static func deleteLastSegment(_ path: String) -> String {
        if path.isEmpty { return path }
        var p = Substring(path)
        while p.count > 1, p.hasSuffix("/") { p = p.dropLast() }
        guard let slash = p.lastIndex(of: "/") else { return "" }
        return String(p[p.startIndex...slash])
    }

    /// Which directory's children should be listed. browse has no live listing.
    static func parentDirOf(_ state: PathInputState) -> String? {
        switch state {
        case .browse: return nil
        case .dirBrowse(let dir): return dir
        case .segment(let dir, _): return dir
        case .scopedSearch(let base, _): return base
        }
    }
}

// MARK: - Candidates

enum PathCandidateSource: String, Sendable {
    /// From a directory listing (confirmed to exist).
    case live
    /// A frequent-dirs history entry.
    case history
}

struct PathCandidate: Identifiable, Equatable, Sendable {
    struct HistoryEntry: Equatable, Sendable {
        var count: Int
        var lastUsed: String
    }

    var cwd: String
    /// nil (or "", the wire's local spelling) = the primary box.
    var host: String?
    var hostLabel: String?
    var source: PathCandidateSource
    /// Depth relative to the listed parent (1 = direct child), 0 for history-only.
    var depth: Int
    /// Set when this cwd is ALSO a history entry (marker plus frecency source).
    var history: HistoryEntry?

    var id: String { PathRanking.pathChipKey(cwd: cwd, host: host) }
    var hostKey: String { PathRanking.normalizedHost(host) ?? PathRanking.localHostKey }
}

struct RankedPath: Identifiable, Equatable, Sendable {
    var candidate: PathCandidate
    var quality: MatchQuality
    var leafHit: Bool
    var frecency: Double

    var id: String { candidate.id }
    var cwd: String { candidate.cwd }
    var host: String? { candidate.host }
    var hostLabel: String? { candidate.hostLabel }
    var source: PathCandidateSource { candidate.source }
    var depth: Int { candidate.depth }
    var history: PathCandidate.HistoryEntry? { candidate.history }
    var hostKey: String { candidate.hostKey }
}

struct PathSection: Identifiable, Equatable, Sendable {
    var id: String
    var label: String
    var hostKey: String
    var items: [RankedPath]
}

// MARK: - Ranking (ranking.ts) + identity helpers (DraftLaunchBar.tsx)

enum PathRanking {

    static let localHostKey = "__local__"
    static let historySectionLabel = "🕘 history"
    static let liveSectionLabel = "📁 subdirectories"
    static let localSectionLabel = "Local"

    /// Count decayed with a 7-day half-life.
    static let frecencyHalfLife: TimeInterval = 7 * 24 * 60 * 60
    private static let ln2 = 0.6931471805599453

    static func frecencyScore(count: Int, lastUsed: Date, now: Date = Date()) -> Double {
        let age = max(0, now.timeIntervalSince(lastUsed))
        return Double(count) * exp(-(age * ln2) / frecencyHalfLife)
    }

    /// ISO overload. The TS yields NaN for an unparseable stamp, which then
    /// poisons every comparison it touches; here an unparseable stamp scores 0
    /// (no history signal), which is the intent of the sort keys.
    static func frecencyScore(count: Int, lastUsedISO: String, now: Date = Date()) -> Double {
        guard let date = WalnutTask.parseISO(lastUsedISO) else { return 0 }
        return frecencyScore(count: count, lastUsed: date, now: now)
    }

    /// The needle a state matches candidates against ("" admits everything).
    static func needleOf(_ state: PathInputState) -> String {
        switch state {
        case .browse(let query): return query.trimmingCharacters(in: .whitespacesAndNewlines)
        case .dirBrowse: return ""
        case .segment(_, let partial): return partial
        case .scopedSearch(_, let keyword): return keyword
        }
    }

    /// Leaf segment, tolerant of trailing slashes (unlike fuzzyScore's lastSeg).
    static func leafOf(_ cwd: String) -> String {
        var p = Substring(cwd)
        while p.hasSuffix("/") { p = p.dropLast() }
        guard let slash = p.lastIndex(of: "/") else { return String(p) }
        return String(p[p.index(after: slash)...])
    }

    /// Sort keys, in priority order. Relevance dominates and history only
    /// tiebreaks, so "what you typed" outranks "where you've been":
    ///   1. leaf-segment hit before mid-path hit
    ///   2. match quality (prefix > substring > subsequence)
    ///   3. in history at all, then by frecency when BOTH are in history
    ///   4. shallower depth, then alphabetical cwd
    ///
    /// Admission rule: a LIVE deep candidate whose only match is a middle segment
    /// is noise unless it is also in history, so it is dropped entirely.
    static func rankCandidates(state: PathInputState,
                               candidates: [PathCandidate],
                               now: Date = Date()) -> [RankedPath] {
        let needle = needleOf(state)
        var ranked: [RankedPath] = []

        for c in candidates {
            let frecency = c.history.map {
                frecencyScore(count: $0.count, lastUsedISO: $0.lastUsed, now: now)
            } ?? 0

            if needle.isEmpty {
                ranked.append(RankedPath(candidate: c, quality: .prefix, leafHit: true, frecency: frecency))
                continue
            }
            let leafQ = MatchQuality.of(needle: needle, hay: leafOf(c.cwd))
            if leafQ != MatchQuality.none {
                ranked.append(RankedPath(candidate: c, quality: leafQ, leafHit: true, frecency: frecency))
                continue
            }
            // Leaf missed, so try the rest of the path. browse matches loosely
            // across the whole path (multi-token fuzzy), path modes demand a real
            // quality band on the path string.
            let pathQ: MatchQuality
            if case .browse = state {
                pathQ = PathFuzzy.fuzzyScore(needle, c.cwd) > 0 ? MatchQuality.substring : MatchQuality.none
            } else {
                pathQ = MatchQuality.of(needle: needle, hay: c.cwd)
            }
            if pathQ == MatchQuality.none { continue }
            if c.source == .live, c.history == nil { continue }   // admission rule
            ranked.append(RankedPath(candidate: c, quality: pathQ, leafHit: false, frecency: frecency))
        }

        // JS Array#sort is stable, Swift's sort is not, so rows that tie on every
        // key fall back to their input index. That reproduces the TS order and
        // makes the result total (deterministic) at the same time.
        let order = ranked.indices.sorted { i, j in
            let a = ranked[i], b = ranked[j]
            if a.leafHit != b.leafHit { return a.leafHit }
            if a.quality.rank != b.quality.rank { return a.quality.rank > b.quality.rank }
            let aHist = a.history != nil, bHist = b.history != nil
            if aHist != bHist { return aHist }
            if aHist, bHist, a.frecency != b.frecency { return a.frecency > b.frecency }
            if a.depth != b.depth { return a.depth < b.depth }
            let cmp = a.cwd.localizedCompare(b.cwd)   // mirrors String#localeCompare
            if cmp != .orderedSame { return cmp == .orderedAscending }
            return i < j
        }
        return order.map { ranked[$0] }
    }

    /// Display sections, items keeping their ranked order inside each.
    ///  - hostGrouping: one section per host, local ALWAYS first, remotes by
    ///    activity (sum of history counts) descending.
    ///  - otherwise: a history section and a live section, ordered by their best
    ///    member's GLOBAL rank rather than a fixed history-first rule. With an
    ///    empty needle frecency floats history up (the old browse behavior); when
    ///    the typed needle hits a live dir's leaf, live leads.
    static func buildSections(ranked: [RankedPath],
                              hostGrouping: Bool,
                              hostActivity: [String: Int]) -> [PathSection] {
        if hostGrouping {
            var order: [String] = []
            var byHost: [String: [RankedPath]] = [:]
            for item in ranked {
                if byHost[item.hostKey] == nil { order.append(item.hostKey) }
                byHost[item.hostKey, default: []].append(item)
            }
            var keys: [String] = byHost[localHostKey] != nil ? [localHostKey] : []
            let remotes = order.filter { $0 != localHostKey }
            // Ties on activity keep first-seen order, which is what the JS stable
            // sort produced.
            keys += remotes.indices
                .sorted { i, j in
                    let av = hostActivity[remotes[i]] ?? 0, bv = hostActivity[remotes[j]] ?? 0
                    return av != bv ? av > bv : i < j
                }
                .map { remotes[$0] }

            return keys.map { key in
                let items = byHost[key] ?? []
                // Flattened deliberately: `items.first?.hostLabel` is String?? and
                // a bare `??` on that yields String?, not the String the label needs.
                let label: String
                if key == localHostKey {
                    label = localSectionLabel
                } else if let first = items.first, let hostLabel = first.hostLabel {
                    label = hostLabel
                } else {
                    label = key
                }
                return PathSection(id: "host:\(key)", label: label, hostKey: key, items: items)
            }
        }

        let historyItems = ranked.filter { $0.source == .history }
        let liveItems = ranked.filter { $0.source == .live }
        // Rank position of each section's best member: `ranked` is already
        // globally sorted, so the first index of each kind IS that position.
        var pairs: [(pos: Int, section: PathSection)] = []
        if let first = historyItems.first,
           let pos = ranked.firstIndex(where: { $0.source == PathCandidateSource.history }) {
            pairs.append((pos, PathSection(id: "history", label: historySectionLabel,
                                           hostKey: first.hostKey, items: historyItems)))
        }
        if let first = liveItems.first,
           let pos = ranked.firstIndex(where: { $0.source == PathCandidateSource.live }) {
            pairs.append((pos, PathSection(id: "live", label: liveSectionLabel,
                                           hostKey: first.hostKey, items: liveItems)))
        }
        return pairs.sorted { $0.pos < $1.pos }.map { $0.section }
    }

    // MARK: Identity helpers

    /// Wire quirk: `/api/v1/sessions/launch-options` sends `host: ""` for the
    /// primary box while the web model uses `null`. Both mean local, so both
    /// normalize to nil here and therefore to the SAME chip key. Without this an
    /// empty-string host and a nil host would key two chips for one directory.
    static func normalizedHost(_ host: String?) -> String? {
        guard let host, !host.isEmpty else { return nil }
        return host
    }

    /// "host::cwd" identity of one directory, matching the web's `chipKey`.
    static func pathChipKey(cwd: String, host: String?) -> String {
        "\(normalizedHost(host) ?? localHostKey)::\(cwd)"
    }

    static func pathChipKey(dir: SessionLaunchOptions.Dir) -> String {
        pathChipKey(cwd: dir.cwd, host: dir.host)
    }

    /// Trailing-slash-tolerant basename, "/" for the root or an empty path.
    static func pathBasename(_ cwd: String) -> String {
        var p = Substring(cwd)
        while p.hasSuffix("/") { p = p.dropLast() }
        let leaf = p.split(separator: "/").last.map(String.init) ?? ""
        return leaf.isEmpty ? "/" : leaf
    }

    /// "walnut · clouddev": folder basename plus the host alias when remote.
    /// hostLabel wins over the raw alias (matching the TS `hostLabel ?? host`,
    /// which only falls back when the label is absent, not when it is empty).
    static func pathLabel(cwd: String, host: String?, hostLabel: String?) -> String {
        if cwd.isEmpty { return "Choose folder…" }
        let dir = pathBasename(cwd)
        guard let shown = hostLabel ?? host, !shown.isEmpty else { return dir }
        return "\(dir) · \(shown)"
    }
}
