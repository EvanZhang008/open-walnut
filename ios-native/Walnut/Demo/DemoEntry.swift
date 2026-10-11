import Foundation

/// Entering and leaving the demo. Both go through the app's ordinary pairing
/// paths, so the demo exercises the same code a real server does:
///  - enter = the demo's own state erased, then `ConnectionStore.connect`
///    against the demo server's address;
///  - leave = `ConnectionStore.disconnect`, whose local data reset erases the
///    demo's state (its preferences suite, its files) and reseeds the demo
///    server, so nothing written during the demo survives it;
///  - a launch in the demo erases the demo's state too.
/// The real app's preferences are never touched by any of the three
/// (`AppPrefs`).
@MainActor
enum DemoEntry {
    /// `recents`: the Tasks tab's history. The erase empties it, and a store
    /// hydrated at launch would not read it again until the next launch, so it is
    /// read again here, now in the demo, which starts it from its sample history.
    /// `arguments`: the launch arguments, read for the demo's clock pin
    /// (`AppClock`, Debug builds only).
    /// `connect`: WalnutTests make the connection fail; nil is the real one.
    static func enter(
        connection: ConnectionStore, recents: RecentOpens? = nil,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        connect: ((ConnectionStore) async throws -> Void)? = nil
    ) async throws {
        DemoMode.registerGlobally()
        // The demo's clock first: the sample data below is timed from it.
        AppClock.applyDemoPin(arguments: arguments, demoActive: true)
        // A demo always starts from its sample data, whatever an earlier run
        // left (one ended by the app being killed rather than by Leave demo).
        LocalDataReset.eraseAll(reason: "enter-demo", scope: .demo)
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
        AppLog.info("demo", "entering the demo", [:])
        do {
            if let connect {
                try await connect(connection)
            } else {
                try await connection.connect(
                    serverURL: DemoMode.baseURLString, token: DemoMode.token, deviceName: DemoMode.deviceName
                )
            }
        } catch {
            // The demo did not start: the shown clock is the device's again, or a
            // real pairing made next in this process would run on the demo's pin
            // (App Store r7 gate, finding 5).
            AppClock.clearDemoPin()
            throw error
        }
        await recents?.hydrate()
    }

    /// The Tasks drawer's "Recently opened" when nothing is saved: the demo's sample
    /// history (`DemoFixtures.recentOpens`), timed by the demo server's clock, so the
    /// drawer has something to show the first time it opens. Empty outside the demo.
    static func sampleRecentOpens() -> [RecentOpen] {
        guard DemoMode.isActive else { return [] }
        let clock = DemoServer.shared.clockNow
        return DemoServer.shared.withState { DemoFixtures.recentOpens($0, clock) }
    }

    /// A launch while paired with the demo: the in-memory demo server has just
    /// started again from its sample data, so the demo's state from the last
    /// run goes before any store reads it: the copies the app cached (a task
    /// made in the last run came back from the pending-create cache for up to
    /// 30 minutes, beside sample data that no longer had it), and the demo's
    /// preferences and files (Apple Health turned on in the demo stayed on
    /// after a relaunch: App Store gate, 2026-10-05). The cache deletes are
    /// barriers on the caches' own queues, so they run before any later read.
    static func startFreshAtLaunch() {
        LocalDataReset.eraseDemoAtLaunch()
        AppLog.info("demo", "demo restarted from its sample data", [:])
    }

    /// The conversation the Chat tab opens on in the demo.
    static let sampleConversationID = "c-today"

    /// After the chat store's first load: a real pairing opens on an empty new
    /// chat, which in the demo would hide the best example of what chat does.
    /// So the demo opens its sample conversation instead, once per launch.
    static func didHydrateChat(_ chat: ChatStore) {
        guard DemoMode.isActive, chat.activeID == nil,
              chat.conversations.contains(where: { $0.id == sampleConversationID })
        else { return }
        chat.select(sampleConversationID)
    }
}
