import Foundation
import HealthKit

/// HKSample → one wire item for its catalog entry. Pure: no store, no query, so
/// it is unit-tested with samples built in memory.
///
/// Rules (each pinned by HealthSampleEncoderTests):
///  - instants are ISO-8601 in the sample's own zone (HKMetadataKeyTimeZone,
///    else the phone's), and `tz` is omitted when it equals the batch zone;
///  - a quantity is read in the entry's ONE unit and scaled (a percent arrives
///    from HealthKit as a fraction and leaves as 0 to 100);
///  - a category sample's code is its HealthKit value, except `mindful`, whose
///    value is the session length in minutes;
///  - `meta.userEntered` mirrors HKMetadataKeyWasUserEntered;
///  - a value that is not finite drops the sample (the server would reject it).
enum HealthSampleEncoder {
    static func encode(_ sample: HKSample, spec: HealthTypeSpec, batchTimeZone: TimeZone) -> HealthWireSample? {
        let zone = sampleTimeZone(sample, fallback: batchTimeZone)
        var item = HealthWireSample(
            uuid: sample.uuid.uuidString,
            start: HealthWireTime.iso(sample.startDate, in: zone),
            end: HealthWireTime.iso(sample.endDate, in: zone),
            source: HealthWireSource(
                bundleId: sample.sourceRevision.source.bundleIdentifier,
                name: sample.sourceRevision.source.name
            ),
            device: sample.device?.model ?? sample.device?.name,
            tz: zone.identifier == batchTimeZone.identifier ? nil : zone.identifier
        )
        var meta = HealthWireMeta()
        if (sample.metadata?[HKMetadataKeyWasUserEntered] as? Bool) == true { meta.userEntered = true }

        switch sample {
        case let quantity as HKQuantitySample:
            guard let unit = spec.hkUnit, quantity.quantity.is(compatibleWith: unit) else { return nil }
            item.value = quantity.quantity.doubleValue(for: unit) * spec.scale
        case let category as HKCategorySample:
            if spec.name == "mindful" {
                item.value = sample.endDate.timeIntervalSince(sample.startDate) / 60
            } else {
                item.code = category.value
            }
        case let workout as HKWorkout:
            item.value = workout.duration / 60
            meta.activity = HealthReadableNames.activity(workout.workoutActivityType)
            meta.energyKcal = workoutEnergyKcal(workout)
            meta.distanceM = workoutDistanceMeters(workout)
        case let mood as HKStateOfMind:
            item.value = mood.valence
            meta.kind = mood.kind == .dailyMood ? "daily" : "momentary"
            meta.labels = HealthReadableNames.short(mood.labels.map(HealthReadableNames.label))
            meta.associations = HealthReadableNames.short(mood.associations.map(HealthReadableNames.association))
        case let ecg as HKElectrocardiogram:
            item.code = ecg.classification.rawValue
            if let unit = spec.hkUnit, let rate = ecg.averageHeartRate, rate.is(compatibleWith: unit) {
                item.value = rate.doubleValue(for: unit)
            }
        case let assessment as HKScoredAssessment:
            item.code = assessment.score
        default:
            return nil
        }
        if let value = item.value, !value.isFinite { return nil }
        if item.code == nil && item.value == nil { return nil }
        item.meta = meta.isEmpty ? nil : meta
        return item
    }

    /// The zone the sample was recorded in, when HealthKit kept it.
    static func sampleTimeZone(_ sample: HKSample, fallback: TimeZone) -> TimeZone {
        if let name = sample.metadata?[HKMetadataKeyTimeZone] as? String, let zone = TimeZone(identifier: name) {
            return zone
        }
        return fallback
    }

    private static func workoutEnergyKcal(_ workout: HKWorkout) -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
              let sum = workout.statistics(for: type)?.sumQuantity() else { return nil }
        let kcal = sum.doubleValue(for: .kilocalorie())
        return kcal.isFinite && kcal >= 0 ? kcal : nil
    }

    /// The workout's own distance: whichever distance type its activity records.
    private static func workoutDistanceMeters(_ workout: HKWorkout) -> Double? {
        let identifiers: [HKQuantityTypeIdentifier] = [
            .distanceWalkingRunning, .distanceCycling, .distanceSwimming, .distanceWheelchair,
            .distanceDownhillSnowSports, .distanceRowing, .distancePaddleSports,
            .distanceCrossCountrySkiing, .distanceSkatingSports,
        ]
        for identifier in identifiers {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier),
                  let sum = workout.statistics(for: type)?.sumQuantity() else { continue }
            let meters = sum.doubleValue(for: .meter())
            if meters.isFinite, meters >= 0 { return meters }
        }
        return nil
    }
}

