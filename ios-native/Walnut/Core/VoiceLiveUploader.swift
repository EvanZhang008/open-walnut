import Foundation

/// Sends the take to the server WHILE it is recorded (POST
/// /stt/recordings/:id/live), so a server that transcribes takes itself can
/// work through the first minutes during the take and stopping leaves only the
/// last seconds to do.
///
/// A head start, never the record: the finished file still goes through
/// chunks + commit + transcribe exactly as before, and the server reuses the
/// live pieces only when the finished file holds the same samples. So every
/// failure here is silent: a server that does not take live pieces (an older
/// one, one that hands transcription to another machine) answers
/// `accepted: false` or 404 and the loop stops; a network error is retried
/// after a growing wait, and a few in a row end it.
@MainActor
final class VoiceLiveUploader {
    struct Ack: Decodable, Sendable {
        let accepted: Bool
        let receivedBytes: Int
        var reason: String? = nil
    }

    enum Outcome: Equatable, Sendable {
        case stopped
        case declined(String)
        case unsupported
        case gaveUp
    }

    typealias Send = @Sendable (_ from: Int, _ data: Data) async throws -> Ack

    /// The server cuts every 20 s or so; a piece every few seconds keeps it
    /// fed without holding the radio awake.
    nonisolated static let interval: Duration = .seconds(4)
    nonisolated static let maxFailures = 5

    private var task: Task<Outcome, Never>?

    func start(fileURL: URL, send: @escaping Send) {
        task?.cancel()
        let name = fileURL.lastPathComponent
        task = Task.detached(priority: .utility) {
            let outcome = await Self.run(fileURL: fileURL, send: send)
            if outcome != .stopped {
                await MainActor.run { AppLog.info("voice", "live upload ended", ["file": name, "outcome": String(describing: outcome)]) }
            }
            return outcome
        }
    }

    /// Ends the loop. The bytes not yet sent are left for the finished file.
    func stop() {
        task?.cancel()
        task = nil
    }

    /// The take was thrown away: ends the loop and tells the server to drop it.
    func cancel(drop: @escaping @Sendable () async throws -> Void) {
        let running = task != nil
        stop()
        guard running else { return }
        Task.detached(priority: .utility) { try? await drop() }
    }

    /// The loop, separate so tests drive it with a file they grow by hand.
    nonisolated static func run(
        fileURL: URL, send: Send, interval: Duration = interval,
        chunkBytes: Int = WalnutAPI.voiceChunkBytes
    ) async -> Outcome {
        var sent = 0
        var failures = 0
        while !Task.isCancelled {
            let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? 0
            guard size > sent else {
                try? await Task.sleep(for: interval)
                continue
            }
            guard let data = read(fileURL, from: sent, count: min(size - sent, chunkBytes)), !data.isEmpty else {
                try? await Task.sleep(for: interval)
                continue
            }
            var advanced = false
            do {
                let ack = try await send(sent, data)
                failures = 0
                guard ack.accepted else { return .declined(ack.reason ?? "declined") }
                advanced = ack.receivedBytes > sent
                sent = ack.receivedBytes
            } catch {
                if case let APIError.server(status, _, _, _, _) = error, status == 404 { return .unsupported }
                if Task.isCancelled { break }
                failures += 1
                if failures >= maxFailures { return .gaveUp }
                // 2x, 4x, 8x the tick: a short network drop is waited out.
                try? await Task.sleep(for: interval * (1 << failures))
                continue
            }
            // Behind (a slow network): catch up without waiting a tick. A
            // resend that moved nothing (the server lost its copy) waits one.
            let now = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? 0
            if !advanced || now - sent < chunkBytes { try? await Task.sleep(for: interval) }
        }
        return .stopped
    }

    nonisolated private static func read(_ url: URL, from offset: Int, count: Int) -> Data? {
        guard let file = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? file.close() }
        do {
            try file.seek(toOffset: UInt64(offset))
            return try file.read(upToCount: count)
        } catch {
            return nil
        }
    }
}

extension WalnutAPI {
    /// One piece of a take still being recorded. See `VoiceLiveUploader`.
    func sendLiveVoice(id: String, from: Int, audio: Data, origin: String?) async throws -> VoiceLiveUploader.Ack {
        guard let origin, let token = AppConfig.token,
              let url = URL(string: origin + "/api/v1/stt/recordings/\(escape(id.lowercased()))/live")
        else { throw APIError.notConfigured }
        struct Body: Encodable { let from: Int; let audio: String }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(from: from, audio: audio.base64EncodedString()))
        let (data, response) = try await perform(request, retrySafe: true)
        return try Self.decode(VoiceLiveUploader.Ack.self, data: data, response: response)
    }

    func dropLiveVoice(id: String, origin: String?) async throws {
        guard let origin, let token = AppConfig.token,
              let url = URL(string: origin + "/api/v1/stt/recordings/\(escape(id.lowercased()))/live")
        else { throw APIError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try await perform(request, retrySafe: true)
    }
}
