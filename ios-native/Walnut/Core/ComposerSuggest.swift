import Foundation

/// The `@` and `/` lists every box the user writes to an agent in shares: the chat composer,
/// a session's composer, a letter's reply and an ask card's words (2026-11-20, the user: "all
/// the inbox like this should like input box ... the at works like the slash works"). The
/// phone's twin of the web's `mention-trigger.ts`, `slash-trigger.ts` and `composer-refs.ts`:
/// the same trigger rules and the same `<task-ref/>` markup, so a message reads the same
/// wherever it was written.
///
/// Pure: no UIKit, no store. Offsets are UTF-16 (`NSString`), the unit `UITextView` speaks.
enum ComposerTrigger: Equatable {
    /// `@` at `start`, then `query` up to the caret.
    case mention(start: Int, query: String)
    /// `/` at `start`, then `query` up to the caret.
    case command(start: Int, query: String)

    var start: Int {
        switch self { case .mention(let s, _), .command(let s, _): return s }
    }

    var query: String {
        switch self { case .mention(_, let q), .command(_, let q): return q }
    }

    var isMention: Bool { if case .mention = self { return true } else { return false } }

    /// The span the trigger covers: the sigil and the query.
    var length: Int { 1 + (query as NSString).length }

    /// Longest a multi-word `@` query may grow before it stops being a lookup (the web's 64).
    static let mentionMaxChars = 64
    /// Most words a multi-word `@` query may hold (the web's 6).
    static let mentionMaxWords = 6

    /// The trigger the caret sits in, or nil.
    ///
    /// `@` and `/` fire only at the start of the text or right after whitespace, so an address
    /// (`a@b`), a path (`src/foo`) or a URL never opens a list. A `/` query stops at whitespace
    /// or a second `/` (a path like `/Users/me`). An `@` query may grow across single spaces
    /// only while its list is already open for that very `@` (`openMentionAt`), so a stray `@`
    /// in prose never captures the rest of the sentence. `@[label]` is a reference already in
    /// the box, not a lookup. `commands: false` (a box with no session) never opens `/`.
    static func detect(in text: String, caret: Int, openMentionAt: Int = -1, commands: Bool = true) -> ComposerTrigger? {
        let ns = text as NSString
        let caret = min(max(caret, 0), ns.length)
        guard caret > 0 else { return nil }
        let mention = detectMention(ns, caret: caret, openAt: openMentionAt)
        let command = commands ? detectCommand(ns, caret: caret) : nil
        switch (mention, command) {
        case let (m?, c?): return m.start > c.start ? m : c
        case let (m?, nil): return m
        case let (nil, c?): return c
        default: return nil
        }
    }

    /// How far back from the caret a sigil is looked for: past it a query is too long to be a
    /// lookup, so a keystroke in a long draft never walks the whole text.
    static let scanLimit = mentionMaxChars + 2

    /// Whether the words END near an `@` or `/` (a composer that knows no caret checks this
    /// before asking for a trigger). O(1): the last bytes of the UTF-8 view.
    static func mayOpen(_ text: String) -> Bool {
        text.utf8.suffix(scanLimit).contains { $0 == 0x40 || $0 == 0x2F }
    }

    private static func lastIndex(of sigil: unichar, in ns: NSString, before caret: Int) -> Int? {
        var i = caret - 1
        let floor = max(0, caret - scanLimit)
        while i >= floor {
            let c = ns.character(at: i)
            if c == sigil { return i }
            if c == 0x0A || c == 0x0D { return nil }
            i -= 1
        }
        return nil
    }

    private static func followsSpaceOrStart(_ ns: NSString, _ index: Int) -> Bool {
        guard index > 0 else { return true }
        guard let scalar = Unicode.Scalar(ns.character(at: index - 1)) else { return false }
        return CharacterSet.whitespacesAndNewlines.contains(scalar)
    }

