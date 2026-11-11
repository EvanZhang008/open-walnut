import Foundation
import Network

/// The server `ChatPlaceUITests` pair the app to: a loopback `/api/v1` the test
/// runner hosts itself, so the tests need no Walnut anywhere (CI runs with none) and
/// never touch anyone's data. It holds just what the Chat tab's ways back need: one
/// agent with two conversations, two asks with a session (one still on its placeholder
/// title), and an org whose Main (an org node, `org_role` main) has
/// a session. Field names follow `src/web/routes/api-v1.ts` and the app's decoders;
/// anything else answers the v1 404, which the app reads as "not on this server",
/// never as offline. Event streams are held open with comments, as the real ones are.
///
/// Port 0 on 127.0.0.1 (the simulator shares the Mac's loopback), so two runs never
/// collide and it is never production's port.
final class ChatPlaceFixtureServer {
    static let mainTaskID = "task-fixture-main"
    static let mainSessionID = "sess-fixture-main"
    static let askTaskID = "task-fixture-ask"
    static let askSessionID = "sess-fixture-ask"
    static let conversationIDs = ["conv-fixture-1", "conv-fixture-2"]
    /// An ask still wearing its placeholder title, filed under the stored "Ask Walnut"
    /// project, as an older Mac lists it (QuickQuestionRenameUITests reads it).
    static let placeholderAskTaskID = "task-fixture-ask-placeholder"
    static let placeholderAskSessionID = "sess-fixture-ask-placeholder"
    static let askProject = "Ask Walnut"

    /// Optional test data; the empty default keeps the old answers (transcript 404, no tasks).
    struct Options {
        /// Session id to `SessionTranscript.Message` rows, served at `GET /sessions/:id/transcript`.
        var history: [String: [[String: Any]]] = [:]
        /// `WalnutTask` rows for `GET /tasks`; `GET /tasks/:id` answers each as a sessionless detail.
        var tasks: [[String: Any]] = []
        var tasksInitiallyHidden = false
    }

    private let options: Options
    private var tasksVisible: Bool
    private let listener: NWListener
    private let queue = DispatchQueue(label: "chat-place-fixture")
    /// Open event streams, each pinged every 20 s: the app's stream watchdog
    /// reconnects after 50 s of silence.
    private var held: [ObjectIdentifier: NWConnection] = [:]
    private var events: [ObjectIdentifier: NWConnection] = [:]
    private var ping: DispatchSourceTimer?
    private(set) var port: UInt16 = 0
    /// Extra projects, each named by one task, so a picker's list is longer than a screen
    /// with the "Ask Walnut" project in the middle (a list that has to scroll to its row).
    var extraProjectCount = 0
    /// Answers a test adds on top (`OrgThreadsFixture`), asked first; nil passes to the routes
    /// below. Set before `start`.
    var extraRoute: ((_ method: String, _ path: String) -> (Int, Any)?)?
    /// How long an answer waits before it goes out, per path (a slow server for one read). Set
    /// before `start`.
    var answerDelay: ((_ method: String, _ path: String) -> TimeInterval)?
    /// Answers kept back until `releaseHeld()`: a slow read the test ends itself, not a clock, so
    /// a slow runner's queries can never outlast it (CI, 2026-11-10: a 5 s read landed before Back).
    private var holdMatch: ((_ method: String, _ path: String) -> Bool)?
    private var heldAnswers: [() -> Void] = []

