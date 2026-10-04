import HealthKit
import XCTest
@testable import Walnut

/// HKSample → wire item, with samples built in memory (no store, no query).
final class HealthSampleEncoderTests: XCTestCase {
    private let newYork = TimeZone(identifier: "America/New_York")!
    private let bpm = HKUnit.count().unitDivided(by: .minute())
    /// 2026-09-21 03:00:00 UTC = 2026-09-20 23:00 in New York (EDT, -04:00).
    private let instant = Date(timeIntervalSince1970: 1_789_959_600)

    private func spec(_ name: String) throws -> HealthTypeSpec {
        try XCTUnwrap(HealthTypeCatalog.spec(named: name), name)
    }

    func testWireTimeIsISOWithTheZonesOwnOffset() {
        XCTAssertEqual(HealthWireTime.iso(instant, in: newYork), "2026-09-20T23:00:00-04:00")
        XCTAssertEqual(HealthWireTime.iso(instant, in: TimeZone(identifier: "UTC")!), "2026-09-21T03:00:00+00:00")
        XCTAssertEqual(HealthWireTime.iso(instant, in: TimeZone(identifier: "Asia/Kolkata")!), "2026-09-21T08:30:00+05:30")
        XCTAssertEqual(HealthWireTime.iso(instant.addingTimeInterval(0.25), in: newYork), "2026-09-20T23:00:00.250-04:00")
        // Winter in New York is -05:00; a leap day comes out right.
        let leap = Date(timeIntervalSince1970: 1_709_208_000) // 2024-02-29 12:00 UTC
        XCTAssertEqual(HealthWireTime.iso(leap, in: newYork), "2024-02-29T07:00:00-05:00")
        // What the server parses must be the same instant.
        let parsed = ISO8601DateFormatter().date(from: HealthWireTime.iso(instant, in: newYork))
        XCTAssertEqual(parsed, instant)
    }

