import Foundation
import HealthKit

/// How one Health type reaches the Mac (`POST /api/v1/health/sync`).
enum HealthUploadKind: String, Sendable {
    /// Individual samples, keyed by their HealthKit UUID.
    case raw
    /// HealthKit statistics buckets (1 day and 1 hour), already merged by Health.
    case buckets
}

/// What a statistics bucket carries.
enum HealthBucketStat: Sendable {
    /// `.cumulativeSum` (steps, energy, dietary intake ...).
    case sum
    /// `.discreteAverage` plus min and max (the two audio exposure metrics).
    case average
}

/// The HealthKit object type behind a catalog entry, by raw identifier, so a
/// table entry is plain data and an identifier this iOS does not know never
/// crashes: `HealthTypeSpec.sampleType` is nil for it and the entry is dropped.
enum HealthObjectKind: Sendable, Hashable {
    case quantity(String)
    case category(String)
    case workout
    case stateOfMind
    case electrocardiogram
    case scoredAssessment(String)
}

/// One readable Health type: the name the server knows it by, how it is sent,
/// and the ONE unit its values are read in. The server pins the first unit it
/// sees per generic type and refuses a different one later, so a type's unit is
/// fixed here forever.
struct HealthTypeSpec: Sendable, Hashable {
    /// Server name: a catalog name (`sleep`, `steps`) or `q.` / `c.` / `x.` generic.
    let name: String
    let object: HealthObjectKind
    let kind: HealthUploadKind
    /// HKUnit string values are read in (quantity types and the ECG heart rate).
    let unit: String?
    /// Multiplier applied after reading (100 for a percent: HealthKit gives a fraction).
    let scale: Double
    /// True for `q.` / `c.` / `x.` names, which need `supported.generic` on the server.
    let isGeneric: Bool
    let bucketStat: HealthBucketStat?
    /// HealthKit background delivery frequency: immediate, else hourly.
    let immediateDelivery: Bool

    /// Batch-level `unit`: required on every `q.` call, and sent on the ECG too.
    /// Catalog calls carry none (the server pins catalog units itself).
    var wireUnit: String? { isGeneric ? unit : nil }

    /// Batch-level `agg`: required on every generic bucket call.
    var wireAgg: String? { isGeneric && kind == .buckets ? "sum" : nil }

    /// The runtime HealthKit type, or nil when this iOS does not have it.
    var sampleType: HKSampleType? {
        switch object {
        case .quantity(let raw):
            return HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: raw))
        case .category(let raw):
            return HKCategoryType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: raw))
        case .workout:
            return HKObjectType.workoutType()
        case .stateOfMind:
            return HKSampleType.stateOfMindType()
        case .electrocardiogram:
            return HKObjectType.electrocardiogramType()
        case .scoredAssessment(let raw):
            return HKScoredAssessmentType(HKScoredAssessmentTypeIdentifier(rawValue: raw))
        }
    }

    /// `unit` as an HKUnit. Every string in the table is pinned by a test that
    /// parses it, so this never meets an invalid one.
    var hkUnit: HKUnit? { unit.map { HKUnit(from: $0) } }
}

/// The readable Health types, in the order a sync visits them.
///
/// Catalog types first (the names the Mac's agent reads directly), then every
/// other quantity and category type HealthKit has, plus the ECG, the two scored
/// assessments and the six characteristics, as generic `q.` / `c.` / `x.` names.
/// The identifier lists come from the iOS 26 SDK's HKTypeIdentifiers.h
/// (120 quantity and 69 category identifiers).
///
/// Left out on purpose:
///  - deprecated identifiers (NikeFuel, AudioExposureEvent);
///  - correlation types (blood pressure and food are read through their own
///    quantity types instead): asking authorization for one raises an
///    Objective-C exception and crashes the app;
///  - clinical records (they need a separate entitlement and a review);
///  - vision prescriptions and medications (per-object authorization, which the
///    plain read request cannot ask for);
///  - audiograms, heartbeat series and workout routes (routes are location data).
enum HealthTypeCatalog {
    /// Catalog types in sync order. heart_rate and respiratory_rate go raw only.
    static let catalogSpecs: [HealthTypeSpec] = [
        cat("sleep", .category("HKCategoryTypeIdentifierSleepAnalysis"), immediate: true),
        qraw("heart_rate", "HeartRate", "count/min"),
        qraw("hrv_sdnn", "HeartRateVariabilitySDNN", "ms"),
        qraw("resting_hr", "RestingHeartRate", "count/min"),
        qraw("respiratory_rate", "RespiratoryRate", "count/min"),
        qraw("spo2", "OxygenSaturation", "%", scale: 100),
        qraw("wrist_temp", "AppleSleepingWristTemperature", "degC"),
        cat("workout", .workout, immediate: true),
        qsum("steps", "StepCount", "count"),
        qsum("distance", "DistanceWalkingRunning", "m"),
        qsum("active_energy", "ActiveEnergyBurned", "kcal"),
        qsum("basal_energy", "BasalEnergyBurned", "kcal"),
        qsum("exercise_min", "AppleExerciseTime", "min"),
        qsum("stand_min", "AppleStandTime", "min"),
        qsum("daylight_min", "TimeInDaylight", "min"),
        HealthTypeSpec(name: "audio_env", object: .quantity(q("EnvironmentalAudioExposure")), kind: .buckets,
                       unit: "dBASPL", scale: 1, isGeneric: false, bucketStat: .average, immediateDelivery: false),
        HealthTypeSpec(name: "audio_headphone", object: .quantity(q("HeadphoneAudioExposure")), kind: .buckets,
                       unit: "dBASPL", scale: 1, isGeneric: false, bucketStat: .average, immediateDelivery: false),
        cat("state_of_mind", .stateOfMind, immediate: true),
        cat("mindful", .category("HKCategoryTypeIdentifierMindfulSession")),
        qraw("walking_hr", "WalkingHeartRateAverage", "count/min"),
        qraw("vo2max", "VO2Max", "ml/(kg*min)"),
    ]

