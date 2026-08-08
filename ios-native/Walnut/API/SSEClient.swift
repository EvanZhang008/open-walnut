import Foundation

/// A parsed SSE event (`id:` / `event:` / `data:` lines up to a blank line).
struct SSEEvent {
    let id: String?
    let event: String
    let data: String
}

/// Server-Sent Events client for the conversation turn stream.
///
/// - Parses `id:` / `event:` / `data:` frames terminated by a blank line;
///   `:` comment lines (the server's 25s pings) are ignored.
/// - Tracks the last seen event id and sends it as `Last-Event-ID` on
///   reconnect so the server replays only missed events.
/// - Reconnects automatically with exponential backoff (1s → 30s) until stopped.
///
/// NOTE: we parse raw bytes rather than `URLSession.AsyncBytes.lines` because
/// AsyncLineSequence silently skips empty lines — and the empty line is
/// exactly what delimits SSE frames.
final class SSEClient: @unchecked Sendable {
    private let url: URL
    private let token: String
    private let onEvent: @Sendable (SSEEvent) -> Void
    private let onConnectionChange: @Sendable (Bool) -> Void
    /// Fired with the HTTP status when the stream endpoint answers non-200
    /// (e.g. 404 on an older server that lacks the route). Lets the caller
    /// abandon SSE and fall back to polling instead of retrying forever.
    private let onHTTPError: (@Sendable (Int) -> Void)?

    /// Both of these are touched from several concurrency domains and so live
    /// under `stallLock` like the rest of the mutable state:
    ///  - `task` is written by `start()` / `stop()` on whatever actor the store
    ///    calls from, and read by `stop()`.
    ///  - `lastEventID` is written inside the byte loop (the run-loop Task) and
    ///    read by `streamOnce` when building the reconnect request AND by the
    ///    stall-watchdog log line, which runs on a different task.
    /// The class is `@unchecked Sendable`, so nothing else was enforcing this;
    /// a torn read here means a reconnect replays from the wrong event id (a
    /// duplicated or, worse, a skipped span of the turn).
    private var task: Task<Void, Never>?
    private var lastEventID: String?

    private func currentTask() -> Task<Void, Never>? {
        stallLock.lock()
        defer { stallLock.unlock() }
        return task
    }

    /// Installs a run-loop task only when none is live. Returns false when one
    /// already is (so `start()` stays idempotent without a racy nil-check).
    private func installTask(_ candidate: Task<Void, Never>) -> Bool {
        stallLock.lock()
        defer { stallLock.unlock() }
        guard task == nil else { return false }
        task = candidate
        return true
    }

    private func takeTask() -> Task<Void, Never>? {
        stallLock.lock()
        defer { stallLock.unlock() }
        let existing = task
        task = nil
        return existing
    }

    private func setLastEventID(_ id: String) {
        stallLock.lock()
        lastEventID = id
        stallLock.unlock()
    }

    private func currentLastEventID() -> String? {
        stallLock.lock()
        defer { stallLock.unlock() }
        return lastEventID
    }

    /// Stall watchdog state. The server sends a `: ping` comment every 25s, so
    /// a healthy stream is never silent for long. Cellular NAT rebinds (WiFi↔5G,
    /// screen lock) kill idle TCP flows WITHOUT an error — URLSession would sit
    /// on the dead stream for up to timeoutIntervalForRequest (1h). The watchdog
    /// tears the connection down after `stallThreshold` of silence so the run
    /// loop reconnects (with Last-Event-ID replay) within seconds.
    private let stallLock = NSLock()
    private var lastActivity = Date()
    private var stallTripped = false
    private var generation: UInt64 = 0
    private var liveSession: URLSession?
    private static let stallThreshold: TimeInterval = 50
    /// Single-line buffer cap. Real SSE lines are tiny except the attach
    /// `snapshot`, which the server now byte-budgets (session-stream-buffer's
    /// SNAPSHOT_BYTE_BUDGET ≈ 640KB plus JSON overhead) — 4MB is comfortably
    /// above every legitimate frame while still bounding memory against a
    /// newline-free garbage stream. Internal for WalnutTests.
    static let maxLineBytes = 4_194_304

