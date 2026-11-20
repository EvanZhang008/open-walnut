import Foundation
import Observation

/// One box's `@` and `/` lists (`ComposerSuggest.swift` holds the rules). Every box the user
/// writes to an agent in owns one: the chat and session composers (`ComposerBar`), a letter's
/// reply (`LetterReaderView`) and an ask card's words (`ReplyBox`). The box reports its words
/// and caret on each change; the controller says which list is open and what it holds, and a
/// pick hands back the new words. `outgoing` turns the box's `@[label]` tokens into the
/// `<task-ref/>` markup the message carries.
///
/// Cheap when nothing is open: a keystroke with no `@` or `/` before the caret writes nothing
/// observed, so the composers' per-keystroke budget is untouched.
@MainActor
@Observable
final class ComposerSuggestController {
    /// What the box is for: the task it answers (never offered to itself on `@`) and the
    /// session whose commands `/` lists (`commands: false` = the box has no `/` list).
    struct Scope: Equatable {
        var selfTaskId: String? = nil
        var commands = false
        var commandsCwd: String? = nil
        var commandsHost: String? = nil

        var commandsKey: String { "\(commandsCwd ?? "")::\(commandsHost ?? "")" }
    }

    enum Status: Equatable { case ready, loading, failed }

    private(set) var trigger: ComposerTrigger?
    private(set) var suggestions: [ComposerSuggestion] = []
    /// The `/` list is still loading, or could not load.
    private(set) var status: Status = .ready

    var isOpen: Bool { trigger != nil }

    @ObservationIgnored var scope = Scope()
    /// Where `@` finds tasks and sessions: the app's task store.
    @ObservationIgnored weak var store: TasksStore?
    /// Tests swap these for fakes.
    @ObservationIgnored var search: (String) async throws -> [GlobalSearchResult] = { query in
        try await WalnutAPI().globalSearch(query: query, limit: 20, semanticWaitMs: 600).results
    }
    @ObservationIgnored var loadCommands: (String?, String?) async throws -> [SlashCommand] = { cwd, host in
        try await WalnutAPI().slashCommands(cwd: cwd, host: host).items
    }
    /// The wait after a keystroke before the server is asked (local rows show at once).
    @ObservationIgnored var searchDelay: Duration = .milliseconds(250)

    /// label -> tag for every reference picked into this box.
    @ObservationIgnored private(set) var table: [String: String] = [:]
    @ObservationIgnored private var text = ""
    @ObservationIgnored private var caret = 0
    /// The `@` or `/` the user closed the list of: it stays closed until the trigger moves.
    @ObservationIgnored private var dismissedAt: Int?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var commandsTask: Task<Void, Never>?
    @ObservationIgnored private var commandsTaskKey: String?
    @ObservationIgnored private var candidates: [MentionCandidate] = []

    /// Commands per cwd and host, shared by every box: an ask card on each row of a long
    /// board must not each ask the server.
    private static var commandCache: [String: (at: Date, items: [SlashCommand])] = [:]
    private static let commandCacheTTL: TimeInterval = 120

    init() {}

    /// The box's words or caret changed.
    func update(text: String, caret: Int) {
        self.text = text
        self.caret = caret
        let openAt = trigger.flatMap { $0.isMention ? $0.start : nil } ?? -1
        let raw = ComposerTrigger.detect(in: text, caret: caret, openMentionAt: openAt, commands: scope.commands)
        // A closed list stays closed while the caret is in the same `@` or `/`; a new one opens.
        if let closed = dismissedAt, raw?.start != closed { dismissedAt = nil }
        let next = raw?.start == dismissedAt ? nil : raw
        guard next != trigger else { return }
        let opened = trigger == nil || trigger?.isMention != next?.isMention || trigger?.start != next?.start
        trigger = next
        guard let next else {
            close()
            return
        }
        if next.isMention {
            if opened || candidates.isEmpty { candidates = buildCandidates() }
            setSuggestions(MentionRanking.rank(next.query, candidates))
            scheduleSearch(next.query)
        } else {
            searchTask?.cancel()
            showCommands(next.query)
        }
    }

    /// The words of a field that reports no caret (a SwiftUI `TextField` or `TextEditor`): a
    /// list opens for an `@` or `/` at the END of the words. Words that end nowhere near one
    /// (and no list open) cost one look at their last bytes, so a long draft's keystroke stays
    /// cheap.
    func updateAtEnd(_ text: String) {
        guard isOpen || ComposerTrigger.mayOpen(text) else {
            // No `@` or `/` near the end: whatever list was closed is behind the words now.
            dismissedAt = nil
            return
        }
        update(text: text, caret: text.utf16.count)
    }

