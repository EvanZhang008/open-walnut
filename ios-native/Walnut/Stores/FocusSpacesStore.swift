import Foundation
import Observation

/// The person's focus space, as the server holds it (`GET /api/v1/focus-spaces`), and the saved
/// spaces the Tasks board's Focus menu enters.
///
/// One per person and held by the server, so the web and the phone show the same focus. This
/// store reads it on app start, on every return to the foreground and on the events feed's
/// `focus-changed` frame, ends it on the phone when its `until` passes (and reads again), and
/// hands its scope to `TasksStore.focusSpaceScope`, which narrows the lists.
///
/// Behind the server experiment `focus_workspace` (`ServerClientSettings`): off, it makes no
/// request and holds nothing, so no list is narrowed and no Focus control is drawn. A server
/// that answers 404 (`experiment_off`, or one older than the routes) reads as off too.
@MainActor
@Observable
final class FocusSpacesStore {
    static let shared = FocusSpacesStore()

    /// The experiment id (src/core/experimental.ts).
    static let experimentID = "focus_workspace"

    /// The saved spaces, in the server's order.
    private(set) var spaces: [FocusSpace] = []
    /// The focus the person is in; nil = none.
    private(set) var active: ActiveFocusSpace?
    /// The server answered with the experiment on: the Focus menu shows.
    private(set) var isAvailable = false
    /// An enter is on its way to the server (the Focus menu's symbol shows it).
    private(set) var entering = false

    @ObservationIgnored private let fetch: () async throws -> FocusSpacesListing
    @ObservationIgnored private let enterCall: (String, Date?) async throws -> ActiveFocusSpace?
    @ObservationIgnored private let leaveCall: () async throws -> Void
    @ObservationIgnored private let experimentOn: @MainActor () async -> Bool
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private weak var tasks: TasksStore?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    /// A `focus-changed` came while a read was out: that read may predate it, so read once more.
    @ObservationIgnored private var readAgain = false
    /// Bumped by every enter and leave: a read that started before one is older than its answer.
    @ObservationIgnored private var writeSeq = 0
    @ObservationIgnored private var expiry: Task<Void, Never>?
    /// False while backgrounded: nothing observed is written then.
    @ObservationIgnored private var isActive = true

    init(
        fetch: @escaping () async throws -> FocusSpacesListing = { try await WalnutAPI().focusSpaces() },
        enter: @escaping (String, Date?) async throws -> ActiveFocusSpace? = { id, until in
            try await WalnutAPI().enterFocusSpace(spaceId: id, until: until)
        },
        leave: @escaping () async throws -> Void = { try await WalnutAPI().leaveFocusSpace() },
        experimentOn: @escaping @MainActor () async -> Bool = {
            await ServerClientSettings.shared.refreshIfStale()
            return ServerClientSettings.shared.isOn(FocusSpacesStore.experimentID)
        },
        now: @escaping () -> Date = Date.init
    ) {
        self.fetch = fetch
        self.enterCall = enter
        self.leaveCall = leave
        self.experimentOn = experimentOn
        self.now = now
        LifecycleHub.shared.register(self)
    }

    /// Wire the task lists: they take the focus's scope, and their feed's `focus-changed` frame
    /// reads the focus again.
    func attach(tasks: TasksStore) {
        self.tasks = tasks
        tasks.onFocusSpacesChanged = { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
        pushScope()
    }

    // MARK: - Reading

    /// Read the focus now. Concurrent callers share one read; a call during a read asks for one
    /// more after it, since the read out may predate what changed.
    func refresh() async {
        if let inflight {
            readAgain = true
            return await inflight.value
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.readAgain = false
                await self.readOnce()
            } while self.readAgain
            // Cleared here, in the same turn as the last check, so no ask falls between them.
            self.inflight = nil
        }
        inflight = task
        await task.value
    }

    private func readOnce() async {
        guard await experimentOn() else {
            adoptOff()
            return
        }
        let seq = writeSeq
        do {
            let listing = try await fetch()
            guard isActive, seq == writeSeq else { return }
            isAvailable = true
            if spaces != listing.spaces { spaces = listing.spaces }
            setActive(listing.active)
        } catch let error as APIError where error.meansFocusSpacesOff {
            adoptOff()
        } catch {
            // Offline or a hiccup: keep what is shown; the next foreground or frame reads again.
            AppLog.warn("focus-spaces", "read failed", ["error": String(describing: error)])
        }
    }

