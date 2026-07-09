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

    private var task: Task<Void, Never>?
    private var lastEventID: String?

    init(
        url: URL,
        token: String,
        onEvent: @escaping @Sendable (SSEEvent) -> Void,
        onConnectionChange: @escaping @Sendable (Bool) -> Void
    ) {
        self.url = url
        self.token = token
        self.onEvent = onEvent
        self.onConnectionChange = onConnectionChange
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.runLoop()
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func runLoop() async {
        var backoff: Double = 1
        while !Task.isCancelled {
            do {
                try await streamOnce()
                backoff = 1 // clean EOF — server closed; reconnect promptly
            } catch is CancellationError {
                return
            } catch let urlError as URLError where urlError.code == .cancelled {
                // stop() cancels the in-flight byte stream — URLSession
                // surfaces that as URLError.cancelled, not CancellationError.
                // It's a deliberate close, NOT a connectivity failure.
                return
            } catch {
                onConnectionChange(false)
            }
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 30)
        }
    }

    private func streamOnce() async throws {
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
        defer { session.invalidateAndCancel() }

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.badResponse
        }
        onConnectionChange(true)

        var parser = FrameParser()
        var lineBuffer: [UInt8] = []
        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == UInt8(ascii: "\n") {
                var line = lineBuffer
                if line.last == UInt8(ascii: "\r") { line.removeLast() }
                lineBuffer.removeAll(keepingCapacity: true)
                if let frame = parser.consume(line: String(decoding: line, as: UTF8.self)) {
                    if let id = frame.id { lastEventID = id }
                    onEvent(frame)
                }
            } else {
                lineBuffer.append(byte)
            }
        }
        onConnectionChange(false)
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