    private func touchActivity() {
        stallLock.lock()
        lastActivity = Date()
        stallLock.unlock()
    }

    private func silentFor() -> TimeInterval {
        stallLock.lock()
        defer { stallLock.unlock() }
        return Date().timeIntervalSince(lastActivity)
    }

    /// Synchronous helpers so async contexts never touch NSLock directly
    /// (lock()/unlock() are unavailable-from-async in Swift 6 mode).
    private func markStallTripped() {
        stallLock.lock()
        stallTripped = true
        stallLock.unlock()
    }

    private func consumeStallTripped() -> Bool {
        stallLock.lock()
        defer { stallLock.unlock() }
        let tripped = stallTripped
        stallTripped = false
        return tripped
    }

    private func currentGeneration() -> UInt64 {
        stallLock.lock()
        defer { stallLock.unlock() }
        return generation
    }

    private func isCurrent(_ candidate: UInt64) -> Bool {
        stallLock.lock()
        defer { stallLock.unlock() }
        return generation == candidate
    }

    private func installSession(_ session: URLSession, generation candidate: UInt64) -> Bool {
        stallLock.lock()
        defer { stallLock.unlock() }
        guard generation == candidate else { return false }
        liveSession = session
        return true
    }

    private func clearSession(_ session: URLSession) {
        stallLock.lock()
        if liveSession === session { liveSession = nil }
        stallLock.unlock()
    }

    private func advanceGenerationAndTakeSession() -> URLSession? {
        stallLock.lock()
        generation &+= 1
        let session = liveSession
        liveSession = nil
        stallLock.unlock()
        return session
    }

    init(
        url: URL,
        token: String,
        onEvent: @escaping @Sendable (SSEEvent) -> Void,
        onConnectionChange: @escaping @Sendable (Bool) -> Void,
        onHTTPError: (@Sendable (Int) -> Void)? = nil
    ) {
        self.url = url
        self.token = token
        self.onEvent = onEvent
        self.onConnectionChange = onConnectionChange
        self.onHTTPError = onHTTPError
    }

    func start() {
        let startGeneration = currentGeneration()
        let candidate = Task { [weak self] () -> Void in
            await self?.runLoop(generation: startGeneration)
        }
        // Lose the race → cancel the loser rather than leaking two run loops
        // onto one client (the old `guard task == nil` read was unsynchronized).
        guard installTask(candidate) else {
            candidate.cancel()
            return
        }
    }

    func stop() {
        let session = advanceGenerationAndTakeSession()
        takeTask()?.cancel()
        // URLSession cancellation is synchronous here; no late delegate work can
        // keep the app alive after stores enter their closed state.
        session?.invalidateAndCancel()
    }

    /// Oversized-line strikes before the client stops retrying and degrades.
    /// One oversized line CAN be transient garbage (captive portal); the same
    /// failure three connections in a row is structural — most likely a
    /// server whose snapshot line exceeds `maxLineBytes` (audit IO-3): every
    /// reconnect replays the same giant snapshot, so retrying forever is a
    /// silent livelock that delivers nothing and burns ~4MB per cycle.
    /// Internal for WalnutTests.
    static let maxOversizedStrikes = 3

    /// Distinguishes the oversized-line bail from generic badResponse so the
    /// run loop can count strikes (a plain APIError.badResponse can't carry
    /// that meaning — non-200s and decode issues share it).
    private struct OversizedLineError: Error {}