    /// The user picked `suggestion`: the box's new words and caret.
    func pick(_ suggestion: ComposerSuggestion) -> (text: String, caret: Int)? {
        guard let trigger else { return nil }
        let result = ComposerRefs.apply(suggestion, to: text, trigger: trigger, table: table)
        if let entry = result.entry { table[entry.label] = entry.tag }
        AppLog.info("composer", "suggestion picked", ["kind": suggestion.kind.rawValue, "id": suggestion.id])
        self.trigger = nil
        close()
        text = result.text
        caret = result.caret
        return (result.text, result.caret)
    }

    /// The user closed the list without a pick (its x): it stays shut for this `@` or `/`.
    func dismiss() {
        dismissedAt = trigger?.start
        trigger = nil
        close()
    }

    /// The words that go out: each picked `@[label]` as its tag.
    func outgoing(_ words: String) -> String {
        ComposerRefs.compose(words, table: table)
    }

    /// The box was sent: the list goes, and a new `@` in the emptied box opens it again. The
    /// picked references stay, so words a refused send puts back still send as tags.
    func closeList() {
        dismissedAt = nil
        trigger = nil
        close()
    }

    /// Words put back into the box from outside (a failed reply to edit): its tags read as
    /// tokens again and send as the same tags.
    func adopt(_ words: String) -> String {
        let split = ComposerRefs.inline(words, table: table)
        table.merge(split.table) { _, new in new }
        return split.body
    }

    /// The box was sent and emptied: nothing it picked carries over.
    func reset() {
        table = [:]
        dismissedAt = nil
        trigger = nil
        close()
    }

    // MARK: - Lists

    private func close() {
        searchTask?.cancel()
        searchTask = nil
        if !suggestions.isEmpty { suggestions = [] }
        if status != .ready { status = .ready }
    }

    private func setSuggestions(_ rows: [ComposerSuggestion]) {
        if suggestions != rows { suggestions = rows }
    }

    private func buildCandidates() -> [MentionCandidate] {
        guard let store else { return [] }
        return MentionRanking.candidates(tasks: store.tasks, sessions: store.sessions, selfTaskId: scope.selfTaskId)
    }

    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        let delay = searchDelay
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            do {
                let hits = try await self.search(q)
                guard !Task.isCancelled, let trigger = self.trigger, trigger.isMention,
                      trigger.query.trimmingCharacters(in: .whitespaces) == q else { return }
                let local = MentionRanking.rank(q, self.candidates)
                self.setSuggestions(MentionRanking.merge(local: local, hits: hits, candidates: self.candidates,
                                                         selfTaskId: self.scope.selfTaskId))
            } catch {
                // The local rows stay; the server's ranking is a refinement.
                AppLog.info("composer", "mention search failed", ["error": String(describing: error)])
            }
        }
    }

    private func showCommands(_ query: String) {
        let key = scope.commandsKey
        if let cached = Self.commandCache[key] {
            setSuggestions(SlashRanking.rank(query, cached.items))
            if status != .ready { status = .ready }
            if Date().timeIntervalSince(cached.at) < Self.commandCacheTTL { return }
        } else {
            setSuggestions([])
            if status != .loading { status = .loading }
        }
        readCommands(for: key)
    }

    /// Load the `/` list before it is asked for (a box's first focus), so it opens full.
    func prefetchCommands() {
        guard scope.commands, Self.commandCache[scope.commandsKey] == nil else { return }
        readCommands(for: scope.commandsKey)
    }

    /// The one read of a scope's commands, a prefetch's or an open list's: whichever started
    /// it, its answer goes to the list open NOW when that list is the scope's `/` list. A read
    /// for another scope (the box's session changed) is replaced, never waited on.
    private func readCommands(for key: String) {
        if commandsTask != nil, commandsTaskKey == key { return }
        commandsTask?.cancel()
        commandsTaskKey = key
        let cwd = scope.commandsCwd
        let host = scope.commandsHost
        commandsTask = Task { [weak self] in
            guard let self else { return }
            let result: Result<[SlashCommand], Error>
            do { result = .success(try await self.loadCommands(cwd, host)) } catch { result = .failure(error) }
            guard !Task.isCancelled else { return }
            self.commandsTask = nil
            self.commandsTaskKey = nil
            let showing = self.trigger.map { !$0.isMention } == true && self.scope.commandsKey == key
            switch result {
            case .success(let items):
                Self.commandCache[key] = (Date(), items)
                AppLog.info("composer", "slash commands loaded", ["count": String(items.count), "host": host ?? ""])
                guard showing, let trigger = self.trigger else { return }
                self.setSuggestions(SlashRanking.rank(trigger.query, items))
                if self.status != .ready { self.status = .ready }
            case .failure(let error):
                AppLog.warn("composer", "slash commands failed", ["error": String(describing: error), "host": host ?? ""])
                if showing, Self.commandCache[key] == nil { self.status = .failed }
            }
        }
    }

    /// Tests start each case with no cached commands.
    static func clearCommandCache() { commandCache = [:] }
}
