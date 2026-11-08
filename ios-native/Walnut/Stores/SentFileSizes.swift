import Foundation
import Observation

/// The server's answer to `POST /api/files/exists`: whether each path is there,
/// and the byte size of each file it found. A path it cannot answer for is left
/// out of both.
struct FileStats: Decodable, Equatable, Sendable {
    var exists: [String: Bool]? = nil
    var sizes: [String: Int64]? = nil
}

/// The one call `SentFileSizes` makes, so tests can stand in for the server.
protocol FileStatTransport {
    func fileStats(paths: [String], host: String?) async throws -> FileStats
}

extension WalnutAPI: FileStatTransport {
    /// Stats a few paths on the machine Walnut runs on, or on `host`. Reads only.
    func fileStats(paths: [String], host: String?) async throws -> FileStats {
        struct Body: Encodable {
            let paths: [String]
            let host: String?
        }
        let hostField = (host?.isEmpty ?? true) ? nil : host
        return try await sendAbsolute("POST", "/api/files/exists", body: Body(paths: paths, host: hostField),
                                      timeout: 15, retrySafe: true)
    }
}

/// Sizes of the files sent messages name by path, for their cards ("PDF ·
/// 1.2 MB"). Each path is asked for once in this run of the app, a few to a
/// request, of the host the message's files are on. A path the server gives no
/// size for (gone, a folder, a host that does not answer) keeps none, and its
/// card shows the kind alone; one whose request failed is asked again the next
/// time its card is drawn.
@MainActor
@Observable
final class SentFileSizes {
    static let shared = SentFileSizes()

    /// The server's own cap on paths a request (files.ts `EXISTS_MAX`).
    static let perRequest = 8

    private(set) var sizes: [String: Int64] = [:]
    @ObservationIgnored private var asked: Set<String> = []
    @ObservationIgnored private let transport: FileStatTransport

    init(transport: FileStatTransport? = nil) {
        self.transport = transport ?? WalnutAPI()
    }

    func size(of path: String) -> Int64? { sizes[path] }

    /// The pairing is going (`LocalDataReset`): nothing known of the old
    /// server's files is kept, and the next server is asked afresh.
    func removeAll() {
        sizes = [:]
        asked = []
    }

    /// Asks for the sizes of `paths` not asked for yet.
    func request(_ paths: [String], host: String?) async {
        var fresh: [String] = []
        for path in paths where !asked.contains(path) && !fresh.contains(path) { fresh.append(path) }
        guard !fresh.isEmpty else { return }
        asked.formUnion(fresh)
        for start in stride(from: 0, to: fresh.count, by: Self.perRequest) {
            let batch = Array(fresh[start..<min(start + Self.perRequest, fresh.count)])
            do {
                let answer = try await transport.fileStats(paths: batch, host: host)
                for (path, size) in answer.sizes ?? [:] where size >= 0 && batch.contains(path) {
                    sizes[path] = size
                }
            } catch {
                asked.subtract(batch)
                AppLog.info("files", "sent file sizes not known", ["count": String(batch.count), "error": String(describing: error)])
            }
        }
    }

    /// The paths of files sent messages in `messages` name whose cards show a
    /// size: files the host got, not pictures (drawn as pictures) and not ones
    /// the server could not copy there.
    static func sentFilePaths(in messages: [ChatMessage]) -> [String] {
        var out: [String] = []
        for message in messages where message.isUser && message.text.hasPrefix("[") {
            guard let parts = MessageRow.attachmentSendParts(message.text) else { continue }
            for path in parts.filePaths where !MarkdownParser.isImagePath(path)
                && parts.copyFailures[path] == nil && !out.contains(path) {
                out.append(path)
            }
        }
        return out
    }
}
