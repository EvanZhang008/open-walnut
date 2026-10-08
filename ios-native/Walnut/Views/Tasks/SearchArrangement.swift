import Foundation

/// The Tasks tab's search rules, ported from the web console's home search
/// (`web/src/components/tasks/search-relevance.ts`) so the phone answers a query the
/// way the Mac does.
///
/// # Two lanes, as on the web
///
/// The QUICK lane is a literal substring match on the small fields (title, project,
/// tags) of what the phone already holds, answered on every keystroke: the board and
/// project rows above, plus the completed tasks in the phone's list. The SERVER lane
/// arrives after a typing pause: the Mac's keyword and semantic (vector) search over
/// descriptions, notes and session transcripts. Quick rows lead and never move;
/// server rows only append.
///
/// A server row that shows the typed text in its own title or snippet is real
/// evidence. One that does not came from the semantic lane alone, and dozens of those
/// at once read as "my result was replaced", so they fold into "Related (N)": the open
/// ones first, then the completed ones (the web reveals those with its Done chip; the
/// phone has no chip, and a finished task found by meaning is often the one wanted).
/// Completed tasks must stay findable by their own title, but a broad word matches
/// dozens of them, so at most three completed title hits show inline and the rest wait
/// behind "Completed (N)".
enum SearchRelevance {

    /// Full-width letters, digits and punctuation (a CJK input method in full-width
    /// mode) folded to ASCII. Twin of `foldWidth` on the web and in the server's
    /// tokenizer, which apply it to the same query.
    static func foldWidth(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var changed = false
        for scalar in text.unicodeScalars {
            if scalar.value == 0x3000 {
                out.append(" ")
                changed = true
            } else if (0xFF01...0xFF5E).contains(scalar.value),
                      let ascii = Unicode.Scalar(scalar.value - 0xFEE0) {
                out.append(ascii)
                changed = true
            } else {
                out.append(scalar)
            }
        }
        return changed ? String(out) : text
    }

    /// Lowercased whitespace-split terms; one-character terms are noise unless
    /// nothing else is left.
    static func queryTerms(_ query: String) -> [String] {
        let all = foldWidth(query)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        let terms = all.filter { $0.count > 1 }
        return terms.isEmpty ? all : terms
    }

    /// The quick lane's test. `lowerQuery` is already trimmed and lowercased.
    static func taskMatchesLiterally(_ task: WalnutTask, lowerQuery: String) -> Bool {
        let query = foldWidth(lowerQuery)
        guard !query.isEmpty else { return false }
        return task.title.lowercased().contains(query)
            || task.project.lowercased().contains(query)
            || (task.tags ?? []).contains { $0.lowercased().contains(query) }
    }

    /// Server rows matched on an identifier answer exactly what was typed.
    static let referenceFields: Set<String> = ["id", "session_id", "commit_sha", "external_url"]

    /// The coverage tier at which keyword evidence counts even when the ~80-character
    /// snippet has no room for every term (a note saying "cron job" for
    /// "dockhub sync cron job").
    static let fullCoverageTier: Double = 4

    /// Does a server row show the query: every term in its title or snippet, an
    /// identifier match, or full keyword coverage of the document?
    static func rowShowsQuery(_ row: GlobalSearchResult, terms: [String]) -> Bool {
        if let field = row.matchField, referenceFields.contains(field) { return true }
        guard !terms.isEmpty else { return false }
        if let tier = row.coveredTermHits, tier >= fullCoverageTier { return true }
        let text = "\(row.title)\n\(row.snippet ?? "")".lowercased()
        var joined: String?
        return terms.allSatisfy { term in
            if text.contains(term) { return true }
            if joined == nil { joined = joinWords(text) }
            return joined!.contains(joinWords(term))
        }
    }

    private static let wordSeparators = try! NSRegularExpression(
        pattern: #"([\p{L}\p{N}])[\s_./-]{1,3}(?=[\p{L}\p{N}])"#
    )

