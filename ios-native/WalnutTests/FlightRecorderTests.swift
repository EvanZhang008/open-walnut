import XCTest
import zlib
@testable import Walnut

/// Independent gunzip for the round-trip assertions.
///
/// NOT `NSData.decompressed(using: .zlib)`: that decoder expects a zlib
/// wrapper, and `Gzip.compress` deliberately emits GZIP framing (that mismatch
/// is the whole reason Gzip.swift exists rather than calling Foundation). Using
/// it here failed with NSCocoaErrorDomain 5377 against a byte-perfect gzip
/// stream — verified independently with `gunzip -t` and Python's gzip module —
/// i.e. the test was wrong, not the product. This inflater asks zlib for the
/// same `15 + 16` gzip-aware window the compressor used, so a failure here is a
/// real framing bug.
private func gunzip(_ data: Data) -> Data? {
    guard !data.isEmpty else { return nil }
    var stream = z_stream()
    guard inflateInit2_(&stream, 15 + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
    else { return nil }
    defer { inflateEnd(&stream) }

    var output = Data()
    let chunkSize = 64 * 1024
    var chunk = [UInt8](repeating: 0, count: chunkSize)
    var input = data
    return input.withUnsafeMutableBytes { rawInput -> Data? in
        stream.next_in = rawInput.bindMemory(to: UInt8.self).baseAddress
        stream.avail_in = uInt(rawInput.count)
        while true {
            let result: Int32 = chunk.withUnsafeMutableBufferPointer { buffer -> Int32 in
                stream.next_out = buffer.baseAddress
                stream.avail_out = uInt(chunkSize)
                return inflate(&stream, Z_NO_FLUSH)
            }
            guard result == Z_OK || result == Z_STREAM_END || result == Z_BUF_ERROR else { return nil }
            let produced = chunkSize - Int(stream.avail_out)
            if produced > 0 { output.append(contentsOf: chunk[0..<produced]) }
            if result == Z_STREAM_END { return output }
            if produced == 0 { return result == Z_BUF_ERROR ? output : nil }
        }
    }
}

/// Contracts of the pieces the flight recorder is built on, beyond the durable
/// queue (LogSpillTests): the gzip framing the uploader relies on, and the
/// crumb-sink fan-out that turns FreezeContext pushes into uploaded log lines.
final class FlightRecorderTests: XCTestCase {

    override func tearDown() {
        FreezeContext.shared.resetForTesting()
        super.tearDown()
    }

    // MARK: - Gzip framing

    /// Must be real GZIP (magic 1f 8b), not zlib-wrapped DEFLATE: the header is
    /// what `Content-Encoding: gzip` promises, and the server's body parser
    /// gunzips. Foundation's own `compressed(using: .zlib)` would silently fail
    /// this — hence the hand-rolled deflate.
    func testProducesGzipFraming() throws {
        let payload = Data(String(repeating: #"{"level":"info","subsystem":"crumb"}"#, count: 200).utf8)
        let compressed = try XCTUnwrap(Gzip.compress(payload))
        XCTAssertEqual(compressed[compressed.startIndex], 0x1f)
        XCTAssertEqual(compressed[compressed.startIndex + 1], 0x8b)
        XCTAssertEqual(compressed[compressed.startIndex + 2], 0x08, "expected DEFLATE method")
    }

    /// Round-trips through an independent gzip inflater, proving the stream is
    /// COMPLETE (a missing Z_FINISH would produce a truncated body the server
    /// rejects with a 400, after which the client retries the same bad batch
    /// forever and every log behind it is stuck).
    func testRoundTripsThroughDecompression() throws {
        let original = (0..<500)
            .map { #"{"seq":"\#($0)","level":"debug","subsystem":"heartbeat","message":"state"}"# }
            .joined(separator: "\n")
        let compressed = try XCTUnwrap(Gzip.compress(Data(original.utf8)))
        let restored = try XCTUnwrap(gunzip(compressed))
        XCTAssertEqual(String(data: restored, encoding: .utf8), original)
    }

    /// The economics of full-dump mode: repetitive JSON must compress hard
    /// enough that uploading EVERY line stays affordable on cellular. If this
    /// ratio ever collapses, the volume estimate behind the design is wrong.
    func testCompressesRepetitiveLogsAtLeastFourFold() throws {
        let lines = (0..<1000).map { index in
            #"{"ts":"2026-08-07T12:00:0\#(index % 10).000Z","level":"debug","subsystem":"heartbeat","message":"state","m_ctxScreen":"chat","m_ctxKeyboard":"hidden","m_ctxMemoryMB":"318"}"#
        }
        let payload = Data(lines.joined(separator: ",").utf8)
        let compressed = try XCTUnwrap(Gzip.compress(payload))
        let ratio = Double(payload.count) / Double(compressed.count)
        XCTAssertGreaterThan(ratio, 4.0, "compression ratio \(ratio) breaks the volume budget")
    }

    func testEmptyInputCompressesToNil() {
        XCTAssertNil(Gzip.compress(Data()), "empty body should skip compression entirely")
    }

    /// Large single batch (the 512KB uploader cap) must not wedge the chunked
    /// deflate loop.
    func testCompressesABatchSizedPayload() throws {
        let payload = Data(String(repeating: #"{"m":"x"},"#, count: 60_000).utf8)
        XCTAssertGreaterThan(payload.count, 512 * 1024)
        let compressed = try XCTUnwrap(Gzip.compress(payload))
        let restored = try XCTUnwrap(gunzip(compressed))
        XCTAssertEqual(restored, payload, "multi-chunk deflate lost or reordered bytes")
    }

    // MARK: - Wire contract

    /// The server's ingest route flattens each line into one JSON object and
    /// every forensic `jq`/`grep` targets these exact keys. A silent rename here
    /// would leave a log that still uploads but no longer matches the queries
    /// people run against it.
    func testLineCarriesTheContractKeys() throws {
        let encoded = ClientLogWire.encodeLine(
            ts: "2026-08-07T12:00:00.123Z", level: "error", subsystem: "freeze",
            message: "main thread unresponsive", seq: 4821,
            meta: ["stalledSeconds": "7.4", "ctxScreen": "session:a1b2c3d4"]
        )
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: String]
        )
        XCTAssertEqual(object["ts"], "2026-08-07T12:00:00.123Z")
        XCTAssertEqual(object["level"], "error")
        XCTAssertEqual(object["subsystem"], "freeze")
        XCTAssertEqual(object["message"], "main thread unresponsive")
        XCTAssertEqual(object["seq"], "4821")
        // Meta MUST carry the m_ prefix — that's what keeps it from colliding
        // with the envelope's own fields after the server flattens the line.
        XCTAssertEqual(object["m_stalledSeconds"], "7.4")
        XCTAssertEqual(object["m_ctxScreen"], "session:a1b2c3d4")
        XCTAssertNil(object["stalledSeconds"], "meta must not land unprefixed")
    }

    /// The envelope is hand-built (lines are spliced in as text rather than
    /// re-encoded), so it must still be valid JSON for real device names —
    /// which contain apostrophes and emoji. An invalid body earns a 400, after
    /// which the client retries the same bad batch forever and everything queued
    /// behind it is stuck.
    func testBodyStaysValidJSONForAwkwardDeviceNames() throws {
        let lines = [
            ClientLogWire.encodeLine(ts: "t1", level: "info", subsystem: "crumb",
                                     message: "send", seq: 1, meta: ["count": "42"]),
            ClientLogWire.encodeLine(ts: "t2", level: "debug", subsystem: "heartbeat",
                                     message: "state", seq: 2, meta: nil),
        ]
        for name in [#"Evan's iPhone"#, #"a "quoted" phone"#, "phone 📱", "back\\slash"] {
            let body = ClientLogWire.encodeBody(
                lines: lines, device: name, appVersion: "1.0.0 (36)", os: "iOS 26"
            )
            let parsed = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: body) as? [String: Any],
                "body was not valid JSON for device name \(name)"
            )
            XCTAssertEqual(parsed["device"] as? String, name)
            XCTAssertEqual(parsed["appVersion"] as? String, "1.0.0 (36)")
            let carried = try XCTUnwrap(parsed["lines"] as? [[String: String]])
            XCTAssertEqual(carried.count, 2)
            XCTAssertEqual(carried[0]["m_count"], "42")
            XCTAssertEqual(carried[1]["subsystem"], "heartbeat")
        }
    }

    /// Timestamps must be sortable ISO-8601 UTC with millisecond precision —
    /// the whole point of the tape is ordering events across layers.
    func testTimestampIsSortableISO8601() {
        let stamp = ClientLogWire.timestamp()
        XCTAssertEqual(stamp.count, 24, "expected yyyy-MM-ddTHH:mm:ss.SSSZ — got \(stamp)")
        XCTAssertTrue(stamp.hasSuffix("Z"), "must be UTC-marked: \(stamp)")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertNotNil(formatter.date(from: stamp), "unparseable timestamp: \(stamp)")
        // Lexical order must equal chronological order.
        let later = ClientLogWire.timestamp()
        XCTAssertLessThanOrEqual(stamp, later)
    }

    // MARK: - Crumb sink

    /// Every FreezeContext crumb must reach the sink. This is what lets the tape
    /// carry pushes from hot paths (send, append-draft, focus/blur, turn-end)
    /// with no per-call-site log statement — and the ring only holds 8, so a
    /// missed fan-out means those events exist nowhere in a field log.
    func testEveryCrumbReachesTheSink() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }

        context.note("send", 42)
        context.note("append-draft", 7)
        context.note("turn-end")

        XCTAssertEqual(recorded.names, ["send", "append-draft", "turn-end"])
        XCTAssertEqual(recorded.counts, [42, 7, nil])
    }

    /// Screen changes fan out too — the snapshot keeps only the current screen
    /// plus one level of history, so the LOG is the only place the full
    /// navigation path survives.
    func testScreenTransitionsFanOutWithBothDirections() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }

        context.setScreen("chat")
        context.setScreen("session:abc12345")
        context.clearScreen("session:abc12345")

        XCTAssertEqual(recorded.names, [
            "screen:chat",
            "screen:session:abc12345",
            "screen-left:session:abc12345>chat",
        ])
    }

    /// Re-setting the same screen must not emit — SwiftUI runs onAppear on
    /// every re-render, and a line per render would drown the tape.
    func testRepeatedSameScreenDoesNotEmit() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }

        context.setScreen("tasks")
        context.setScreen("tasks")
        context.setScreen("tasks")

        XCTAssertEqual(recorded.names, ["screen:tasks"])
    }

    /// Keyboard crumbs carry the 10s FLIP COUNT, which is the oscillation
    /// signal. Carrying it on every line shows the ramp in the log rather than
    /// only in the eventual freeze report.
    func testKeyboardCrumbsCarryTheFlipCount() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }

        let base = FreezeContext.uptimeNow()
        context.noteKeyboard(visible: true, at: base)
        context.noteKeyboard(visible: false, at: base + 0.1)
        context.noteKeyboard(visible: true, at: base + 0.2)

        XCTAssertEqual(recorded.names, ["kb-show", "kb-hide", "kb-show"])
        XCTAssertEqual(recorded.counts, [1, 2, 3], "flip count must accumulate within the window")
    }

    /// resetForTesting must also drop the sink, or a later test keeps writing
    /// into the real upload pipeline.
    func testResetDropsTheSink() {
        let context = FreezeContext.shared
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }
        context.resetForTesting()
        context.note("after-reset")
        XCTAssertTrue(recorded.names.isEmpty)
    }

    /// The sink runs OUTSIDE FreezeContext's lock (a sink that took AppLog's
    /// lock while holding this one would be a deadlock waiting to happen), so a
    /// sink that re-enters must not hang.
    func testSinkMayReenterTheContext() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in
            // Reading the snapshot takes the same lock note() just released; a
            // sink invoked from INSIDE the lock would deadlock right here.
            _ = context.snapshotMeta()
            recorded.append(name, count)
            // One level of re-entry, guarded by name so this can't recurse.
            if name == "outer" { context.note("inner") }
        }
        // No expectation/timeout: note() is synchronous, so a deadlock here
        // hangs the case (which the test runner reports) rather than passing.
        context.note("outer")
        XCTAssertEqual(recorded.names, ["outer", "inner"])
    }

    /// Thread-safe: crumbs are pushed from the main thread and from stores on
    /// background tasks, while the sink writes into AppLog's own lock.
    func testConcurrentCrumbsAreAllDelivered() {
        let context = FreezeContext.shared
        context.resetForTesting()
        let recorded = Recorder()
        context.setCrumbSink { name, count in recorded.append(name, count) }

        let group = DispatchGroup()
        for worker in 0..<4 {
            DispatchQueue.global().async(group: group) {
                for index in 0..<50 { context.note("w\(worker)", index) }
            }
        }
        group.wait()
        XCTAssertEqual(recorded.names.count, 200)
    }
}

/// Lock-guarded capture helper — the sink is invoked from several queues.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(String, Int?)] = []

    func append(_ name: String, _ count: Int?) {
        lock.lock(); entries.append((name, count)); lock.unlock()
    }

    var names: [String] {
        lock.lock(); defer { lock.unlock() }
        return entries.map(\.0)
    }

    var counts: [Int?] {
        lock.lock(); defer { lock.unlock() }
        return entries.map(\.1)
    }
}
