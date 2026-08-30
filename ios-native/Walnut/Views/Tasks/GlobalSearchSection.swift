import SwiftUI

/// Collapses the server-search hit list against what the list ABOVE it already
/// shows, so one task is one row.
///
/// # The measured defect
///
/// While searching, the same task appeared THREE times in one viewport: once as its
/// live board row (`board.row.<taskId>`), and twice under "Server Search", because
/// `/api/search` answers a task hit AND the hit for the session that task owns. The
/// two server rows are not near-duplicates that a human eye has to reconcile —
/// they are the same id. `SearchResult` carries `taskId` on a session hit on
/// purpose (server-side: "which TASK did X?" is the question users ask), and the
/// iOS decoder folds `id ?? taskId ?? sessionId` into `resultId`, so both rows
/// arrive holding the same task id and only `type` differs. `GlobalSearchResult.id`
/// is `"\(type)|\(resultId)"`, which is exactly why `ForEach` was happy to render
/// both.
///
/// # Two rules, in this order
///
/// 1. A hit for a task that is ALREADY on screen above is dropped outright. The
///    board row is the better row: it is live, it carries phase/tier/session state,
///    and it is where taps already work.
/// 2. Whatever survives is collapsed by task, preferring the `task` hit over the
///    `session` one — the task hit is the one `resultRow` makes tappable, so
///    keeping the session copy would turn a real row into a dead one. The survivor
///    keeps the SLOT of the first of the pair, so the server's ranking is untouched.
///
/// Pure and free of `View` on purpose: this is the kind of rule that rots silently
/// inside a body, and it is the whole content of the fix.
enum BoardSearchHitDedup {

    /// Shortest id overlap that may count as the same task.
    ///
    /// Ids are matched by prefix in both directions because the server can answer a
    /// short id and the board holds the full one (`TasksView` already resolves hits
    /// with `hasPrefix`). Unbounded prefix matching is how a confident wrong answer
    /// gets made — a 2-character id would swallow unrelated tasks — so a prefix has
    /// to be long enough to be an id rather than a coincidence.
    static let minimumIdOverlap = 6

    /// The task a hit is about, or nil if it is not about a task at all.
    ///
    /// Memory hits never carry one. A session hit carries its owning task's id when
    /// it has one, and its own session id when it does not — the second case is
    /// still returned, and it is safe: a session id cannot prefix-match a task id at
    /// `minimumIdOverlap`, so it simply never pairs with anything.
    static func taskKey(for hit: GlobalSearchResult) -> String? {
        guard hit.type == "task" || hit.type == "session" else { return nil }
        guard let id = hit.resultId?.trimmingCharacters(in: .whitespaces), !id.isEmpty else {
            return nil
        }
        return id
    }

    /// Same task? Exact, or one id is a long-enough prefix of the other.
    static func sameTask(_ lhs: String, _ rhs: String) -> Bool {
        if lhs == rhs { return true }
        let (short, long) = lhs.count <= rhs.count ? (lhs, rhs) : (rhs, lhs)
        guard short.count >= minimumIdOverlap else { return false }
        return long.hasPrefix(short)
    }