    func testCatalogQuantityInItsUnitWithoutARepeatedZone() throws {
        let watch = HKDevice(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch", hardwareVersion: nil,
                             firmwareVersion: nil, softwareVersion: nil, localIdentifier: nil, udiDeviceIdentifier: nil)
        let sample = HKQuantitySample(
            type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: bpm, doubleValue: 61),
            start: instant, end: instant.addingTimeInterval(60), device: watch,
            metadata: [HKMetadataKeyTimeZone: "America/New_York"]
        )
        let item = try XCTUnwrap(HealthSampleEncoder.encode(sample, spec: try spec("heart_rate"), batchTimeZone: newYork))
        XCTAssertEqual(item.uuid, sample.uuid.uuidString)
        XCTAssertEqual(item.value, 61)
        XCTAssertNil(item.code)
        XCTAssertEqual(item.start, "2026-09-20T23:00:00-04:00")
        XCTAssertEqual(item.end, "2026-09-20T23:01:00-04:00")
        XCTAssertNil(item.tz, "the batch zone is not repeated per sample")
        XCTAssertEqual(item.device, "Watch")
        XCTAssertNotNil(item.source)
        XCTAssertNil(item.meta)
    }

    func testOwnZoneIsKeptWhenItDiffersFromTheBatch() throws {
        let sample = HKQuantitySample(
            type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: bpm, doubleValue: 70),
            start: instant, end: instant, metadata: [HKMetadataKeyTimeZone: "Asia/Tokyo"]
        )
        let item = try XCTUnwrap(HealthSampleEncoder.encode(sample, spec: try spec("heart_rate"), batchTimeZone: newYork))
        XCTAssertEqual(item.tz, "Asia/Tokyo")
        XCTAssertEqual(item.start, "2026-09-21T12:00:00+09:00")
    }

    func testNoZoneMetadataMeansThePhonesZone() throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: bpm, doubleValue: 70),
                                      start: instant, end: instant)
        let item = try XCTUnwrap(HealthSampleEncoder.encode(sample, spec: try spec("heart_rate"), batchTimeZone: newYork))
        XCTAssertNil(item.tz)
        XCTAssertTrue(item.start.hasSuffix("-04:00"))
    }

    func testSpo2AndGenericPercentsAreTimesHundred() throws {
        let spo2 = HKQuantitySample(type: HKQuantityType(.oxygenSaturation),
                                    quantity: HKQuantity(unit: .percent(), doubleValue: 0.97), start: instant, end: instant)
        let item = try XCTUnwrap(HealthSampleEncoder.encode(spo2, spec: try spec("spo2"), batchTimeZone: newYork))
        XCTAssertEqual(try XCTUnwrap(item.value), 97, accuracy: 1e-9)

        let fat = HKQuantitySample(type: HKQuantityType(.bodyFatPercentage),
                                   quantity: HKQuantity(unit: .percent(), doubleValue: 0.215), start: instant, end: instant)
        let generic = try XCTUnwrap(HealthSampleEncoder.encode(fat, spec: try spec("q.BodyFatPercentage"), batchTimeZone: newYork))
        XCTAssertEqual(try XCTUnwrap(generic.value), 21.5, accuracy: 1e-9)
    }

    func testGenericQuantityIsReadInTheFixedUnit() throws {
        // Written in grams, sent in the table's kg.
        let mass = HKQuantitySample(type: HKQuantityType(.bodyMass),
                                    quantity: HKQuantity(unit: .gram(), doubleValue: 72_400), start: instant, end: instant)
        let item = try XCTUnwrap(HealthSampleEncoder.encode(mass, spec: try spec("q.BodyMass"), batchTimeZone: newYork))
        XCTAssertEqual(try XCTUnwrap(item.value), 72.4, accuracy: 1e-9)
        // Fahrenheit in, Celsius out.
        let temp = HKQuantitySample(type: HKQuantityType(.bodyTemperature),
                                    quantity: HKQuantity(unit: .degreeFahrenheit(), doubleValue: 98.6), start: instant, end: instant)
        let celsius = try XCTUnwrap(HealthSampleEncoder.encode(temp, spec: try spec("q.BodyTemperature"), batchTimeZone: newYork))
        XCTAssertEqual(try XCTUnwrap(celsius.value), 37, accuracy: 1e-6)
    }

    func testUserEnteredMirrorsTheMetadataKey() throws {
        let entered = HKQuantitySample(
            type: HKQuantityType(.bodyMass), quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 70),
            start: instant, end: instant, metadata: [HKMetadataKeyWasUserEntered: true]
        )
        let item = try XCTUnwrap(HealthSampleEncoder.encode(entered, spec: try spec("q.BodyMass"), batchTimeZone: newYork))
        XCTAssertEqual(item.meta?.userEntered, true)
        let notEntered = HKQuantitySample(
            type: HKQuantityType(.bodyMass), quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 70),
            start: instant, end: instant, metadata: [HKMetadataKeyWasUserEntered: false]
        )
        XCTAssertNil(HealthSampleEncoder.encode(notEntered, spec: try spec("q.BodyMass"), batchTimeZone: newYork)?.meta)
    }

    func testCategoriesSendTheirCodeAndMindfulItsMinutes() throws {
        let deep = HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                                    start: instant, end: instant.addingTimeInterval(1800))
        let sleep = try XCTUnwrap(HealthSampleEncoder.encode(deep, spec: try spec("sleep"), batchTimeZone: newYork))
        XCTAssertEqual(sleep.code, 4)
        XCTAssertNil(sleep.value)

        let headache = HKCategorySample(type: HKCategoryType(.headache), value: HKCategoryValueSeverity.moderate.rawValue,
                                        start: instant, end: instant.addingTimeInterval(3600))
        let symptom = try XCTUnwrap(HealthSampleEncoder.encode(headache, spec: try spec("c.Headache"), batchTimeZone: newYork))
        XCTAssertEqual(symptom.code, HKCategoryValueSeverity.moderate.rawValue)

        let session = HKCategorySample(type: HKCategoryType(.mindfulSession), value: HKCategoryValue.notApplicable.rawValue,
                                       start: instant, end: instant.addingTimeInterval(600))
        let mindful = try XCTUnwrap(HealthSampleEncoder.encode(session, spec: try spec("mindful"), batchTimeZone: newYork))
        XCTAssertEqual(mindful.value, 10)
        XCTAssertNil(mindful.code)
    }

    func testStateOfMindSendsValenceKindAndReadableNames() throws {
        let mood = HKStateOfMind(date: instant, kind: .dailyMood, valence: 0.4, labels: [.happy, .calm],
                                 associations: [.work, .selfCare])
        let item = try XCTUnwrap(HealthSampleEncoder.encode(mood, spec: try spec("state_of_mind"), batchTimeZone: newYork))
        XCTAssertEqual(item.value, 0.4)
        XCTAssertEqual(item.meta?.kind, "daily")
        XCTAssertEqual(item.meta?.labels, ["happy", "calm"])
        XCTAssertEqual(item.meta?.associations, ["work", "self care"])
    }

    @available(iOS, deprecated: 17.0)
    func testWorkoutSendsMinutesAndActivity() throws {
        let run = HKWorkout(activityType: .running, start: instant, end: instant.addingTimeInterval(1800))
        let item = try XCTUnwrap(HealthSampleEncoder.encode(run, spec: try spec("workout"), batchTimeZone: newYork))
        XCTAssertEqual(try XCTUnwrap(item.value), 30, accuracy: 1e-9)
        XCTAssertEqual(item.meta?.activity, "running")
    }

    func testAMismatchedTypeIsDroppedNotGuessed() throws {
        // A quantity sample handed to a category entry cannot be encoded.
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: bpm, doubleValue: 70),
                                      start: instant, end: instant)
        XCTAssertNil(HealthSampleEncoder.encode(sample, spec: try spec("q.BodyMass"), batchTimeZone: newYork))
    }

    func testOmittedFieldsDoNotReachTheWire() throws {
        let item = HealthWireSample(uuid: "U1", start: "2026-09-20T23:00:00-04:00", end: "2026-09-20T23:00:00-04:00", code: 3)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(item), encoding: .utf8))
        XCTAssertFalse(json.contains("value"))
        XCTAssertFalse(json.contains("tz"))
        XCTAssertFalse(json.contains("meta"))
        XCTAssertTrue(json.contains("\"code\":3"))
    }
}
