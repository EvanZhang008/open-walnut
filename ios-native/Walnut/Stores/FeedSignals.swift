import Foundation
import Observation

/// What the live feed (`GET /api/v1/events`, `TasksStore`) says changed besides the task and
/// session rows it carries, for the stores that keep something else: a node's Threads, the Org
/// tree's counts, a Brief, the Inbox. Each store reads itself again when its signal comes
/// (coalesced, `CoalescedRefetch`), so a thread acted on at the Mac, a letter read on the web, or a
/// status the server derived shows on the phone within a second instead of on the next reopen.
///
///   threadsChanged  `threads-changed` {task_id} (server 2026-11-19)
///   inboxChanged    `inbox-changed` {} (server 2026-11-19)
///   statusChanged   a `task-upsert` whose `user_status` moved: every server sends these, so an
///                   older server without the two frames above still moves the counts
///   resynced        a fresh snapshot (a reconnect): anything may have moved while away
@Observable
@MainActor
final class FeedSignals {
    static let shared = FeedSignals()

    enum Signal: Equatable {
        case threadsChanged(taskId: String)
        case inboxChanged
        case statusChanged(taskId: String)
        case resynced
    }

    /// Bumped per node on any signal about it (and on a resync): a view keyed on it reads again.
    private(set) var nodeGeneration: [String: Int] = [:]
    /// Observed, so a view keyed on `generation(of:)` follows a resync too.
    private(set) var resyncCount = 0
    @ObservationIgnored private var listeners: [Int: (Signal) -> Void] = [:]
    @ObservationIgnored private var nextToken = 0

    /// A view's key for one node: moves on every signal about it and on every resync.
    func generation(of taskId: String) -> Int {
        (nodeGeneration[taskId] ?? 0) &+ resyncCount
    }

    @discardableResult
    func listen(_ listener: @escaping (Signal) -> Void) -> Int {
        nextToken += 1
        listeners[nextToken] = listener
        return nextToken
    }

    func stopListening(_ token: Int) {
        listeners[token] = nil
    }

    func post(_ signal: Signal) {
        switch signal {
        case .threadsChanged(let id), .statusChanged(let id):
            nodeGeneration[id, default: 0] &+= 1
        case .resynced:
            resyncCount &+= 1
        case .inboxChanged:
            break
        }
        for listener in Array(listeners.values) { listener(signal) }
    }
}

/// One read that many signals ask for: the first ask schedules it `delay` out, later asks before
/// it runs ride the same one, and an ask while it runs schedules one more after it. Never per
/// event, never lost.
@MainActor
final class CoalescedRefetch {
    private let delay: Duration
    private let action: @MainActor () async -> Void
    private var scheduled: Task<Void, Never>?
    private var running = false
    private var again = false

    init(delay: Duration = .milliseconds(300), action: @escaping @MainActor () async -> Void) {
        self.delay = delay
        self.action = action
    }

    var isScheduled: Bool { scheduled != nil }

    func ask() {
        if running { again = true; return }
        guard scheduled == nil else { return }
        scheduled = Task { [weak self] in
            guard let delay = self?.delay else { return }
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.run()
        }
    }

    private func run() async {
        scheduled = nil
        running = true
        await action()
        running = false
        if again {
            again = false
            ask()
        }
    }

    func cancel() {
        scheduled?.cancel()
        scheduled = nil
        again = false
    }
}
