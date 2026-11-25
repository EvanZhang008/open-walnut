import Foundation
import Observation

/// What the paired server's `GET /api/v1/config` says about how this app draws:
///
/// - `ui.show_walnut_additions` (`showAll`): whether the session chat shows what Walnut added to a person's message (its notes in front,
/// the context blocks it put first; no message hints since 2026-11-01) on every message. Off, the
/// chat hides them and each bubble's long-press item shows them for that message
/// (`TimelineTurnFold.Additions`), as the web chat does.
/// - `ui.show_hidden_lines` (`showHiddenLines`): whether a reply shows, as one closed "Hidden by
///   Walnut" row under it, the lines Walnut hid from it (a developer switch, Settings > Advanced).
///   Written from here too (`setShowHiddenLines`), as the web's switch writes it. A read that does
///   not name it keeps what the phone had (`offersHiddenLines` says whether a server ever named it:
///   Settings shows the switch only then, so an older server never takes a write it cannot keep).
/// - `experimental` (`isOn`): the experiments switched on or off by choice in
///   Settings (src/core/experimental.ts). The phone shows what an experiment
///   changes only when it is on, as the web does; an id the server does not name
///   is off, each experiment's default.
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
final class ServerClientSettings {
    static let shared = ServerClientSettings()

    /// The same key as when this held one setting: a stored record without the
    /// experiments still reads.
    static let defaultsKey = "walnut.showWalnutAdditions.v1"
    /// A setting the person flips rarely; one read per five minutes is plenty.
    static let maxAge: TimeInterval = 300

    private(set) var showAll = false
    /// `ui.show_hidden_lines` as the server resolved it.
    private(set) var showHiddenLines = false
    /// The server named `ui.show_hidden_lines` (a server that has the switch).
    private(set) var offersHiddenLines = false
    /// The experiments chosen on or off on the server (`experimental`).
    private(set) var experimental: [String: Bool] = [:]
    /// When the server last answered, for this server. nil = never in this process.
    private(set) var lastRead: Date?

    @ObservationIgnored private let storedDefaults: UserDefaults
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults { AppPrefs.resolve(storedDefaults) }
    @ObservationIgnored private let fetch: () async throws -> ServerConfigInfo.ClientSettings
    @ObservationIgnored private let writeHiddenLines: (Bool) async throws -> Void
    @ObservationIgnored private let currentServer: () -> String
    @ObservationIgnored private let now: () -> Date
    /// The server `showAll` belongs to.
    @ObservationIgnored private var server: String?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    /// The newest switch write: an older write's answer, and a read made while one is out, never
    /// put back a value a newer tap set.
    @ObservationIgnored private var writeGeneration = 0
    @ObservationIgnored private var writesOut = 0

    private struct Stored: Codable {
        let server: String
        let showAll: Bool
        var experimental: [String: Bool]? = nil
        var showHiddenLines: Bool? = nil
        var offersHiddenLines: Bool? = nil
    }

    /// Whether the experiment `id` is on (an id from src/core/experimental.ts).
    func isOn(_ id: String) -> Bool { experimental[id] == true }

    init(
        defaults: UserDefaults = .standard,
        fetch: @escaping () async throws -> ServerConfigInfo.ClientSettings = { try await WalnutAPI().serverConfig().clientSettings },
        currentServer: @escaping () -> String = { AppConfig.serverURL?.absoluteString ?? "" },
        now: @escaping () -> Date = Date.init,
        writeHiddenLines: @escaping (Bool) async throws -> Void = { try await WalnutAPI().setShowHiddenLines($0) }
    ) {
        self.storedDefaults = defaults
        self.fetch = fetch
        self.writeHiddenLines = writeHiddenLines
        self.currentServer = currentServer
        self.now = now
        adoptStored()
    }

    /// Read again when the last answer is older than `maxAge`, or came from another server.
    func refreshIfStale(maxAge: TimeInterval = ServerClientSettings.maxAge) async {
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
                AppLog.warn("chat", "server client settings read failed", ["error": String(describing: error)])
            }
        }
        inflight = task
        await task.value
        inflight = nil
    }

    /// Flip `ui.show_hidden_lines`: every chat draws it at once, then the server keeps it. A
    /// refused write puts the value back and says why (the caller shows it).
    func setShowHiddenLines(_ on: Bool) async throws {
        let before = showHiddenLines
        writeGeneration += 1
        let generation = writeGeneration
        writesOut += 1
        defer { writesOut -= 1 }
        showHiddenLines = on
        store()
        do {
            try await writeHiddenLines(on)
        } catch {
            if generation == writeGeneration {
                showHiddenLines = before
                store()
            }
            AppLog.warn("chat", "show hidden lines write failed", ["error": String(describing: error)])
            throw error
        }
    }

    /// A config read made elsewhere (Settings) answers this too.
    func adopt(_ info: ServerConfigInfo) {
        adopt(info.clientSettings, server: currentServer())
    }

    private func adopt(_ value: ServerConfigInfo.ClientSettings, server: String) {
        self.server = server
        if showAll != value.showWalnutAdditions { showAll = value.showWalnutAdditions }
        if experimental != value.experimental { experimental = value.experimental }
        // A read that crossed a write out still carries the old value: the write's own answer decides.
        if let shown = value.showHiddenLines, writesOut == 0 {
            if showHiddenLines != shown { showHiddenLines = shown }
            if !offersHiddenLines { offersHiddenLines = true }
        }
        lastRead = now()
        store()
    }

    private func store() {
        guard let server else { return }
        if let data = try? JSONEncoder().encode(Stored(server: server, showAll: showAll,
                                                       experimental: experimental, showHiddenLines: showHiddenLines,
                                                       offersHiddenLines: offersHiddenLines)) {
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
            experimental = stored.experimental ?? [:]
            showHiddenLines = stored.showHiddenLines ?? false
            offersHiddenLines = stored.offersHiddenLines ?? (stored.showHiddenLines != nil)
        } else {
            showAll = false
            experimental = [:]
            showHiddenLines = false
            offersHiddenLines = false
        }
    }
}
