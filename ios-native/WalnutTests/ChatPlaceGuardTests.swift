import XCTest

/// Guard for the whole class of "the Chat tab forgot where the user was" (the user,
/// 2026-11-02: every return to a chat landed on a new chat). It reads the app's own
/// source and fails when a NEW member appears that does not remember the place:
///
/// 1. a call anywhere in the app that resets the chat to a new chat
///    (`startNewConversation()` / `select(nil)`) or moves it to some other
///    conversation of the list (`select(….first…)`), unless it is listed below
///    with why;
/// 2. a write of the chat's conversation or agent outside the functions that
///    remember it (`ChatStore.select`, `switchAgent`, the lazy first-send adopt,
///    the launch restore, disconnect's erase);
/// 3. a session pushed over the Chat tab by anything but the remembered
///    `openedAskSession` binding, or that binding no longer being saved;
/// 4. the launch going back to a fixed new chat or a fixed agent.
final class ChatPlaceGuardTests: XCTestCase {

    private func appSources() throws -> [(path: String, text: String)] {
        let root = Self.iosRoot.appendingPathComponent("Walnut")
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no source tree at \(root.path)")
        }
        var out: [(String, String)] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let relative = String(url.path.dropFirst(Self.iosRoot.path.count + 1))
            out.append((relative, try String(contentsOf: url, encoding: .utf8)))
        }
        XCTAssertGreaterThan(out.count, 50, "the walk found the app's sources")
        return out
    }

    private static var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: Self.iosRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// Code lines only: doc and line comments name these calls in prose.
    private func codeLines(_ text: String) -> [(number: Int, line: String)] {
        text.components(separatedBy: "\n").enumerated().compactMap { index, raw in
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("//") { return nil }
            let code = raw.components(separatedBy: "//").first ?? raw
            return (index + 1, code)
        }
    }

    /// The name of the function or view property a line sits in (the nearest
    /// `func name` or `var name: some View` above it).
    private func enclosingFunction(_ lines: [(number: Int, line: String)], at index: Int) -> String {
        for i in stride(from: index, through: 0, by: -1) {
            let line = lines[i].line
            if let range = line.range(of: "func ") {
                return Self.identifier(after: line[range.upperBound...])
            }
            if line.contains(": some View"), let range = line.range(of: "var ") {
                return Self.identifier(after: line[range.upperBound...])
            }
        }
        return "<top level>"
    }

    private static func identifier(after text: Substring) -> String {
        String(text.prefix { $0.isLetter || $0.isNumber || $0 == "_" })
    }

    // MARK: 1. Every reset to a new chat is a user's own choice

    /// `file:function` of each call that puts the chat on a new chat, and why that
    /// is what the user asked for. A new entry that resets the chat fails here.
    private let newChatResets: [String: String] = [
        "Walnut/Stores/ChatStore.swift:startNewConversation":
            "the body of the explicit New chat action itself",
        "Walnut/Views/Chat/ChatDrawer.swift:newChatPill":
            "the drawer's New chat button: the user's one way to start fresh",
        "Walnut/Views/Chat/ChatDrawer.swift:deleteAsk":
            "the user deleted the ask whose chat was open: there is nothing left to return to",
    ]

    /// `file:function` of each call that moves the chat to a conversation picked
    /// from a list (its first, the newest), and why the user is not losing a place.
    private let listPicks: [String: String] = [
        "Walnut/Stores/ChatStore.swift:switchAgent":
            "a first visit to an agent the user was never on (nothing remembered): its newest chat",
        "Walnut/Stores/ChatStore.swift:deleteConversation":
            "the user deleted the conversation that was open: the newest one remaining",
    ]

    func testEveryPickFromTheListIsListed() throws {
        var found: Set<String> = []
        for (path, text) in try appSources() {
            let lines = codeLines(text)
            for (i, entry) in lines.enumerated() where entry.line.contains("select(") && entry.line.contains(".first") {
                let key = "\(path):\(enclosingFunction(lines, at: i))"
                found.insert(key)
                XCTAssertNotNil(
                    listPicks[key],
                    "\(path):\(entry.number) moves the chat to a conversation picked from a list in \(key). A return "
                        + "to the chat must come back where the user was (ChatPlace). If this is not a lost place, "
                        + "list it in listPicks with why."
                )
            }
        }
        for key in listPicks.keys {
            XCTAssertTrue(found.contains(key), "\(key) no longer picks from the list: drop it from listPicks")
        }
    }

    func testEveryResetToANewChatIsListed() throws {
        var found: [String] = []
        for (path, text) in try appSources() {
            let lines = codeLines(text)
            for (i, entry) in lines.enumerated()
            where entry.line.contains("startNewConversation()") || entry.line.contains("select(nil)") {
                if entry.line.contains("func startNewConversation") { continue }
                let key = "\(path):\(enclosingFunction(lines, at: i))"
                found.append(key)
                XCTAssertNotNil(
                    newChatResets[key],
                    "\(path):\(entry.number) resets the chat to a new chat in \(key). A return to the chat must "
                        + "come back where the user was (ChatPlace); only the user's own New chat may reset it. "
                        + "If this one IS the user's choice, list it in newChatResets with why."
                )
            }
        }
        for key in newChatResets.keys {
            XCTAssertTrue(found.contains(key), "\(key) no longer resets the chat: drop it from the list")
        }
    }

    // MARK: 2. Every write of the conversation or the agent remembers it

    func testEveryWriteOfTheChatsPlaceIsRemembered() throws {
        let path = "Walnut/Stores/ChatStore.swift"
        let lines = codeLines(try source(path))
        // Function -> why its write is remembered.
        let activeIDWriters: [String: String] = [
            "select": "writes ChatPlace.conversationKey for the agent",
            "switchAgent": "clears, then selects the agent's remembered conversation",
            "performSend": "the lazy new chat adopts its id and writes the key in the same block",
            "eraseLocalState": "disconnect forgets everything, the keys included",
        ]
        let agentWriters: [String: String] = [
            "initialize": "the launch reads ChatPlace.agentKey",
            "switchAgent": "writes ChatPlace.agentKey",
            "eraseLocalState": "disconnect forgets everything",
        ]
        // Any assignment, `self.` or not, never a comparison.
        let write = { (name: String) in
            try NSRegularExpression(pattern: "(^|[^A-Za-z0-9_.])(self\\??\\.)?\(name)\\s*=(?!=)")
        }
        let activeIDWrite = try write("activeID")
        let agentWrite = try write("activeAgentID")
        func matches(_ regex: NSRegularExpression, _ line: String) -> Bool {
            regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
        }
        var activeIDWrites = 0
        for (i, entry) in lines.enumerated() {
            let line = entry.line
            // The stored properties' own declarations are no writes.
            if line.contains("var activeID") || line.contains("var activeAgentID") { continue }
            if matches(activeIDWrite, line) {
                activeIDWrites += 1
                let fn = enclosingFunction(lines, at: i)
                XCTAssertNotNil(activeIDWriters[fn],
                                "\(path):\(entry.number) sets activeID in \(fn) without remembering it (ChatPlace)")
            }
            if matches(agentWrite, line) {
                let fn = enclosingFunction(lines, at: i)
                XCTAssertNotNil(agentWriters[fn],
                                "\(path):\(entry.number) sets activeAgentID in \(fn) without remembering it (ChatPlace)")
            }
        }
        XCTAssertGreaterThanOrEqual(activeIDWrites, 4, "the scan finds the writes it knows")
        let text = lines.map(\.line).joined(separator: "\n")
        XCTAssertTrue(text.contains("ChatPlace.save(conversation: id, agentID: activeAgentID)"),
                      "select remembers the conversation, a new chat as such")
        XCTAssertTrue(text.contains("ChatPlace.save(conversation: created, agentID: activeAgentID)"),
                      "a first send remembers its new chat")
        XCTAssertTrue(text.contains("AppPrefs.defaults.set(agentID, forKey: ChatPlace.agentKey)"), "switchAgent remembers the agent")
    }

    // MARK: 3. A session over the chat is pushed only through the remembered binding

    func testSessionsOverTheChatGoThroughTheRememberedBinding() throws {
        for (path, text) in try appSources() where path.hasPrefix("Walnut/Views/Chat/") {
            let code = codeLines(text).map(\.line).joined(separator: "\n")
            let pushes = code.components(separatedBy: "SessionConversationView(").count - 1
            if path.hasSuffix("/ChatView.swift") {
                XCTAssertEqual(pushes, 1, "ChatView pushes a session in exactly one place")
                XCTAssertTrue(code.contains(".navigationDestination(for: WalnutSession.self)"),
                              "that place is the openedAskSession destination")
                XCTAssertTrue(code.contains("chatPath = newValue.map { [$0] } ?? []"),
                              "a chat opened over another takes its place: the stack holds one chat at most")
                XCTAssertTrue(code.contains(".navigationBarBackButtonHidden(true)"),
                              "a chat over the chat is its peer: no Back to the one under it")
                XCTAssertTrue(code.contains("showChat: showChat"),
                              "picking a conversation in the sidebar takes the chat over it away")
                XCTAssertTrue(code.contains("ChatPlace.saveOpenSession(session)"),
                              "every change of openedAskSession is remembered")
                XCTAssertTrue(code.contains("whenActive { restorePlace() }"),
                              "a launch puts the remembered session back")
                XCTAssertTrue(code.contains("VoiceQuickAction.shared.armedInThisProcess"),
                              "never over a voice shortcut the composer already took")
            } else {
                XCTAssertEqual(pushes, 0, "\(path) pushes a session over the chat outside ChatView's remembered binding")
            }
        }
    }

    // MARK: 4. The launch opens the remembered place

    func testTheLaunchDoesNotForceANewChatOrTheMainAgent() throws {
        let lines = codeLines(try source("Walnut/Stores/ChatStore.swift"))
        guard let start = lines.firstIndex(where: { $0.line.contains("func initialize()") }) else {
            return XCTFail("ChatStore.initialize() not found")
        }
        let body = lines[start...].prefix { !$0.line.contains("func refreshAgents()") }.map(\.line).joined(separator: "\n")
        XCTAssertFalse(body.contains("activeAgentID = Self.mainAgentID"), "the launch opens the agent the user left")
        XCTAssertTrue(body.contains("ChatPlace.launchAgent("), "the launch reads the remembered agent")
        XCTAssertTrue(body.contains("select(remembered)"), "the launch opens the remembered conversation")
    }
}