    /// The text with the separators between words removed, so a name typed as one word
    /// shows in a row that writes it as two ("dockhub" in "Dock Hub KB sync"), and a
    /// version typed with other separators shows ("opus-4-8" in "Opus 4.8 upgrade").
    static func joinWords(_ text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return wordSeparators.stringByReplacingMatches(in: text, range: range, withTemplate: "$1")
    }
}

/// One task in the search section.
struct SearchHit: Identifiable, Equatable {
    /// The task id.
    let id: String
    /// The task to draw as a row: the phone's live copy, else the one the search
    /// response carried. nil when neither knows it (an older server, or the companion
    /// answering while the Mac is away): the row then draws from `row` alone.
    let task: WalnutTask?
    /// The server row this hit came from; nil for a completed task the phone matched itself.
    var row: GlobalSearchResult?
    /// Where the server found the query, when the row says more than the title.
    var snippet: String?
    /// The typed text shows in the task's own fields, or a server row shows it.
    var showsQuery: Bool
    /// A quick-lane match: the query is in the title, project or a tag.
    let literal: Bool

    var isOpen: Bool { !(task?.isDone ?? false) }
}

/// What the search section draws, in order. A pure function of the inputs, so the rules
/// are tested without a view (`SearchArrangementTests`).
struct SearchArrangement: Equatable {
    /// Open hits that show the query, three completed title hits, then the open server hits.
    var primary: [SearchHit] = []
    /// The other completed hits that show the query, behind "Completed (N)".
    var completed: [SearchHit] = []
    /// Hits that do not show it (the semantic lane alone), behind "Related (N)":
    /// the open ones, then the completed ones.
    var related: [SearchHit] = []
    /// How many of `related` are completed (the web's Done chip count).
    var looseDone = 0
    /// The server answered rows about tasks, and every one is already on screen above.
    var allOnScreen = false

    /// Completed title hits shown inline before the "Completed (N)" fold.
    static let inlineCompletedHits = 3
    /// Rows mounted per list, as on the web: counts stay whole, the list stays bounded.
    static let renderCap = 40

    var isEmpty: Bool { primary.isEmpty && completed.isEmpty && related.isEmpty }

