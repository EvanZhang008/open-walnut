import Foundation

// MARK: - Session stream: replay gate, resume ids, connection notice
//
// The session page's SSE stream reaches the phone from one of two servers, and
// their replay behaviour is what this file exists for:
//
//  - the PRIMARY (the Mac) sends a `snapshot` attach frame and resets its replay
//    ring at every turn start, so a replay is at most one turn and the snapshot
//    already carries the live region;
//  - the CLOUD replica relays the Mac over the bridge and NEVER resets its ring
//    (up to 512 events: turn-ends, bridge-offline/online pairs, status). It sends
//    an id-less `bridge-online` / `bridge-offline` attach frame, then replays the
//    whole ring to any connect without `Last-Event-ID`.
//
// Field evidence (2026-09-26, a 1.69 GB session open on the phone): every page
// open and every return to the foreground built a new stream without
// Last-Event-ID, the replica replayed its ring, and each replayed `turn-end` and
// `bridge-online` started its own `fresh=1&rich=1` transcript read. That was
// 140-147 reads of 512 KB each within 1-3 s, six times in eleven minutes, over
// the Mac's upload link, and every burst ended in a bridge teardown. The replayed
// offline/online pairs also flashed the "unreachable" banner and disabled the
// composer on every open.
//
// Three defences, each correct on its own so an old replica (which ignores none
// of this) is still safe:
//  1. `SessionStreamResumeIDs`: a new connection sends the newest applied id as
//     Last-Event-ID, so a current server replays only what was missed.
//  2. `SessionStreamReplayGate`: a frame at or below that id is a replay and is
//     never applied, whatever the server did with the header.
//  3. The store's single-flight transcript refresh (see SessionConversationStore):
//     whatever still gets through costs at most one read in flight plus one
//     follow-up.

/// Monotonic time and sleep for the session page's stream timers (refresh
/// debounce, replay hold window, reconnect grace). Injectable so WalnutTests can
/// drive every timer deterministically instead of sleeping for real.
protocol SessionStreamClock: Sendable {
    /// Seconds on a monotonic clock. Only differences are meaningful.
    func now() -> TimeInterval
    /// Throws CancellationError when the calling task is cancelled.
    func sleep(seconds: TimeInterval) async throws
}

struct SystemSessionStreamClock: SessionStreamClock {
    func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(max(0, seconds)))
    }
}

/// What the session page says about its link to the session's host. Shown only
/// after CONTINUOUS absence: a bridge redial takes about 1.3 s in the field, and
/// flashing a banner for each one (the old behaviour) read as "broken".
enum SessionConnectionNotice: Equatable {
    case none
    /// A small chip, from `reconnectingAfter` of continuous absence.
    case reconnecting
    /// The full banner, from `unreachableAfter` of continuous absence.
    case unreachable

    /// Longer than a field bridge redial (~1.3 s) with margin for a slow one,
    /// short enough that a real outage is admitted within a glance.
    static let reconnectingAfter: TimeInterval = 3
    /// Two full redial attempts plus backoff; past it the link is genuinely down
    /// and the reader should know the transcript is the last synced copy.
    static let unreachableAfter: TimeInterval = 10
}

/// Which server the stream is attached to, learned from its attach frame.
enum SessionStreamKind: Equatable {
    case unknown
    /// `snapshot` attach frame: the Mac itself.
    case primary
    /// Id-less `bridge-online` / `bridge-offline` attach frame: the cloud replica.
    case cloud
}

/// Decides which SSE frames of a CLOUD session stream the page may apply.
///
/// A frame whose id is at or below the newest one already applied is a replay
/// and is dropped, so it can neither start a transcript read nor flip the
/// connection state. The subtle case is a SERVER RESTART: the replica's ids are a
/// process-global counter that starts again at 0, so after a restart every new
/// frame is numerically "old", and dropping them would silence the page. The two
/// look alike frame by frame, and are told apart by one property of a replay:
///
///   A server replays its ring in order, and when the ring holds any frame older
///   than our newest applied id it also holds THAT id (a ring only loses its
///   oldest frames, and a reset happens at a turn start). So a genuine replay
///   presents our anchor id before any newer one.
///
/// Frames below the anchor are therefore HELD, not dropped: the anchor arriving
/// proves they were a replay (dropped); a newer id, a new connection, a full ring
/// of them, or `restartWindow` passing without the anchor proves the server
/// restarted (released in order, and the anchor rebased onto the new ids).
///
/// Primary streams (a `snapshot` attach frame) bypass the gate entirely: the
/// snapshot resets the live region and the replay that follows it (starting at
/// the turn's own `turn-start`) rebuilds it, exactly as before this gate existed.
struct SessionStreamReplayGate {
    /// Newest numeric id applied on a cloud stream (the Last-Event-ID to resume from).
    private(set) var lastAppliedID: Int?
    /// Frames below the anchor, awaiting the proof described above.
    private(set) var held: [SSEEvent] = []
    /// When the held frames are released if the anchor never shows up.
    private(set) var holdDeadline: TimeInterval?

    private var connection: UInt64?
    private var connectionIsPrimary = false
    private var connectionResumed = true
    private var attachAt: TimeInterval?
    private var attachSaidOnline = false

    /// A replay is written in one synchronous loop right after the attach frame,
    /// so it arrives within a moment; two seconds covers a slow cellular link.
    /// Past it the held frames are a restarted server's new frames.
    static let restartWindow: TimeInterval = 2
    /// The replica's ring size (sse-channels.ts RING_MAX). A replay can hold at
    /// most this many frames below the anchor before presenting the anchor.
    static let ringMax = 512
    /// On a connection that sent NO Last-Event-ID the replay cannot be told from
    /// live frames by id. Its bridge-offline frames are the dangerous ones: the
    /// ring's last bridge event can be an old offline whose online was never
    /// recorded (no phone was attached when the bridge came back), and applying
    /// it would claim an outage the attach frame just contradicted. Within this
    /// window after an attach frame that said online, such a frame is stale.
    static let attachBurstWindow: TimeInterval = 2

