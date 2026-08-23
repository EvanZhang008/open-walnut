import Foundation
import Observation

/// Human Inbox state — the letters agents wrote for the human, plus the read /
/// pinned / archived state that belongs to the reader rather than to the work.
///
/// Refresh model, deliberately poll-free: the v1 events feed carries tasks and
/// sessions only, so the inbox refreshes on foreground (`resumeForForeground`),
/// on pull-to-refresh, and when a letter push arrives (`LetterDeepLink` calls
/// `refreshFromPush`). A letter is an async artifact — nothing here needs to be
/// live to the second, and a timer would cost battery for no gain.
@Observable
@MainActor
final class InboxStore {
    private let api = WalnutAPI()
    weak var connection: ConnectionStore?

    /// False while the app is backgrounded. Every async completion re-checks it
    /// before mutating observed state (same rule as the other stores: a write
    /// that lands while suspended is scene-update work the OS bills us for).
    private var isActive = true

    /// Live (non-archived) letters, pinned first then newest.
    var letters: [Letter] = []
    /// The Archived shelf — kept SEPARATE so browsing it can never zero the
    /// unread badge or hide a letter that still wants a decision.
    var archivedLetters: [Letter] = []

    var loading = false
    var loadingArchived = false
    var errorMessage: String?

    init() {
        LifecycleHub.shared.register(self)
    }

    // MARK: - Derived

    /// Badge count. Derived from the rows we hold rather than trusted from the
    /// list response, so an optimistic read flip shows up immediately and the
    /// Archived view (a different array) cannot influence it.
    var unreadCount: Int { letters.filter { !$0.isRead }.count }

    /// Letters still waiting on a decision — the phone's "Needs Action".
    var awaitingDecisionCount: Int { letters.filter(\.isAwaitingDecision).count }

    func letter(id: String) -> Letter? {
        letters.first { $0.id == id } ?? archivedLetters.first { $0.id == id }
    }

    // MARK: - Load

    /// Cached rows first (off-main), then the network. Mirrors NotesStore: the
    /// disk read must never block the caller's thread on a cold/prewarm launch.
    func initialize() async {
        isActive = true
        if let cached = await DiskCache.loadAsync([Letter].self, key: "inbox-letters"),
           isActive, letters.isEmpty {
            letters = cached.sorted(by: Letter.isOrderedBefore)
        }
        await refresh()
    }