    /// Backoff policy for a clean EOF (audit TMR-1): only a connection that
    /// proved REAL (delivered at least one frame, or held long enough that
    /// per-connection cost amortizes) earns a prompt reconnect. A server that
    /// 200s-then-closes instantly used to reset backoff every loop — a ~1Hz
    /// forever storm of fresh URLSessions + TLS handshakes against a
    /// flapping/captive endpoint. Internal + pure for WalnutTests.
    static func shouldResetBackoff(deliveredFrame: Bool, connectedSeconds: TimeInterval) -> Bool {
        deliveredFrame || connectedSeconds > 30
    }

    private func runLoop(generation runGeneration: UInt64) async {
        var backoff: Double = 1
        var oversizedStrikes = 0
        while !Task.isCancelled {
            do {
                let outcome = try await streamOnce(generation: runGeneration)
                guard isCurrent(runGeneration) else { return }
                oversizedStrikes = 0
                // Clean EOF: prompt reconnect only for a proven connection
                // (see shouldResetBackoff — the anti-storm gate).
                if Self.shouldResetBackoff(
                    deliveredFrame: outcome.deliveredFrame,
                    connectedSeconds: outcome.connectedSeconds
                ) {
                    backoff = 1
                }
            } catch is CancellationError {
                return
            } catch let urlError as URLError where urlError.code == .cancelled {
                // stop() cancels the byte stream — but the WATCHDOG also
                // cancels it (session.invalidateAndCancel) when the stream
                // went silent. A watchdog trip is a dead connection, not a
                // deliberate close: reconnect immediately.
                if !consumeStallTripped() { return }
                AppLog.error("sse", "stall watchdog tripped — reconnecting", ["lastEventID": currentLastEventID() ?? "-"])
                oversizedStrikes = 0
                backoff = 1
            } catch is OversizedLineError {
                oversizedStrikes += 1
                AppLog.error("sse", "oversized line — server frame exceeds client cap", [
                    "strikes": "\(oversizedStrikes)", "path": Self.sanitizedPath(url),
                ])
                if oversizedStrikes >= Self.maxOversizedStrikes {
                    // Terminal: reconnecting replays the same oversized frame
                    // (attach re-sends the snapshot, and Last-Event-ID can't
                    // skip it — the killed line never yielded an id). Report
                    // 404 to ride the existing "route unusable → fall back to
                    // polling" contract both stores already implement; the
                    // page stays live via the 5s transcript poll instead of
                    // silently dead behind an eternal reconnect loop (IO-3).
                    AppLog.error("sse", "oversized-line livelock — abandoning stream, degrading to polling", [
                        "path": Self.sanitizedPath(url),
                    ])
                    if isCurrent(runGeneration) {
                        onConnectionChange(false)
                        onHTTPError?(404)
                    }
                    return
                }
                if isCurrent(runGeneration) { onConnectionChange(false) }
            } catch {
                AppLog.error("sse", "stream error — backing off", ["error": String(describing: error), "backoff": "\(backoff)s"])
                if isCurrent(runGeneration) { onConnectionChange(false) }
            }
            if Task.isCancelled || !isCurrent(runGeneration) { return }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 30)
        }
    }

    /// What a connection accomplished — the run loop's backoff policy input.
    private struct StreamOutcome {
        let deliveredFrame: Bool
        let connectedSeconds: TimeInterval
    }

    @discardableResult
    private func streamOnce(generation streamGeneration: UInt64) async throws -> StreamOutcome {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600
        if let resumeFrom = currentLastEventID() {
            request.setValue(resumeFrom, forHTTPHeaderField: "Last-Event-ID")
        }

        // Dedicated session: the stream must outlive normal request timeouts.
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 86_400
        let session = URLSession(configuration: config)
        guard installSession(session, generation: streamGeneration) else {
            session.invalidateAndCancel()
            throw CancellationError()
        }
        defer {
            clearSession(session)
            session.invalidateAndCancel()
        }

        let (bytes, response) = try await session.bytes(for: request)
        guard isCurrent(streamGeneration) else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            AppLog.error("sse", "stream endpoint refused", [
                "status": String(status), "path": Self.sanitizedPath(url),
            ])
            if isCurrent(streamGeneration) { onHTTPError?(status) }
            // 404 = route absent (older server) — terminal, don't retry.
            if status == 404 { throw CancellationError() }
            throw APIError.badResponse
        }
        if isCurrent(streamGeneration) { onConnectionChange(true) }
        touchActivity()
        // Stream attach/detach is the spine of any "the app went quiet" report:
        // whether the phone still had a live turn stream, and for how long, is
        // otherwise unknowable after the fact.
        let connectedAt = Date()
        AppLog.info("sse", "stream connected", [
            "path": Self.sanitizedPath(url),
            "resumedFrom": currentLastEventID() ?? "-",
        ])
        defer {
            AppLog.info("sse", "stream disconnected", [
                "path": Self.sanitizedPath(url),
                "connectedSeconds": String(Int(Date().timeIntervalSince(connectedAt))),
                "lastEventID": currentLastEventID() ?? "-",
            ])
        }

        // Watchdog: any byte (data OR ping comment) counts as activity. If the
        // stream is silent past the threshold, the connection is dead — kill
        // the session so the byte loop throws and the run loop reconnects.
        let watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self else { return }
                if self.silentFor() > Self.stallThreshold {
                    self.markStallTripped()
                    session.invalidateAndCancel()
                    return
                }
            }
        }
        defer { watchdog.cancel() }

        var parser = FrameParser()
        var lineBuffer: [UInt8] = []
        var deliveredFrame = false
        var sinceTouch = 0
        for try await byte in bytes {
            // Watchdog feed + cancellation check per LINE (and every 64KB of
            // an unbroken line), not per byte: touchActivity is an NSLock +
            // Date() (~32ns), which alone cost ~134ms across a 4MB frame
            // (audit IO-4) — pure overhead added to event delivery latency.
            // Granularity stays far below the 50s stall threshold.
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
                    if let id = frame.id { setLastEventID(id) }
                    deliveredFrame = true
                    if isCurrent(streamGeneration) { onEvent(frame) }
                }
            } else {
                lineBuffer.append(byte)
                // A single line past the cap is either a newline-free garbage
                // stream (captive portal — the stall watchdog never trips
                // because bytes keep arriving) or a server frame bigger than
                // we'll buffer (a whale `snapshot`). Typed error so the run
                // loop can count strikes and degrade instead of relooping
                // through the same frame forever (audit IO-3).
                if lineBuffer.count > Self.maxLineBytes { throw OversizedLineError() }
            }
        }
        if isCurrent(streamGeneration) { onConnectionChange(false) }
        return StreamOutcome(
            deliveredFrame: deliveredFrame,
            connectedSeconds: Date().timeIntervalSince(connectedAt)
        )
    }
}

extension SSEClient {
    /// Coarse endpoint template only — session ids and note paths never enter
    /// client diagnostics (same rule as WalnutAPI.sanitizedPath).
    fileprivate static func sanitizedPath(_ url: URL) -> String {
        let segments = url.path.split(separator: "/")
        return "/" + segments.prefix(3).joined(separator: "/")
    }
}

/// Incremental SSE frame assembler — feed lines, get an event back on each
/// blank-line frame boundary.
private struct FrameParser {
    private var id: String?
    private var event = "message"
    private var data: [String] = []

    mutating func consume(line: String) -> SSEEvent? {
        if line.isEmpty {
            defer {
                id = nil
                event = "message"
                data = []
            }
            guard !data.isEmpty else { return nil }
            return SSEEvent(id: id, event: event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // comment / ping

        guard let colon = line.firstIndex(of: ":") else {
            return nil // field with no value — nothing we use
        }
        let field = String(line[line.startIndex..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() } // optional space per spec

        switch field {
        case "id": id = value
        case "event": event = value
        case "data": data.append(value)
        default: break // unknown fields are ignored per spec
        }
        return nil
    }
}
