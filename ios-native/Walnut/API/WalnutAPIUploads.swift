import Foundation

/// The host's answer to one chunk of a session upload
/// (`PUT /api/v1/sessions/:id/uploads/:uploadId`, docs/reference/api-v1.md).
struct UploadChunkReply: Decodable, Equatable, Sendable {
    /// Bytes the host now holds: send the next chunk from here.
    let received: Int64
    let size: Int64
    let done: Bool
    /// Where the finished file is on the session's host (the last chunk only).
    let path: String?
}

/// What a chunk upload can answer besides a reply.
enum UploadChunkOutcome: Equatable, Sendable {
    case reply(UploadChunkReply)
    /// 409 `upload_offset_mismatch`: the host holds a different amount; resume there.
    case resumeAt(Int64)
    /// 422 `upload_checksum_mismatch`: the host's copy differs; start over.
    case restart
}

/// The one call the uploader makes, so tests can stand in for the server.
protocol SessionUploadTransport {
    func uploadChunk(sessionID: String, uploadID: String, name: String, size: Int64,
                     offset: Int64, sha256: String?, data: Data) async throws -> UploadChunkOutcome
}

extension WalnutAPI: SessionUploadTransport {
    /// One raw chunk. Safe to retry: the host acknowledges a chunk it already
    /// holds without writing it again.
    func uploadChunk(sessionID: String, uploadID: String, name: String, size: Int64,
                     offset: Int64, sha256: String?, data: Data) async throws -> UploadChunkOutcome {
        guard let base = AppConfig.serverURL, let token = AppConfig.token,
              var components = URLComponents(string: base.absoluteString + "/api/v1/sessions/\(escape(sessionID))/uploads/\(escape(uploadID))")
        else { throw APIError.notConfigured }
        var query = [
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "size", value: String(size)),
            URLQueryItem(name: "name", value: name),
        ]
        if let sha256 { query.append(URLQueryItem(name: "sha256", value: sha256)) }
        components.queryItems = query
        // `+` is a space to some query parsers; a file name may hold one.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw APIError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        // A 2 MB chunk over a slow uplink, plus the host's write.
        request.timeoutInterval = 120
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let (body, response) = try await perform(request, retrySafe: true)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 409, let resume = Self.resumeOffset(body) { return .resumeAt(resume) }
            if http.statusCode == 422 { return .restart }
        }
        return .reply(try Self.decode(UploadChunkReply.self, data: body, response: response))
    }

    /// `received` from a 409 `upload_offset_mismatch` body, else nil (any other 409).
    static func resumeOffset(_ body: Data) -> Int64? {
        struct Envelope: Decodable {
            struct Inner: Decodable { let code: String; let received: Int64? }
            let error: Inner
        }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: body),
              envelope.error.code == "upload_offset_mismatch" else { return nil }
        return max(0, envelope.error.received ?? 0)
    }
}
