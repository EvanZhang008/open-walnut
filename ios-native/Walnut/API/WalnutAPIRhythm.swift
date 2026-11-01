import Foundation

/// The Rhythm plugin's ops, for the phone's focus music player.
///
/// Rhythm is a plugin, so it has no /api/v1 route of its own: its ops answer at
/// `POST /api/plugin-runtime/walnut-rhythm/ops/<op>` with `{ ok, result }` or
/// `{ ok: false, message }`. A replica relays them to the Mac. A server without
/// Rhythm installed answers 404, which `RhythmUnavailable` words for a person.
extension WalnutAPI {
    static let rhythmPluginID = "walnut-rhythm"

    struct RhythmOpEnvelope<T: Decodable>: Decodable {
        let ok: Bool
        let result: T?
        let message: String?
    }

    struct RhythmUnavailable: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func rhythmOp<T: Decodable>(_ op: String, args: [String: Int] = [:]) async throws -> T {
        try await rhythmOp(op, body: args)
    }

    func rhythmOp<T: Decodable, B: Encodable>(_ op: String, body args: B) async throws -> T {
        let path = "/api/plugin-runtime/\(Self.rhythmPluginID)/ops/walnut_rhythm_\(op)"
        let envelope: RhythmOpEnvelope<T>
        do {
            envelope = try await sendAbsolute("POST", path, body: args, timeout: 15)
        } catch APIError.server(let status, _, _, _, _) where status == 404 {
            throw RhythmUnavailable(message: "Rhythm is not installed on your Walnut. Install it from Apps on the Mac.")
        } catch APIError.server(let status, _, _, _, _) {
            throw RhythmUnavailable(message: "Rhythm could not answer (HTTP \(status)).")
        }
        guard envelope.ok, let result = envelope.result else {
            throw RhythmUnavailable(message: envelope.message ?? "Rhythm did not answer.")
        }
        return result
    }

    func rhythmMusicTracks() async throws -> RhythmMusicListing {
        try await rhythmOp("music_tracks")
    }

    func rhythmStatus() async throws -> RhythmFocusStatus {
        try await rhythmOp("status")
    }

    /// `remember`: the lengths become the next block's defaults (Rhythm's settings).
    /// `spotify`: a playlist URI Rhythm plays in the Spotify app on the Mac.
    func rhythmFocusStart(minutes: Int, breakMinutes: Int, spotify: String? = nil, remember: Bool = true, taskId: String? = nil) async throws -> RhythmActionResult {
        try await rhythmOp("focus_start", body: RhythmStartArgs(minutes: minutes, breakMinutes: breakMinutes, spotify: spotify, remember: remember, taskId: taskId))
    }

    /// Rest now: during a block it ends there and its break starts; while off, a rest of its own.
    func rhythmFocusRest(minutes: Int? = nil) async throws -> RhythmActionResult {
        try await rhythmOp("focus_rest", args: minutes.map { ["minutes": $0] } ?? [:])
    }

    /// More time on the block or the break running now.
    func rhythmFocusExtend(minutes: Int) async throws -> RhythmActionResult {
        try await rhythmOp("focus_extend", args: ["minutes": minutes])
    }

    func rhythmFocusStop() async throws -> RhythmActionResult {
        try await rhythmOp("focus_stop")
    }

    func rhythmBreakSkip() async throws -> RhythmActionResult {
        try await rhythmOp("break_skip")
    }
}

struct RhythmStartArgs: Encodable, Equatable {
    let minutes: Int
    let breakMinutes: Int
    let spotify: String?
    let remember: Bool
    /// Focus now during a break keeps the run's task.
    var taskId: String? = nil
}

/// `music_tracks`: the audio files in the focus music folder on the Mac, and the
/// Spotify playlists Rhythm plays in the Mac's Spotify app.
struct RhythmMusicListing: Decodable, Equatable {
    struct Spotify: Decodable, Equatable {
        struct Playlist: Decodable, Equatable, Identifiable {
            let uri: String
            let name: String
            var id: String { uri }
        }
        let available: Bool
        let reason: String?
        let playlists: [Playlist]
    }
    struct Track: Decodable, Equatable, Identifiable {
        let id: String
        let title: String
        /// Absolute path on the Mac; streamed through /api/v1/file-content?raw=1.
        let file: String
        let bytes: Int
        let type: String
    }
    let folder: String
    let isDefault: Bool
    let exists: Bool
    let tracks: [Track]
    let skipped: [String]
    let error: String?
    let withFocus: Bool?
    /// Absent from a Rhythm older than its Spotify playlists.
    let spotify: Spotify?
}

/// The slice of Rhythm's `status` the player needs: the running block and its settings.
struct RhythmFocusStatus: Decodable, Equatable {
    struct Focus: Decodable, Equatable {
        /// idle | focus | break_due | break
        let phase: String
        /// Epoch ms; 0 while idle.
        let endsAt: Double?
        let title: String?
        /// The run's block length and its picked break, for Focus now and Rest now (absent from an older Rhythm).
        var minutes: Int? = nil
        var breakMinutes: Int? = nil
        var taskId: String? = nil
        /// Blocks done since the last long break (absent from an older Rhythm).
        var completedInCycle: Int? = nil
        var lastRun: LastRun? = nil
    }
    struct LastRun: Decodable, Equatable {
        let endedAt: Double
    }
    struct Config: Decodable, Equatable {
        let focusMinutes: Int?
        let breakMinutes: Int?
        let musicWithFocus: Bool?
        var longBreakMinutes: Int? = nil
        var longBreakEvery: Int? = nil
    }
    let now: Double?
    let focus: Focus
    let config: Config?
}

struct RhythmActionResult: Decodable {
    let message: String
    let state: RhythmFocusStatus?
    /// The block started but Spotify did not play: why.
    let spotifyError: String?
}
