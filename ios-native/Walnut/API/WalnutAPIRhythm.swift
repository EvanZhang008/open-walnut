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

    func rhythmFocusStart(minutes: Int) async throws -> RhythmActionResult {
        try await rhythmOp("focus_start", args: ["minutes": minutes])
    }

    func rhythmFocusStop() async throws -> RhythmActionResult {
        try await rhythmOp("focus_stop")
    }
}

/// `music_tracks`: the audio files in the focus music folder on the Mac.
struct RhythmMusicListing: Decodable, Equatable {
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
}

/// The slice of Rhythm's `status` the player needs: the running block and its settings.
struct RhythmFocusStatus: Decodable, Equatable {
    struct Focus: Decodable, Equatable {
        /// idle | focus | break_due | break
        let phase: String
        /// Epoch ms; 0 while idle.
        let endsAt: Double?
        let title: String?
    }
    struct Config: Decodable, Equatable {
        let focusMinutes: Int?
        let musicWithFocus: Bool?
    }
    let now: Double?
    let focus: Focus
    let config: Config?
}

struct RhythmActionResult: Decodable {
    let message: String
    let state: RhythmFocusStatus?
}
