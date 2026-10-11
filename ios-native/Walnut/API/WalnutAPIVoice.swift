import CryptoKit
import Foundation

struct VoiceTranscriptionResult: Decodable {
    let text: String
    let recordingID: String?
    let primarySaved: Bool?
    var storage: String? = nil
    var archiveOrigin: String? = nil

    private enum CodingKeys: String, CodingKey {
        case text, primarySaved, storage
        case recordingID = "recordingId"
    }
}

struct VoiceArchiveRecord: Decodable, Identifiable, Sendable {
    let id: String
    let createdAt: String
    let format: String
    let durationSeconds: Double?
    let surface: String?
    let audioSizeBytes: Int
    let audioSha256: String?
    let text: String?
    let via: String?
    let state: String
    let primarySaved: Bool?
    var storage: String? = nil
    var archiveOrigin: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, createdAt, format, durationSeconds, surface, audioSizeBytes, audioSha256, text, via, state, primarySaved, storage
    }
}

struct VoiceArchivePage: Decodable, Sendable {
    let recordings: [VoiceArchiveRecord]
    let nextBefore: String?
}

extension WalnutAPI {
    static let voiceChunkBytes = 256 * 1024

    private func voiceRequest<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, body: B?, timeout: TimeInterval = 30,
        retrySafe: Bool = false, origin requestedOrigin: String? = nil
    ) async throws -> T {
        let origin = requestedOrigin ?? AppConfig.serverURL?.absoluteString
        guard let origin, let token = AppConfig.token,
              let url = URL(string: origin + "/api/v1" + path) else { throw APIError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await perform(request, retrySafe: retrySafe)
        return try Self.decode(T.self, data: data, response: response)
    }

    func transcribeVoice(
        audioURL: URL, recording: VoiceRecordingStore.Recording
    ) async throws -> VoiceTranscriptionResult {
        let saved = try await archiveVoice(audioURL: audioURL, recording: recording)
        if let text = saved.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return VoiceTranscriptionResult(text: text, recordingID: saved.id, primarySaved: saved.primarySaved, storage: saved.storage, archiveOrigin: saved.archiveOrigin)
        }
        return try await transcribeArchivedVoice(id: saved.id, origin: saved.archiveOrigin)
    }

    func archiveVoice(
        audioURL: URL, recording: VoiceRecordingStore.Recording
    ) async throws -> VoiceArchiveRecord {
        let cloud = AppConfig.routes.first(where: { $0.kind == .cloud })?.origin
        let current = AppConfig.serverURL?.absoluteString
        let preferred = recording.archiveOrigin ?? cloud ?? current
        do {
            return try await uploadVoice(audioURL: audioURL, recording: recording, origin: preferred)
        } catch let error as APIError {
            guard VoiceRetryPlan.classify(error) == .transport,
                  let current, !ServerRoute.sameOrigin(preferred, current) else { throw error }
            return try await uploadVoice(audioURL: audioURL, recording: recording, origin: current)
        }
    }

    private func uploadVoice(
        audioURL: URL, recording: VoiceRecordingStore.Recording, origin: String?
    ) async throws -> VoiceArchiveRecord {
        struct Chunk: Encodable {
            let index: Int
            let audio: String
            let format: String
            let createdAt: String
            let surface: String?
            let durationSeconds: Double?
        }
        struct Commit: Encodable {
            let chunkCount: Int
            let audioSizeBytes: Int
            let audioSha256: String
            let text: String?
        }
        let id = (recording.serverID ?? recording.id).lowercased()
        let path = "/stt/recordings/\(escape(id))"
        let createdAt = ISO8601DateFormatter().string(from: recording.createdAt)
        let file = try FileHandle(forReadingFrom: audioURL)
        defer { try? file.close() }
        var hasher = SHA256()
        var count = 0
        var bytes = 0
        while let data = try await Task.detached(priority: .utility, operation: {
            try file.read(upToCount: Self.voiceChunkBytes)
        }).value, !data.isEmpty {
            try Task.checkCancellation()
            let encoded = await Task.detached(priority: .utility) {
                data.base64EncodedString()
            }.value
            let _: VoiceArchiveRecord = try await voiceRequest(
                "POST", path + "/chunks",
                body: Chunk(index: count, audio: encoded, format: recording.format,
                            createdAt: createdAt, surface: recording.surface,
                            durationSeconds: recording.durationSeconds),
                timeout: 30, retrySafe: true, origin: origin
            )
            hasher.update(data: data)
            bytes += data.count
            count += 1
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        var saved: VoiceArchiveRecord = try await voiceRequest(
            "POST", path + "/commit",
            body: Commit(chunkCount: count, audioSizeBytes: bytes,
                         audioSha256: digest, text: recording.transcript),
            timeout: 60, retrySafe: true, origin: origin
        )
        saved.archiveOrigin = origin
        return saved
    }

    func transcribeArchivedVoice(id: String, origin: String? = nil) async throws -> VoiceTranscriptionResult {
        var result: VoiceTranscriptionResult = try await voiceRequest(
            "POST", "/stt/recordings/\(escape(id))/transcribe",
            body: [String: String](), timeout: 900, retrySafe: true, origin: origin
        )
        result.archiveOrigin = origin ?? AppConfig.serverURL?.absoluteString
        return result
    }

    func voiceHistory(before: String? = nil) async throws -> VoiceArchivePage {
        var path = "/stt/recordings?limit=30"
        if let before { path += "&before=\(escape(before))" }
        let cloud = AppConfig.routes.first(where: { $0.kind == .cloud })?.origin
        let current = AppConfig.serverURL?.absoluteString
        do {
            let page: VoiceArchivePage = try await voiceRequest("GET", path, body: Optional<String>.none, origin: cloud ?? current)
            return VoiceArchivePage(recordings: page.recordings.map { var row = $0; row.archiveOrigin = cloud ?? current; return row }, nextBefore: page.nextBefore)
        } catch let error as APIError {
            guard VoiceRetryPlan.classify(error) == .transport, !ServerRoute.sameOrigin(cloud, current) else { throw error }
            let page: VoiceArchivePage = try await voiceRequest("GET", path, body: Optional<String>.none, origin: current)
            return VoiceArchivePage(recordings: page.recordings.map { var row = $0; row.archiveOrigin = current; return row }, nextBefore: page.nextBefore)
        }
    }

    func voiceRecording(id: String, origin: String? = nil) async throws -> VoiceArchiveRecord {
        var record: VoiceArchiveRecord = try await voiceRequest("GET", "/stt/recordings/\(escape(id))", body: Optional<String>.none, origin: origin)
        record.archiveOrigin = origin ?? AppConfig.serverURL?.absoluteString
        return record
    }

    func saveVoiceTranscript(id: String, text: String, origin: String? = nil) async throws -> VoiceArchiveRecord {
        var record: VoiceArchiveRecord = try await voiceRequest("POST", "/stt/recordings/\(escape(id))/text", body: ["text": text], retrySafe: true, origin: origin)
        record.archiveOrigin = origin ?? AppConfig.serverURL?.absoluteString
        return record
    }

    func voiceAudio(id: String, destination: URL, origin requestedOrigin: String? = nil) async throws -> URL {
        let origin = requestedOrigin ?? AppConfig.serverURL?.absoluteString
        guard let origin, let token = AppConfig.token,
              let url = URL(string: origin + "/api/v1/stt/recordings/\(escape(id))/audio")
        else { throw APIError.notConfigured }
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (temporary, response) = try await URLSession.shared.download(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let data = try Data(contentsOf: temporary)
            let _: VoiceArchiveRecord = try Self.decode(VoiceArchiveRecord.self, data: data, response: response)
            throw APIError.badResponse
        }
        return try await Task.detached(priority: .utility) {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: temporary, to: destination)
            return destination
        }.value
    }
}
