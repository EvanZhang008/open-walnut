import Foundation

/// Where the Chat tab was when the user left it, so every way back puts them there
/// again: another tab and back, the app in the background and back, and a launch
/// after the system ended the process (the user, 2026-11-02: "it should remember
/// where I was ... if I am in the main chat, stay in the main chat, don't turn it
/// into a new chat").
///
/// Three facts make up the place, each written where it changes:
/// - the agent (`switchAgent`),
/// - that agent's conversation, nil being a new chat (`ChatStore.select`),
/// - the session pushed over the chat, an ask or an org node such as Main
///   (`ChatView`, on every change of the one binding that pushes it).
///
/// A new chat is the user's own choice now: the drawer's New chat button, which
/// is remembered like any other place. Until 2026-11-02 a cold launch always
/// opened a new chat on the main agent (the 2026-08-16 call this replaces).
enum ChatPlace {
    static let agentKey = "walnut.activeAgent"
    static let openSessionKey = "walnut.chat.openSession"

    static func conversationKey(agentID: String) -> String {
        "walnut.activeConversation.\(agentID)"
    }

    /// The user left this agent on a new chat. Its own key rather than an empty
    /// conversation id, so an older build installed over this one never reads a
    /// conversation named "" (it does not know this key and ignores it).
    static func newChatKey(agentID: String) -> String {
        "walnut.chat.newChat.\(agentID)"
    }

    /// Where the user left an agent: never there, on a new chat, or in a
    /// conversation. A first visit to an agent opens its newest chat; a return to
    /// a new chat stays a new chat.
    enum Remembered: Equatable {
        case nothing
        case newChat
        case conversation(String)

        var conversationID: String? {
            if case .conversation(let id) = self { return id }
            return nil
        }
    }

    /// Written by `ChatStore.select` and the lazy first send, nil being a new chat.
    static func save(conversation id: String?, agentID: String, defaults: UserDefaults = AppPrefs.defaults) {
        if let id {
            defaults.set(id, forKey: conversationKey(agentID: agentID))
            defaults.removeObject(forKey: newChatKey(agentID: agentID))
        } else {
            defaults.removeObject(forKey: conversationKey(agentID: agentID))
            defaults.set(true, forKey: newChatKey(agentID: agentID))
        }
    }

    static func remembered(agentID: String, defaults: UserDefaults = AppPrefs.defaults) -> Remembered {
        if let id = defaults.string(forKey: conversationKey(agentID: agentID)), !id.isEmpty {
            return .conversation(id)
        }
        return defaults.bool(forKey: newChatKey(agentID: agentID)) ? .newChat : .nothing
    }

    /// The agent a launch opens: the one the user left, else the main agent. An
    /// agent that no longer exists falls back to the main one when the agent list
    /// lands (`ChatStore.refreshAgents`).
    static func launchAgent(saved: String?, mainAgentID: String) -> String {
        guard let saved = saved?.trimmingCharacters(in: .whitespacesAndNewlines), !saved.isEmpty else {
            return mainAgentID
        }
        return saved
    }

    /// After the conversation list landed: keep the remembered conversation unless
    /// the list is complete (shorter than the page asked for) and does not hold it,
    /// which means it was deleted. A deleted chat gives way to a new chat, never to
    /// some other old conversation. Returns the conversation to show.
    static func conversationAfterList(
        remembered: String?, listed: [String], pageLimit: Int
    ) -> String? {
        guard let remembered else { return nil }
        if listed.contains(remembered) { return remembered }
        return listed.count < pageLimit ? nil : remembered
    }

    // MARK: - The session pushed over the chat

    static func saveOpenSession(_ session: WalnutSession?, defaults: UserDefaults = AppPrefs.defaults) {
        guard let session else {
            defaults.removeObject(forKey: openSessionKey)
            return
        }
        guard let data = try? JSONEncoder().encode(session) else { return }
        defaults.set(data, forKey: openSessionKey)
    }

    static func savedOpenSession(defaults: UserDefaults = AppPrefs.defaults) -> WalnutSession? {
        guard let data = defaults.data(forKey: openSessionKey) else { return nil }
        return try? JSONDecoder().decode(WalnutSession.self, from: data)
    }

    /// The session a launch pushes back over the chat, as the session list carries
    /// it now when it does (fresher status and title than the snapshot). None when
    /// a voice Quick Action arrived in this process, waiting or already taken: it
    /// needs the chat's own composer on screen, and the composer may take it before
    /// the restore runs (`VoiceQuickAction.armedInThisProcess`). None in the demo,
    /// which starts from its sample data every launch.
    static func sessionToRestore(
        saved: WalnutSession?, liveSessions: [WalnutSession],
        voiceActionPending: Bool, inDemo: Bool
    ) -> WalnutSession? {
        guard let saved, !voiceActionPending, !inDemo else { return nil }
        return liveSessions.first { $0.id == saved.id } ?? saved
    }
}