    private static func detectMention(_ ns: NSString, caret: Int, openAt: Int) -> ComposerTrigger? {
        guard let at = lastIndex(of: 0x40, in: ns, before: caret), followsSpaceOrStart(ns, at) else { return nil }
        let query = ns.substring(with: NSRange(location: at + 1, length: caret - at - 1))
        if query.hasPrefix("[") { return nil }
        if !query.contains(where: \.isWhitespace) { return .mention(start: at, query: query) }
        // Words separated by single spaces, only for the `@` whose list is open.
        guard at == openAt else { return nil }
        if query.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\t" }) { return nil }
        if query.contains("  ") || query.first?.isWhitespace == true { return nil }
        if query.count > mentionMaxChars { return nil }
        if query.trimmingCharacters(in: .whitespaces).split(separator: " ").count > mentionMaxWords { return nil }
        return .mention(start: at, query: query)
    }

    private static func detectCommand(_ ns: NSString, caret: Int) -> ComposerTrigger? {
        guard let slash = lastIndex(of: 0x2F, in: ns, before: caret), followsSpaceOrStart(ns, slash) else { return nil }
        let query = ns.substring(with: NSRange(location: slash + 1, length: caret - slash - 1))
        if query.contains(where: { $0.isWhitespace || $0 == "/" }) { return nil }
        return .command(start: slash, query: query)
    }
}

/// One row of an `@` or `/` list.
struct ComposerSuggestion: Identifiable, Equatable {
    enum Kind: String, Equatable { case task, session, command }
    let kind: Kind
    /// The task or session id, or the command's name.
    let id: String
    let title: String
    /// One line under the title: a task's project and state, a command's description.
    var detail: String? = nil
    /// The row's dot: the task's session runs.
    var live = false

    var rowID: String { "\(kind.rawValue):\(id)" }
}

/// The references in a box: the box shows `@[Fix the login]`, the message that goes out
/// carries `<task-ref id="…" label="…"/>` in its place (the web's `composer-refs.ts`). The tag a
/// token stands for lives in a side table (label → tag) the box keeps beside its words; a token
/// whose label the table does not know is the user's own text and goes as typed.
enum ComposerRefs {
    /// `@[label]`: brackets in a label would end the token, so they become spaces.
    static func token(_ label: String) -> String {
        "@[\(tokenLabel(label))]"
    }

    static func tokenLabel(_ label: String) -> String {
        let cleaned = label.replacingOccurrences(of: "[", with: " ").replacingOccurrences(of: "]", with: " ")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return cleaned.isEmpty ? "reference" : cleaned
    }

    /// The server's pill markup (web `entity-ref-tags.ts`: only `"` is escaped).
    static func tag(for suggestion: ComposerSuggestion) -> String? {
        let label = suggestion.title.replacingOccurrences(of: "\"", with: "&quot;")
        let id = suggestion.id.replacingOccurrences(of: "\"", with: "&quot;")
        switch suggestion.kind {
        case .task: return "<task-ref id=\"\(id)\" label=\"\(label)\"/>"
        case .session: return "<session-ref id=\"\(id)\" label=\"\(label)\"/>"
        case .command: return nil
        }
    }

    private static let tokenRegex = try? NSRegularExpression(pattern: #"@\[([^\[\]\n\r]+)\]"#)

    /// The message for the box's words: every known token swapped for its tag.
    static func compose(_ text: String, table: [String: String]) -> String {
        guard !table.isEmpty, let regex = tokenRegex else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let label = ns.substring(with: match.range(at: 1))
            guard let tag = table[label] else { continue }
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            out += tag
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static let tagRegex = try? NSRegularExpression(
        pattern: #"<(task|session)-ref\s+id="([^"]*)"\s+label="([^"]*)"\s*/>"#
    )

    /// Words coming back into a box (a failed reply put back to edit): each tag shown as its
    /// token again, with the table that turns the tokens back into the same tags.
    static func inline(_ text: String, table known: [String: String] = [:]) -> (body: String, table: [String: String]) {
        guard let regex = tagRegex, text.contains("-ref ") else { return (text, [:]) }
        let ns = text as NSString
        var table: [String: String] = [:]
        var taken = known
        var out = ""
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let raw = ns.substring(with: match.range(at: 3)).replacingOccurrences(of: "&quot;", with: "\"")
            let id = ns.substring(with: match.range(at: 2))
            let tag = ns.substring(with: match.range)
            let label = uniqueLabel(tokenLabel(raw.isEmpty ? id : raw), id: id, table: taken)
            table[label] = tag
            taken[label] = tag
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            out += "@[\(label)]"
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return (out, table)
    }

    /// A label another reference in the box already shows gets its id's tail (`Fix login · 0a0a`),
    /// so each token sends its own tag (the web's `labelFor`).
    static func uniqueLabel(_ label: String, id: String, table: [String: String]) -> String {
        let mine = "id=\"\(id.replacingOccurrences(of: "\"", with: "&quot;"))\""
        guard let held = table[label], !held.contains(mine) else { return label }
        let short = "\(label) · \(id.suffix(4))"
        if let other = table[short], !other.contains(mine) { return "\(label) · \(id)" }
        return short
    }

