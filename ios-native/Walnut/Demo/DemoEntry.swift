import Foundation

/// Entering and leaving the demo. Both go through the app's ordinary pairing
/// paths, so the demo exercises the same code a real server does:
///  - enter = `ConnectionStore.connect` against the demo server's address;
///  - leave = `ConnectionStore.disconnect`, whose local data reset also reseeds
///    the demo server, so nothing written during the demo survives it.
@MainActor
enum DemoEntry {
    static func enter(connection: ConnectionStore) async throws {
        DemoMode.registerGlobally()
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
        AppLog.info("demo", "entering the demo", [:])
        try await connection.connect(
            serverURL: DemoMode.baseURLString, token: DemoMode.token, deviceName: DemoMode.deviceName
        )
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
