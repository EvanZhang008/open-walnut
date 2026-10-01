import Foundation

/// The demo server's server-sent event hub: who is listening on which stream, and
/// the frames of the turn currently running on each one.
///
/// It reproduces the parts of the real server's stream contract the app depends
/// on (docs/reference/api-v1.md):
///  - every live frame carries a monotonic `id:`, and a reconnect with
///    `Last-Event-ID` replays only the frames after it;
///  - attaching mid-turn with no id replays the whole current turn, so a stream
///    that connects a moment after the POST that started a turn still sees it;
///  - attach frames (the `snapshot`) carry no id and are never replayed;
///  - a `: ping` comment keeps every stream alive well inside the clients' stall
///    watchdogs (50s for the turn streams, 55s for the events feed).
///
/// Everything runs on ONE serial queue, so frames reach each subscriber in the
/// order they were published and a subscribe never interleaves with a publish.
/// Delivery itself is only an enqueue onto the subscriber's URLSession thread.
final class DemoStreams: @unchecked Sendable {
    enum Channel: Hashable, Sendable {
        /// `GET /api/v1/events`: the task + session list feed.
        case events
        /// `GET /api/v1/conversations/:id/stream`.
        case conversation(String)
        /// `GET /api/v1/sessions/:id/stream`.
        case session(String)
    }

    /// Handle returned to the protocol; cancelling it detaches the subscriber.
    final class Subscription: @unchecked Sendable {
        private let onCancel: () -> Void
        init(onCancel: @escaping () -> Void) { self.onCancel = onCancel }
        func cancel() { onCancel() }
    }

    struct Frame: Equatable {
        let id: Int?
        let event: String
        let data: String

        var wire: Data {
            var text = ""
            if let id { text += "id: \(id)\n" }
            text += "event: \(event)\n"
            for line in data.split(separator: "\n", omittingEmptySubsequences: false) {
                text += "data: \(line)\n"
            }
            text += "\n"
            return Data(text.utf8)
        }
    }

    private struct Subscriber {
        let channel: Channel
        let send: (Data) -> Void
        let close: () -> Void
    }

    private let queue = DispatchQueue(label: "dev.openwalnut.demo.streams")
    private var subscribers: [UUID: Subscriber] = [:]
    private var nextEventID = 1
    /// Frames of the turn in flight (or the last one) per channel.
    private var ring: [Channel: [Frame]] = [:]
    private var turnLive: Set<Channel> = []
    private var pingTimer: DispatchSourceTimer?

    /// The frames a stream opens with (the `snapshot`), built by the server from
    /// its current state at attach time. Called on the hub queue.
    var attachFrames: ((Channel) -> [(event: String, data: String)])?

    static let pingInterval: TimeInterval = 20

    // MARK: - Subscribe

    func subscribe(
        channel: Channel, lastEventID: Int?,
        send: @escaping (Data) -> Void, close: @escaping () -> Void
    ) -> Subscription {
        let key = UUID()
        queue.async { [self] in
            subscribers[key] = Subscriber(channel: channel, send: send, close: close)
            for frame in attachFrames?(channel) ?? [] {
                send(Frame(id: nil, event: frame.event, data: frame.data).wire)
            }
            let turn = ring[channel] ?? []
            let replay: [Frame]
            if let lastEventID {
                replay = turn.filter { ($0.id ?? 0) > lastEventID }
            } else {
                replay = turnLive.contains(channel) ? turn : []
            }
            for frame in replay { send(frame.wire) }
            startPingsIfNeeded()
        }
        return Subscription { [weak self] in
            self?.queue.async { self?.subscribers[key] = nil }
        }
    }

    /// How many subscribers a channel has right now (tests).
    func subscriberCount(_ channel: Channel) -> Int {
        queue.sync { subscribers.values.filter { $0.channel == channel }.count }
    }

    // MARK: - Publish

    /// Publish one frame. `turnStart` clears the channel's replay ring first and
    /// marks a turn in flight; `turnEnd` marks it over (the frames stay so a
    /// reconnect with `Last-Event-ID` still gets the end it missed).
    func publish(
        _ channel: Channel, event: String, json: String,
        turnStart: Bool = false, turnEnd: Bool = false
    ) {
        queue.async { [self] in
            let frame = Frame(id: nextEventID, event: event, data: json)
            nextEventID += 1
            if channel != .events {
                if turnStart {
                    ring[channel] = []
                    turnLive.insert(channel)
                }
                ring[channel, default: []].append(frame)
                if turnEnd { turnLive.remove(channel) }
            }
            let wire = frame.wire
            for subscriber in subscribers.values where subscriber.channel == channel {
                subscriber.send(wire)
            }
        }
    }

    /// Whether a turn is in flight on a channel (tests, snapshot building).
    /// Only valid on the hub queue or via `sync`.
    func isTurnLive(_ channel: Channel) -> Bool {
        queue.sync { turnLive.contains(channel) }
    }

    /// Used by `attachFrames` builders, which already run on the hub queue.
    func isTurnLiveOnQueue(_ channel: Channel) -> Bool {
        turnLive.contains(channel)
    }

    /// End every stream and forget every turn (leaving or re-entering the demo).
    func reset() {
        queue.sync {
            for subscriber in subscribers.values { subscriber.close() }
            subscribers.removeAll()
            ring.removeAll()
            turnLive.removeAll()
            pingTimer?.cancel()
            pingTimer = nil
        }
    }

    /// Wait until every frame published so far has been handed to subscribers.
    func drain() {
        queue.sync {}
    }

    private func startPingsIfNeeded() {
        guard pingTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let ping = Data(": ping\n\n".utf8)
            for subscriber in self.subscribers.values { subscriber.send(ping) }
        }
        timer.resume()
        pingTimer = timer
    }
}