    /// The box's words after `suggestion` was picked for `trigger`: the span becomes the token
    /// (a task or session) or `/name` (a command), then one space unless one already follows.
    /// Returns the new words, the caret after the insert, and the table entry to keep.
    static func apply(_ suggestion: ComposerSuggestion, to text: String, trigger: ComposerTrigger,
                      table: [String: String] = [:])
        -> (text: String, caret: Int, entry: (label: String, tag: String)?) {
        let ns = text as NSString
        let start = min(trigger.start, ns.length)
        let length = min(trigger.length, ns.length - start)
        let inserted: String
        var entry: (label: String, tag: String)?
        switch suggestion.kind {
        case .command:
            inserted = "/" + suggestion.id
        case .task, .session:
            let label = uniqueLabel(tokenLabel(suggestion.title), id: suggestion.id, table: table)
            inserted = "@[\(label)]"
            if let tag = tag(for: suggestion) { entry = (label, tag) }
        }
        let after = start + length
        let nextIsSpace: Bool = {
            guard after < ns.length, let scalar = Unicode.Scalar(ns.character(at: after)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }()
        let piece = nextIsSpace ? inserted : inserted + " "
        let result = ns.replacingCharacters(in: NSRange(location: start, length: length), with: piece)
        let caret = start + (piece as NSString).length + (nextIsSpace ? 1 : 0)
        return (result, min(caret, (result as NSString).length), entry)
    }
}

/// What an `@` list can offer, built from what the phone already holds.
struct MentionCandidate: Equatable {
    var suggestion: ComposerSuggestion
    var pinned = false
    var active = true
    /// Lexically ordered recency (ISO time).
    var recency = ""
    /// Lower-cased title and id, for matching.
    var haystack: String
}

enum MentionRanking {
    /// The longest list shown.
    static let limit = 8

    /// Every task (and every session that belongs to no task) the `@` list can name. `selfTaskId`,
    /// the task the box answers for, is not offered to itself.
    static func candidates(tasks: [WalnutTask], sessions: [WalnutSession], selfTaskId: String?) -> [MentionCandidate] {
        var running = Set<String>()
        for s in sessions where s.processStatus == "running" { if let t = s.taskId { running.insert(t) } }
        var out: [MentionCandidate] = []
        out.reserveCapacity(tasks.count)
        for task in tasks where task.id != selfTaskId {
            let done = task.phase == "COMPLETE" || task.status == "done"
            let title = AskProjectName.displayTitle(TaskMentions.shownTitle(task.title, orgRole: task.orgRole), project: task.project, orgRole: task.orgRole)
            let project = AskProjectName.display(task.project)
            let state = running.contains(task.id) ? "running" : done ? "done" : nil
            let detail = [project, state].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            out.append(MentionCandidate(
                suggestion: ComposerSuggestion(kind: .task, id: task.id, title: title, detail: detail.isEmpty ? nil : detail,
                                               live: running.contains(task.id)),
                pinned: task.pinned == true, active: !done,
                recency: task.updatedAt ?? task.createdAt ?? "",
                haystack: (title + " " + task.id).lowercased()
            ))
        }
        // A task's session is its task (the task row stands for it); a session of its own is a row.
        for s in sessions where (s.taskId ?? "").isEmpty {
            let title = s.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Session \(s.id.prefix(8))"
            out.append(MentionCandidate(
                suggestion: ComposerSuggestion(kind: .session, id: s.id, title: title,
                                               detail: "Session · \(s.processStatus)", live: s.processStatus == "running"),
                pinned: s.pinned == true, active: s.processStatus != "stopped",
                recency: s.lastActiveAt, haystack: (title + " " + s.id).lowercased()
            ))
        }
        return out
    }