    /// Non-cumulative quantity types the catalog does not cover: raw `q.` samples.
    static let genericRawQuantities: [(String, String)] = [
        ("AppleSleepingBreathingDisturbances", "count"), ("AppleWalkingSteadiness", "%"),
        ("AtrialFibrillationBurden", "%"), ("BasalBodyTemperature", "degC"),
        ("BloodAlcoholContent", "%"), ("BloodGlucose", "mg/dL"),
        ("BloodPressureDiastolic", "mmHg"), ("BloodPressureSystolic", "mmHg"),
        ("BodyFatPercentage", "%"), ("BodyMass", "kg"), ("BodyMassIndex", "count"),
        ("BodyTemperature", "degC"), ("CrossCountrySkiingSpeed", "m/s"),
        ("CyclingCadence", "count/min"), ("CyclingFunctionalThresholdPower", "W"),
        ("CyclingPower", "W"), ("CyclingSpeed", "m/s"), ("ElectrodermalActivity", "mcS"),
        ("EnvironmentalSoundReduction", "dBASPL"), ("EstimatedWorkoutEffortScore", "appleEffortScore"),
        ("ForcedExpiratoryVolume1", "L"), ("ForcedVitalCapacity", "L"),
        ("HeartRateRecoveryOneMinute", "count/min"), ("Height", "m"), ("LeanBodyMass", "kg"),
        ("PaddleSportsSpeed", "m/s"), ("PeakExpiratoryFlowRate", "L/min"),
        ("PeripheralPerfusionIndex", "%"), ("PhysicalEffort", "kcal/hr·kg"),
        ("RowingSpeed", "m/s"), ("RunningGroundContactTime", "ms"), ("RunningPower", "W"),
        ("RunningSpeed", "m/s"), ("RunningStrideLength", "m"), ("RunningVerticalOscillation", "cm"),
        ("SixMinuteWalkTestDistance", "m"), ("StairAscentSpeed", "m/s"), ("StairDescentSpeed", "m/s"),
        ("UnderwaterDepth", "m"), ("UVExposure", "count"), ("WaistCircumference", "m"),
        ("WalkingAsymmetryPercentage", "%"), ("WalkingDoubleSupportPercentage", "%"),
        ("WalkingSpeed", "m/s"), ("WalkingStepLength", "m"), ("WaterTemperature", "degC"),
        ("WorkoutEffortScore", "appleEffortScore"),
    ]

