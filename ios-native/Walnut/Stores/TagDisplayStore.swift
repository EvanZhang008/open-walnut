import Foundation
import Observation

/// The tag display rules in force on the paired server (`GET /api/v1/tasks/meta/tag-display`),
/// compiled once for every view that draws tag pills.
///
/// One copy per app, read by the views straight from `shared` (Observation tracks it like an
/// environment object). It is read on every return to the foreground (`WalnutApp`) and when a
/// view that draws tags appears, each time only when the last read is older than `maxAge`,
/// and kept in UserDefaults keyed by the server it came from, so a
/// relaunch never flashes a hidden tag or a `ticket:` prefix before the read answers, and a
/// phone paired with another server never shows the old one's rules. Disconnect sweeps every
/// preference, this one included.
///
/// A failed read keeps what it had: a hidden tag must not reappear because one read failed.
/// With nothing at all (first launch, an older server), Walnut's own rules apply.
@MainActor
@Observable
final class TagDisplayStore {
    static let shared = TagDisplayStore()

    static let defaultsKey = "walnut.tagDisplay.v1"
    /// Rules change rarely (a plugin starting, the user in Settings); one read per five
    /// minutes is plenty.
    static let maxAge: TimeInterval = 300

    private(set) var compiled = CompiledTagDisplay(.walnutOnly)
    /// When the server last answered, for this server. nil = never in this process.
    private(set) var lastRead: Date?

    @ObservationIgnored private let storedDefaults: UserDefaults
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }
    @ObservationIgnored private let fetch: () async throws -> TagDisplayState
    @ObservationIgnored private let currentServer: () -> String
    @ObservationIgnored private let now: () -> Date
    /// The server `compiled` belongs to.
    @ObservationIgnored private var server: String?
    @ObservationIgnored private var inflight: Task<Void, Never>?

    private struct Stored: Codable {
        let server: String
        let state: TagDisplayState
    }

    init(
        defaults: UserDefaults = .standard,
        fetch: @escaping () async throws -> TagDisplayState = { try await WalnutAPI().tagDisplay() },
        currentServer: @escaping () -> String = { AppConfig.serverURL?.absoluteString ?? "" },
        now: @escaping () -> Date = Date.init
    ) {
        self.storedDefaults = defaults
        self.fetch = fetch
        self.currentServer = currentServer
        self.now = now
        adoptStored()
    }

    /// Read again when the last answer is older than `maxAge`, or came from another server.
    func refreshIfStale(maxAge: TimeInterval = TagDisplayStore.maxAge) async {
        if server != currentServer() { adoptStored() }
        if let lastRead, now().timeIntervalSince(lastRead) < maxAge { return }
        await refresh()
    }

    /// Read now. Concurrent callers share one request.
    func refresh() async {
        if let inflight { return await inflight.value }
        let asked = currentServer()
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let state = try await self.fetch()
                // Paired elsewhere while the read was out: its answer is not this server's.
                guard self.currentServer() == asked else { return }
                self.apply(state, server: asked)
                self.lastRead = self.now()
                if let data = try? JSONEncoder().encode(Stored(server: asked, state: state)) {
                    self.defaults.set(data, forKey: Self.defaultsKey)
                }
            } catch {
                AppLog.warn("tags", "tag display read failed", ["error": String(describing: error)])
            }
        }
        inflight = task
        await task.value
        inflight = nil
    }

    private func adoptStored() {
        let current = currentServer()
        lastRead = nil
        if let data = defaults.data(forKey: Self.defaultsKey),
           let stored = try? JSONDecoder().decode(Stored.self, from: data),
           stored.server == current {
            apply(stored.state, server: current)
        } else {
            apply(.walnutOnly, server: current)
        }
    }

    private func apply(_ state: TagDisplayState, server: String) {
        self.server = server
        compiled = CompiledTagDisplay(state)
    }
}

extension WalnutAPI {
    /// GET /api/v1/tasks/meta/tag-display → `{ rules, links }`. A replica asks the Mac for
    /// them (the plugins that set defaults run there) and answers Walnut's own when it cannot.
    func tagDisplay() async throws -> TagDisplayState {
        try await get("/tasks/meta/tag-display")
    }
}
