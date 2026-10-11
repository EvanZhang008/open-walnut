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
///
/// Read state follows the console's rules (see `InboxFilter.swift`), and a read
/// the server did not take is never shown as taken: see "Read writes" below.
@Observable
@MainActor
final class InboxStore {
    private let api: InboxTransport
    private let storedDefaults: UserDefaults
    /// The app's own follow the demo scope (`AppPrefs`): this store is made at
    /// launch and outlives entering and leaving the demo.
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }
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

    /// The Inbox tab's filter, remembered across launches on this device.
    var filter: InboxFilter {
        didSet {
            guard filter != oldValue else { return }
            // The keep set belongs to one visit of one filter (the console clears
            // it when the toggle flips).
            if !keptReadIds.isEmpty { keptReadIds = [] }
            defaults.set(filter.rawValue, forKey: InboxFilter.storageKey)
        }
    }

    /// Letters read while Unread was on. They stay listed until the filter
    /// changes or the human leaves the tab, so the row they just opened does not
    /// vanish from under them (the console's `keptReadIds`).
    private(set) var keptReadIds: Set<String> = []

    /// Letters whose read write failed for a reason that can pass (no network,
    /// the Mac out of reach behind the cloud relay) and that will be retried.
    /// Their rows show the SERVER's answer (unread) meanwhile.
    private(set) var readRetryIds: Set<String> = []

    /// Automatic retry spacing after a failed read write; after the last one the
    /// write waits for the next refresh, foreground or pull-to-refresh. Settable
    /// so tests can run the real ladder on a short clock.
    @ObservationIgnored var readRetryDelays: [Duration] = [.seconds(2), .seconds(6), .seconds(20), .seconds(60)]

    /// One pending read write per letter. `generation` orders them: a newer tap
    /// on the same letter supersedes an older write still in the air.
    private struct ReadIntent {
        var read: Bool
        var generation: Int
        var attempts: Int
        /// A request for it is on the wire right now.
        var sending: Bool
        /// The row shows this value although the server may not have it yet:
        /// true only for the human's own first attempt, never for a retry.
        var optimistic: Bool
        /// What the optimistic flip replaced, for an exact rollback.
        var before: (read: Bool?, readAt: Double?)
    }
    @ObservationIgnored private var readIntents: [String: ReadIntent] = [:]
    @ObservationIgnored private var readGeneration = 0
    /// How new each letter's read flag is: the stamp (`readClock`) of the word it
    /// came from. Every request takes a stamp when it is ASKED and every read write
    /// takes one when it LANDS, so an answer is only as new as its asking. An answer
    /// asked before the flag's word was had (a write that landed meanwhile, or an
    /// answer asked after it that arrived first) keeps the row's flag
    /// (`adoptRead`): the reader asks for the letter and marks it read at the same
    /// moment, and the letter's answer, made with the old flag, can arrive last
    /// (App Store gates r8 and r6). Answers asked later always win, so a letter
    /// another device flips back is shown flipped.
    @ObservationIgnored private var readFreshness: [String: Int] = [:]
    @ObservationIgnored private var readClock = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?

    /// `transport` nil (production) = a WalnutAPI instance. WalnutTests pass a
    /// scripted transport and their own defaults suite.
    init(transport: InboxTransport? = nil, defaults: UserDefaults = .standard) {
        self.api = transport ?? WalnutAPI()
        self.storedDefaults = defaults
        self.filter = InboxFilter(stored: AppPrefs.resolve(defaults).string(forKey: InboxFilter.storageKey))
        LifecycleHub.shared.register(self)
    }

    // MARK: - Derived

    /// Badge count: live letters not read yet (the console's Inbox badge rule).
    /// Derived from the rows held rather than trusted from the list response, so
    /// an optimistic read flip shows up at once and the Archived view (a
    /// different array) cannot influence it.
    var unreadCount: Int { InboxListing.unreadCount(letters) }

    /// Decisions nobody has looked at yet: the Action needed chip's count.
    var unseenDecisionCount: Int { InboxListing.unseenDecisionCount(letters) }

    /// What a chip shows next to its title, nil for chips without a count.
    func count(for filter: InboxFilter) -> Int? {
        InboxListing.count(for: filter, in: letters)
    }

    /// The live list under the current filter, judged at `nowMs`.
    func visibleRows(nowMs: Double) -> [Letter] {
        InboxListing.rows(letters, filter: filter, keep: keptReadIds, nowMs: nowMs)
    }

    func letter(id: String) -> Letter? {
        letters.first { $0.id == id } ?? archivedLetters.first { $0.id == id }
    }

    /// The human left the Inbox tab: forget which read rows Unread was keeping.
    func forgetKeptRows() {
        if !keptReadIds.isEmpty { keptReadIds = [] }
    }

    // MARK: - Load

    /// Cached rows first (off-main), then the network. Mirrors NotesStore: the
    /// disk read must never block the caller's thread on a cold/prewarm launch.
    func initialize() async {
        isActive = true
        if let cached = await DiskCache.loadAsync([Letter].self, key: "inbox-letters"),
           isActive, letters.isEmpty {
            letters = InboxListing.inboxOrder(cached)
        }
        await refresh()
    }

    func refresh() async {
        guard isActive else { return }
        loading = true
        defer { loading = false }
        let asked = stamp()
        do {
            let response = try await api.letters(archived: false)
            guard isActive, !Task.isCancelled else { return }
            letters = InboxListing.inboxOrder(response.letters.map { adoptRead($0, askedAt: asked) })
            errorMessage = nil
            connection?.reportReachability(true, source: "inbox-rest")
            DiskCache.save(letters, key: "inbox-letters")
            // The server answered, so a read it refused earlier can go again now.
            flushReadRetries()
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
        // The same read-freshness rule as the inbox list: an Archived list asked
        // before a read landed must not undo it (App Store r7 gate, probe P6).
        let asked = stamp()
        do {
            let response = try await api.letters(archived: true)
            guard isActive, !Task.isCancelled else { return }
            archivedLetters = InboxListing.inboxOrder(response.letters.map { adoptRead($0, askedAt: asked) })
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

    /// Full letter (body + thread bodies). Not cached: a body can be megabytes
    /// (an html digest embeds its audio) and the thread grows behind our back
    /// whenever the agent replies.
    func detail(id: String) async throws -> Letter {
        let asked = stamp()
        do {
            let letter = adoptRead(try await api.letter(id: id), askedAt: asked)
            if isActive { merge(letter) }
            connection?.reportReachability(true, source: "inbox-rest")
            return letter
        } catch {
            reportIfNetwork(error)
            throw error
        }
    }

    // MARK: - Read writes

    /// Opening a letter marks THAT letter read (never the whole inbox) the
    /// moment it opens, as the console's reader does (not after its body loads:
    /// on a slow relay that was seconds of a badge that disagreed with the screen).
    /// No-op when it is already read, so scrolling back into a letter doesn't
    /// spend a request.
    func markReadOnOpen(id: String) {
        mark(id: id, read: true)
    }

    /// The human set a letter read or unread (opening it, a swipe, the reader's
    /// menu). The console's markLetterRead: a no-op when the row already says so
    /// (an id the list does not hold yet, e.g. a push deep link, still gets its
    /// write), and a letter read while Unread is on stays listed until the filter
    /// changes or the tab is left.
    func mark(id: String, read: Bool) {
        if let current = letter(id: id), current.isRead == read { return }
        if read && filter == .unread { keptReadIds.insert(id) }
        // The flip happens NOW, in the tap's own turn of the run loop; only the
        // request waits for a task.
        let generation = beginRead(id: id, read: read)
        Task { await sendRead(id: id, generation: generation) }
    }

    /// Requests a batch keeps on the wire at once. A Select All over a full inbox
    /// would otherwise open one request per letter in the same instant, each one a
    /// bridge hop when the phone reaches the Mac through the cloud relay.
    nonisolated static let batchReadWidth = 4

    /// The human set several letters read or unread at once (Select mode, Mark
    /// All). Every letter goes through the same intent machine as a single tap:
    /// all rows and the badge flip NOW, each write is retried or rolled back on
    /// its own, and a letter already in that state spends no request. Returns how
    /// many letters it set.
    @discardableResult
    func mark(ids: [String], read: Bool) -> Int {
        var jobs: [(id: String, generation: Int)] = []
        for id in Self.unique(ids) {
            if let current = letter(id: id), current.isRead == read { continue }
            if read && filter == .unread { keptReadIds.insert(id) }
            jobs.append((id, beginRead(id: id, read: read)))
        }
        guard !jobs.isEmpty else { return 0 }
        Task { await sendReads(jobs) }
        return jobs.count
    }

    private nonisolated static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }

    /// Send several pending writes, at most `batchReadWidth` at a time, and write
    /// the cache once at the end instead of once per answer.
    private func sendReads(_ jobs: [(id: String, generation: Int)]) async {
        var next = 0
        await withTaskGroup(of: Void.self) { group in
            func addNext() {
                guard next < jobs.count else { return }
                let job = jobs[next]
                next += 1
                group.addTask { await self.sendRead(id: job.id, generation: job.generation, persist: false) }
            }
            for _ in 0..<min(Self.batchReadWidth, jobs.count) { addNext() }
            while await group.next() != nil { addNext() }
        }
        DiskCache.save(letters, key: "inbox-letters")
    }

    /// Flip read state: optimistic at once (row + badge), then the route.
    ///
    /// A failure never leaves a read the server did not take on screen: the row
    /// goes back to what the server has. A failure that can pass (no network, a 5xx
    /// such as the cloud relay's `bridge_offline` while the Mac is away, a timeout)
    /// is retried on `readRetryDelays`, then on the next refresh or foreground, and
    /// the row flips when a retry lands. A refusal that cannot pass (404, 400) is
    /// dropped and reported.
    func setRead(id: String, read: Bool) async {
        await sendRead(id: id, generation: beginRead(id: id, read: read))
    }

    /// Record the intent and flip the row; returns the intent's generation.
    private func beginRead(id: String, read: Bool) -> Int {
        readGeneration += 1
        let generation = readGeneration
        let row = letter(id: id)
        let flips = row.map { $0.read != read } ?? false
        readIntents[id] = ReadIntent(
            read: read, generation: generation, attempts: 0, sending: true,
            optimistic: flips, before: (row?.read, row?.readAt)
        )
        readRetryIds.remove(id)
        if var row, flips {
            row.read = read
            // The console stamps an optimistic flip too (letter-store.ts
            // mergeLetterPatch): the Action needed grace window starts at the tap.
            row.readAt = InboxListing.nowMs()
            merge(row)
        }
        return generation
    }

    /// Send every waiting read write once more. NOT optimistic: the row keeps the
    /// server's answer until a retry lands, so a flaky relay never makes a row
    /// flicker between read and unread.
    func flushReadRetries() {
        guard isActive else { return }
        var jobs: [(id: String, generation: Int)] = []
        for (id, intent) in readIntents where !intent.sending {
            var next = intent
            next.sending = true
            next.optimistic = false
            readIntents[id] = next
            jobs.append((id, intent.generation))
        }
        guard !jobs.isEmpty else { return }
        // A batch that failed whole (the relay down) comes back whole: the same
        // width limit as when it was first sent.
        Task { await self.sendReads(jobs) }
    }

    /// One attempt of the pending write for `id`, if it is still the current one.
    /// `persist` false: the caller writes the cache once for a whole batch.
    private func sendRead(id: String, generation: Int, persist: Bool = true) async {
        guard let intent = readIntents[id], intent.generation == generation else { return }
        do {
            let updated = try await api.setLetterRead(id: id, read: intent.read)
            // A newer tap owns the row now; its own answer will settle it.
            guard readIntents[id]?.generation == generation else { return }
            readIntents[id] = nil
            readRetryIds.remove(id)
            let settled = keepingNewerReadStamp(updated)
            merge(settled)
            readFreshness[id] = stamp()
            if persist { DiskCache.save(letters, key: "inbox-letters") }
            connection?.reportReachability(true, source: "inbox-rest")
        } catch {
            // Re-read after the await: a refresh that landed meanwhile moved the
            // rollback target to the server's newest answer (overlayInFlightRead).
            guard let intent = readIntents[id], intent.generation == generation else { return }
            reportIfNetwork(error)
            // Show the server's answer again, never a read it did not take. Done
            // even while suspended: one row write is cheap, and a lie left on screen
            // until the next successful refresh is not.
            if intent.optimistic, var row = letter(id: id) {
                row.read = intent.before.read
                row.readAt = intent.before.readAt
                merge(row)
            }
            if Self.readFailureCanPass(error) {
                var waiting = intent
                waiting.sending = false
                waiting.optimistic = false
                waiting.attempts += 1
                readIntents[id] = waiting
                readRetryIds.insert(id)
                if isActive { scheduleReadRetry(after: waiting.attempts) }
                AppLog.warn("inbox", "read write failed, will retry", [
                    "letterId": id, "read": String(intent.read), "attempt": String(waiting.attempts),
                    "error": String(describing: error),
                ])
            } else {
                readIntents[id] = nil
                readRetryIds.remove(id)
                keptReadIds.remove(id)
                if isActive { errorMessage = error.localizedDescription }
                AppLog.error("inbox", "read write refused", [
                    "letterId": id, "read": String(intent.read), "error": String(describing: error),
                ])
            }
        }
    }

    /// Worth retrying: the request never got a real answer, or the server (or
    /// the relay in front of the Mac) said "not now". A 4xx other than 408 is a
    /// real refusal, and retrying it forever would only hide it.
    nonisolated static func readFailureCanPass(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return true }
        switch apiError {
        case .network, .cancelled, .rateLimited, .badResponse: return true
        case .server(let status, _, _, _, _): return status >= 500 || status == 408
        case .notConfigured, .unauthorized: return false
        }
    }

    /// Arm (or re-arm) the one retry timer. Past the ladder's end nothing is
    /// armed: the waiting writes go on the next refresh or foreground instead.
    private func scheduleReadRetry(after attempts: Int) {
        guard attempts >= 1, attempts <= readRetryDelays.count else { return }
        let delay = readRetryDelays[attempts - 1]
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.flushReadRetries()
        }
    }

    /// A list or detail read that landed while a user's read write is still on
    /// the wire describes the server BEFORE that write: keep the row as the human
    /// just set it until the write answers. Waiting (failed) writes are not
    /// overlaid: their rows show the server's answer.
    private func overlayInFlightRead(_ letter: Letter) -> Letter {
        guard var intent = readIntents[letter.id], intent.sending, intent.optimistic else { return letter }
        // This read is the newest word from the server, so a failed write rolls
        // back to IT rather than to what the row said before the tap. Recorded
        // even when it already agrees with the tap (read on another device).
        intent.before = (letter.read, letter.readAt)
        readIntents[letter.id] = intent
        guard letter.read != intent.read, let current = self.letter(id: letter.id) else { return letter }
        var row = letter
        row.read = intent.read
        row.readAt = current.readAt
        return row
    }

    /// The next `readClock` stamp: taken when a request is asked, and when a read
    /// write lands.
    private func stamp() -> Int {
        readClock += 1
        return readClock
    }

    /// An answer to a request asked at stamp `askedAt`, before it reaches a row.
    /// When the row's read flag comes from a newer word (a read write that landed
    /// after the asking, or an answer asked later that arrived first), the answer
    /// keeps the row's flag and stamp: it was made before that word. Otherwise its
    /// flag is the newest the store has, and the in-flight overlay applies.
    private func adoptRead(_ letter: Letter, askedAt: Int) -> Letter {
        if let fresh = readFreshness[letter.id], fresh > askedAt {
            guard let current = self.letter(id: letter.id), letter.read != current.read || letter.readAt != current.readAt
            else { return letter }
            var row = letter
            row.read = current.read
            row.readAt = current.readAt
            return row
        }
        readFreshness[letter.id] = askedAt
        return overlayInFlightRead(letter)
    }

    /// The write's answer, keeping a local stamp that is newer than the server's
    /// (the console's rule in mergeLetterPatch: `readAt` only moves forward).
    private func keepingNewerReadStamp(_ updated: Letter) -> Letter {
        guard let local = letter(id: updated.id)?.readAt, let server = updated.readAt,
              local > server else { return updated }
        var row = updated
        row.readAt = local
        return row
    }

    // MARK: - Pin / archive (optimistic, reverted on failure)

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
                archivedLetters = InboxListing.inboxOrder(archivedLetters)
            }
        } else {
            if let idx = archivedLetters.firstIndex(where: { $0.id == id }) {
                var row = archivedLetters.remove(at: idx)
                row.archived = false
                letters.append(row)
                letters = InboxListing.inboxOrder(letters)
            }
        }
        let asked = stamp()
        do {
            let updated = adoptRead(try await api.setLetterArchived(id: id, archived: archived), askedAt: asked)
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
        }
        let asked = stamp()
        do {
            let updated = adoptRead(try await call(), askedAt: asked)
            guard isActive, !Task.isCancelled else { return }
            merge(updated)
            DiskCache.save(letters, key: "inbox-letters")
        } catch {
            guard isActive else { return }
            if let apiError = error as? APIError, apiError.isCancelled {
                if let before { merge(before) }
                return
            }
            if let before { merge(before) }
            reportIfNetwork(error)
            errorMessage = error.localizedDescription
        }
    }

    /// Adopt the server's letter from an answer/reply response, if it sent one.
    /// Internal (not private) because the reader's reply box sends through
    /// `LetterReplyStore` and hands the response here.
    func adopt(_ result: LetterActionResult) {
        guard isActive, let letter = result.letter else { return }
        merge(overlayInFlightRead(letter))
        DiskCache.save(letters, key: "inbox-letters")
    }

    /// Replace the row with the same id, keeping it in whichever list it lives
    /// in, and keep both lists in inbox order (a pin flip changes the order, not
    /// just the row). A body-inlined detail record is stored as-is: the extra
    /// fields are harmless on a row and save the reader a second fetch.
    private func merge(_ letter: Letter) {
        if let idx = letters.firstIndex(where: { $0.id == letter.id }) {
            if letter.isArchived {
                letters.remove(at: idx)
                archivedLetters = InboxListing.inboxOrder([letter] + archivedLetters)
            } else {
                letters[idx] = letter
                letters = InboxListing.inboxOrder(letters)
            }
            return
        }
        if let idx = archivedLetters.firstIndex(where: { $0.id == letter.id }) {
            if letter.isArchived {
                archivedLetters[idx] = letter
            } else {
                archivedLetters.remove(at: idx)
                letters = InboxListing.inboxOrder(letters + [letter])
            }
            return
        }
        // Unknown id (deep-linked straight from a push before the list landed).
        if letter.isArchived {
            archivedLetters = InboxListing.inboxOrder([letter] + archivedLetters)
        } else {
            letters = InboxListing.inboxOrder(letters + [letter])
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
    /// No streams to tear down: the quiescence contract is purely "stop
    /// mutating observed state". In-flight requests settle into no-ops, and the
    /// retry timer stops; waiting read writes go again on the next foreground.
    func suspendForBackground() {
        isActive = false
        retryTask?.cancel()
        retryTask = nil
    }

    func resumeForForeground() {
        isActive = true
        // One REST refresh per foreground: a letter (or an agent's reply to one)
        // very likely landed while the phone was in the user's pocket. A refresh
        // that lands also sends any read write that is still waiting.
        Task { [weak self] in await self?.refresh() }
    }
}

// MARK: - Disconnect: forget everything this store holds

extension InboxStore {
    /// Drop every letter and pending read, so a re-pair starts empty
    /// (`LocalDataReset`).
    func eraseLocalState() {
        retryTask?.cancel()
        retryTask = nil
        readIntents = [:]
        readFreshness = [:]
        keptReadIds = []
        readRetryIds = []
        letters = []
        archivedLetters = []
        errorMessage = nil
        loading = false
        loadingArchived = false
    }

    /// The filter read again from the preferences now in force, after an
    /// erase: leaving the demo must not keep the demo's choice on screen.
    func reloadPreferences() {
        filter = InboxFilter(stored: defaults.string(forKey: InboxFilter.storageKey))
    }
}