    /// - Parameters:
    ///   - query: what is typed.
    ///   - serverRows: the server's rows in rank order; nil until it answers this query.
    ///   - responseTasks: the tasks the response named (`tasks=1`).
    ///   - storeTasks: everything the phone holds, for the live copy of a hit.
    ///   - localDone: the completed tasks the phone holds (the quick lane's half here).
    ///   - visibleTaskIds: every id a row ABOVE answers to; those get no second row.
    ///   - nothingAbove: no row above matched, so when this section's own primary list
    ///     is empty the first non-empty fold is the answer and shows directly.
    static func arrange(
        query: String,
        serverRows: [GlobalSearchResult]?,
        responseTasks: [WalnutTask] = [],
        storeTasks: [WalnutTask] = [],
        localDone: [WalnutTask],
        visibleTaskIds: Set<String>,
        nothingAbove: Bool
    ) -> SearchArrangement {
        let lowerQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lowerQuery.isEmpty else { return SearchArrangement() }
        let folded = SearchRelevance.foldWidth(lowerQuery)
        let terms = SearchRelevance.queryTerms(query)
        let onScreen = BoardSearchHitDedup.VisibleIndex(visibleTaskIds)

        var matches: [SearchHit] = []
        var slot: [String: Int] = [:]

        // Quick lane: the completed tasks the phone holds (the open ones are above).
        for task in localDone
        where slot[task.id] == nil
            && !onScreen.contains(task.id)
            && SearchRelevance.taskMatchesLiterally(task, lowerQuery: lowerQuery) {
            slot[task.id] = matches.count
            matches.append(SearchHit(id: task.id, task: task, row: nil, snippet: nil, showsQuery: true, literal: true))
        }

        // Server lane, one hit per task. Only rows about a task count, as on the web:
        // memory rows and sessions no task owns have no row on this tab. A task's own
        // row and its sessions' rows are one task (`BoardSearchHitDedup` collapses
        // them, and drops what is on screen above), and any of them showing the query
        // is evidence for it.
        var owned = 0
        if let rows = serverRows {
            let about = rows.filter { !($0.ownerTaskId ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
            owned = about.count
            var shows: [String: Bool] = [:]
            var snippet: [String: String] = [:]
            for row in about {
                guard let key = BoardSearchHitDedup.taskKey(for: row) else { continue }
                let evidence = SearchRelevance.rowShowsQuery(row, terms: terms)
                if evidence && shows[key] != true, let text = row.snippet { snippet[key] = text }
                if snippet[key] == nil, let text = row.snippet { snippet[key] = text }
                shows[key] = (shows[key] ?? false) || evidence
            }
            let wanted = Set(shows.keys)
            var live: [String: WalnutTask] = [:]
            for task in storeTasks where wanted.contains(task.id) { live[task.id] = task }
            var carried: [String: WalnutTask] = [:]
            for task in responseTasks where carried[task.id] == nil { carried[task.id] = task }

            for row in BoardSearchHitDedup.visibleHits(about, visibleTaskIds: visibleTaskIds) {
                guard let key = BoardSearchHitDedup.taskKey(for: row), slot[key] == nil else { continue }
                let task = live[key] ?? carried[key]
                let literal = task.map { SearchRelevance.taskMatchesLiterally($0, lowerQuery: lowerQuery) } ?? false
                slot[key] = matches.count
                matches.append(SearchHit(
                    id: key, task: task, row: row, snippet: snippet[key],
                    showsQuery: shows[key] ?? false, literal: literal
                ))
            }
        }

        var result = SearchArrangement()
        var literalOpen: [SearchHit] = []
        var literalDone: [(hit: SearchHit, order: Int)] = []
        var serverOpen: [SearchHit] = []
        var serverDone: [SearchHit] = []
        var looseOpen: [SearchHit] = []
        var looseDone: [SearchHit] = []
        for hit in matches {
            if !(hit.literal || hit.showsQuery) {
                if hit.isOpen { looseOpen.append(hit) } else { looseDone.append(hit) }
                continue
            }
            if hit.literal {
                if hit.isOpen { literalOpen.append(hit) } else { literalDone.append((hit, literalDone.count)) }
            } else {
                if hit.isOpen { serverOpen.append(hit) } else { serverDone.append(hit) }
            }
        }
        // Completed title hits: the query nearest the title's start first (a long pasted
        // prompt that merely contains the word ranks last), most recently completed next.
        literalDone.sort { a, b in
            let pa = titlePosition(a.hit.task, folded), pb = titlePosition(b.hit.task, folded)
            if pa != pb { return pa < pb }
            let ca = a.hit.task?.completedAt ?? "", cb = b.hit.task?.completedAt ?? ""
            if ca != cb { return ca > cb }
            return a.order < b.order
        }
        let done = literalDone.map(\.hit)
        var related = looseOpen
        related.append(contentsOf: looseDone)
        result.related = related
        result.looseDone = looseDone.count
        var primary = literalOpen
        primary.append(contentsOf: done.prefix(inlineCompletedHits))
        primary.append(contentsOf: serverOpen)
        var completed = Array(done.dropFirst(inlineCompletedHits))
        completed.append(contentsOf: serverDone)
        result.primary = primary
        result.completed = completed
        if result.primary.isEmpty && nothingAbove {
            if !result.completed.isEmpty {
                result.primary = result.completed
                result.completed = []
            } else {
                result.primary = result.related
                result.related = []
            }
        }
        // Nothing to draw although the server found tasks: every one is on screen above.
        result.allOnScreen = matches.isEmpty && owned > 0
        return result
    }

    /// Where the query starts in the title, in characters; Int.max for a project or tag hit.
    private static func titlePosition(_ task: WalnutTask?, _ query: String) -> Int {
        guard let title = task?.title.lowercased(), let range = title.range(of: query) else { return .max }
        return title.distance(from: title.startIndex, to: range.lowerBound)
    }
}
