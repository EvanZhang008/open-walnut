import Foundation
import Observation

enum SessionMediaKind: Equatable {
    case video, audio, unsupported

    static func forPath(_ path: String) -> Self? {
        switch (path as NSString).pathExtension.lowercased() {
        case "mp4", "m4v", "mov": return .video
        case "mp3", "m4a", "wav": return .audio
        case "webm", "ogg", "oga", "ogv": return .unsupported
        default: return nil
        }
    }
}

enum SessionMediaPhase: Equatable {
    case idle, downloading
    case ready(URL)
    case failed(FileReadFailure)
}

enum SessionMediaDownload {
    enum Failure: Error { case saveFailed }
    typealias Download = @Sendable (URLRequest) async throws -> (URL, URLResponse)
    typealias NotifyUnauthorized = @MainActor @Sendable () -> Void

    static let notifyUnauthorized: NotifyUnauthorized = {
        NotificationCenter.default.post(name: WalnutAPI.unauthorizedNotification, object: nil)
    }

    static func request(path: String, host: String?) throws -> URLRequest {
        guard let url = WalnutAPI.rawFileContentURL(path: path, host: host),
              let token = AppConfig.token else { throw APIError.notConfigured }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 300
        return request
    }

    static var cacheDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("session-media", isDirectory: true)
    }

    private static let clearPreviousLaunch = Task.detached(priority: .utility) {
        let directory = cacheDirectory
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil) else { return }
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    static func fetch(request: URLRequest, extension ext: String, directory: URL,
                      download: Download,
                      unauthorized: NotifyUnauthorized = notifyUnauthorized) async throws -> URL {
        if directory == cacheDirectory { await clearPreviousLaunch.value }
        try Task.checkCancellation()
        let (temporary, response) = try await download(request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if http.statusCode == 401 {
            await unauthorized()
            throw APIError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, code: "", message: "",
                                  serverHash: nil, serverContent: nil)
        }
        let transfer = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sourcePath = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "path" })?.value ?? "media.\(ext)"
        let destination = transfer.appendingPathComponent((sourcePath as NSString).lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: transfer, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: transfer)
            throw Failure.saveFailed
        }
        do {
            try Task.checkCancellation()
            return destination
        } catch {
            try? FileManager.default.removeItem(at: transfer)
            throw error
        }
    }
}

@Observable
@MainActor
final class SessionMediaLoader {
    typealias Resolve = @MainActor (String) async -> String?
    private(set) var phase: SessionMediaPhase = .idle
    private(set) var healedPath: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var localURL: URL?
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let download: SessionMediaDownload.Download
    @ObservationIgnored private let makeRequest: (String, String?) throws -> URLRequest
    @ObservationIgnored private let unauthorized: SessionMediaDownload.NotifyUnauthorized

    init(directory: URL = SessionMediaDownload.cacheDirectory,
         download: @escaping SessionMediaDownload.Download = { request in
             try await URLSession.shared.download(for: request)
         },
         makeRequest: @escaping (String, String?) throws -> URLRequest = SessionMediaDownload.request,
         unauthorized: @escaping SessionMediaDownload.NotifyUnauthorized = SessionMediaDownload.notifyUnauthorized) {
        self.directory = directory
        self.download = download
        self.makeRequest = makeRequest
        self.unauthorized = unauthorized
    }

    @discardableResult
    func start(path: String, host: String?, resolve: Resolve? = nil) -> Task<Void, Never>? {
        teardown()
        guard let kind = SessionMediaKind.forPath(path), kind != .unsupported else {
            phase = .failed(FileReadFailure(kind: .unsupportedType, host: host))
            return nil
        }
        let request: URLRequest
        do {
            request = try makeRequest(path, host)
        } catch {
            phase = .failed(FilePreviewLink.failure(for: error, host: host))
            return nil
        }
        phase = .downloading
        let current = generation
        let directory = self.directory
        let download = self.download
        let ext = (path as NSString).pathExtension.lowercased()
        let makeRequest = self.makeRequest
        let unauthorized = self.unauthorized
        task = Task { [weak self] in
            do {
                let url: URL
                do {
                    url = try await SessionMediaDownload.fetch(
                        request: request, extension: ext, directory: directory, download: download, unauthorized: unauthorized)
                } catch {
                    let firstError = error
                    guard case .server(let status, _, _, _, _) = error as? APIError,
                          status == 400 || status == 404,
                          let resolve, !Task.isCancelled,
                          self?.generation == current else { throw firstError }
                    guard let replacement = await resolve(path), !replacement.isEmpty, replacement != path,
                          self?.generation == current, !Task.isCancelled else { throw firstError }
                    self?.healedPath = replacement
                    url = try await SessionMediaDownload.fetch(
                        request: makeRequest(replacement, host),
                        extension: (replacement as NSString).pathExtension.lowercased(),
                        directory: directory, download: download, unauthorized: unauthorized)
                }
                // Cancellation alone cannot fence a downloader that finishes late.
                guard let self, self.generation == current, !Task.isCancelled else {
                    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                    return
                }
                self.localURL = url
                self.phase = .ready(url)
                self.task = nil
            } catch {
                guard let self, self.generation == current, !Task.isCancelled else { return }
                if error is SessionMediaDownload.Failure {
                    self.phase = .failed(FileReadFailure(
                        kind: .hostReadFailed("Couldn't save the downloaded media on this phone."), host: host))
                } else {
                    self.phase = .failed(FilePreviewLink.failure(for: error, host: host))
                }
                self.task = nil
            }
        }
        return task
    }

    func teardown() {
        generation += 1
        task?.cancel()
        task = nil
        if let localURL { try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent()) }
        localURL = nil
        healedPath = nil
        phase = .idle
    }

    deinit {
        task?.cancel()
        if let localURL { try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent()) }
    }
}
