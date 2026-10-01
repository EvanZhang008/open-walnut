import Foundation
import os

// MARK: - Wire types between the protocol and the server

/// One request as the demo server sees it.
struct DemoRequest {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data?

    /// Percent-decoded path segments after `/api/v1` (or after `/api` for the
    /// routes that live outside the versioned contract).
    var segments: [String] {
        url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    }

    var query: [String: String] {
        var out: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            out[item.name] = item.value ?? ""
        }
        return out
    }

    var lastEventID: Int? {
        let raw = headers.first { $0.key.caseInsensitiveCompare("Last-Event-ID") == .orderedSame }?.value
        return raw.flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// The JSON body as a dictionary (empty when there is none).
    var json: [String: Any] {
        guard let body, !body.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return [:] }
        return object
    }

    func string(_ key: String) -> String? { json[key] as? String }
    func bool(_ key: String) -> Bool? { json[key] as? Bool }
}

/// One answer. `.stream` keeps the response open and hands it to `DemoStreams`.
struct DemoReply {
    enum Body {
        case json(Data)
        case bytes(Data, contentType: String)
        case empty
        case stream(DemoStreams.Channel, lastEventID: Int?)
    }

    var status: Int
    var headers: [String: String] = [:]
    var body: Body

    static func encoded<T: Encodable>(_ value: T, status: Int = 200) -> DemoReply {
        let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
        return DemoReply(status: status, body: .json(data))
    }

    static func object(_ value: Any, status: Int = 200) -> DemoReply {
        let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
        return DemoReply(status: status, body: .json(data))
    }

    static func error(_ status: Int, _ code: String, _ message: String, extras: [String: Any] = [:]) -> DemoReply {
        var envelope: [String: Any] = ["error": ["code": code, "message": message]]
        for (key, value) in extras { envelope[key] = value }
        return object(envelope, status: status)
    }

    static let noContent = DemoReply(status: 204, body: .empty)
    static let ok = DemoReply.object(["ok": true])
}

// MARK: - The server

/// The in-process stand-in for a Walnut server, used only by demo mode.
///
/// It answers the same routes, in the same shapes, as the real `/api/v1`
/// contract, from fixtures plus an in-memory store, so every screen runs its
/// normal code path. Writes change the store; `reset()` reseeds it.
///
/// Thread safety: all state lives behind one lock. Scripted turns (a chat reply,
/// a coding session's work) run on a private serial queue and re-take the lock
/// for each step. Nothing calls into `DemoStreams` synchronously while holding
/// the lock, because the stream hub calls back into the server for its attach
/// frames.
final class DemoServer: @unchecked Sendable {
    static let shared = DemoServer()

    let streams = DemoStreams()

    private let lock = NSRecursiveLock()
    private var state: DemoState
    private var clock: DemoClock
    /// Bumped by `reset()`; a scripted step from an older run checks it and stops.
    private var generation = 0
    /// Per-channel turn tokens, so Stop can end one scripted turn early.
    private var turnTokens: [String: Int] = [:]
    let turnQueue = DispatchQueue(label: "dev.openwalnut.demo.turns", qos: .userInitiated)
    private let pendingSteps = OSAllocatedUnfairLock(initialState: 0)

    /// Scripted steps scheduled but not yet run (tests wait for zero).
    var pendingStepCount: Int { pendingSteps.withLock { $0 } }

