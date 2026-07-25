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

    private var task: Task<Void, Never>?
    private var lastEventID: String?

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
        guard task == nil else { return }
        let startGeneration = currentGeneration()
        task = Task { [weak self] in
            await self?.runLoop(generation: startGeneration)
        }
    }

    func stop() {
        let session = advanceGenerationAndTakeSession()
        task?.cancel()
        task = nil
        // URLSession cancellation is synchronous here; no late delegate work can
        // keep the app alive after stores enter their closed state.
        session?.invalidateAndCancel()
    }

    private func runLoop(generation runGeneration: UInt64) async {
        var backoff: Double = 1
        while !Task.isCancelled {
            do {
                try await streamOnce(generation: runGeneration)
                guard isCurrent(runGeneration) else { return }
                backoff = 1 // clean EOF — server closed; reconnect promptly
            } catch is CancellationError {
                return
            } catch let urlError as URLError where urlError.code == .cancelled {
                // stop() cancels the byte stream — but the WATCHDOG also
                // cancels it (session.invalidateAndCancel) when the stream
                // went silent. A watchdog trip is a dead connection, not a
                // deliberate close: reconnect immediately.
                if !consumeStallTripped() { return }
                AppLog.error("sse", "stall watchdog tripped — reconnecting", ["lastEventID": lastEventID ?? "-"])
                backoff = 1
            } catch {
                AppLog.error("sse", "stream error — backing off", ["error": String(describing: error), "backoff": "\(backoff)s"])
                if isCurrent(runGeneration) { onConnectionChange(false) }
            }
            if Task.isCancelled || !isCurrent(runGeneration) { return }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 30)
        }
    }

    private func streamOnce(generation streamGeneration: UInt64) async throws {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600
        if let lastEventID {
            request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
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
            if isCurrent(streamGeneration) { onHTTPError?(status) }
            // 404 = route absent (older server) — terminal, don't retry.
            if status == 404 { throw CancellationError() }
            throw APIError.badResponse
        }
        if isCurrent(streamGeneration) { onConnectionChange(true) }
        touchActivity()

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
        for try await byte in bytes {
            try Task.checkCancellation()
            touchActivity()
            if byte == UInt8(ascii: "\n") {
                var line = lineBuffer
                if line.last == UInt8(ascii: "\r") { line.removeLast() }
                lineBuffer.removeAll(keepingCapacity: true)
                if let frame = parser.consume(line: String(decoding: line, as: UTF8.self)) {
                    if let id = frame.id { lastEventID = id }
                    if isCurrent(streamGeneration) { onEvent(frame) }
                }
            } else {
                lineBuffer.append(byte)
                // A newline-free stream (captive portal, proxy garbage) would
                // grow this buffer forever — and the stall watchdog never trips
                // because bytes keep arriving. Real SSE lines are tiny; anything
                // past 4MB is not our server. Bail out and let the run loop
                // reconnect with backoff.
                if lineBuffer.count > 4_194_304 { throw APIError.badResponse }
            }
        }
        if isCurrent(streamGeneration) { onConnectionChange(false) }
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