    /// The best rows for `query`. Empty: pinned, live, open, then the newest. Otherwise every
    /// word must be found in the title or id; a title that starts with the query leads, then a
    /// word that does, then a match anywhere.
    static func rank(_ query: String, _ candidates: [MentionCandidate], limit: Int = limit) -> [ComposerSuggestion] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let order: (MentionCandidate, MentionCandidate) -> Bool = { a, b in
            if a.pinned != b.pinned { return a.pinned }
            if a.suggestion.live != b.suggestion.live { return a.suggestion.live }
            if a.active != b.active { return a.active }
            return a.recency > b.recency
        }
        guard !q.isEmpty else {
            return Array(candidates.sorted(by: order).prefix(limit).map(\.suggestion))
        }
        let words = q.split(separator: " ").map(String.init)
        var scored: [(score: Int, candidate: MentionCandidate)] = []
        for c in candidates {
            guard words.allSatisfy({ c.haystack.contains($0) }) else { continue }
            let title = c.suggestion.title.lowercased()
            let score: Int
            if title.hasPrefix(q) || c.suggestion.id.lowercased().hasPrefix(q) { score = 3 }
            else if title.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(words[0]) }) { score = 2 }
            else { score = 1 }
            scored.append((score, c))
        }
        scored.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            return order(a.candidate, b.candidate)
        }
        return Array(scored.prefix(limit).map(\.candidate.suggestion))
    }

    /// The server's hybrid hits (`GET /api/v1/search`, the engine behind the task search)
    /// folded into the local list: rows both agree on first in the server's order, then the
    /// server's own, then the local ones, so the list only gets smarter and never drops a row
    /// already shown. A session hit with a task is that task.
    static func merge(local: [ComposerSuggestion], hits: [GlobalSearchResult], candidates: [MentionCandidate],
                      selfTaskId: String?, limit: Int = limit) -> [ComposerSuggestion] {
        let byID = Dictionary(candidates.map { ($0.suggestion.rowID, $0.suggestion) }, uniquingKeysWith: { a, _ in a })
        var server: [ComposerSuggestion] = []
        var seen = Set<String>()
        for hit in hits {
            let row: ComposerSuggestion?
            if hit.type == "task", let id = hit.resultId {
                row = byID["task:\(id)"] ?? ComposerSuggestion(kind: .task, id: id, title: hit.title, detail: hit.snippet)
            } else if hit.type == "session", let task = hit.taskId {
                row = byID["task:\(task)"]
            } else if hit.type == "session", let id = hit.resultId {
                row = byID["session:\(id)"] ?? ComposerSuggestion(kind: .session, id: id, title: hit.title, detail: "Session")
            } else { row = nil }
            guard let row, row.id != selfTaskId, seen.insert(row.rowID).inserted else { continue }
            server.append(row)
        }
        let localIDs = Set(local.map(\.rowID))
        let agreed = server.filter { localIDs.contains($0.rowID) }
        let serverOnly = server.filter { !localIDs.contains($0.rowID) }
        let agreedIDs = Set(agreed.map(\.rowID))
        let localOnly = local.filter { !agreedIDs.contains($0.rowID) }
        return Array((agreed + serverOnly + localOnly).prefix(limit))
    }
}

/// One command a session can run, as `GET /api/v1/slash-commands` lists it.
struct SlashCommand: Codable, Equatable {
    let name: String
    var description: String? = nil
    var source: String? = nil
}

struct SlashCommandList: Codable, Equatable {
    let items: [SlashCommand]
    var degraded: Bool? = nil
}

enum SlashRanking {
    static let limit = 30

    /// A name that starts with the query first, then a name that holds it, then a description
    /// that does; each group in the server's order.
    static func rank(_ query: String, _ commands: [SlashCommand], limit: Int = limit) -> [ComposerSuggestion] {
        let q = query.lowercased()
        let rows: [SlashCommand]
        if q.isEmpty {
            rows = commands
        } else {
            let prefix = commands.filter { $0.name.lowercased().hasPrefix(q) }
            let inName = commands.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }
            let inText = commands.filter { !$0.name.lowercased().contains(q) && ($0.description ?? "").lowercased().contains(q) }
            rows = prefix + inName + inText
        }
        return rows.prefix(limit).map {
            ComposerSuggestion(kind: .command, id: $0.name, title: "/" + $0.name,
                               detail: $0.description?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty)
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
