import Foundation
import Observation

/// Voice mode's live words: what the person is saying, shown in the box while they talk.
///
/// While a take hears speech, the audio recorded so far is drafted through
/// `POST /api/v1/stt/draft`, one request at a time, every `interval` (the web's
/// `LiveWords`, web/src/voice/live-words.ts). A draft only shows the words: the
/// take's own transcription is still what is sent. A draft that comes back after
/// its take ended is dropped, and a server that has no draft route (404) is not
/// asked again by this voice mode.
@Observable
@MainActor
final class VoiceLiveWords {
    /// The words heard so far in the current take, nil when there are none.
    private(set) var text: String?

    /// Turns the take so far (a WAV) into words. Throws what the request threw.
    typealias Draft = @Sendable (_ wav: Data) async throws -> String

    /// How often the take so far is drafted. The first draft waits this long after
    /// the take begins.
    static let interval: TimeInterval = 1.5
    /// Past this the take is not drafted again (its words stay): the whole take
    /// rides every draft, and the server takes about 70 s of it at most.
    static let maxTakeSeconds: TimeInterval = 45

    private let draft: Draft
    @ObservationIgnored private var takeURL: URL?
    @ObservationIgnored private var since: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    /// The server answered 404: it predates the route.
    @ObservationIgnored private(set) var unsupported = false
    /// Drafts of this take that failed in a row; at `maxFailures` the take is drafted no more
    /// (a server that cannot answer now would be sent the whole take every 1.5 s).
    @ObservationIgnored private var failures = 0
    static let maxFailures = 2

    init(draft: Draft? = nil) {
        self.draft = draft ?? { wav in try await WalnutAPI().draftTranscribe(wav: wav) }
    }

    /// Called on every reading of a take: drafts the take so far while it hears speech.
    func tick(takeURL: URL?, heardSpeech: Bool, elapsed: TimeInterval, now: Date = Date()) {
        guard !unsupported, let takeURL else { return }
        if takeURL != self.takeURL {
            clear()
            self.takeURL = takeURL
            since = now
            return
        }
        guard heardSpeech, inFlight == nil, elapsed <= Self.maxTakeSeconds, failures < Self.maxFailures,
              let since, now.timeIntervalSince(since) >= Self.interval else { return }
        self.since = now
        let take = generation
        let draft = self.draft
        inFlight = Task { [weak self] in
            let words: String?
            do {
                let wav = try await Task.detached(priority: .utility) {
                    try Self.wav(ofTakeAt: takeURL)
                }.value
                words = try await draft(wav)
            } catch let APIError.server(status, _, _, _, _) where status == 404 {
                self?.unsupported = true
                words = nil
            } catch {
                // A draft is a preview: the take's own transcription still goes out.
                words = nil
            }
            guard let self, self.generation == take, !Task.isCancelled else { return }
            self.inFlight = nil
            self.failures = words == nil ? self.failures + 1 : 0
            if let words {
                let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
                self.text = trimmed.isEmpty ? nil : trimmed
            }
        }
    }

    /// The take ended and is being transcribed: no more drafts (the one still out
    /// would hold the engine the take's own words need), and the words stay shown.
    func freeze() {
        generation += 1
        inFlight?.cancel()
        inFlight = nil
        takeURL = nil
        since = nil
    }

    /// The take's words leave the box: it was sent, dropped, or a new one began.
    func clear() {
        generation += 1
        inFlight?.cancel()
        inFlight = nil
        takeURL = nil
        since = nil
        failures = 0
        text = nil
    }

    // MARK: - The take so far as a WAV (pure, unit-tested)

    enum TakeError: Error { case unreadable }

    nonisolated static func wav(ofTakeAt url: URL) throws -> Data {
        guard let wav = wav(fromCAF: try Data(contentsOf: url, options: .mappedIfSafe)) else {
            throw TakeError.unreadable
        }
        return wav
    }

