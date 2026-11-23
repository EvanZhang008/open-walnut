import Foundation
import Observation

/// The org as last read (`GET /api/v1/org`): ONE copy for every surface that shows it (the Chat
/// drawer's Org list, an Org node's Tasks), kept live while one of them is on screen. A status
/// that moves (the feed's `task-upsert`), a node's threads that change, or a reconnect reads it
/// again, coalesced, so the rows' counts follow within a second instead of on the next reopen.
/// The node rows' thread badges and red dots need no read: they come off each node's task row in
/// `TasksStore`, which carries the phone's own predictions from the tap.
@Observable
@MainActor
final class OrgTreeStore {
    static let shared = OrgTreeStore()

    private(set) var tree: OrgTreeWire?
    /// false: this server has no org (an older one).
    private(set) var available = true
    private(set) var loading = false
    /// The last read failed (what was shown, if anything, stays).
    private(set) var failure: String?
    /// A read has answered (with a tree, none, or an error) since launch.
    private(set) var answered = false

    @ObservationIgnored private let read: () async throws -> OrgTreeWire?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var signalToken: Int?
    @ObservationIgnored private var refetch: CoalescedRefetch?
    /// nil: the app's feed (`FeedSignals.shared`).
    @ObservationIgnored private let signals: FeedSignals?

    /// `read` is the WalnutTests seam; the app reads its server.
    init(read: (() async throws -> OrgTreeWire?)? = nil, signals: FeedSignals? = nil) {
        self.read = read ?? { try await WalnutAPI().orgTree() }
        self.signals = signals
        refetch = CoalescedRefetch(delay: .milliseconds(400)) { [weak self] in await self?.load() }
    }

    /// Only the newest read writes, so a read cancelled by a newer one can neither block it nor
    /// leave its error behind.
    func load() async {
        generation &+= 1
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        do {
            let fetched = try await read()
            guard gen == generation else { return }
            answered = true
            guard let fetched else {
                available = false
                return
            }
            available = true
            if fetched != tree { tree = fetched }
            failure = nil
        } catch {
            guard gen == generation, !SessionConversationStore.isCancellation(error) else { return }
            answered = true
            failure = error.localizedDescription
            AppLog.info("org", "org tree load failed", ["error": error.localizedDescription])
        }
    }

    /// A change a hand made, shown at once on every surface (a Director taken off the list): the
    /// server's next read replaces it.
    func predict(_ change: (OrgTreeWire) -> OrgTreeWire) {
        guard let tree else { return }
        let next = change(tree)
        if next != tree { self.tree = next }
    }

    // MARK: - Live while shown

    func viewerAppeared() {
        viewers += 1
        guard signalToken == nil else { return }
        signalToken = (signals ?? .shared).listen { [weak self] signal in self?.heard(signal) }
    }

    func viewerLeft() {
        viewers = max(0, viewers - 1)
        guard viewers == 0 else { return }
        if let signalToken { (signals ?? .shared).stopListening(signalToken) }
        signalToken = nil
        refetch?.cancel()
    }

    /// Any task's status (the counts are made of them), any node's threads, a reconnect.
    func heard(_ signal: FeedSignals.Signal) {
        // Shown nowhere: the next surface to open it reads it anyway.
        guard signalToken != nil else { return }
        if case .inboxChanged = signal { return }
        refetch?.ask()
    }

    /// A disconnect: the next server's org is read afresh (`LocalDataReset`).
    func eraseLocalState() {
        generation &+= 1
        tree = nil
        available = true
        loading = false
        failure = nil
        answered = false
    }
}