    /// Run `work` on the turn queue after `delay` seconds.
    func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) {
        pendingSteps.withLock { $0 += 1 }
        turnQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            defer { self?.pendingSteps.withLock { $0 -= 1 } }
            work()
        }
    }

    /// Multiplies every artificial delay. Tests set 0 so replies are immediate.
    private let scales = OSAllocatedUnfairLock(initialState: (latency: 1.0, turn: 1.0))
    var latencyScale: Double {
        get { scales.withLock { $0.latency } }
        set { scales.withLock { $0.latency = newValue } }
    }
    var turnScale: Double {
        get { scales.withLock { $0.turn } }
        set { scales.withLock { $0.turn = newValue } }
    }

    /// Routes that got the 404 fallback, for tests (an app route nobody wrote).
    private let unanswered = OSAllocatedUnfairLock(initialState: [String]())
    var unansweredRoutes: [String] { unanswered.withLock { $0 } }

    init() {
        let clock = DemoClock()
        self.clock = clock
        self.state = DemoFixtures.seed(clock)
        streams.attachFrames = { [weak self] channel in self?.attachFrames(channel) ?? [] }
        #if DEBUG
        // A UI test slows the demo down (`-walnut.demoLatencyScale 40`) to look at
        // the screen while a request is still in flight. Debug builds only.
        let requested = UserDefaults.standard.double(forKey: "walnut.demoLatencyScale")
        if requested > 0 { latencyScale = requested }
        #endif
    }

    /// Back to the fixtures, timed from now. Ends every open stream and every
    /// scripted turn.
    func reset(now: Date = Date()) {
        withState { state in
            generation += 1
            turnTokens.removeAll()
            clock = DemoClock(now: now)
            state = DemoFixtures.seed(clock)
        }
        unanswered.withLock { $0.removeAll() }
        streams.reset()
    }

    /// Read or change the store under the lock.
    @discardableResult
    func withState<T>(_ body: (inout DemoState) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    var now: Date { Date() }
    var nowISO: String { DemoClock.iso(Date()) }
    var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// A short, believable network delay, so spinners and transitions look the
    /// way they do against a real server on Wi-Fi.
    func latency(for request: DemoRequest) -> TimeInterval {
        let scale = latencyScale
        guard scale > 0 else { return 0 }
        let path = request.url.path
        if path.hasSuffix("/stt/transcribe") { return 0.8 * scale }
        if request.method == "POST", path == "/api/v1/sessions" { return 0.45 * scale }
        return Double.random(in: 0.05...0.16) * scale
    }

    // MARK: - Routing

    func handle(_ request: DemoRequest) -> DemoReply {
        let parts = request.segments
        guard parts.first == "api" else { return unknown(request) }
        let reply: DemoReply?
        if parts.count >= 2, parts[1] == "v1" {
            reply = routeV1(request, Array(parts.dropFirst(2)))
        } else if parts.count >= 2, parts[1] == "push" {
            reply = routePush(request, Array(parts.dropFirst(2)))
        } else {
            reply = nil
        }
        return reply ?? unknown(request)
    }

    private func unknown(_ request: DemoRequest) -> DemoReply {
        let route = "\(request.method) \(request.url.path)"
        unanswered.withLock { $0.append(route) }
        AppLog.warn("demo", "no demo answer for route", ["route": route])
        return .error(404, "not_found", "The demo server has no answer for \(route).")
    }

    /// Match `s` against a pattern where `*` takes one segment.
    private func match(_ request: DemoRequest, _ method: String, _ s: [String], _ pattern: String...) -> [String]? {
        guard request.method == method, s.count == pattern.count else { return nil }
        var captures: [String] = []
        for (expected, actual) in zip(pattern, s) {
            if expected == "*" { captures.append(actual) } else if expected != actual { return nil }
        }
        return captures
    }

    private func routeV1(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match(r, "GET", s, "status") != nil { return .object(DemoFixtures.status(now)) }
        if match(r, "POST", s, "devices", "self") != nil { return .ok }
        if match(r, "GET", s, "events") != nil { return DemoReply(status: 200, body: .stream(.events, lastEventID: r.lastEventID)) }
        if match(r, "GET", s, "agents") != nil { return .encoded(DemoFixtures.agents) }
        if match(r, "GET", s, "config") != nil { return .object(DemoFixtures.serverConfig) }
        if match(r, "POST", s, "client-logs") != nil { return .ok }
        if match(r, "POST", s, "time", "heartbeats") != nil { return .noContent }
        if match(r, "POST", s, "stt", "transcribe") != nil { return .object(["text": DemoFixtures.transcriptionSentence]) }
        if match(r, "GET", s, "asks") != nil { return asks(r) }
        if match(r, "GET", s, "search") != nil { return globalSearch(r) }
        if match(r, "GET", s, "media") != nil { return .init(status: 200, body: .bytes(DemoImage.png, contentType: "image/png")) }
        if match(r, "GET", s, "favorites") != nil { return .encoded(FavoritesResponse(notes: withState { $0.favorites })) }
        if s.first == "favorites", s.count == 2, s[1] == "notes" { return favorite(r) }
        if s.first == "conversations" { return routeConversations(r, s) }
        if s.first == "chat" { return routeChat(r, s) }
        if s.first == "tasks" { return routeTasks(r, s) }
        if s.first == "focus" { return routeFocus(r, s) }
        if s.first == "sessions" { return routeSessions(r, s) }
        if s.first == "notes" { return routeNotes(r, s) }
        if s.first == "human-inbox" { return routeInbox(r, s) }
        if s.first == "routines" { return routeRoutines(r, s) }
        if s.first == "files" || s.first == "file-content" { return routeFiles(r, s) }
        return nil
    }

    private func routePush(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match(r, "GET", s, "status") != nil {
            // The demo can never deliver a notification, and says so: the app
            // then never asks for permission while in the demo.
            return .object([
                "registeredThisDevice": false, "registered": false, "count": 0,
                "apns": ["configured": false], "tokens": [],
            ])
        }
        if match(r, "POST", s, "register") != nil {
            return .object(["ok": true, "kind": "apns", "mode": r.string("mode") ?? "always", "deliverable": false])
        }
        if match(r, "POST", s, "preferences") != nil || match(r, "POST", s, "active") != nil { return .ok }
        return nil
    }

    // MARK: - Stream attach frames

    struct SnapshotBlock: Encodable {
        let type: String
        let content: String?
        let name: String?
        let status: String?
    }

    private struct SessionSnapshot: Encodable {
        let blocks: [SnapshotBlock]
        let isStreaming: Bool
        let completedLen: Int
        let processStatus: String
    }

    private struct FeedSnapshot: Encodable {
        let tasks: [WalnutTask]
        let sessions: [WalnutSession]
    }

    /// Called by the hub on attach. Reads the store; never touches the hub.
    private func attachFrames(_ channel: DemoStreams.Channel) -> [(event: String, data: String)] {
        switch channel {
        case .events:
            let snapshot = withState { state in
                FeedSnapshot(
                    tasks: state.tasks.map(\.wire),
                    sessions: state.visibleSessions.map { state.wireSession($0) }
                )
            }
            return [("snapshot", Self.text(snapshot))]
        case .session(let id):
            let snapshot: SessionSnapshot? = withState { state in
                guard let session = state.sessions.first(where: { $0.id == id }) else { return nil }
                let key = "s:\(id)"
                if let pending = state.pendingPermissions[id] {
                    // Blocked on a prompt: the live region shows what the agent was
                    // about to do, with its tool call still running.
                    return SessionSnapshot(
                        blocks: [
                            SnapshotBlock(type: "text", content: state.liveTurns[key], name: nil, status: nil),
                            SnapshotBlock(type: "tool_call", content: nil, name: pending.toolName, status: "calling"),
                        ],
                        isStreaming: true, completedLen: 0, processStatus: "running"
                    )
                }
                // A scripted turn in flight replays its own frames after this, so
                // the snapshot only has to say a turn is running.
                return SessionSnapshot(
                    blocks: [], isStreaming: state.liveTurns[key] != nil, completedLen: 0,
                    processStatus: session.processStatus
                )
            }
            return snapshot.map { [("snapshot", Self.text($0))] } ?? []
        case .conversation:
            return []
        }
    }

    // MARK: - Small helpers

    static func text<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    static func text(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    /// The live events feed: a task changed.
    func publishTask(_ id: String) {
        guard let wire = withState({ state in state.tasks.first { $0.id == id }?.wire }) else { return }
        streams.publish(.events, event: "task-upsert", json: Self.text(wire))
    }

    func publishTaskDeleted(_ id: String) {
        streams.publish(.events, event: "task-delete", json: Self.text(["id": id]))
    }

    /// The live events feed: a session changed.
    func publishSession(_ id: String) {
        let wire = withState { state in
            state.sessions.first { $0.id == id }.map { state.wireSession($0) }
        }
        guard let wire else { return }
        streams.publish(.events, event: "session-upsert", json: Self.text(wire))
    }

    var currentGeneration: Int { withState { _ in generation } }

    /// Start a new scripted turn on `key`, returning the token its steps check.
    func beginTurnToken(_ key: String) -> Int {
        withState { _ in
            let next = (turnTokens[key] ?? 0) + 1
            turnTokens[key] = next
            return next
        }
    }

    func cancelTurnToken(_ key: String) {
        withState { _ in turnTokens[key, default: 0] += 1 }
    }

    /// Whether a scripted step still belongs to the current run and turn.
    func isCurrent(generation gen: Int, key: String, token: Int) -> Bool {
        withState { _ in generation == gen && turnTokens[key] == token }
    }

    var clockNow: DemoClock { withState { _ in clock } }
}
