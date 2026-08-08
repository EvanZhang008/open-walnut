import Foundation

/// One decoded mutation from the /api/v1/events feed, in arrival order.
/// A snapshot is a full replace of both lists; upserts/deletes are per-row.
enum EventsFeedMutation: Equatable {
    case snapshot(tasks: [WalnutTask], sessions: [WalnutSession])
    case taskUpsert(WalnutTask)
    case taskDelete(id: String)
    case sessionUpsert(WalnutSession)
}

/// Pure list-merge logic for the events feed — kept out of the store so the
/// snapshot → upsert → delete state machine is unit-testable without SwiftUI.
/// Every function returns a `changed` flag so callers can skip same-value
/// writes (an unchanged @Observable assignment still invalidates views).
enum EventsFeedReducer {
    static func upsertTask(_ rows: [WalnutTask], _ row: WalnutTask) -> (rows: [WalnutTask], changed: Bool) {
        if let idx = rows.firstIndex(where: { $0.id == row.id }) {
            if rows[idx] == row { return (rows, false) }
            var next = rows
            next[idx] = row
            return (next, true)
        }
        return ([row] + rows, true)
    }

    static func deleteTask(_ rows: [WalnutTask], id: String) -> (rows: [WalnutTask], changed: Bool) {
        guard rows.contains(where: { $0.id == id }) else { return (rows, false) }
        return (rows.filter { $0.id != id }, true)
    }

    static func upsertSession(_ rows: [WalnutSession], _ row: WalnutSession) -> (rows: [WalnutSession], changed: Bool) {
        if let idx = rows.firstIndex(where: { $0.id == row.id }) {
            if rows[idx] == row { return (rows, false) }
            var next = rows
            next[idx] = row
            return (next, true)
        }
        return ([row] + rows, true)
    }
}

/// SSE frame assembler for the events feed (same wire format as the session
/// stream: `id:`/`event:`/`data:` lines up to a blank line, `:` comments
/// ignored). Deliberately a standalone copy — SSEClient's parser is private
/// and that file is under active surgery by another workstream; sharing it
/// would couple this feature to those changes for ~30 lines of code.
struct EventsFrameParser {
    private var event = "message"
    private var data: [String] = []

