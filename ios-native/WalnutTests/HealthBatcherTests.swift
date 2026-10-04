import XCTest
@testable import Walnut

/// Splitting one type's items into calls the Mac accepts: at most 500 items and
/// 180 KB each (the server's caps are 500 and 192 KB).
final class HealthBatcherTests: XCTestCase {
    private let header = try! JSONEncoder().encode(HealthSyncHeader(
        spec: .testRaw("sleep"), storeId: "hs-1",
        device: .init(installId: "abc", model: "iPhone17,1", os: "iOS 26.0"), tz: "America/New_York"
    ))

    private func items(_ count: Int, padding: Int = 0) -> [Data] {
        (0..<count).map { i in
            HealthBatcher.encode([HealthWireSample(
                uuid: "U\(i)", start: "2026-09-20T23:00:00-04:00", end: "2026-09-20T23:05:00-04:00", code: 3,
                source: HealthWireSource(bundleId: "com.apple.health.test", name: String(repeating: "w", count: padding))
            )])[0]
        }
    }

    private func decode(_ batch: HealthBatch) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
    }

    func testCapsAtFiveHundredItems() throws {
        let batches = HealthBatcher.batches(header: header, itemsKey: "samples", items: items(1200), deleted: [])
        XCTAssertEqual(batches.map(\.count), [500, 500, 200])
        for batch in batches {
            let body = try decode(batch)
            XCTAssertEqual((body["samples"] as? [Any])?.count, batch.items.count)
            XCTAssertEqual(body["type"] as? String, "sleep")
            XCTAssertEqual(body["storeId"] as? String, "hs-1")
            XCTAssertNil(body["deleted"], "no empty deleted array")
        }
    }

    func testCapsTheSerializedSizeAndMeasuresItExactly() throws {
        // ~1 KB items: the byte cap binds long before the item cap.
        let big = items(600, padding: 900)
        let batches = HealthBatcher.batches(header: header, itemsKey: "samples", items: big, deleted: [])
        XCTAssertGreaterThan(batches.count, 3)
        for batch in batches {
            XCTAssertEqual(batch.body.count, batch.byteCount, "the size is known before the body is built")
            XCTAssertLessThanOrEqual(batch.body.count, HealthBatcher.maxBytes)
            XCTAssertLessThan(batch.body.count, 192 * 1024)
            XCTAssertLessThanOrEqual(batch.count, HealthBatcher.maxItems)
        }
        XCTAssertEqual(batches.reduce(0) { $0 + $1.count }, 600, "nothing lost")
    }

    func testDeletionsCountTowardTheCapAndGoFirst() throws {
        let deleted = (0..<300).map { "D\($0)" }
        let batches = HealthBatcher.batches(header: header, itemsKey: "samples", items: items(300), deleted: deleted)
        XCTAssertEqual(batches.map(\.count), [500, 100])
        let first = try decode(batches[0])
        XCTAssertEqual((first["deleted"] as? [String])?.count, 300)
        XCTAssertEqual((first["samples"] as? [Any])?.count, 200)
        XCTAssertEqual((first["deleted"] as? [String])?.first, "D0")
        let second = try decode(batches[1])
        XCTAssertNil(second["deleted"])
        XCTAssertEqual((second["samples"] as? [Any])?.count, 100)
    }

    func testNeverBuildsAnEmptyCall() {
        XCTAssertTrue(HealthBatcher.batches(header: header, itemsKey: "samples", items: [], deleted: []).isEmpty)
        let onlyDeleted = HealthBatcher.batches(header: header, itemsKey: "samples", items: [], deleted: ["D1"])
        XCTAssertEqual(onlyDeleted.count, 1)
        XCTAssertEqual(onlyDeleted.first?.deleted.count, 1)
    }

    func testAnItemOverTheCapStillGoesOutAlone() {
        let huge = items(1, padding: 200_000) + items(2)
        let batches = HealthBatcher.batches(header: header, itemsKey: "samples", items: huge, deleted: [])
        XCTAssertEqual(batches.map(\.count), [1, 2])
    }

    func testHalvesKeepEveryElementAndDeletionsFirst() throws {
        let batch = HealthBatcher.batches(header: header, itemsKey: "samples", items: items(5), deleted: ["D1", "D2", "D3"])[0]
        let (a, b) = try XCTUnwrap(batch.halves())
        XCTAssertEqual(a.count + b.count, 8)
        XCTAssertEqual(a.deleted.count, 3, "deletions stay in front")
        XCTAssertEqual(a.items.count + b.items.count, 5)
        XCTAssertNil(HealthBatcher.batches(header: header, itemsKey: "samples", items: items(1), deleted: [])[0].halves())
    }

    func testBucketBodiesCarryUnitAndAggForGenericOnly() throws {
        let generic = try JSONEncoder().encode(HealthSyncHeader(
            spec: .testBuckets("q.FlightsClimbed", generic: true), storeId: nil, device: nil, tz: "UTC"
        ))
        let bucket = HealthBatcher.encode([HealthWireBucket(start: "2026-09-20T00:00:00+00:00", intervalSec: 86_400, sum: 12)])
        let body = try decode(HealthBatcher.batches(header: generic, itemsKey: "buckets", items: bucket, deleted: [])[0])
        XCTAssertEqual(body["kind"] as? String, "buckets")
        XCTAssertEqual(body["metric"] as? String, "q.FlightsClimbed")
        XCTAssertNil(body["type"])
        XCTAssertEqual(body["unit"] as? String, "count")
        XCTAssertEqual(body["agg"] as? String, "sum")
        XCTAssertEqual((body["buckets"] as? [[String: Any]])?.first?["sum"] as? Double, 12)

        let catalog = try JSONEncoder().encode(HealthSyncHeader(spec: .testBuckets("steps"), storeId: nil, device: nil, tz: "UTC"))
        let plain = try decode(HealthBatcher.batches(header: catalog, itemsKey: "buckets", items: bucket, deleted: [])[0])
        XCTAssertNil(plain["unit"], "catalog calls carry no unit")
        XCTAssertNil(plain["agg"])
    }
}
