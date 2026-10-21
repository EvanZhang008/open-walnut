import XCTest
@testable import Walnut

/// The live upload loop: it sends what the recorder has written so far, from
/// the offset the server last confirmed, and stops quietly when the server
/// does not take live pieces.
final class VoiceLiveUploaderTests: XCTestCase {
    private var file: URL!

    override func setUp() async throws {
        file = FileManager.default.temporaryDirectory.appendingPathComponent("live-\(UUID().uuidString).caf")
        FileManager.default.createFile(atPath: file.path, contents: nil)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: file)
    }

    private func append(_ count: Int, byte: UInt8) throws {
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(repeating: byte, count: count))
        try handle.close()
    }

    /// Records each piece; the server keeps every byte it is sent.
    private actor Server {
        var received = Data()
        var calls: [(from: Int, count: Int)] = []
        var gapOnce = false
        var failures = 0
        var declineAfter: Int?

        func take(_ from: Int, _ data: Data) throws -> VoiceLiveUploader.Ack {
            calls.append((from, data.count))
            if failures > 0 { failures -= 1; throw APIError.badResponse }
            if gapOnce { gapOnce = false; return .init(accepted: true, receivedBytes: 0) }
            if let declineAfter, calls.count > declineAfter {
                return .init(accepted: false, receivedBytes: received.count, reason: "not-transcribed-here")
            }
            if from <= received.count, received.count - from < data.count {
                received.append(data.suffix(from: data.startIndex + (received.count - from)))
            }
            return .init(accepted: true, receivedBytes: received.count)
        }
        func set(gapOnce: Bool = false, failures: Int = 0, declineAfter: Int? = nil) {
            self.gapOnce = gapOnce; self.failures = failures; self.declineAfter = declineAfter
        }
    }

    private func runLoop(_ server: Server, chunk: Int = 1000) -> Task<VoiceLiveUploader.Outcome, Never> {
        let url = file!
        return Task.detached {
            await VoiceLiveUploader.run(
                fileURL: url, send: { from, data in try await server.take(from, data) },
                interval: .milliseconds(20), chunkBytes: chunk
            )
        }
    }

    private func waitFor(_ timeout: TimeInterval = 5, _ check: @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("condition not met in \(timeout)s")
    }

    func testSendsTheGrowingFileInOrderAndCatchesUp() async throws {
        let server = Server()
        try append(2500, byte: 1)
        let loop = runLoop(server)
        try await waitFor { await server.received.count == 2500 }
        try append(700, byte: 2)
        try await waitFor { await server.received.count == 3200 }
        loop.cancel()
        let outcome = await loop.value
        XCTAssertEqual(outcome, .stopped)
        let received = await server.received
        let written = try Data(contentsOf: file)
        XCTAssertEqual(received, written)
        // A backlog goes out in whole pieces, never more than one piece per call.
        let calls = await server.calls
        XCTAssertTrue(calls.allSatisfy { $0.count <= 1000 })
        XCTAssertEqual(calls.first?.from, 0)
    }

    func testResendsFromWhatTheServerSaysItHas() async throws {
        let server = Server()
        try append(1500, byte: 3)
        await server.set(gapOnce: true)
        let loop = runLoop(server)
        try await waitFor { await server.received.count == 1500 }
        loop.cancel()
        _ = await loop.value
        let froms = await server.calls.map(\.from)
        // The first piece was answered "I have 0": it is sent again from 0.
        XCTAssertEqual(Array(froms.prefix(2)), [0, 0])
        let received = await server.received
        XCTAssertEqual(received, try Data(contentsOf: file))
    }

    func testStopsWhenTheServerDeclines() async throws {
        let server = Server()
        await server.set(declineAfter: 1)
        try append(3000, byte: 4)
        let outcome = await runLoop(server).value
        XCTAssertEqual(outcome, .declined("not-transcribed-here"))
    }

    func testStopsOnAnOlderServerWithoutTheRoute() async throws {
        try append(10, byte: 5)
        let url = file!
        let outcome = await VoiceLiveUploader.run(
            fileURL: url,
            send: { _, _ in throw APIError.server(status: 404, code: "not_found", message: "Not found", serverHash: nil, serverContent: nil) },
            interval: .milliseconds(10)
        )
        XCTAssertEqual(outcome, .unsupported)
    }

    func testRetriesANetworkErrorThenGivesUpAfterAFew() async throws {
        let server = Server()
        await server.set(failures: 1)
        try append(500, byte: 6)
        let loop = runLoop(server)
        try await waitFor { await server.received.count == 500 }
        loop.cancel()
        _ = await loop.value

        let failing = Server()
        await failing.set(failures: 100)
        let outcome = await runLoop(failing).value
        XCTAssertEqual(outcome, .gaveUp)
        let calls = await failing.calls.count
        XCTAssertEqual(calls, VoiceLiveUploader.maxFailures)
    }
}