    /// The hits worth rendering, in the server's order.
    ///
    /// - Parameter visibleTaskIds: every id the list above can be recognised by
    ///   (`BoardModel.searchDedupIds` over the visible bands, plus the local hit rows'
    ///   task ids). Nothing in here gets a second row.
    ///
    ///   It is deliberately every id a row ANSWERS TO rather than the id a row is keyed
    ///   by, and that distinction was the R25 duplicate: a board row whose owning task
    ///   is missing from the phone's projection used to be keyed by the CLI session
    ///   UUID, so the server's hit for that task (`taskId` in hand) matched nothing and
    ///   drew a second row 55pt below the first. The board keys such a row by the owning
    ///   task id now, and this set still carries the session id as well, so the drop
    ///   happens regardless of which id the row was keyed by.
    static func visibleHits(
        _ hits: [GlobalSearchResult], visibleTaskIds: Set<String>
    ) -> [GlobalSearchResult] {
        guard !hits.isEmpty else { return [] }
        // Index the visible ids instead of scanning them per hit. This runs on every
        // body pass of the section, while the user is typing, against a board that can
        // hold hundreds of visible rows — and the prefix lane cannot fire unless two
        // ids agree on their first `minimumIdOverlap` characters, so bucketing by
        // exactly those characters is equivalent to the scan, not an approximation of
        // it: anything shorter than the floor can only match EXACTLY, which is the
        // `exact` set.
        var exact = Set<String>()
        var buckets: [String: [String]] = [:]
        for raw in visibleTaskIds {
            let id = raw.trimmingCharacters(in: .whitespaces)
            guard !id.isEmpty else { continue }
            exact.insert(id)
            if id.count >= minimumIdOverlap {
                buckets[String(id.prefix(minimumIdOverlap)), default: []].append(id)
            }
        }
        func isAlreadyOnScreen(_ key: String) -> Bool {
            if exact.contains(key) { return true }
            guard key.count >= minimumIdOverlap else { return false }
            guard let candidates = buckets[String(key.prefix(minimumIdOverlap))] else { return false }
            return candidates.contains { sameTask($0, key) }
        }

        var kept: [GlobalSearchResult] = []
        // Task key → index in `kept`, so a pair collapses into the slot the FIRST of
        // the two won rather than jumping to the end of the list. A plain array
        // because a response holds ~15 hits: the prefix rule needs a scan, and a scan
        // over 15 is cheaper than the dictionary that would avoid it.
        var slots: [(key: String, index: Int)] = []

        for hit in hits {
            guard let key = taskKey(for: hit) else {
                kept.append(hit)      // memory (or an id-less hit): nothing to dedup
                continue
            }
            if isAlreadyOnScreen(key) { continue }
            if let slot = slots.first(where: { sameTask($0.key, key) }) {
                // Prefer the tappable row. Anything else about the pair (title,
                // snippet, score) belongs to the same task by construction.
                if hit.type == "task", kept[slot.index].type != "task" {
                    kept[slot.index] = hit
                }
                continue
            }
            slots.append((key: key, index: kept.count))
            kept.append(hit)
        }
        return kept
    }
}

/// Server-side global search results (GET /v1/search — tasks/memory/sessions)
/// rendered as an extra List section under the local matches while the user
/// types in the Tasks search field. Debounced 350ms. On a cloud REPLICA the
/// endpoint answers 501 not_supported_cloud → a one-line degradation notice
/// (notes search elsewhere still works there).
///
/// What it renders is `BoardSearchHitDedup.visibleHits`, never the raw response —
/// see there for the triple-listing this fixes.
struct GlobalSearchSection: View {
    let query: String
    /// Task ids the list ABOVE already shows, so this section never draws a second
    /// copy of a row the user is looking at.
    var visibleTaskIds: Set<String> = []
    /// Open a task hit (the parent resolves the id against its store).
    var onOpenTask: (String) -> Void

    @State private var results: [GlobalSearchResult] = []
    @State private var searching = false
    /// Non-nil = show the degraded/unavailable line instead of results.
    @State private var unavailableNotice: String?
    @State private var debounceTask: Task<Void, Never>?
    @State private var searchedQuery = ""

    private let api = WalnutAPI()