    /// Cumulative quantity types the catalog does not cover: `q.` sum buckets.
    static let genericBucketQuantities: [(String, String)] = [
        ("AppleMoveTime", "min"), ("DistanceCrossCountrySkiing", "m"), ("DistanceCycling", "m"),
        ("DistanceDownhillSnowSports", "m"), ("DistancePaddleSports", "m"), ("DistanceRowing", "m"),
        ("DistanceSkatingSports", "m"), ("DistanceSwimming", "m"), ("DistanceWheelchair", "m"),
        ("FlightsClimbed", "count"), ("PushCount", "count"), ("SwimmingStrokeCount", "count"),
        ("InhalerUsage", "count"), ("InsulinDelivery", "IU"), ("NumberOfAlcoholicBeverages", "count"),
        ("NumberOfTimesFallen", "count"),
        ("DietaryBiotin", "g"), ("DietaryCaffeine", "g"), ("DietaryCalcium", "g"),
        ("DietaryCarbohydrates", "g"), ("DietaryChloride", "g"), ("DietaryCholesterol", "g"),
        ("DietaryChromium", "g"), ("DietaryCopper", "g"), ("DietaryEnergyConsumed", "kcal"),
        ("DietaryFatMonounsaturated", "g"), ("DietaryFatPolyunsaturated", "g"),
        ("DietaryFatSaturated", "g"), ("DietaryFatTotal", "g"), ("DietaryFiber", "g"),
        ("DietaryFolate", "g"), ("DietaryIodine", "g"), ("DietaryIron", "g"), ("DietaryMagnesium", "g"),
        ("DietaryManganese", "g"), ("DietaryMolybdenum", "g"), ("DietaryNiacin", "g"),
        ("DietaryPantothenicAcid", "g"), ("DietaryPhosphorus", "g"), ("DietaryPotassium", "g"),
        ("DietaryProtein", "g"), ("DietaryRiboflavin", "g"), ("DietarySelenium", "g"),
        ("DietarySodium", "g"), ("DietarySugar", "g"), ("DietaryThiamin", "g"),
        ("DietaryVitaminA", "g"), ("DietaryVitaminB12", "g"), ("DietaryVitaminB6", "g"),
        ("DietaryVitaminC", "g"), ("DietaryVitaminD", "g"), ("DietaryVitaminE", "g"),
        ("DietaryVitaminK", "g"), ("DietaryWater", "mL"), ("DietaryZinc", "g"),
    ]

    /// Category types the catalog does not cover: raw `c.` samples, code = value.
    static let genericCategories: [String] = [
        "AbdominalCramps", "Acne", "AppetiteChanges", "AppleStandHour", "AppleWalkingSteadinessEvent",
        "BladderIncontinence", "BleedingAfterPregnancy", "BleedingDuringPregnancy", "Bloating",
        "BreastPain", "CervicalMucusQuality", "ChestTightnessOrPain", "Chills", "Constipation",
        "Contraceptive", "Coughing", "Diarrhea", "Dizziness", "DrySkin",
        "EnvironmentalAudioExposureEvent", "Fainting", "Fatigue", "Fever", "GeneralizedBodyAche",
        "HairLoss", "HandwashingEvent", "Headache", "HeadphoneAudioExposureEvent", "Heartburn",
        "HighHeartRateEvent", "HotFlashes", "InfrequentMenstrualCycles", "IntermenstrualBleeding",
        "IrregularHeartRhythmEvent", "IrregularMenstrualCycles", "Lactation", "LossOfSmell",
        "LossOfTaste", "LowCardioFitnessEvent", "LowerBackPain", "LowHeartRateEvent", "MemoryLapse",
        "MenstrualFlow", "MoodChanges", "Nausea", "NightSweats", "OvulationTestResult", "PelvicPain",
        "PersistentIntermenstrualBleeding", "Pregnancy", "PregnancyTestResult",
        "ProgesteroneTestResult", "ProlongedMenstrualPeriods", "RapidPoundingOrFlutteringHeartbeat",
        "RunnyNose", "SexualActivity", "ShortnessOfBreath", "SinusCongestion", "SkippedHeartbeat",
        "SleepApneaEvent", "SleepChanges", "SoreThroat", "ToothbrushingEvent", "VaginalDryness",
        "Vomiting", "Wheezing",
    ]

    /// The `x.` sample types (the characteristics are separate, see below).
    static let extraSpecs: [HealthTypeSpec] = [
        HealthTypeSpec(name: "x.Electrocardiogram", object: .electrocardiogram, kind: .raw, unit: "count/min",
                       scale: 1, isGeneric: true, bucketStat: nil, immediateDelivery: false),
        HealthTypeSpec(name: "x.GAD7", object: .scoredAssessment("HKScoredAssessmentTypeIdentifierGAD7"),
                       kind: .raw, unit: nil, scale: 1, isGeneric: true, bucketStat: nil, immediateDelivery: false),
        HealthTypeSpec(name: "x.PHQ9", object: .scoredAssessment("HKScoredAssessmentTypeIdentifierPHQ9"),
                       kind: .raw, unit: nil, scale: 1, isGeneric: true, bucketStat: nil, immediateDelivery: false),
    ]

    /// The six characteristics, `x.<Name>`, read once per run.
    static let characteristicNames = [
        "BiologicalSex", "BloodType", "DateOfBirth", "FitzpatrickSkinType", "WheelchairUse", "ActivityMoveMode",
    ]

