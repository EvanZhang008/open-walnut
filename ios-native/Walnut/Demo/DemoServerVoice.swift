import CryptoKit
import Foundation
import os

fileprivate struct DemoVoiceTake {
    var chunks: [Int: Data] = [:]
    var metadata: [String: Any]
    var audio: Data?
}

enum DemoVoice {
    fileprivate static let takes = OSAllocatedUnfairLock(initialState: [String: DemoVoiceTake]())
    static func reset() { takes.withLock { $0.removeAll() } }
}

extension DemoServer {
    func routeVoice(_ request: DemoRequest, _ segments: [String]) -> DemoReply? {
        guard segments.count >= 2, segments[1] == "recordings" else { return nil }
        if segments.count == 2, request.method == "GET" {
            return .object(["recordings": DemoVoice.takes.withLock { $0.values.map(\.metadata) }])
        }
        guard segments.count >= 3 else { return nil }
        let id = segments[2].lowercased()
        return DemoVoice.takes.withLock { takes in
            if segments.count == 3, request.method == "GET" {
                guard let take = takes[id] else { return .error(404, "not_found", "Recording not found") }
                return .object(take.metadata)
            }
            guard segments.count == 4 else { return nil }
            let operation = segments[3]
            if request.method == "POST", operation == "chunks" {
                guard let encoded = request.string("audio"), let data = Data(base64Encoded: encoded),
                      let index = request.json["index"] as? Int else { return .error(400, "bad_request", "Audio chunk required") }
                var take = takes[id] ?? DemoVoiceTake(metadata: [
                    "id": id, "createdAt": request.string("createdAt") ?? ISO8601DateFormatter().string(from: Date()),
                    "format": request.string("format") ?? "caf", "audioSizeBytes": 0,
                    "state": "uploading", "primarySaved": false, "storage": "primary",
                ])
                if let existing = take.chunks[index], existing != data { return .error(409, "conflict", "Chunk already saved") }
                take.chunks[index] = data
                if let duration = request.json["durationSeconds"] as? Double { take.metadata["durationSeconds"] = duration }
                takes[id] = take
                return .object(take.metadata)
            }
            guard var take = takes[id] else { return .error(404, "not_found", "Recording not found") }
            if request.method == "POST", operation == "commit" {
                guard let count = request.json["chunkCount"] as? Int else { return .error(400, "bad_request", "Chunk count required") }
                var audio = Data()
                for index in 0..<count {
                    guard let data = take.chunks[index] else { return .error(409, "conflict", "Recording is incomplete") }
                    audio.append(data)
                }
                let digest = SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined()
                guard digest == request.string("audioSha256"), audio.count == request.json["audioSizeBytes"] as? Int else {
                    return .error(409, "conflict", "Recording checksum does not match")
                }
                take.audio = audio
                take.metadata["audioSizeBytes"] = audio.count
                take.metadata["audioSha256"] = digest
                take.metadata["state"] = "saved"
                take.metadata["primarySaved"] = true
                if let text = request.string("text") { take.metadata["text"] = text; take.metadata["state"] = "transcribed" }
                takes[id] = take
                return .object(take.metadata)
            }
            if request.method == "POST", operation == "transcribe" {
                let text = take.metadata["text"] as? String ?? DemoFixtures.transcriptionSentence(clockNow)
                take.metadata["text"] = text
                take.metadata["state"] = "transcribed"
                takes[id] = take
                return .object(["text": text, "recordingId": id, "via": "demo", "primarySaved": true, "storage": "primary"])
            }
            if request.method == "GET", operation == "audio", let audio = take.audio {
                return DemoReply(status: 200, body: .bytes(audio, contentType: "audio/x-caf"))
            }
            return nil
        }
    }
}
