import XCTest
@testable import Walnut

/// Invariants of the durable log queue — the retention tier of the flight
/// recorder. These are the properties that decide whether a field incident is
/// reconstructable at all, so each test names the failure it prevents.
final class LogSpillTests: XCTestCase {

    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("logspill-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    private func makeSpill(maxUnreadBytes: UInt64 = 16 * 1024 * 1024) -> LogSpill {
        LogSpill(directory: directory, name: "test", maxUnreadBytes: maxUnreadBytes)
    }

    private func line(_ index: Int, padding: Int = 0) -> String {
        let pad = String(repeating: "x", count: padding)
        return #"{"seq":"\#(index)","message":"line-\#(index)\#(pad)"}"#
    }

    // MARK: - FIFO ordering

    func testDrainsInAppendOrder() {
        let spill = makeSpill()
        spill.append((0..<10).map { line($0) })

        let (lines, consumed) = spill.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(lines.count, 10)
        XCTAssertTrue(lines[0].contains("line-0"))
        XCTAssertTrue(lines[9].contains("line-9"))
        spill.commit(consumedBytes: consumed)
        XCTAssertTrue(spill.isEmpty)
    }

    func testPartialDrainResumesWhereItLeftOff() {
        let spill = makeSpill()
        spill.append((0..<10).map { line($0) })

        let first = spill.peek(maxLines: 4, maxBytes: 1 << 20)
        XCTAssertEqual(first.lines.count, 4)
        spill.commit(consumedBytes: first.consumedBytes)

        let second = spill.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(second.lines.count, 6)
        XCTAssertTrue(second.lines[0].contains("line-4"), "resumed from the wrong offset")
    }

    /// The whole point of the disk tier: a batch that was NOT acknowledged must
    /// still be there. (The old in-memory buffer dropped by count, which threw
    /// away never-sent lines whenever the buffer changed shape mid-flight.)
    func testUncommittedBatchSurvivesAndReplays() {
        let spill = makeSpill()
        spill.append((0..<5).map { line($0) })

        let attempt = spill.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(attempt.lines.count, 5)
        // Upload "failed" — no commit.
        let retry = spill.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(retry.lines, attempt.lines)
    }

    // MARK: - Durability across relaunch

    func testSurvivesReopenWithCursorIntact() {
        let first = makeSpill()
        first.append((0..<10).map { line($0) })
        let batch = first.peek(maxLines: 5, maxBytes: 1 << 20)
        first.commit(consumedBytes: batch.consumedBytes)

        // A fresh instance = the next process launch.
        let second = makeSpill()
        let remaining = second.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(remaining.lines.count, 5, "relaunch lost or re-sent lines")
        XCTAssertTrue(remaining.lines[0].contains("line-5"))
    }

    // MARK: - Byte cap + drop accounting

    /// Eviction must be oldest-first AND counted. An unexplained gap in a
    /// forensic log is worse than a labelled one — AppLog turns this counter
    /// into a "dropped lines" marker so the server sees where the hole is.
    func testEvictsOldestAndCountsDrops() {
        let spill = makeSpill(maxUnreadBytes: 8 * 1024)
        // Each line ~1KB; 40 of them blows past the 8KB cap several times over.
        for index in 0..<40 {
            spill.append([line(index, padding: 1000)])
        }
        XCTAssertGreaterThan(spill.takeDroppedCount(), 0, "cap never evicted anything")
        XCTAssertLessThanOrEqual(spill.unreadBytes, 8 * 1024 + 2048, "cap not enforced")

        let (lines, _) = spill.peek(maxLines: 1000, maxBytes: 1 << 20)
        XCTAssertFalse(lines.isEmpty)
        // The NEWEST line must survive — dropping the tail instead of the head
        // would discard exactly the moments around the incident.
        XCTAssertTrue(lines.last!.contains("line-39"), "evicted the newest line")
        XCTAssertFalse(lines.contains { $0.contains("\"line-0") }, "kept the oldest line")
    }

    func testDroppedCounterResetsOnRead() {
        let spill = makeSpill(maxUnreadBytes: 4 * 1024)
        for index in 0..<20 { spill.append([line(index, padding: 1000)]) }
        XCTAssertGreaterThan(spill.takeDroppedCount(), 0)
        XCTAssertEqual(spill.takeDroppedCount(), 0, "counter must be read-and-clear")
    }