/// Readable names for workout activities and State of Mind labels, so the
/// Mac's agent reads "running", not a raw enum number.
enum HealthReadableNames {
    /// At most 10 names of at most 32 characters (the server's own limits).
    static func short(_ names: [String]) -> [String]? {
        let out = names.prefix(10).map { String($0.prefix(32)) }
        return out.isEmpty ? nil : Array(out)
    }

    static func activity(_ type: HKWorkoutActivityType) -> String {
        activityNames[type.rawValue] ?? "activity-\(type.rawValue)"
    }

    /// HKStateOfMind.Label raw values start at 1, in this order.
    private static let labelNames = [
        "amazed", "amused", "angry", "anxious", "ashamed", "brave", "calm", "content", "disappointed",
        "discouraged", "disgusted", "embarrassed", "excited", "frustrated", "grateful", "guilty", "happy",
        "hopeless", "irritated", "jealous", "joyful", "lonely", "passionate", "peaceful", "proud",
        "relieved", "sad", "scared", "stressed", "surprised", "worried", "annoyed", "confident", "drained",
        "hopeful", "indifferent", "overwhelmed", "satisfied",
    ]

    /// HKStateOfMind.Association raw values start at 1, in this order.
    private static let associationNames = [
        "community", "current events", "dating", "education", "family", "fitness", "friends", "health",
        "hobbies", "identity", "money", "partner", "self care", "spirituality", "tasks", "travel", "work",
        "weather",
    ]

    static func label(_ label: HKStateOfMind.Label) -> String {
        name(in: labelNames, raw: label.rawValue, fallback: "label")
    }

    static func association(_ association: HKStateOfMind.Association) -> String {
        name(in: associationNames, raw: association.rawValue, fallback: "association")
    }

    private static func name(in table: [String], raw: Int, fallback: String) -> String {
        raw >= 1 && raw <= table.count ? table[raw - 1] : "\(fallback)-\(raw)"
    }

    /// HKWorkoutActivityType raw values (HKWorkout.h). Deprecated cases keep
    /// their old meaning, since old workouts still carry them.
    private static let activityNames: [UInt: String] = [
        1: "american football", 2: "archery", 3: "australian football", 4: "badminton", 5: "baseball",
        6: "basketball", 7: "bowling", 8: "boxing", 9: "climbing", 10: "cricket", 11: "cross training",
        12: "curling", 13: "cycling", 14: "dance", 15: "dance training", 16: "elliptical",
        17: "equestrian sports", 18: "fencing", 19: "fishing", 20: "functional strength training",
        21: "golf", 22: "gymnastics", 23: "handball", 24: "hiking", 25: "hockey", 26: "hunting",
        27: "lacrosse", 28: "martial arts", 29: "mind and body", 30: "mixed cardio", 31: "paddle sports",
        32: "play", 33: "preparation and recovery", 34: "racquetball", 35: "rowing", 36: "rugby",
        37: "running", 38: "sailing", 39: "skating", 40: "snow sports", 41: "soccer", 42: "softball",
        43: "squash", 44: "stair climbing", 45: "surfing", 46: "swimming", 47: "table tennis",
        48: "tennis", 49: "track and field", 50: "traditional strength training", 51: "volleyball",
        52: "walking", 53: "water fitness", 54: "water polo", 55: "water sports", 56: "wrestling",
        57: "yoga", 58: "barre", 59: "core training", 60: "cross country skiing", 61: "downhill skiing",
        62: "flexibility", 63: "high intensity interval training", 64: "jump rope", 65: "kickboxing",
        66: "pilates", 67: "snowboarding", 68: "stairs", 69: "step training", 70: "wheelchair walk pace",
        71: "wheelchair run pace", 72: "tai chi", 73: "mixed cardio", 74: "hand cycling",
        75: "disc sports", 76: "fitness gaming", 77: "cardio dance", 78: "social dance", 79: "pickleball",
        80: "cooldown", 82: "swim bike run", 83: "transition", 84: "underwater diving", 3000: "other",
    ]
}