    init(options: Options = Options()) throws {
        self.options = options
        tasksVisible = !options.tasksInitiallyHidden
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters)
    }

    var url: String { "http://127.0.0.1:\(port)" }

    func start(timeout: TimeInterval = 30) throws {
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): failure = error; ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + timeout) == .success else {
            listener.cancel()
            throw NSError(domain: "ChatPlaceFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "listener never got ready"])
        }
        if let failure { throw failure }
        port = listener.port?.rawValue ?? 0
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 20, repeating: 20)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            for connection in self.held.values {
                connection.send(content: Data(": ping\n\n".utf8), completion: .contentProcessed { _ in })
            }
        }
        timer.resume()
        ping = timer
    }

    /// While set, every connection is dropped as it comes and the open streams go: the server is
    /// out of reach, and back when cleared (a test that goes offline and comes back).
    private var refusingConnections = false

    func setReachable(_ reachable: Bool) {
        queue.sync {
            refusingConnections = !reachable
            guard !reachable else { return }
            for connection in held.values { connection.cancel() }
            held.removeAll()
        }
    }

    /// From now on, an answer `match` names waits until `releaseHeld()` (any `answerDelay` it had
    /// is dropped: the hold is its delay).
    func holdAnswers(where match: @escaping (_ method: String, _ path: String) -> Bool) {
        queue.sync { holdMatch = match }
    }

    /// Sends every held answer now and holds no more.
    func releaseHeld() {
        queue.sync {
            holdMatch = nil
            let answers = heldAnswers
            heldAnswers.removeAll()
            for send in answers { send() }
        }
    }

    func stop() {
        queue.sync {
            holdMatch = nil
            heldAnswers.removeAll()
            ping?.cancel()
            ping = nil
            for connection in held.values { connection.cancel() }
            held.removeAll()
            events.removeAll()
        }
        listener.cancel()
    }

    var taskEventsConnected: Bool { queue.sync { !events.isEmpty } }

    func revealTasks() -> Bool {
        queue.sync {
            guard !events.isEmpty else { return false }
            tasksVisible = true
            for task in options.tasks {
                guard let data = try? JSONSerialization.data(withJSONObject: task) else { continue }
                var frame = Data("event: task-upsert\ndata: ".utf8)
                frame.append(data)
                frame.append(Data("\n\n".utf8))
                for connection in events.values {
                    connection.send(content: frame, completion: .contentProcessed { _ in })
                }
            }
            return true
        }
    }

    // MARK: - HTTP

    private func accept(_ connection: NWConnection) {
        if refusingConnections {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let head = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let header = String(decoding: buffer[..<head.lowerBound], as: UTF8.self)
                let length = Self.contentLength(header)
                if buffer.count - head.upperBound >= length {
                    self.answer(connection, requestLine: header.components(separatedBy: "\r\n").first ?? "")
                    return
                }
            }
            if done || error != nil { connection.cancel(); return }
            self.read(connection, buffer: buffer)
        }
    }

    private static func contentLength(_ header: String) -> Int {
        for line in header.components(separatedBy: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased() == "content-length" {
                return Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        return 0
    }

    private func answer(_ connection: NWConnection, requestLine: String) {
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map(String.init) ?? "GET"
        let target = parts.count > 1 ? String(parts[1]) : "/"
        let split = target.split(separator: "?", maxSplits: 1).map(String.init)
        let path = split.first ?? target
        let query = split.count > 1 ? split[1] : ""
        if method == "GET", Self.isStream(path) {
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n"
                + "Connection: keep-alive\r\n\r\n: fixture\n\n"
            let key = ObjectIdentifier(connection)
            held[key] = connection
            if path == "/api/v1/events" { events[key] = connection }
            connection.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed, .cancelled:
                    self?.held[key] = nil
                    self?.events[key] = nil
                default: break
                }
            }
            connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            return
        }
        let (status, body) = route(method: method, path: path, query: query)
        let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
        let head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Not Found")\r\nContent-Type: application/json\r\n"
            + "Content-Length: \(data.count)\r\nConnection: close\r\n\r\n"
        if let holdMatch, holdMatch(method, path) {
            heldAnswers.append {
                connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
            }
            return
        }
        let wait = answerDelay?(method, path) ?? 0
        guard wait > 0 else {
            connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
            return
        }
        queue.asyncAfter(deadline: .now() + wait) {
            connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    private static func isStream(_ path: String) -> Bool {
        path == "/api/v1/events"
            || (path.hasSuffix("/stream")
                && (path.hasPrefix("/api/v1/sessions/") || path.hasPrefix("/api/v1/conversations/")))
    }

    // MARK: - The data

    private static let at = "2026-11-02T10:00:00.000Z"
    /// Older than `at`, so the placeholder ask lists second and `firstMatch` stays the
    /// ask ChatPlaceUITests opens.
    private static let earlier = "2026-11-02T09:00:00.000Z"

    private static func session(_ id: String, task: String, title: String, project: String? = nil) -> [String: Any] {
        var row: [String: Any] = [
            "id": id, "title": title, "task_id": task, "task_title": title, "host": "",
            "process_status": "idle", "started_at": at, "last_active_at": at, "message_count": 2,
        ]
        if let project { row["project"] = project }
        return row
    }

    /// `GET /sessions/:id`, for an open that comes before the session list.
    private static func sessionDetail(_ id: String, task: String, title: String) -> [String: Any] {
        [
            "session": [
                "claudeSessionId": id, "taskId": task, "title": title, "process_status": "idle",
                "host": "", "startedAt": at, "lastActiveAt": at, "messageCount": 2,
            ],
            "pendingPermissions": [] as [Any],
        ]
    }

    private static func task(_ id: String, title: String, session: String, project: String? = nil) -> [String: Any] {
        var row: [String: Any] = ["id": id, "title": title, "phase": "IN_PROGRESS", "session_ids": [session], "session_id": session]
        if let project { row["project"] = project }
        return row
    }

    /// A `GET /tasks` row: the fields `WalnutTask` requires, nothing else.
    static func taskRow(id: String, title: String, phase: String = "TODO") -> [String: Any] {
        ["id": id, "title": title, "status": "todo", "phase": phase, "priority": "none", "project": "",
         "created_at": at, "updated_at": at]
    }

    /// One transcript row (`SessionTranscript.Message`): a text row, a user row a person sent.
    static func historyRow(role: String, text: String, at timestamp: String) -> [String: Any] {
        var row: [String: Any] = ["role": role, "text": text, "timestamp": timestamp]
        if role == "user" { row["sentBy"] = "person" }
        return row
    }

    /// The whole history as one rich, unpageable page; `before=` has nothing older.
    private func transcript(_ sessionID: String, query: String) -> [String: Any]? {
        guard let rows = options.history[sessionID] else { return nil }
        let older = query.split(separator: "&").contains { $0.hasPrefix("before=") }
        return [
            "sessionId": sessionID, "exportedAt": Self.at, "truncated": false,
            "messages": older ? [] as [Any] : rows, "pageable": false, "rich": true,
        ]
    }

    private func route(method: String, path: String, query: String) -> (Int, Any) {
        if let extra = extraRoute?(method, path) { return extra }
        let v1 = "/api/v1"
        guard path.hasPrefix(v1) else { return (404, Self.notFound(path)) }
        let p = String(path.dropFirst(v1.count))
        if method == "GET", p.hasPrefix("/sessions/"), p.hasSuffix("/transcript") {
            let id = String(p.dropFirst("/sessions/".count).dropLast("/transcript".count))
            if let body = transcript(id, query: query) { return (200, body) }
            return (404, Self.notFound(path))
        }
        if method == "GET", p.hasPrefix("/tasks/"),
           let row = options.tasks.first(where: { "/tasks/\($0["id"] as? String ?? "")" == p }) {
            guard tasksVisible else { return (404, Self.notFound(path)) }
            var detail = row
            detail["session_ids"] = [] as [Any]
            return (200, ["task": detail])
        }
        switch (method, p) {
        case ("GET", ""), ("GET", "/"), ("GET", "/status"):
            return (200, ["mode": "LIVE", "cloud": false, "version": "0.0.0-fixture", "serverTime": Self.at])
        case ("GET", "/agents"):
            return (200, [["id": "general", "name": "Walnut", "isMain": true]])
        case ("GET", "/conversations"):
            return (200, [
                ["id": Self.conversationIDs[0], "title": "Weekend plans", "updatedAt": Self.at, "messageCount": 2],
                ["id": Self.conversationIDs[1], "title": "Reading list", "updatedAt": Self.at, "messageCount": 2],
            ])
        case ("GET", "/asks"):
            return (200, [
                "agentId": "general", "project": Self.askProject, "total": 2, "launch": true,
                "asks": [[
                    "id": Self.askTaskID, "title": "Compare two laptops", "state": "idle",
                    "activityAt": Self.at, "createdAt": Self.at, "sessionId": Self.askSessionID,
                    "phase": "IN_PROGRESS", "unread": false,
                ], [
                    "id": Self.placeholderAskTaskID, "title": Self.askProject, "state": "idle",
                    "activityAt": Self.earlier, "createdAt": Self.earlier, "sessionId": Self.placeholderAskSessionID,
                    "phase": "IN_PROGRESS", "unread": false,
                ]],
            ])
        case ("GET", "/org"):
            return (200, ["tree": [
                "main": ["id": Self.mainTaskID, "title": "Main", "phase": "IN_PROGRESS", "hasSession": true, "name": "Main"],
                "projects": [] as [Any],
                "counts": ["open": 0, "running": 0, "needsYou": 0, "waiting": 0],
            ]])
        case ("GET", "/sessions"):
            return (200, ["syncedAt": Self.at, "sessions": [
                Self.session(Self.mainSessionID, task: Self.mainTaskID, title: "Main"),
                Self.session(Self.askSessionID, task: Self.askTaskID, title: "Compare two laptops"),
                Self.session(Self.placeholderAskSessionID, task: Self.placeholderAskTaskID,
                             title: Self.askProject, project: Self.askProject),
            ]])
        case ("GET", "/tasks/\(Self.mainTaskID)"):
            // Main is the org's CEO node, so its chat wears the Threads, Tasks and Brief bar.
            var main = Self.task(Self.mainTaskID, title: "Main", session: Self.mainSessionID)
            main["org_role"] = "main"
            return (200, ["task": main])
        case ("GET", "/tasks/\(Self.askTaskID)"):
            return (200, ["task": Self.task(Self.askTaskID, title: "Compare two laptops", session: Self.askSessionID)])
        case ("GET", "/sessions/\(Self.mainSessionID)"):
            return (200, Self.sessionDetail(Self.mainSessionID, task: Self.mainTaskID, title: "Main"))
        case ("GET", "/tasks/\(Self.placeholderAskTaskID)"):
            return (200, ["task": Self.task(Self.placeholderAskTaskID, title: Self.askProject,
                                            session: Self.placeholderAskSessionID, project: Self.askProject)])
        case ("GET", "/sessions/\(Self.placeholderAskSessionID)"):
            return (200, Self.sessionDetail(Self.placeholderAskSessionID, task: Self.placeholderAskTaskID, title: Self.askProject))
        case ("GET", "/sessions/\(Self.askSessionID)"):
            return (200, Self.sessionDetail(Self.askSessionID, task: Self.askTaskID, title: "Compare two laptops"))
        case ("GET", "/tasks"):
            return (200, ["tasks": tasksVisible ? options.tasks : [], "syncedAt": Self.at])
        case ("GET", "/tasks/groups"):
            // Projects named by an (empty) folder each: "Aa" ones sort before "Ask Walnut", "Zz" ones after.
            let before = extraProjectCount * 5 / 8
            return (200, ["groups": (0..<extraProjectCount).map { i -> [String: Any] in
                let name = i < before ? String(format: "Aa Project %02d", i) : String(format: "Zz Project %02d", i)
                return ["group_id": "g-fixture-extra-\(i)", "label": name, "hidden": false,
                        "member_ids": [] as [Any], "project": name]
            }])
        case ("GET", "/focus/tasks"):
            return (200, ["pinned_tasks": [] as [Any]])
        case ("GET", "/human-inbox"):
            return (200, ["letters": [] as [Any], "unreadCount": 0])
        case ("POST", _), ("PUT", _), ("PATCH", _):
            // Logs, heartbeats, the device row: accepted and forgotten.
            return (200, ["ok": true])
        default:
            if method == "GET", p.hasPrefix("/conversations/"), p.hasSuffix("/messages") {
                return (200, [] as [Any])
            }
            return (404, Self.notFound(path))
        }
    }

    private static func notFound(_ path: String) -> [String: Any] {
        ["error": ["code": "not_found", "message": "the chat place fixture does not serve \(path)"]]
    }
}