    static let characteristicIdentifiers: [String: HKCharacteristicTypeIdentifier] = [
        "BiologicalSex": .biologicalSex, "BloodType": .bloodType, "DateOfBirth": .dateOfBirth,
        "FitzpatrickSkinType": .fitzpatrickSkinType, "WheelchairUse": .wheelchairUse,
        "ActivityMoveMode": .activityMoveMode,
    ]

    /// Generic specs in sync order: raw quantities, bucket quantities, categories, x.
    static let genericSpecs: [HealthTypeSpec] = {
        let raw = genericRawQuantities.map { suffix, unit in
            HealthTypeSpec(name: "q.\(suffix)", object: .quantity(q(suffix)), kind: .raw, unit: unit,
                           scale: unit == "%" ? 100 : 1, isGeneric: true, bucketStat: nil, immediateDelivery: false)
        }
        let buckets = genericBucketQuantities.map { suffix, unit in
            HealthTypeSpec(name: "q.\(suffix)", object: .quantity(q(suffix)), kind: .buckets, unit: unit,
                           scale: 1, isGeneric: true, bucketStat: .sum, immediateDelivery: false)
        }
        let categories = genericCategories.map { suffix in
            HealthTypeSpec(name: "c.\(suffix)", object: .category(categoryIdentifier(suffix)), kind: .raw,
                           unit: nil, scale: 1, isGeneric: true, bucketStat: nil, immediateDelivery: false)
        }
        return raw + buckets + categories + extraSpecs
    }()

    /// Every entry this iOS can read, in sync order. Built once: an identifier
    /// a newer SDK names but this OS lacks returns nil and is dropped here.
    static let all: [HealthTypeSpec] = (catalogSpecs + genericSpecs).filter { $0.sampleType != nil }

    static func spec(named name: String) -> HealthTypeSpec? {
        all.first { $0.name == name }
    }

    /// The characteristic types this iOS has.
    static var characteristicTypes: [HKCharacteristicType] {
        characteristicNames.compactMap { characteristicIdentifiers[$0] }.compactMap {
            HKCharacteristicType.characteristicType(forIdentifier: $0)
        }
    }

    /// Everything Walnut asks to READ. Only quantity, category, workout, state of
    /// mind, ECG, scored assessment and characteristic types are ever in here: a
    /// correlation, clinical or per-object type would raise an exception inside
    /// `requestAuthorization` (pinned by HealthTypeCatalogTests).
    static func readTypes(for specs: [HealthTypeSpec] = all, characteristics: Bool = true) -> Set<HKObjectType> {
        var types = Set<HKObjectType>(specs.compactMap(\.sampleType))
        if characteristics { types.formUnion(characteristicTypes) }
        return types
    }

    /// The generic-name regex the server checks (`^[qcx]\.[A-Z][A-Za-z0-9]{1,62}$`).
    static func isValidGenericName(_ name: String) -> Bool {
        name.range(of: #"^[qcx]\.[A-Z][A-Za-z0-9]{1,62}$"#, options: .regularExpression) != nil
    }

    // MARK: - Table helpers

    private static func q(_ suffix: String) -> String { "HKQuantityTypeIdentifier\(suffix)" }

    /// A category identifier's string. Every one is its symbol's name, except
    /// EnvironmentalAudioExposureEvent, which kept the string of the iOS 13 name
    /// it replaced (checked against the SDK symbols with dlsym).
    static func categoryIdentifier(_ suffix: String) -> String {
        suffix == "EnvironmentalAudioExposureEvent"
            ? "HKCategoryTypeIdentifierAudioExposureEvent" : "HKCategoryTypeIdentifier\(suffix)"
    }

    private static func qraw(_ name: String, _ suffix: String, _ unit: String, scale: Double = 1) -> HealthTypeSpec {
        HealthTypeSpec(name: name, object: .quantity(q(suffix)), kind: .raw, unit: unit, scale: scale,
                       isGeneric: false, bucketStat: nil, immediateDelivery: false)
    }

    private static func qsum(_ name: String, _ suffix: String, _ unit: String) -> HealthTypeSpec {
        HealthTypeSpec(name: name, object: .quantity(q(suffix)), kind: .buckets, unit: unit, scale: 1,
                       isGeneric: false, bucketStat: .sum, immediateDelivery: false)
    }

    private static func cat(_ name: String, _ object: HealthObjectKind, immediate: Bool = false) -> HealthTypeSpec {
        HealthTypeSpec(name: name, object: object, kind: .raw, unit: nil, scale: 1,
                       isGeneric: false, bucketStat: nil, immediateDelivery: immediate)
    }
}