    var body: some View {
        // ONE dedup per body pass, and the empty states read from the SAME array the
        // rows do: "No server-side matches" while holding hits that were all already
        // on screen would be a lie, and the two branches disagreeing about what is
        // empty is how that lie gets shipped.
        let hits = BoardSearchHitDedup.visibleHits(results, visibleTaskIds: visibleTaskIds)
        Section {
            if let unavailableNotice {
                Label(unavailableNotice, systemImage: "icloud.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if searching && hits.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Searching server…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if hits.isEmpty && !results.isEmpty {
                // Every hit collapsed into a row above. Say so, rather than claiming
                // the server found nothing.
                Text("Every server match is already listed above.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else if hits.isEmpty && searchedQuery == query {
                Text("No server-side matches.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(hits) { result in
                    resultRow(result)
                }
            }
        } header: {
            Text("Server Search")
        }
        .onChange(of: query, initial: true) { _, newQuery in
            schedule(newQuery)
        }
        .onDisappear { debounceTask?.cancel() }
    }

    /// Characters a snippet uses to say "this text is a window into something longer".
    /// The server writes ASCII `...` (`extractSnippet` in the search core); a single
    /// `…` shows up in other lanes and in fixtures.
    private static let ellipsisEdges = CharacterSet(charactersIn: "…. \t\n\u{00A0}")

    /// Quotes and sentence punctuation a snippet can be wrapped in without carrying any
    /// content of its own.
    private static let wrapperEdges = CharacterSet(charactersIn: "\"'“”‘’«»,;:")

    /// A snippet or title reduced to the text it actually carries: no surrounding
    /// whitespace, no leading/trailing ellipsis run, no wrapping quotes or sentence
    /// punctuation, single spaces inside, case- and diacritic-folded.
    ///
    /// Pure and separate from the rule below because the rule is a SUBSET test, and a
    /// subset test is only as honest as the normalisation both sides go through.
    static func normalizedSnippetText(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Alternate until neither pass can strip anything: `"…title…".` needs the quote
        // pass after the ellipsis pass, and `…"title"…` needs the reverse.
        while true {
            let stripped = value
                .trimmingCharacters(in: ellipsisEdges)
                .trimmingCharacters(in: wrapperEdges)
            if stripped == value { break }
            value = stripped
        }
        let words = value.split(whereSeparator: { $0.isWhitespace })
        return words.joined(separator: " ")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// The snippet, or nil when it adds nothing beyond the title.
    ///
    /// # Why a subset rule, and not the residue heuristic it replaces
    ///
    /// When the match is on the TITLE, the server windows the title into the snippet
    /// (`extractSnippet(task.title, query)`), so the client is handed an ellipsised COPY
    /// of the line it is already drawing: "Watch NVDA Q2 earnings call and write …".
    /// The row then said its name twice, in two type sizes, and the second line read as
    /// a detail the user was missing.
    ///
    /// The R25 rule deleted the title's characters out of the snippet and asked whether
    /// any alphanumerics were left, and a WINDOW is exactly what that cannot see: a
    /// snippet cut out of the middle of the title does not CONTAIN the title, so the
    /// subtraction found nothing to remove, the whole snippet counted as residue, and the
    /// duplicate line shipped. (It could also swing the other way, on a snippet whose only
    /// addition to the title was symbols.)
    ///
    /// So: normalise both sides, then SUPPRESS iff the snippet is a substring of the
    /// title (a window of it, however it was cut) or equal to it, and KEEP it whenever it
    /// carries anything the title does not — which is what keeps the memory hit's
    /// `title #tag #tag` line, where the tags are the whole point.
    ///
    /// # The subset test on its own is one-directional, which R27 measured
    ///
    /// `title.contains(snippet)` catches a snippet the title SWALLOWS. It says nothing
    /// about the other direction, and the server produces that shape too: a window that
    /// contains the whole title plus an overrun the edge-trimming cannot reach, because
    /// the overrun is not at an edge it looks at (`"…title — …"`, `"title!"`, `"title |"`).
    /// Those printed the title twice, with a dangling mark under it.
    ///
    /// So when the snippet contains the TITLE, the question moves to the REMAINDER: strip
    /// the title out and ask whether what is left says anything (`remainderBeyondTitle`
    /// + `carriesRealContent`). Punctuation, ellipses, quotes and whitespace are not
    /// something to say; `#finance #q2` is.
    static func snippetWorthShowing(title: String, snippet: String?) -> String? {
        guard let snippet else { return nil }
        let trimmed = snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // Nothing but decoration (a bare "…"): there is no text to show.
        let normalizedSnippet = normalizedSnippetText(trimmed)
        guard !normalizedSnippet.isEmpty else { return nil }
        let normalizedTitle = normalizedSnippetText(title)
        // A hit with no title has only this line — never drop it.
        guard !normalizedTitle.isEmpty else { return trimmed }
        // A WINDOW of the title, however it was cut: the row already draws this text.
        if normalizedTitle.contains(normalizedSnippet) { return nil }
        // The title plus something. Whether that something is CONTENT is the whole
        // question, and a remainder of punctuation is the title said twice.
        if let remainder = remainderBeyondTitle(
            title: normalizedTitle, snippet: normalizedSnippet
        ), !carriesRealContent(remainder) {
            return nil
        }
        return trimmed
    }

    /// What a snippet says BEYOND a title it contains, or nil when it does not contain it.
    ///
    /// Both sides must already be normalised — this is a plain substring removal, and its
    /// whole honesty depends on the two texts having been folded the same way. The FIRST
    /// occurrence only: a snippet that repeats the title twice is not "the title plus
    /// decoration" by any reading, so what is left of the second copy is content as far as
    /// this rule is concerned, and the line stays.
    static func remainderBeyondTitle(title: String, snippet: String) -> String? {
        guard let range = snippet.range(of: title) else { return nil }
        var remainder = snippet
        remainder.removeSubrange(range)
        return remainder
    }

    /// Does this text say anything, or is it what a window leaves behind?
    ///
    /// Letters and digits are content; everything else (ellipses, quotes, dashes, sentence
    /// punctuation, whitespace) is a cut mark. Stated as "has a letter or a digit" rather
    /// than as a denylist of punctuation on purpose: a denylist has to be complete, and the
    /// character that shipped the defect was an em dash nobody had listed.
    static func carriesRealContent(_ text: String) -> Bool {
        text.contains { $0.isLetter || $0.isNumber }
    }

    @ViewBuilder
    private func resultRow(_ result: GlobalSearchResult) -> some View {
        let row = VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: Self.icon(for: result.type))
                    .font(.caption)
                    .foregroundStyle(Self.color(for: result.type))
                    // DECORATIVE, and this one matters: a task hit's glyph is
                    // `checkmark.circle`, whose default accessibility contribution made
                    // every search row announce "Selected" and report `isSelected` — so
                    // VoiceOver described a list of results as a list of chosen things.
                    // The type is already carried by the row's own text and colour.
                    //
                    // All THREE modifiers are needed, and `accessibilityHidden` alone was
                    // the R26 half-fix: hiding an element does not withdraw what the
                    // platform contributed for its symbol, so the row still reported
                    // `selected = true` (measured on the built binary). The trait is
                    // removed and the label emptied explicitly.
                    .accessibilityHidden(true)
                    .accessibilityRemoveTraits(.isSelected)
                    .accessibilityLabel(Text(verbatim: ""))
                Text(result.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            if let snippet = Self.snippetWorthShowing(title: result.title, snippet: result.snippet) {
                Text(snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)

        if result.type == "task", let id = result.resultId {
            Button { onOpenTask(id) } label: { row }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search.result.\(id)")
        } else {
            // Memory/session hits have no dedicated phone surface yet —
            // render read-only (title + snippet carries the answer).
            row
        }
    }

    private func schedule(_ newQuery: String) {
        debounceTask?.cancel()
        let trimmed = newQuery.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            searchedQuery = ""
            return
        }
        debounceTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do {
                let hits = try await api.globalSearch(query: trimmed, limit: 15)
                guard !Task.isCancelled else { return }
                results = hits
                searchedQuery = newQuery
                unavailableNotice = nil
            } catch let error as APIError where error.isNotSupportedCloud {
                unavailableNotice = "Global search needs your Mac online — notes search still works."
            } catch let error as APIError where error.isCancelled {
                return
            } catch {
                // Old server (404) or transient failure — hide quietly; local
                // search results above still work.
                results = []
                searchedQuery = newQuery
            }
        }
    }

    static func icon(for type: String) -> String {
        switch type {
        case "task": return "checkmark.circle"
        case "session": return "terminal"
        case "memory": return "brain"
        default: return "doc.text.magnifyingglass"
        }
    }

    static func color(for type: String) -> Color {
        switch type {
        case "task": return Theme.tint
        case "session": return .indigo
        case "memory": return .purple
        default: return .secondary
        }
    }
}