    /// The recorder's CAF (16-bit integer PCM, `VoiceRecorder.captureSettings`) as a
    /// WAV, readable while the recording still grows: its `data` chunk then has no
    /// size yet (-1) and runs to the end of the file. Nil for anything else.
    nonisolated static func wav(fromCAF caf: Data) -> Data? {
        let bytes = [UInt8](caf)
        guard bytes.count >= 8, bytes[0..<4] == [0x63, 0x61, 0x66, 0x66] else { return nil } // "caff"
        var offset = 8
        var sampleRate: Double?
        var channels: UInt32 = 1
        var bits: UInt32 = 16
        var littleEndian = true
        var isFloat = false
        var pcm: ArraySlice<UInt8>?
        while offset + 12 <= bytes.count {
            let type = String(bytes: bytes[offset..<offset + 4], encoding: .ascii) ?? ""
            let size = Int64(bitPattern: bigEndian(bytes, offset + 4, 8))
            let start = offset + 12
            switch type {
            case "desc":
                guard start + 32 <= bytes.count else { return nil }
                sampleRate = Double(bitPattern: bigEndian(bytes, start, 8))
                let formatID = String(bytes: bytes[start + 8..<start + 12], encoding: .ascii)
                guard formatID == "lpcm" else { return nil }
                let flags = UInt32(bigEndian(bytes, start + 12, 4))
                isFloat = flags & 1 != 0
                littleEndian = flags & 2 != 0
                channels = UInt32(bigEndian(bytes, start + 24, 4))
                bits = UInt32(bigEndian(bytes, start + 28, 4))
            case "data":
                // Four bytes of edit count, then the audio.
                let audioStart = start + 4
                guard audioStart <= bytes.count else { return nil }
                // A recording still being written may say -1, 0 or a size from an
                // earlier flush: the audio runs to the end of the file unless the size
                // lands exactly on another chunk.
                let claimed = size > 4 && size < Int64(bytes.count) ? start + Int(size) : bytes.count
                let end = claimed < bytes.count && !startsChunk(bytes, at: claimed) ? bytes.count : min(claimed, bytes.count)
                pcm = bytes[audioStart..<max(audioStart, end)]
            default:
                break
            }
            if pcm != nil || size < 0 || size > Int64(bytes.count - start) { break }
            offset = start + Int(size)
        }
        guard let rate = sampleRate, let pcm, !isFloat, bits == 16, channels >= 1 else { return nil }
        let frameBytes = Int(channels) * 2
        var audio = [UInt8](pcm.prefix(pcm.count - pcm.count % frameBytes))
        if !littleEndian {
            for index in stride(from: 0, to: audio.count, by: 2) { audio.swapAt(index, index + 1) }
        }
        var wav = Data()
        func put(_ text: String) { wav.append(contentsOf: Array(text.utf8)) }
        func put32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        func put16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        put("RIFF"); put32(UInt32(36 + audio.count)); put("WAVE")
        put("fmt "); put32(16); put16(1); put16(UInt16(channels)); put32(UInt32(rate))
        put32(UInt32(rate) * UInt32(frameBytes)); put16(UInt16(frameBytes)); put16(16)
        put("data"); put32(UInt32(audio.count))
        wav.append(contentsOf: audio)
        return wav
    }

    /// Four ASCII letters and a size: a chunk header starts at `at`.
    private nonisolated static func startsChunk(_ bytes: [UInt8], at: Int) -> Bool {
        guard at + 12 <= bytes.count else { return false }
        return bytes[at..<at + 4].allSatisfy { (0x20...0x7E).contains($0) }
    }

    private nonisolated static func bigEndian(_ bytes: [UInt8], _ at: Int, _ count: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in at..<at + count { value = value << 8 | UInt64(bytes[index]) }
        return value
    }
}

extension WalnutAPI {
    /// The words of a take still being recorded (`POST /api/v1/stt/draft`), a preview only.
    func draftTranscribe(wav: Data, language: String? = nil) async throws -> String {
        struct Result: Codable { let text: String }
        let encoded = await Task.detached(priority: .utility) { wav.base64EncodedString() }.value
        var body: [String: String] = ["audio": encoded, "format": "wav"]
        if let language { body["language"] = language }
        let result: Result = try await sendAbsolute("POST", "/api/v1/stt/draft", body: body, timeout: 20)
        return result.text
    }
}
