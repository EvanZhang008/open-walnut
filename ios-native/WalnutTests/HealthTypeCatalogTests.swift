import HealthKit
import XCTest
@testable import Walnut

/// The Health type table: every readable type, one fixed unit each, nothing a
/// read request may not name.
final class HealthTypeCatalogTests: XCTestCase {
    func testCountsMatchTheSDKLists() {
        // iOS 26 SDK: 120 quantity identifiers (NikeFuel left out) and 69
        // category identifiers (AudioExposureEvent left out).
        let catalogQuantities = HealthTypeCatalog.catalogSpecs.filter {
            if case .quantity = $0.object { return true } else { return false }
        }
        XCTAssertEqual(catalogQuantities.count, 17)
        XCTAssertEqual(HealthTypeCatalog.genericRawQuantities.count, 47)
        XCTAssertEqual(HealthTypeCatalog.genericBucketQuantities.count, 55)
        XCTAssertEqual(catalogQuantities.count + 47 + 55, 119)
        XCTAssertEqual(HealthTypeCatalog.genericCategories.count, 66)
        XCTAssertEqual(HealthTypeCatalog.catalogSpecs.count, 21)
        XCTAssertEqual(HealthTypeCatalog.extraSpecs.count, 3)
        XCTAssertEqual(HealthTypeCatalog.characteristicTypes.count, 6)
        // This OS knows every one of them.
        XCTAssertEqual(HealthTypeCatalog.all.count, 21 + 47 + 55 + 66 + 3)
    }

    func testNamesAreUniqueAndGenericNamesMatchTheServerRule() {
        let names = HealthTypeCatalog.all.map(\.name)
        XCTAssertEqual(Set(names).count, names.count, "duplicate names")
        for spec in HealthTypeCatalog.all where spec.isGeneric {
            XCTAssertTrue(HealthTypeCatalog.isValidGenericName(spec.name), spec.name)
            XCTAssertLessThanOrEqual(spec.name.count, 64, spec.name)
        }
        for name in HealthTypeCatalog.characteristicNames {
            XCTAssertTrue(HealthTypeCatalog.isValidGenericName("x.\(name)"), name)
        }
        XCTAssertFalse(HealthTypeCatalog.isValidGenericName("q.lowercase"))
        XCTAssertFalse(HealthTypeCatalog.isValidGenericName("z.Thing"))
    }

    func testNoCatalogIdentifierIsAlsoSentUnderAGenericName() {
        let identifiers = HealthTypeCatalog.all.map(\.object)
        XCTAssertEqual(Set(identifiers).count, identifiers.count, "one identifier, one name")
        let catalog = Set(HealthTypeCatalog.catalogSpecs.map(\.object))
        for spec in HealthTypeCatalog.genericSpecs {
            XCTAssertFalse(catalog.contains(spec.object), "\(spec.name) is covered by the catalog")
        }
        for name in ["q.HeartRate", "q.RespiratoryRate", "q.StepCount", "c.SleepAnalysis", "c.MindfulSession",
                     "q.OxygenSaturation", "q.VO2Max"] {
            XCTAssertNil(HealthTypeCatalog.spec(named: name), name)
        }
    }

    func testDeprecatedIdentifiersAreLeftOut() {
        XCTAssertNil(HealthTypeCatalog.spec(named: "q.NikeFuel"))
        XCTAssertNil(HealthTypeCatalog.spec(named: "c.AudioExposureEvent"))
    }

    func testEnvironmentalAudioEventsUseTheStringHealthKitKept() {
        // Its identifier string is still the iOS 13 name, so building it from
        // the symbol name would silently drop the type.
        let spec = HealthTypeCatalog.spec(named: "c.EnvironmentalAudioExposureEvent")
        XCTAssertEqual(spec?.sampleType, HKCategoryType(.environmentalAudioExposureEvent))
        XCTAssertEqual(HealthTypeCatalog.spec(named: "c.HeadphoneAudioExposureEvent")?.sampleType,
                       HKCategoryType(.headphoneAudioExposureEvent))
    }

    func testEveryUnitParsesIsCompatibleAndIsSentInItsCanonicalForm() throws {
        for spec in HealthTypeCatalog.all {
            switch spec.object {
            case .quantity:
                let type = try XCTUnwrap(spec.sampleType as? HKQuantityType, spec.name)
                let unit = try XCTUnwrap(spec.hkUnit, spec.name)
                XCTAssertTrue(type.is(compatibleWith: unit), "\(spec.name) in \(spec.unit ?? "")")
                if let wire = spec.wireUnit {
                    // The server pins the first unit string it sees: what is sent
                    // must be exactly what HealthKit prints, forever.
                    XCTAssertEqual(unit.unitString, wire, spec.name)
                }
            case .electrocardiogram:
                XCTAssertEqual(spec.wireUnit, "count/min")
            default:
                XCTAssertNil(spec.unit, spec.name)
            }
        }
    }

