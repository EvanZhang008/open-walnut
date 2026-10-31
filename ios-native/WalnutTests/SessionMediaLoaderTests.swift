import XCTest
@testable import Walnut

@MainActor
final class SessionMediaLoaderTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("media-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testMediaExtensionsAreCaseInsensitiveAndHTMLStaysSeparate() {
        for ext in ["mp4", "MP4", "m4v", "M4V", "mov", "MoV"] {
            XCTAssertEqual(SessionMediaKind.forPath("/tmp/clip.\(ext)"), .video)
        }
        for ext in ["mp3", "MP3", "m4a", "M4A", "wav", "WaV"] {
            XCTAssertEqual(SessionMediaKind.forPath("/tmp/clip.\(ext)"), .audio)
        }
        for ext in ["webm", "WEBM", "ogg", "oga", "ogv"] {
            XCTAssertEqual(SessionMediaKind.forPath("/tmp/clip.\(ext)"), .unsupported)
        }
        for path in ["/tmp/file.html", "/tmp/file.HTM", "/tmp/file.md", "/tmp/mp4", ""] {
            XCTAssertNil(SessionMediaKind.forPath(path))
        }
        XCTAssertTrue(FilePreviewLink.isPreviewablePath("/tmp/file.HTM"))
        XCTAssertFalse(FilePreviewLink.isPreviewablePath("/tmp/clip.mp4"))
    }

    func testRequestUsesRawURLPreservesQueryHostAndAuthentication() throws {
        let savedURL = AppConfig.processServerURLOverride
        let savedToken = AppConfig.processTokenOverride
        defer {
            AppConfig.processServerURLOverride = savedURL
            AppConfig.processTokenOverride = savedToken
        }
        AppConfig.processServerURLOverride = URL(string: "https://media.example.test:8443/old?discard=1")!
        AppConfig.processTokenOverride = "unit-test-credential"
        let path = "/tmp/\u{89C6}\u{9891} #1&next=2?.MP4"
        let request = try SessionMediaDownload.request(path: path, host: "build box&one")
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/v1/file-content")
        XCTAssertEqual(components.host, "media.example.test")
        XCTAssertEqual(components.port, 8443)
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "path", value: path), URLQueryItem(name: "raw", value: "1"),
            URLQueryItem(name: "host", value: "build box&one")
        ])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer unit-test-credential")
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(request.timeoutInterval, 300)
        for host in [nil, ""] as [String?] {
            let request = try SessionMediaDownload.request(path: path, host: host)
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertFalse(query?.contains { $0.name == "host" } ?? true)
        }
    }

    func testDownloadMovesDiskFileWithoutSizeLimitAndCleansOnlyOwnedFile() async throws {
        let temporary = try makeDiskFile("transfer", bytes: 5 * 1_048_576)
        let unrelated = try makeDiskFile("other-view.mp4")
        let loader = makeLoader { request in
            (temporary, Self.response(request, status: 200))
        }
        let task = try XCTUnwrap(loader.start(path: "/tmp/clip.MP4", host: "buildbox"))
        await task.value
        guard case .ready(let url) = loader.phase else { return XCTFail("Expected local media") }
        XCTAssertTrue(url.isFileURL)
        XCTAssertEqual(url.pathExtension, "MP4")
        XCTAssertEqual(url.lastPathComponent, "clip.MP4")
        XCTAssertEqual(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, 5 * 1_048_576)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
        loader.teardown()
        loader.teardown()
        XCTAssertEqual(loader.phase, .idle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }

    func testHTTPFailuresUseTheFileErrorLadderAndDeleteTemporaryBodies() async throws {
        let table: [(Int, FileReadFailureKind, Bool)] = [
            (401, .signInRefused, true), (403, .refused, false), (404, .notFoundOnHost, true),
            (413, .tooLarge, false), (415, .unsupportedType, false),
            (500, .serverError(status: 500), true), (501, .hostNeedsUpgrade, true),
            (503, .hostUnreachable, true)
        ]
        for (status, kind, retry) in table {
            let temporary = try makeDiskFile("error-\(status)")
            let loader = makeLoader { request in (temporary, Self.response(request, status: status)) }
            await loader.start(path: "/tmp/clip.mp4", host: "buildbox")?.value
            guard case .failed(let failure) = loader.phase else { return XCTFail("Expected HTTP \(status) failure") }
            XCTAssertEqual(failure.kind, kind)
            XCTAssertEqual(failure.host, "buildbox")
            XCTAssertEqual(failure.isRetryable, retry)
            XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
            loader.teardown()
        }
    }

    func testTransportFailureCanRetryAndASecondOpenOwnsANewFile() async throws {
        let probe = MediaDownloadProbe()
        let loader = makeLoader { request in try await probe.download(request) }
        let first = try XCTUnwrap(loader.start(path: "/tmp/clip.mp4", host: "buildbox"))
        await probe.waitForRequests(1)
        await probe.fail(0, error: URLError(.timedOut))
        await first.value
        XCTAssertEqual(loader.phase, .failed(FileReadFailure(kind: .transportFailed, host: "buildbox")))
        let retry = try XCTUnwrap(loader.start(path: "/tmp/clip.mp4", host: "buildbox"))
        XCTAssertEqual(loader.phase, .downloading)
        await probe.waitForRequests(2)
        let transfer = try makeDiskFile("retry-transfer")
        await probe.succeed(1, file: transfer)
        await retry.value
        guard case .ready(let firstURL) = loader.phase else { return XCTFail("Expected retry success") }
        let reopened = try XCTUnwrap(loader.start(path: "/tmp/clip.mp4", host: "buildbox"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstURL.path))
        await probe.waitForRequests(3)
        await probe.succeed(2, file: try makeDiskFile("reopened-transfer"))
        await reopened.value
        guard case .ready(let nextURL) = loader.phase else { return XCTFail("Expected second open success") }
        XCTAssertNotEqual(nextURL, firstURL)
        let requests = await probe.requests
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[0].url, requests[1].url)
        loader.teardown()
        XCTAssertFalse(FileManager.default.fileExists(atPath: nextURL.path))
    }

    func testClosingDuringDownloadDeletesLateFileAndNeverInstallsIt() async throws {
        let probe = MediaDownloadProbe()
        let loader = makeLoader { request in try await probe.download(request) }
        let pending = try XCTUnwrap(loader.start(path: "/tmp/clip.mp4", host: nil))
        await probe.waitForRequests(1)
        loader.teardown()
        let temporary = try makeDiskFile("late-transfer")
        await probe.succeed(0, file: temporary)
        await pending.value
        XCTAssertEqual(loader.phase, .idle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(at: directory,
                                                                includingPropertiesForKeys: nil).isEmpty)
    }

    func testReplacingFileIgnoresLateSuccessAndLateFailure() async throws {
        let probe = MediaDownloadProbe()
        let loader = makeLoader { request in try await probe.download(request) }
        let first = try XCTUnwrap(loader.start(path: "/tmp/first.mp4", host: "first-host"))
        await probe.waitForRequests(1)
        let second = try XCTUnwrap(loader.start(path: "/tmp/second.mov", host: "second-host"))
        await probe.waitForRequests(2)
        await probe.succeed(1, file: try makeDiskFile("second-transfer"))
        await second.value
        let secondPhase = loader.phase
        let late = try makeDiskFile("first-late")
        await probe.succeed(0, file: late)
        await first.value
        XCTAssertEqual(loader.phase, secondPhase)
        XCTAssertFalse(FileManager.default.fileExists(atPath: late.path))

        let third = try XCTUnwrap(loader.start(path: "/tmp/third.wav", host: nil))
        await probe.waitForRequests(3)
        loader.teardown()
        await probe.fail(2, error: URLError(.networkConnectionLost))
        await third.value
        XCTAssertEqual(loader.phase, .idle)
    }

    func testUnsupportedAndUnpairedInputsDoNotDownload() {
        let loader = SessionMediaLoader(directory: directory, download: { _ in
            XCTFail("Unsupported or unpaired media must not download")
            throw URLError(.badURL)
        }, makeRequest: { _, _ in throw APIError.notConfigured })
        XCTAssertNil(loader.start(path: "/tmp/clip.webm", host: "buildbox"))
        XCTAssertEqual(loader.phase, .failed(FileReadFailure(kind: .unsupportedType, host: "buildbox")))
        XCTAssertNil(loader.start(path: "/tmp/clip.mp4", host: nil))
        XCTAssertEqual(loader.phase, .failed(FilePreviewLink.failure(for: APIError.notConfigured)))
    }

    func testUnexpectedResponseCleansUpDownload() async throws {
        let temporary = try makeDiskFile("bad-response")
        let loader = makeLoader { request in
            (temporary, URLResponse(url: request.url!, mimeType: nil, expectedContentLength: 1, textEncodingName: nil))
        }
        await loader.start(path: "/tmp/clip.mp4", host: nil)?.value
        XCTAssertEqual(loader.phase, .failed(FilePreviewLink.failure(for: APIError.badResponse)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
    }

    func testDeallocationCleansItsReadyFile() async throws {
        let temporary = try makeDiskFile("deinit-transfer")
        var loader: SessionMediaLoader? = makeLoader { request in
            (temporary, Self.response(request, status: 200))
        }
        await loader?.start(path: "/tmp/clip.mp3", host: nil)?.value
        guard case .ready(let url) = loader?.phase else { return XCTFail("Expected local media") }
        weak var weakLoader = loader
        loader = nil
        XCTAssertNil(weakLoader)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testDiskFailureIsNotReportedAsANetworkFailure() async throws {
        let blocked = try makeDiskFile("not-a-directory")
        let temporary = try makeDiskFile("disk-transfer")
        let loader = SessionMediaLoader(directory: blocked, download: { request in
            (temporary, Self.response(request, status: 200))
        }, makeRequest: { _, _ in URLRequest(url: URL(string: "https://media.example.test/file")!) })
        await loader.start(path: "/tmp/clip.mp4", host: "buildbox")?.value
        guard case .failed(let failure) = loader.phase else { return XCTFail("Expected disk failure") }
        XCTAssertEqual(failure.kind, .hostReadFailed("Couldn't save the downloaded media on this phone."))
        XCTAssertTrue(failure.isRetryable)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
    }

    func testUnauthorizedNotifiesThroughAnInjectedCallbackAndCleansBody() async throws {
        let temporary = try makeDiskFile("unauthorized-body")
        var notified = false
        do {
            _ = try await SessionMediaDownload.fetch(
                request: URLRequest(url: URL(string: "https://media.example.test/file")!),
                extension: "mp4", directory: directory,
                download: { request in (temporary, Self.response(request, status: 401)) },
                unauthorized: { notified = true })
            XCTFail("Expected unauthorized failure")
        } catch APIError.unauthorized {
            XCTAssertTrue(notified)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
    }

    func testOnlyWrongPathsResolveAndTheHealedPathKeepsItsHost() async throws {
        for status in [400, 404, 403, 413, 501, 503] {
            let missing = try makeDiskFile("missing-\(status)")
            let replacement = try makeDiskFile("replacement-\(status)")
            var resolved = 0
            let loader = makeLoader { request in
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                let path = query?.first { $0.name == "path" }?.value
                XCTAssertEqual(query?.first { $0.name == "host" }?.value, "buildbox")
                return path == "/tmp/new.mov" ? (replacement, Self.response(request, status: 200))
                    : (missing, Self.response(request, status: status))
            }
            await loader.start(path: "/tmp/old.mp4", host: "buildbox", resolve: { path in
                XCTAssertEqual(path, "/tmp/old.mp4")
                resolved += 1
                return "/tmp/new.mov"
            })?.value
            if status == 400 || status == 404 {
                XCTAssertEqual(resolved, 1)
                XCTAssertEqual(loader.healedPath, "/tmp/new.mov")
                guard case .ready(let url) = loader.phase else { return XCTFail("Expected healed media") }
                XCTAssertEqual(url.pathExtension, "mov")
            } else {
                XCTAssertEqual(resolved, 0)
                XCTAssertNil(loader.healedPath)
                XCTAssertEqual(loader.phase, .failed(FilePreviewLink.failure(forHTTPStatus: status, host: "buildbox")))
            }
            loader.teardown()
        }
    }

    func testResolvedPathFailureReportsActualErrorAndKeepsTheNotice() async throws {
        let missing = try makeDiskFile("original-missing")
        let unavailable = try makeDiskFile("healed-unavailable")
        let loader = makeLoader { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            let path = query?.first { $0.name == "path" }?.value
            return path == "/tmp/new.mp4" ? (unavailable, Self.response(request, status: 503))
                : (missing, Self.response(request, status: 404))
        }
        await loader.start(path: "/tmp/old.mp4", host: "buildbox", resolve: { _ in "/tmp/new.mp4" })?.value
        XCTAssertEqual(loader.healedPath, "/tmp/new.mp4")
        XCTAssertEqual(loader.phase, .failed(FilePreviewLink.failure(forHTTPStatus: 503, host: "buildbox")))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: unavailable.path))
        loader.teardown()
    }

    func testClosingWhileResolvingNeverDownloadsTheLateReplacement() async throws {
        let probe = MediaResolveProbe()
        let missing = try makeDiskFile("resolve-missing")
        let loader = makeLoader { request in (missing, Self.response(request, status: 404)) }
        let task = try XCTUnwrap(loader.start(path: "/tmp/old.mp4", host: nil, resolve: { _ in
            await probe.resolve()
        }))
        await probe.waitUntilResolving()
        loader.teardown()
        await probe.finish("/tmp/new.mp4")
        await task.value
        XCTAssertEqual(loader.phase, .idle)
        XCTAssertNil(loader.healedPath)
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    func testAudioHandoffCannotActivateAfterCloseAndBackgroundKeepsThePlayer() async throws {
        let probe = MediaResolveProbe()
        var activations = 0
        var deactivations = 0
        let playback = SessionMediaPlayback(settleAudio: { _ = await probe.resolve() },
                                            activateAudio: { activations += 1 },
                                            deactivateAudio: { deactivations += 1 }, stopSpeech: {})
        let pending = try XCTUnwrap(playback.claimAudio(host: nil))
        await probe.waitUntilResolving()
        playback.teardown()
        await probe.finish(nil)
        await pending.value
        XCTAssertEqual(activations, 0)
        XCTAssertEqual(deactivations, 0)

        let immediate = SessionMediaPlayback(settleAudio: {}, activateAudio: { activations += 1 },
                                             deactivateAudio: { deactivations += 1 }, stopSpeech: {})
        await immediate.claimAudio(host: nil)?.value
        XCTAssertEqual(activations, 1)
        immediate.setForeground(false, host: nil)
        XCTAssertEqual(deactivations, 1)
        immediate.setForeground(true, host: nil)
        await Task.yield()
        XCTAssertEqual(activations, 1, "Returning to the preview must not take the audio session")
        immediate.teardown()
        XCTAssertEqual(deactivations, 1)

        let file = try makeDiskFile("paused-media.mp4")
        immediate.open(file, host: nil)
        let player = try XCTUnwrap(immediate.player)
        let item = player.currentItem
        immediate.setForeground(false, host: nil)
        XCTAssertTrue(immediate.player === player)
        XCTAssertTrue(immediate.player?.currentItem === item)
        XCTAssertEqual(player.rate, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        immediate.teardown()
    }

    func testPausedPlayerDoesNotActivateAfterPendingAudioHandoff() async throws {
        let probe = MediaResolveProbe()
        var activations = 0
        let playback = SessionMediaPlayback(settleAudio: { _ = await probe.resolve() },
                                            activateAudio: { activations += 1 },
                                            deactivateAudio: {}, stopSpeech: {})
        playback.open(try makeDiskFile("paused.mp4"), host: nil)
        let pending = try XCTUnwrap(playback.claimAudio(host: nil))
        await probe.waitUntilResolving()
        playback.player?.pause()
        await probe.finish(nil)
        await pending.value
        XCTAssertEqual(activations, 0)
        XCTAssertEqual(playback.player?.rate, 0)
        playback.teardown()
    }

    func testAudioActivationFailureReportsError() async {
        let playback = SessionMediaPlayback(settleAudio: {}, activateAudio: { throw APIError.badResponse },
                                            deactivateAudio: {}, stopSpeech: {})
        await playback.claimAudio(host: nil)?.value
        XCTAssertNotNil(playback.failure)
        XCTAssertFalse(playback.preparing)
        playback.teardown()
    }

    func testAccessibleMediaTimeLabelHandlesUnknownDuration() {
        XCTAssertEqual(SessionMediaView.timeLabel(.nan), "0:00")
        XCTAssertEqual(SessionMediaView.timeLabel(.infinity), "0:00")
        XCTAssertEqual(SessionMediaView.timeLabel(-1), "0:00")
        XCTAssertEqual(SessionMediaView.timeLabel(11.9), "0:11")
        XCTAssertEqual(SessionMediaView.timeLabel(3600), "60:00")
    }

    private func makeLoader(download: @escaping SessionMediaDownload.Download) -> SessionMediaLoader {
        SessionMediaLoader(directory: directory, download: download, makeRequest: { path, host in
            var components = URLComponents(string: "https://media.example.test/api/v1/file-content")!
            components.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "raw", value: "1")]
            if let host { components.queryItems?.append(URLQueryItem(name: "host", value: host)) }
            return URLRequest(url: components.url!)
        }, unauthorized: {})
    }

    private func makeDiskFile(_ name: String, bytes: Int = 32) throws -> URL {
        let url = directory.appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        let file = try FileHandle(forWritingTo: url)
        defer { try? file.close() }
        try file.truncate(atOffset: UInt64(bytes))
        return url
    }

    nonisolated private static func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

private actor MediaResolveProbe {
    private var pending: CheckedContinuation<String?, Never>?
    private var started: CheckedContinuation<Void, Never>?

    func resolve() async -> String? {
        await withCheckedContinuation { continuation in
            pending = continuation
            started?.resume()
            started = nil
        }
    }

    func waitUntilResolving() async {
        if pending != nil { return }
        await withCheckedContinuation { started = $0 }
    }

    func finish(_ path: String?) {
        pending?.resume(returning: path)
        pending = nil
    }
}

private actor MediaDownloadProbe {
    private(set) var requests: [URLRequest] = []
    private var pending: [Int: CheckedContinuation<(URL, URLResponse), Error>] = [:]
    private var waiter: (count: Int, continuation: CheckedContinuation<Void, Never>)?

    func download(_ request: URLRequest) async throws -> (URL, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let index = requests.count
            requests.append(request)
            pending[index] = continuation
            if let waiter, requests.count >= waiter.count {
                self.waiter = nil
                waiter.continuation.resume()
            }
        }
    }

    func waitForRequests(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { waiter = (count, $0) }
    }

    func succeed(_ index: Int, file: URL) {
        let response = HTTPURLResponse(url: requests[index].url!, statusCode: 200,
                                       httpVersion: nil, headerFields: nil)!
        pending.removeValue(forKey: index)?.resume(returning: (file, response))
    }

    func fail(_ index: Int, error: Error) {
        pending.removeValue(forKey: index)?.resume(throwing: error)
    }
}
