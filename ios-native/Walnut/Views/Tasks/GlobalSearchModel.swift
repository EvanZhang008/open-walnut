import Foundation
import Observation

/// The Tasks tab's server search: what was asked, what came back, and how it stands.
///
/// The tab owns it and schedules on every query change; `GlobalSearchSection` only
/// reads it. The section sits at the foot of a lazy List, below every local match, and
/// while the search lived in the section it started only once the section had been
/// drawn. Since the section draws nothing until it has something to say, a query with
/// many local matches and no completed one on the phone never searched at all: the
/// More Results never came, and neither did "Couldn't search right now" (2026-10-08,
/// found by the server-gone simulator flow).
@MainActor
@Observable
final class GlobalSearchModel {
    typealias Search = @MainActor (String) async throws -> GlobalSearchResponse

    /// The answer for `searchedQuery`. Read it through `answer(for:)`: an answer for an
    /// older query is never shown under a newer one.
    private(set) var response: GlobalSearchResponse?
    /// The query `response` (or `failed`) belongs to.
    private(set) var searchedQuery = ""
    /// A search is waiting out the typing pause or in flight for the newest query, so
    /// the section says "Searching…" from the first keystroke on.
    private(set) var searching = false
    /// Non-nil = the server cannot search at all (an old companion while the Mac is away).
    private(set) var unavailableNotice: String?
    /// The newest search failed (network, timeout): say so rather than "no matches".
    private(set) var failed = false
    /// The folds' reveals. Both are per search, as on the web.
    var showCompleted = false
    var showRelated = false

    @ObservationIgnored private var task: Task<Void, Never>?
    /// Bumped per scheduled search; only the newest one writes state.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let search: Search

    init(
        debounce: Duration = .milliseconds(350),
        search: @escaping Search = { try await WalnutAPI().globalSearch(query: $0) }
    ) {
        self.debounce = debounce
        self.search = search
    }

    /// The answer for `query`, or nil while there is none.
    func answer(for query: String) -> GlobalSearchResponse? {
        searchedQuery == query ? response : nil
    }

    /// Search for `query` after the typing pause, superseding any search before it.
    /// Under two characters nothing is asked.
    func schedule(_ query: String) {
        task?.cancel()
        generation &+= 1
        let mine = generation
        // A failure, or an old companion's "needs your Mac", belongs to the query it
        // happened to; the next one starts clean and learns it again if it holds.
        failed = false
        unavailableNotice = nil
        showCompleted = false
        showRelated = false
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            response = nil
            searchedQuery = ""
            searching = false
            return
        }
        searching = true
        task = Task { [weak self, debounce, search] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled, let self, mine == self.generation else { return }
            defer { if mine == self.generation { self.searching = false } }
            do {
                let answer = try await search(trimmed)
                guard mine == self.generation else { return }
                self.response = answer
                self.searchedQuery = query
                self.unavailableNotice = nil
            } catch let error as APIError where error.isNotSupportedCloud {
                guard mine == self.generation else { return }
                self.unavailableNotice = "Search needs your Mac online. Notes search still works."
            } catch {
                // A newer search cancelled this one: it speaks for itself. Anything
                // else, a cancellation this model did not make included, is a search
                // that did not answer; the phone's own matches still stand.
                guard mine == self.generation else { return }
                self.response = nil
                self.searchedQuery = query
                self.failed = true
            }
        }
    }
}