    func testCumulativeTypesGoAsBucketsAndTheRestRaw() throws {
        for spec in HealthTypeCatalog.all {
            guard let type = spec.sampleType as? HKQuantityType else {
                XCTAssertEqual(spec.kind, .raw, spec.name)
                continue
            }
            if spec.bucketStat == .average {
                // The two catalog audio metrics: averaged buckets.
                XCTAssertEqual(type.aggregationStyle, .discreteEquivalentContinuousLevel, spec.name)
                continue
            }
            XCTAssertEqual(spec.kind == .buckets, type.aggregationStyle == .cumulative, spec.name)
            XCTAssertEqual(spec.wireAgg, spec.isGeneric && spec.kind == .buckets ? "sum" : nil, spec.name)
        }
    }

    func testPercentsAreSentAsZeroToHundred() {
        for spec in HealthTypeCatalog.all {
            XCTAssertEqual(spec.scale, spec.unit == "%" ? 100 : 1, spec.name)
        }
        XCTAssertEqual(HealthTypeCatalog.spec(named: "spo2")?.scale, 100)
        XCTAssertNil(HealthTypeCatalog.spec(named: "spo2")?.wireUnit, "catalog calls carry no unit")
        XCTAssertEqual(HealthTypeCatalog.spec(named: "q.BodyFatPercentage")?.wireUnit, "%")
    }

    func testHeartAndRespiratoryRateGoRawOnly() {
        XCTAssertEqual(HealthTypeCatalog.spec(named: "heart_rate")?.kind, .raw)
        XCTAssertEqual(HealthTypeCatalog.spec(named: "respiratory_rate")?.kind, .raw)
        XCTAssertEqual(HealthTypeCatalog.spec(named: "steps")?.kind, .buckets)
    }

    func testReadSetHoldsOnlyTypesARequestMayName() {
        let read = HealthTypeCatalog.readTypes()
        XCTAssertEqual(read.count, HealthTypeCatalog.all.count + 6)
        for type in read {
            let allowed = type is HKQuantityType || type is HKCategoryType || type is HKWorkoutType
                || type is HKStateOfMindType || type is HKElectrocardiogramType || type is HKScoredAssessmentType
                || type is HKCharacteristicType
            XCTAssertTrue(allowed, type.identifier)
            let forbidden = type is HKCorrelationType || type is HKClinicalType || type is HKAudiogramSampleType
                || type is HKSeriesType || type is HKPrescriptionType || type is HKDocumentType
            XCTAssertFalse(forbidden, type.identifier)
            if #available(iOS 26.0, *) {
                XCTAssertFalse(type is HKUserAnnotatedMedicationType || type is HKMedicationDoseEventType,
                               type.identifier)
            }
        }
    }

    /// HealthKit validates the types of an authorization request the same way
    /// `requestAuthorization` does, without showing any sheet: a disallowed type
    /// would raise here instead of crashing the app on "Turn On".
    func testHealthKitAcceptsTheWholeReadSet() async throws {
        try XCTSkipUnless(HKHealthStore.isHealthDataAvailable())
        let status = try await HKHealthStore().statusForAuthorizationRequest(
            toShare: [], read: HealthTypeCatalog.readTypes()
        )
        XCTAssertNotEqual(status, .unknown)
    }

    func testReadableNames() {
        XCTAssertEqual(HealthReadableNames.activity(.running), "running")
        XCTAssertEqual(HealthReadableNames.activity(.traditionalStrengthTraining), "traditional strength training")
        XCTAssertEqual(HealthReadableNames.activity(.underwaterDiving), "underwater diving")
        XCTAssertEqual(HealthReadableNames.activity(.swimBikeRun), "swim bike run")
        XCTAssertEqual(HealthReadableNames.activity(.other), "other")
        XCTAssertEqual(HealthReadableNames.activity(HKWorkoutActivityType(rawValue: 999)!), "activity-999")
        XCTAssertEqual(HealthReadableNames.label(.happy), "happy")
        XCTAssertEqual(HealthReadableNames.label(.satisfied), "satisfied")
        XCTAssertEqual(HealthReadableNames.association(.selfCare), "self care")
        XCTAssertEqual(HealthReadableNames.association(.weather), "weather")
        let long = HealthReadableNames.short(Array(repeating: String(repeating: "a", count: 40), count: 12))
        XCTAssertEqual(long?.count, 10)
        XCTAssertEqual(long?.first?.count, 32)
        XCTAssertNil(HealthReadableNames.short([]))
    }
}