    mutating func consume(line: String) -> (event: String, data: String)? {
        if line.isEmpty {
            defer { event = "message"; data = [] }
            guard !data.isEmpty else { return nil }
            return (event, data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // ping / comment
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let field = String(line[line.startIndex..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": event = value
        case "data": data.append(value)
        default: break // `id` unused: every reconnect starts with a snapshot
        }
        return nil
    }
}

/// Lightweight SSE client for `GET /api/v1/events` — the live task + session
/// list feed. NOT SSEClient: that class is the per-conversation turn stream
/// (Last-Event-ID replay, per-store lifecycle) and is being reworked by the
/// freeze workstream; this one is a small, feed-specific client instead.
///
/// Main-thread discipline: the byte loop, frame parsing, and JSON decoding all
/// run off the MainActor. Decoded mutations buffer under a lock and flush to
/// the caller at most every `flushInterval` (≤4Hz), so a busy bus (many
/// session status flips) can never storm SwiftUI with per-event renders.
final class EventsFeedClient: @unchecked Sendable {
    enum FeedState: Equatable {
        /// Snapshot received — the feed is authoritative, stop poll fallbacks.
        case live
        /// Transport down; the client is backing off + reconnecting. Callers
        /// should poll until `live` comes back.
        case down
        /// 404 (server predates the feed) or 401/403 (token refused).
        /// Terminal: no reconnects; the caller stays on its polling fallback
        /// for the app session. Never wipes the token — auth revocation is
        /// confirmed elsewhere (ConnectionStore's probe).
        case unsupported
    }

    private let url: URL
    private let token: String
    private let onMutations: @Sendable ([EventsFeedMutation]) -> Void
    private let onStateChange: @Sendable (FeedState) -> Void

    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var liveSession: URLSession?
    private var generation: UInt64 = 0
    private var pending: [EventsFeedMutation] = []
    private var flushScheduled = false
    private var lastActivity = Date()

    /// ≤4Hz UI refresh under upsert storms (freeze-battle rule).
    private static let flushInterval: Duration = .milliseconds(250)
    /// Server pings every ~25s; silence past this = dead NAT flow, reconnect.
    private static let stallThreshold: TimeInterval = 55
    /// A snapshot data line for a big install is ~1MB; anything near this is
    /// not our server (captive portal / proxy garbage) — bail and reconnect.
    private static let maxLineBytes = 8_388_608

    init(
        url: URL,
        token: String,
        onMutations: @escaping @Sendable ([EventsFeedMutation]) -> Void,
        onStateChange: @escaping @Sendable (FeedState) -> Void
    ) {
        self.url = url
        self.token = token
        self.onMutations = onMutations
        self.onStateChange = onStateChange
    }

    func start() {
        lock.lock()
        guard task == nil else { lock.unlock(); return }
        let gen = generation
        let runner = Task { [weak self] () -> Void in
            await self?.runLoop(generation: gen)
        }
        task = runner
        lock.unlock()
    }

    func stop() {
        lock.lock()
        generation &+= 1
        let running = task
        task = nil
        let session = liveSession
        liveSession = nil
        pending = []
        flushScheduled = false
        lock.unlock()
        running?.cancel()
        session?.invalidateAndCancel()
    }

    // MARK: - Run loop

    /// Statuses that END the feed for this app session (→ .unsupported, no
    /// reconnect loop): 404 = older server without the feed; 401/403 = token
    /// refused — retrying an auth failure every 30s forever just burns
    /// battery. Deliberately does NOT wipe the token (a single 401 wiping the
    /// token forced re-pairing before — that class of bug); confirming a real
    /// revocation is ConnectionStore's probe's job. Everything else (5xx,
    /// proxies, captive portals) is transient → backoff + reconnect.
    static func isTerminalStatus(_ status: Int) -> Bool {
        status == 404 || status == 401 || status == 403
    }

    private func isCurrent(_ gen: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == gen
    }

    private func runLoop(generation gen: UInt64) async {
        var backoff: Double = 1
        while !Task.isCancelled && isCurrent(gen) {
            do {
                try await streamOnce(generation: gen)
                backoff = 1 // clean EOF — reconnect promptly (fresh snapshot)
            } catch is CancellationError {
                return
            } catch let urlError as URLError where urlError.code == .cancelled {
                // stop() OR the stall watchdog killed the session. stop() also
                // bumps the generation, so a still-current run is a watchdog
                // trip: dead connection, reconnect immediately.
                guard isCurrent(gen) else { return }
                AppLog.info("events", "feed stalled — reconnecting", [:])
                backoff = 1
            } catch {
                guard isCurrent(gen) else { return }
                AppLog.info("events", "feed error — backing off", [
                    "error": String(describing: error), "backoff": "\(backoff)s",
                ])
            }
            guard !Task.isCancelled && isCurrent(gen) else { return }
            onStateChange(.down)
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 30)
        }
    }

    private func streamOnce(generation gen: UInt64) async throws {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 86_400
        let session = URLSession(configuration: config)
        lock.lock()
        if generation == gen {
            liveSession = session
            lock.unlock()
        } else {
            lock.unlock()
            session.invalidateAndCancel()
            throw CancellationError()
        }
        defer {
            lock.lock()
            if liveSession === session { liveSession = nil }
            lock.unlock()
            session.invalidateAndCancel()
        }

        let (bytes, response) = try await session.bytes(for: request)
        guard isCurrent(gen) else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            AppLog.info("events", "feed endpoint refused", ["status": String(status)])
            if Self.isTerminalStatus(status) {
                onStateChange(.unsupported)
                stop()
                throw CancellationError()
            }
            throw APIError.badResponse
        }
        AppLog.info("events", "feed connected", [:])
        let connectedAt = Date()
        touchActivity()

        // Stall watchdog: pings count as activity; prolonged silence means the
        // TCP flow died under us (cellular NAT rebind) — kill and reconnect.
        let watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self else { return }
                self.lock.lock()
                let silent = Date().timeIntervalSince(self.lastActivity)
                self.lock.unlock()
                if silent > Self.stallThreshold {
                    session.invalidateAndCancel()
                    return
                }
            }
        }
        defer { watchdog.cancel() }