    // MARK: - Batch bounds

    func testRespectsByteBudget() {
        let spill = makeSpill()
        for index in 0..<50 { spill.append([line(index, padding: 1000)]) }
        let (lines, consumed) = spill.peek(maxLines: 1000, maxBytes: 4096)
        XCTAssertGreaterThan(lines.count, 0)
        XCTAssertLessThan(lines.count, 50, "byte budget ignored")
        XCTAssertLessThanOrEqual(consumed, 4096 + 1100, "overshot by more than one line")
    }

    /// A corrupt line must consume its bytes rather than wedge the queue: a
    /// permanently un-drainable head would silently stop ALL uploads.
    func testSkipsCorruptLinesWithoutWedging() {
        let spill = makeSpill()
        spill.append(["not json at all", line(1), "", line(2)])
        let (lines, consumed) = spill.peek(maxLines: 100, maxBytes: 1 << 20)
        XCTAssertEqual(lines.count, 2, "garbage lines should be skipped, not returned")
        spill.commit(consumedBytes: consumed)
        XCTAssertTrue(spill.isEmpty, "corrupt lines wedged the queue")
    }

    // MARK: - Large backlog

    /// A day offline is the case the ring buffer failed at. Draining must be
    /// linear in size (the cursor + amortized compaction), not quadratic.
    func testDrainsALargeBacklogInBoundedBatches() {
        let spill = makeSpill()
        for chunk in 0..<20 {
            spill.append((0..<500).map { line(chunk * 500 + $0) })
        }
        var drained = 0
        var rounds = 0
        while !spill.isEmpty, rounds < 200 {
            let (lines, consumed) = spill.peek(maxLines: 1000, maxBytes: 512 * 1024)
            guard !lines.isEmpty else { break }
            drained += lines.count
            spill.commit(consumedBytes: consumed)
            rounds += 1
        }
        XCTAssertEqual(drained, 10_000, "backlog not fully drained")
        XCTAssertTrue(spill.isEmpty)
    }

    // MARK: - Legacy import

    /// Builds ≤35 persisted a single JSON array. Those lines are real forensics
    /// and must not be thrown away by the format change.
    func testImportsLegacyArrayThenDeletesIt() throws {
        let legacyURL = directory.appendingPathComponent("legacy.json")
        let legacy: [[String: String]] = [
            ["ts": "2026-08-06T00:00:00Z", "level": "error", "subsystem": "freeze", "message": "old freeze"],
            ["ts": "2026-08-06T00:00:01Z", "level": "info", "subsystem": "sse", "message": "old attach"],
        ]
        try JSONSerialization.data(withJSONObject: legacy).write(to: legacyURL)

        let spill = makeSpill()
        let imported = spill.importLegacyArray(at: legacyURL) { String(data: $0, encoding: .utf8) }
        XCTAssertEqual(imported, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path),
                       "legacy file must be removed so the import runs once")

        let (lines, _) = spill.peek(maxLines: 10, maxBytes: 1 << 20)
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines.contains { $0.contains("old freeze") })
    }

    func testMissingLegacyFileIsANoOp() {
        let spill = makeSpill()
        let imported = spill.importLegacyArray(at: directory.appendingPathComponent("nope.json")) {
            String(data: $0, encoding: .utf8)
        }
        XCTAssertEqual(imported, 0)
        XCTAssertTrue(spill.isEmpty)
    }

    // MARK: - Concurrency

    /// Append is reached from the AppLog flush queue, the uploader, and (on a
    /// freeze) the watchdog queue. A torn write here would corrupt the tape.
    func testConcurrentAppendsDoNotCorruptTheFile() {
        let spill = makeSpill()
        let group = DispatchGroup()
        for worker in 0..<8 {
            DispatchQueue.global().async(group: group) {
                for index in 0..<50 {
                    spill.append([self.line(worker * 100 + index)])
                }
            }
        }
        group.wait()

        var total = 0
        while !spill.isEmpty {
            let (lines, consumed) = spill.peek(maxLines: 1000, maxBytes: 512 * 1024)
            guard !lines.isEmpty else { break }
            total += lines.count
            spill.commit(consumedBytes: consumed)
        }
        XCTAssertEqual(total, 400, "concurrent appends lost or duplicated lines")
    }
}