    init(lastAppliedID: Int? = nil) {
        self.lastAppliedID = lastAppliedID
    }

    /// Admit one frame; returns the frames to apply now, in order (possibly
    /// earlier held frames first, possibly none).
    mutating func admit(_ event: SSEEvent, now: TimeInterval) -> [SSEEvent] {
        var out: [SSEEvent] = []
        if event.connection != connection {
            // Held frames that never met their anchor on the connection that
            // carried them were not a replay of ours.
            out += releaseHeld()
            connection = event.connection
            connectionIsPrimary = false
            connectionResumed = event.resumed
            attachAt = nil
            attachSaidOnline = false
        }
        guard let raw = event.id, let id = Int(raw) else {
            // Id-less frames are attach frames, written before any replay.
            switch event.event {
            case "snapshot":
                connectionIsPrimary = true
                lastAppliedID = nil // a different id space; never resume a primary from it
            case "bridge-online", "bridge-offline":
                attachAt = now
                attachSaidOnline = event.event == "bridge-online"
            default:
                break
            }
            out.append(event)
            return out
        }
        if connectionIsPrimary {
            out.append(event)
            return out
        }
        if !connectionResumed, event.event == "bridge-offline", attachSaidOnline,
           let at = attachAt, now - at <= Self.attachBurstWindow {
            // Stale offline in a first connection's replay (see attachBurstWindow).
            // Its id still advances the anchor: it has been seen.
            if id > (lastAppliedID ?? Int.min) { lastAppliedID = id }
            return out
        }
        guard let last = lastAppliedID else {
            lastAppliedID = id
            out.append(event)
            return out
        }
        if id > last {
            // A genuine replay presents the anchor first, so anything still held
            // here came from a restarted server: release it, then this frame.
            out += releaseHeld()
            lastAppliedID = id
            out.append(event)
        } else if id == last {
            // The replay reached our anchor: everything held was replay.
            held.removeAll()
            holdDeadline = nil
        } else {
            held.append(event)
            if holdDeadline == nil { holdDeadline = now + Self.restartWindow }
            if held.count >= Self.ringMax { out += releaseHeld() }
        }
        return out
    }

    /// Release held frames once the window has passed without the anchor.
    mutating func expire(now: TimeInterval) -> [SSEEvent] {
        guard let deadline = holdDeadline, now >= deadline else { return [] }
        return releaseHeld()
    }

    /// Forget everything held (the store is going away or suspending: a new
    /// connection will replay or deliver them again).
    mutating func dropHeld() {
        held.removeAll()
        holdDeadline = nil
    }

    private mutating func releaseHeld() -> [SSEEvent] {
        holdDeadline = nil
        guard !held.isEmpty else { return [] }
        let released = held
        held.removeAll()
        // The server's ids restarted; its newest frame is the new anchor.
        if let raw = released.last?.id, let id = Int(raw) { lastAppliedID = id }
        return released
    }
}

/// The newest applied event id of each CLOUD session stream, so every new
/// connection (page re-open, return to the foreground, relaunch) resumes with
/// Last-Event-ID instead of asking for the whole ring. Keyed by the stream URL,
/// which carries both the server and the session: ids are a per-server counter.
///
/// Written on suspend/close only (never per event: the stream can carry hundreds
/// of frames a second). Primary streams are never stored (see the gate).
@MainActor
final class SessionStreamResumeIDs {
    /// The hosted unit-test process runs inside the installed app, so it keeps
    /// this in memory only rather than writing test keys into the app's defaults.
    static let shared = SessionStreamResumeIDs(
        defaults: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil ? .standard : nil
    )

    private struct Entry: Codable {
        let id: Int
        let savedAt: TimeInterval
    }

    private static let defaultsKey = "walnut.sessionStreamResumeIDs"
    /// Enough for every session a person keeps open; older entries only cost a
    /// full replay, which the gate and the refresh coalescing already make safe.
    static let maxEntries = 64

    private let storedDefaults: UserDefaults?
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults? { storedDefaults.map(AppPrefs.resolve) }
    private var entries: [String: Entry] = [:]

    init(defaults: UserDefaults?) {
        self.storedDefaults = defaults
        if let data = defaults.map(AppPrefs.resolve)?.data(forKey: Self.defaultsKey),
           let stored = try? JSONDecoder().decode([String: Entry].self, from: data) {
            entries = stored
        }
    }

    func id(for key: String) -> Int? { entries[key]?.id }

    func save(_ id: Int, for key: String) {
        guard entries[key]?.id != id else { return }
        entries[key] = Entry(id: id, savedAt: Date().timeIntervalSince1970)
        if entries.count > Self.maxEntries {
            let keep = entries.sorted { $0.value.savedAt > $1.value.savedAt }.prefix(Self.maxEntries)
            entries = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        if let defaults, let data = try? JSONEncoder().encode(entries) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    func remove(_ key: String) {
        guard entries.removeValue(forKey: key) != nil else { return }
        if let defaults, let data = try? JSONEncoder().encode(entries) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }
}

extension SessionStreamResumeIDs {
    /// Disconnect and Leave demo: forget every stream position, in memory too,
    /// so nothing from the old pairing is written back on the next save.
    func removeAll() {
        entries = [:]
        defaults?.removeObject(forKey: Self.defaultsKey)
    }
}