        var parser = EventsFrameParser()
        var lineBuffer: [UInt8] = []
        var deliveredFrame = false
        var sinceTouch = 0
        for try await byte in bytes {
            // Per-LINE watchdog feed (see SSEClient's byte loop, audit IO-4):
            // touchActivity is a lock + Date() per call — per-byte it added
            // ~32ns x every payload byte of pure overhead. The feed's
            // snapshot frames are hundreds of KB, so this loop pays too.
            sinceTouch += 1
            if sinceTouch >= 65_536 {
                try Task.checkCancellation()
                touchActivity()
                sinceTouch = 0
            }
            if byte == UInt8(ascii: "\n") {
                try Task.checkCancellation()
                touchActivity()
                sinceTouch = 0
                var line = lineBuffer
                if line.last == UInt8(ascii: "\r") { line.removeLast() }
                lineBuffer.removeAll(keepingCapacity: true)
                if let frame = parser.consume(line: String(decoding: line, as: UTF8.self)) {
                    deliveredFrame = true
                    handleFrame(event: frame.event, data: frame.data, generation: gen)
                }
            } else {
                lineBuffer.append(byte)
                if lineBuffer.count > Self.maxLineBytes { throw APIError.badResponse }
            }
        }
        // Anti-storm gate (audit TMR-1, same policy as SSEClient): a clean
        // EOF from a connection that never delivered a frame must not earn a
        // prompt reconnect — a 200-then-close server would loop at ~1Hz.
        if !SSEClient.shouldResetBackoff(
            deliveredFrame: deliveredFrame,
            connectedSeconds: Date().timeIntervalSince(connectedAt)
        ) {
            throw APIError.badResponse
        }
    }

    private func touchActivity() {
        lock.lock()
        lastActivity = Date()
        lock.unlock()
    }

    // MARK: - Decode + coalesced delivery (all off-main)

    private struct SnapshotFrame: Decodable {
        let tasks: [WalnutTask]
        let sessions: [WalnutSession]
    }
    private struct DeleteFrame: Decodable { let id: String }

    private func handleFrame(event: String, data: String, generation gen: UInt64) {
        let decoder = JSONDecoder()
        let payload = Data(data.utf8)
        let mutation: EventsFeedMutation?
        switch event {
        case "snapshot":
            if let snap = try? decoder.decode(SnapshotFrame.self, from: payload) {
                mutation = .snapshot(tasks: snap.tasks, sessions: snap.sessions)
                // The snapshot is the proof the feed is authoritative.
                onStateChange(.live)
            } else {
                mutation = nil
                AppLog.error("events", "snapshot decode failed", ["bytes": String(payload.count)])
            }
        case "task-upsert":
            mutation = (try? decoder.decode(WalnutTask.self, from: payload)).map { .taskUpsert($0) }
        case "task-delete":
            mutation = (try? decoder.decode(DeleteFrame.self, from: payload)).map { .taskDelete(id: $0.id) }
        case "session-upsert":
            mutation = (try? decoder.decode(WalnutSession.self, from: payload)).map { .sessionUpsert($0) }
        default:
            mutation = nil
        }
        guard let mutation else { return }
        enqueue(mutation, generation: gen)
    }

    /// Buffer a mutation and schedule one flush at most `flushInterval` out.
    /// Arrival order is preserved inside the batch, so a delete that follows
    /// an upsert of the same id still lands last.
    private func enqueue(_ mutation: EventsFeedMutation, generation gen: UInt64) {
        lock.lock()
        guard generation == gen else { lock.unlock(); return }
        pending.append(mutation)
        let shouldSchedule = !flushScheduled
        flushScheduled = true
        lock.unlock()
        guard shouldSchedule else { return }
        Task { [weak self] in
            try? await Task.sleep(for: Self.flushInterval)
            self?.flush(generation: gen)
        }
    }

    private func flush(generation gen: UInt64) {
        lock.lock()
        guard generation == gen, !pending.isEmpty else {
            flushScheduled = false
            lock.unlock()
            return
        }
        let batch = pending
        pending = []
        flushScheduled = false
        lock.unlock()
        onMutations(batch)
    }
}