    /// The experiment is off: nothing held, nothing narrowed, no menu.
    private func adoptOff() {
        guard isActive else { return }
        if isAvailable { isAvailable = false }
        if !spaces.isEmpty { spaces = [] }
        setActive(nil)
    }

    // MARK: - Entering and leaving

    /// Enter a saved space, until `until` (nil = until the person leaves). A failure shows as the
    /// board's toast, with the server's own words (a cloud companion's `not_supported_cloud`).
    func enter(spaceId: String, until: Date?) async {
        writeSeq += 1
        entering = true
        defer { entering = false }
        do {
            let entered = try await enterCall(spaceId, until)
            guard isActive else { return }
            setActive(entered)
        } catch {
            report(error, what: "enter")
        }
    }

    /// Leave the focus. Shown at once; put back when the server refuses.
    func leave() async {
        guard let previous = active else { return }
        writeSeq += 1
        setActive(nil)
        do {
            try await leaveCall()
        } catch {
            // Back as it was, unless something newer landed meanwhile.
            if active == nil { setActive(previous) }
            report(error, what: "leave")
        }
    }

    private func report(_ error: Error, what: String) {
        if (error as? APIError)?.isCancelled == true { return }
        AppLog.warn("focus-spaces", "\(what) failed", ["error": String(describing: error)])
        guard isActive else { return }
        let verb = what == "enter" ? "Focus not entered" : "Focus not left"
        tasks?.transientError = "\(verb): \(error.localizedDescription)"
    }

    // MARK: - The active focus

    /// Adopt a focus (nil = none). One that has already ended is none. Hands the scope to the
    /// lists and arms the end.
    private func setActive(_ next: ActiveFocusSpace?) {
        let current = next.flatMap { $0.hasEnded(at: now()) ? nil : $0 }
        if active != current { active = current }
        pushScope()
        armExpiry()
    }

    private func pushScope() {
        guard let tasks else { return }
        let scope = active?.scope
        if tasks.focusSpaceScope != scope { tasks.focusSpaceScope = scope }
    }

    /// At `until` the focus ends here at once (the lists come back whole) and the server is read
    /// again, which has ended it too.
    private func armExpiry() {
        expiry?.cancel()
        expiry = nil
        guard isActive, let until = active?.untilDate else { return }
        let delay = max(0, until.timeIntervalSince(now()))
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.expireIfDue()
        }
    }

    private func expireIfDue() {
        guard isActive, let active, active.hasEnded(at: now()) else { return }
        setActive(nil)
        Task { await self.refresh() }
    }

    /// Disconnect: nothing of the old server's focus stays.
    func eraseLocalState() {
        expiry?.cancel()
        expiry = nil
        isAvailable = false
        spaces = []
        active = nil
        pushScope()
    }

    // MARK: - Test seams (production code never calls these)

    func _expireIfDueForTesting() { expireIfDue() }
}

extension FocusSpacesStore: LifecycleSuspendable {
    func suspendForBackground() {
        isActive = false
        expiry?.cancel()
        expiry = nil
    }

    func resumeForForeground() {
        isActive = true
        // A focus that ended while away ends now, before the read answers.
        if let active, active.hasEnded(at: now()) { setActive(nil) } else { armExpiry() }
        Task { [weak self] in await self?.refresh() }
    }
}

/// How long an entered focus lasts, as the Focus menu offers it (the web's `FOCUS_LENGTHS`).
enum FocusSpaceLength: CaseIterable, Identifiable {
    case oneHour, twoHours, untilLeft

    var id: Self { self }

    var title: String {
        switch self {
        case .oneHour: return "1 hour"
        case .twoHours: return "2 hours"
        case .untilLeft: return "Until I leave"
        }
    }

    /// The end for a focus entered at `now`; nil = until the person leaves.
    func until(from now: Date) -> Date? {
        switch self {
        case .oneHour: return now.addingTimeInterval(3600)
        case .twoHours: return now.addingTimeInterval(7200)
        case .untilLeft: return nil
        }
    }
}
