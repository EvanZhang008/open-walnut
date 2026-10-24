import CoreLocation
import HealthKit
import XCTest
@testable import Walnut

/// Recordings → chunk items, with objects built in memory. The columns must match
/// src/core/health/series-catalog.ts exactly, or the Mac drops the chunk.
/// (The per-ear audiogram API the fixtures build with is iOS 18.1.)
@available(iOS 18.1, *)
final class HealthRecordingEncoderTests: XCTestCase {
    private let newYork = TimeZone(identifier: "America/New_York")!
    /// 2026-09-21 03:00:00 UTC = 2026-09-20 23:00 in New York.
    private let instant = Date(timeIntervalSince1970: 1_789_959_600)

    private func audiogram(_ points: [(Double, Double?, Double?)]) throws -> HKAudiogramSample {
        let hz = HKUnit.hertz()
        let db = HKUnit.decibelHearingLevel()
        let sensitivity = try points.map { freq, left, right -> HKAudiogramSensitivityPoint in
            var tests: [HKAudiogramSensitivityTest] = []
            if let left {
                tests.append(try HKAudiogramSensitivityTest(sensitivity: HKQuantity(unit: db, doubleValue: left), type: .air,
                                                            masked: false, side: .left, clampingRange: nil))
            }
            if let right {
                tests.append(try HKAudiogramSensitivityTest(sensitivity: HKQuantity(unit: db, doubleValue: right), type: .air,
                                                            masked: false, side: .right, clampingRange: nil))
            }
            return try HKAudiogramSensitivityPoint(frequency: HKQuantity(unit: hz, doubleValue: freq), tests: tests)
        }
        return HKAudiogramSample(sensitivityPoints: sensitivity, start: instant, end: instant.addingTimeInterval(300),
                                 metadata: [HKMetadataKeyTimeZone: "Europe/Berlin"])
    }

    func testAudiogramPointsAreFrequencyAndBothEars() throws {
        let sample = try audiogram([(500, 10, 15), (1000, 15.04, nil), (4000, nil, 40)])
        let points = HealthRecordingEncoder.audiogramPoints(sample)
        XCTAssertEqual(points, [[500, 10, 15], [1000, 15, nil], [4000, nil, 40]])
        XCTAssertNil(HealthRecordingEncoder.audiogramPoint(frequencyHz: 500, left: nil, right: nil),
                     "a frequency with no ear measured is no point")
        XCTAssertNil(HealthRecordingEncoder.audiogramPoint(frequencyHz: .nan, left: 1, right: 1))

        let items = HealthRecordingEncoder.items(sample, points: points, batchTimeZone: newYork)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].chunk, 0)
        XCTAssertEqual(items[0].chunks, 1)
        XCTAssertEqual(items[0].uuid, sample.uuid.uuidString)
        XCTAssertEqual(items[0].tz, "Europe/Berlin", "the sample's own zone rides along when it differs")
        XCTAssertEqual(items[0].start, "2026-09-21T05:00:00+02:00")
    }

    func testHeartbeatPointsAreWholeMillisecondsAndGapFlags() {
        let points = HealthRecordingEncoder.heartbeatPoints([(0, false), (0.8124, false), (5.2, true), (.infinity, false), (-1, false)])
        XCTAssertEqual(points, [[0, 0], [812, 0], [5200, 1]])
    }

    func testRoutePointsRoundAndDropInvalidReadings() {
        let start = instant
        let good = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 10.123456789, longitude: -30.98765432),
                              altitude: 12.345, horizontalAccuracy: 4.56, verticalAccuracy: 3, course: 90, speed: 2.345,
                              timestamp: start.addingTimeInterval(1.2345))
        let noAltitude = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 10, longitude: -30), altitude: 99,
                                    horizontalAccuracy: -1, verticalAccuracy: -1, course: -1, speed: -1,
                                    timestamp: start.addingTimeInterval(2))
        let points = HealthRecordingEncoder.routePoints([good, noAltitude], start: start)
        XCTAssertEqual(points.count, 2)
        XCTAssertEqual(points[0], [1235, 10.123457, -30.987654, 12.3, 4.6, 2.35])
        XCTAssertEqual(points[1], [2000, 10, -30, nil, nil, nil], "negative accuracy and speed mean invalid")
    }

    func testALongRouteIsCutIntoChunksUnderOneUUID() throws {
        let sample = try audiogram([(500, 1, 1)])
        let points: [[Double?]] = (0..<2500).map { [Double($0 * 1000), 10, -30, nil, nil, nil] }
        let items = HealthRecordingEncoder.items(sample, points: points, batchTimeZone: newYork)
        XCTAssertEqual(items.map(\.chunk), [0, 1, 2])
        XCTAssertEqual(Set(items.map(\.chunks)), [3])
        XCTAssertEqual(items.map(\.points.count), [1000, 1000, 500])
        XCTAssertEqual(Set(items.map(\.uuid)).count, 1)
        XCTAssertEqual(items[2].points.last?.first ?? nil, 2_499_000)

        let empty = HealthRecordingEncoder.items(sample, points: [], batchTimeZone: newYork)
        XCTAssertEqual(empty.count, 1, "an object with no point still tells the Mac it exists")
        XCTAssertEqual(empty[0].points, [])
    }

    func testALongRouteIsThinnedToWhatTheMacTakesAndBeatsAreCut() {
        let route: [[Double?]] = (0..<250_000).map { [Double($0), 10, -30, nil, nil, nil] }
        let thin = HealthRecordingEncoder.capped(route, object: .workoutRoute)
        XCTAssertEqual(thin.count, HealthRecordingEncoder.maxRoutePoints)
        XCTAssertEqual(thin.first?.first ?? nil, 0)
        XCTAssertEqual(thin.last?.first ?? nil, 249_999, "the end of the route stays")
        XCTAssertEqual(thin.count / HealthRecordingEncoder.maxPointsPerChunk, 100, "fits the Mac's 100 chunks")
        let beats: [[Double?]] = (0..<25_000).map { [Double($0), 0] }
        XCTAssertEqual(HealthRecordingEncoder.capped(beats, object: .heartbeatSeries).count, 20_000)
        XCTAssertEqual(HealthRecordingEncoder.capped(Array(route.prefix(10)), object: .workoutRoute).count, 10)
    }

    func testTheWireShapeIsWhatTheMacParses() throws {
        let sample = try audiogram([(1000, 20, nil)])
        let item = HealthRecordingEncoder.items(sample, points: HealthRecordingEncoder.audiogramPoints(sample),
                                                batchTimeZone: TimeZone(identifier: "Europe/Berlin")!)[0]
        let json = String(decoding: try JSONEncoder().encode(item), as: UTF8.self)
        XCTAssertTrue(json.contains("\"points\":[[1000,20,null]]"), json)
        XCTAssertTrue(json.contains("\"chunk\":0"), json)
        XCTAssertFalse(json.contains("\"tz\""), "the batch zone is not repeated")
    }
}