    func refresh() async {
        guard isActive else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await api.letters()
            guard isActive, !Task.isCancelled else { return }
            letters = response.letters.sorted(by: Letter.isOrderedBefore)
            errorMessage = nil
            connection?.reportReachability(true, source: "inbox-rest")
            DiskCache.save(letters, key: "inbox-letters")
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive else { return }
            reportIfNetwork(error)
            // A failed refresh must not blank an inbox we already have.
            if letters.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    func refreshArchived() async {
        guard isActive else { return }
        loadingArchived = true
        defer { loadingArchived = false }
        do {
            let response = try await api.letters(archived: true)
            guard isActive, !Task.isCancelled else { return }
            archivedLetters = response.letters.sorted(by: Letter.isOrderedBefore)
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive else { return }
            reportIfNetwork(error)
        }
    }

    /// A letter push landed. The push carries the envelope only (subject + the
    /// short preview), so the list has to be re-read to show the new row.
    func refreshFromPush(letterId: String?) {
        AppLog.info("inbox", "refresh from push", ["letterId": letterId ?? ""])
        Task { await refresh() }
    }

    /// Full letter (body + thread bodies). Not cached: a body can be 200KB and
    /// the thread grows behind our back whenever the agent replies.
    func detail(id: String) async throws -> Letter {
        do {
            let letter = try await api.letter(id: id)
            if isActive { merge(letter) }
            connection?.reportReachability(true, source: "inbox-rest")
            return letter
        } catch {
            reportIfNetwork(error)
            throw error
        }
    }

    // MARK: - Human state (optimistic)

    /// Opening a letter marks THAT letter read — never the whole inbox.
    /// No-op when it is already read, so scrolling back into a letter doesn't
    /// spend a request.
    func markReadOnOpen(id: String) {
        guard let current = letter(id: id), !current.isRead else { return }
        Task { await setRead(id: id, read: true) }
    }

    func setRead(id: String, read: Bool) async {
        await toggle(id: id, apply: { $0.read = read }) {
            try await self.api.setLetterRead(id: id, read: read)
        }
    }

    func setPinned(id: String, pinned: Bool) async {
        await toggle(id: id, apply: { $0.pinned = pinned }) {
            try await self.api.setLetterPinned(id: id, pinned: pinned)
        }
    }

    /// Archive/unarchive moves the row between the two lists immediately; the
    /// server answer is adopted afterwards, and a failure puts it back.
    func setArchived(id: String, archived: Bool) async {
        let before = (letters, archivedLetters)
        if archived {
            if let idx = letters.firstIndex(where: { $0.id == id }) {
                var row = letters.remove(at: idx)
                row.archived = true
                archivedLetters.insert(row, at: 0)
                archivedLetters.sort(by: Letter.isOrderedBefore)
            }
        } else {
            if let idx = archivedLetters.firstIndex(where: { $0.id == id }) {
                var row = archivedLetters.remove(at: idx)
                row.archived = false
                letters.append(row)
                letters.sort(by: Letter.isOrderedBefore)
            }
        }
        do {
            let updated = try await api.setLetterArchived(id: id, archived: archived)
            guard isActive, !Task.isCancelled else { return }
            merge(updated)
            DiskCache.save(letters, key: "inbox-letters")
        } catch {
            guard isActive else { return }
            if let apiError = error as? APIError, apiError.isCancelled { return }
            (letters, archivedLetters) = before
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Answering (delivered to the origin session)

    /// Click one action button. Returns the result so the reader can render the
    /// answered record and the delivery line; nil means the call failed and
    /// `error` carries why (the caller shows it, the buttons stay armed).
    func answer(id: String, actionId: String, freeText: String?) async -> Result<LetterActionResult, Error> {
        do {
            let result = try await api.answerLetter(id: id, actionId: actionId, freeText: freeText)
            adopt(result)
            return .success(result)
        } catch {
            reportIfNetwork(error)
            return .failure(error)
        }
    }

    /// Free-text reply from the human.
    func reply(id: String, text: String) async -> Result<LetterActionResult, Error> {
        do {
            let result = try await api.replyToLetter(id: id, text: text)
            adopt(result)
            return .success(result)
        } catch {
            reportIfNetwork(error)
            return .failure(error)
        }
    }

    // MARK: - Plumbing

    /// One optimistic toggle: flip locally, call, adopt the server row, revert
    /// the exact field on failure.
    private func toggle(
        id: String,
        apply: (inout Letter) -> Void,
        call: () async throws -> Letter
    ) async {
        let before = letter(id: id)
        if var row = before {
            apply(&row)
            merge(row)
            // A pin flip changes the order, not just the row.
            letters.sort(by: Letter.isOrderedBefore)
        }
        do {
            let updated = try await call()
            guard isActive, !Task.isCancelled else { return }
            merge(updated)
            letters.sort(by: Letter.isOrderedBefore)
            DiskCache.save(letters, key: "inbox-letters")
        } catch {
            guard isActive else { return }
            if let apiError = error as? APIError, apiError.isCancelled {
                if let before { merge(before) }
                return
            }
            if let before { merge(before) }
            letters.sort(by: Letter.isOrderedBefore)
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
        }
    }

    /// Adopt the server's letter from an answer/reply response, if it sent one.
    private func adopt(_ result: LetterActionResult) {
        guard isActive, let letter = result.letter else { return }
        merge(letter)
        DiskCache.save(letters, key: "inbox-letters")
    }

    /// Replace the row with the same id, keeping it in whichever list it lives
    /// in. A body-inlined detail record is stored as-is: the extra fields are
    /// harmless on a row and save the reader a second fetch.
    private func merge(_ letter: Letter) {
        if let idx = letters.firstIndex(where: { $0.id == letter.id }) {
            if letter.isArchived {
                letters.remove(at: idx)
                archivedLetters.insert(letter, at: 0)
                archivedLetters.sort(by: Letter.isOrderedBefore)
            } else {
                letters[idx] = letter
            }
            return
        }
        if let idx = archivedLetters.firstIndex(where: { $0.id == letter.id }) {
            if letter.isArchived {
                archivedLetters[idx] = letter
            } else {
                archivedLetters.remove(at: idx)
                letters.append(letter)
                letters.sort(by: Letter.isOrderedBefore)
            }
            return
        }
        // Unknown id (deep-linked straight from a push before the list landed).
        if letter.isArchived {
            archivedLetters.insert(letter, at: 0)
            archivedLetters.sort(by: Letter.isOrderedBefore)
        } else {
            letters.append(letter)
            letters.sort(by: Letter.isOrderedBefore)
        }
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError {
                connection?.reportReachability(false, source: "inbox-rest", error: error)
            }
        }
    }
}

extension InboxStore: LifecycleSuspendable {
    /// No streams or timers to tear down — the quiescence contract is purely
    /// "stop mutating observed state". In-flight requests settle into no-ops.
    func suspendForBackground() { isActive = false }

    func resumeForForeground() {
        isActive = true
        // One REST refresh per foreground: a letter (or an agent's reply to one)
        // very likely landed while the phone was in the user's pocket.
        Task { [weak self] in await self?.refresh() }
    }
}
