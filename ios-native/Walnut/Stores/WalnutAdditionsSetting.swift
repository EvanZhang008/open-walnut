import Foundation
import Observation

/// The paired server's `ui.show_walnut_additions` (`GET /api/v1/config`): whether the
/// session chat shows what Walnut added to a person's message (its notes in front,
/// the context blocks it put first, its message hints) on every message. Off, the
/// chat hides them and each bubble's long-press item shows them for that message
/// (`TimelineTurnFold.Additions`), as the web chat does.
///
/// One copy per app, read straight from `shared` (Observation tracks it), like
/// `TagDisplayStore`: read when a session chat appears and on every return to the
/// foreground, each time only when the last read is older than `maxAge`, and kept in
/// UserDefaults keyed by the server it came from, so a relaunch draws the chat the way
/// the person chose before the read answers and a phone paired elsewhere never takes
/// the old server's choice. A failed read keeps what it had; with nothing at all
/// (first launch, an older server) it is off, the server's own default.
@MainActor
@Observable
final class WalnutAdditionsSetting {
    static let shared = WalnutAdditionsSetting()

    static let defaultsKey = "walnut.showWalnutAdditions.v1"
    /// A setting the person flips rarely; one read per five minutes is plenty.
    static let maxAge: TimeInterval = 300

    private(set) var showAll = false
    /// When the server last answered, for this server. nil = never in this process.
    private(set) var lastRead: Date?

    @ObservationIgnored private let storedDefaults: UserDefaults
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }
    @ObservationIgnored private let fetch: () async throws -> Bool
    @ObservationIgnored private let currentServer: () -> String
    @ObservationIgnored private let now: () -> Date
    /// The server `showAll` belongs to.
    @ObservationIgnored private var server: String?
    @ObservationIgnored private var inflight: Task<Void, Never>?

    private struct Stored: Codable {
        let server: String
        let showAll: Bool
    }

    init(
        defaults: UserDefaults = .standard,
        fetch: @escaping () async throws -> Bool = { try await WalnutAPI().serverConfig().showWalnutAdditions },
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
    func refreshIfStale(maxAge: TimeInterval = WalnutAdditionsSetting.maxAge) async {
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
                let value = try await self.fetch()
                // Paired elsewhere while the read was out: its answer is not this server's.
                guard self.currentServer() == asked else { return }
                self.adopt(value, server: asked)
            } catch {
                AppLog.warn("chat", "walnut additions setting read failed", ["error": String(describing: error)])
            }
        }
        inflight = task
        await task.value
        inflight = nil
    }

    /// A config read made elsewhere (Settings) answers this too.
    func adopt(_ info: ServerConfigInfo) {
        adopt(info.showWalnutAdditions, server: currentServer())
    }

    private func adopt(_ value: Bool, server: String) {
        self.server = server
        if showAll != value { showAll = value }
        lastRead = now()
        if let data = try? JSONEncoder().encode(Stored(server: server, showAll: value)) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    private func adoptStored() {
        let current = currentServer()
        server = current
        lastRead = nil
        if let data = defaults.data(forKey: Self.defaultsKey),
           let stored = try? JSONDecoder().decode(Stored.self, from: data),
           stored.server == current {
            showAll = stored.showAll
        } else {
            showAll = false
        }
    }
}
