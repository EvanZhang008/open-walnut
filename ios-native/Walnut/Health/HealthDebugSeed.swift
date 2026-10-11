#if DEBUG
import Foundation
import HealthKit

/// DEBUG builds only: write a small synthetic Health dataset so the sync can be
/// checked end to end on a simulator, which has no Watch and no real data.
///
///     xcrun simctl launch <udid> dev.openwalnut.ios -walnut.healthDebugSeed 1
///
/// This is the ONLY code in the app that asks to WRITE to Health, and why
/// NSHealthUpdateUsageDescription exists in Info.plist. A Release build never
/// compiles it and drops that string from its Info.plist (project.yml,
/// postBuildScripts), so the shipped app only ever asks to read.
///
/// Every sample carries a sync identifier made from its kind and day, so seeding
/// again the same day replaces instead of duplicating.
enum HealthDebugSeed {
    static let launchArgument = "walnut.healthDebugSeed"

    @MainActor
    static func runIfRequested() {
        guard UserDefaults.standard.bool(forKey: launchArgument), HKHealthStore.isHealthDataAvailable() else { return }
        LaunchGate.shared.whenActive {
            do {
                let count = try await seed()
                AppLog.info("health", "debug seed written", ["samples": String(count)])
            } catch {
                AppLog.error("health", "debug seed failed", ["error": String(describing: error)])
            }
        }
    }

    private static func seed(now: Date = Date()) async throws -> Int {
        let store = HKHealthStore()
        let sleep = HKCategoryType(.sleepAnalysis)
        let heartRate = HKQuantityType(.heartRate)
        let resting = HKQuantityType(.restingHeartRate)
        let hrv = HKQuantityType(.heartRateVariabilitySDNN)
        let steps = HKQuantityType(.stepCount)
        let mass = HKQuantityType(.bodyMass)
        let headache = HKCategoryType(.headache)
        let workout = HKObjectType.workoutType()
        let share: Set<HKSampleType> = [sleep, heartRate, resting, hrv, steps, mass, headache, workout]
        try await store.requestAuthorization(toShare: share, read: share)

        let watch = HKDevice(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch",
                             hardwareVersion: "Watch7,1", firmwareVersion: nil, softwareVersion: "26.0",
                             localIdentifier: nil, udiDeviceIdentifier: nil)
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let dayKey = ISO8601DateFormatter.string(from: today, timeZone: .current, formatOptions: [.withFullDate])
        var serial = 0
        func meta(_ kind: String) -> [String: Any] {
            serial += 1
            return [
                HKMetadataKeySyncIdentifier: "walnut-seed-\(kind)-\(dayKey)-\(serial)",
                HKMetadataKeySyncVersion: 1,
                HKMetadataKeyTimeZone: TimeZone.current.identifier,
            ]
        }
        func at(_ hour: Int, _ minute: Int, dayOffset: Int = 0) -> Date {
            calendar.date(byAdding: DateComponents(day: dayOffset, hour: hour, minute: minute), to: today) ?? now
        }

        var samples: [HKSample] = []
        // Last night: in bed 23:00 to 07:00, with core, deep, REM and awake stages.
        samples.append(HKCategorySample(type: sleep, value: HKCategoryValueSleepAnalysis.inBed.rawValue,
                                        start: at(23, 0, dayOffset: -1), end: at(7, 0), device: watch,
                                        metadata: meta("inbed")))
        // Stages as minutes after 23:00 yesterday.
        let bedtime = at(23, 0, dayOffset: -1)
        let stages: [(HKCategoryValueSleepAnalysis, Int, Int)] = [
            (.asleepCore, 15, 90), (.asleepDeep, 90, 150), (.asleepCore, 150, 220), (.asleepREM, 220, 260),
            (.awake, 260, 270), (.asleepCore, 270, 350), (.asleepDeep, 350, 380), (.asleepREM, 380, 440),
            (.asleepCore, 440, 470),
        ]
        for (stage, from, to) in stages {
            samples.append(HKCategorySample(
                type: sleep, value: stage.rawValue,
                start: bedtime.addingTimeInterval(Double(from) * 60), end: bedtime.addingTimeInterval(Double(to) * 60),
                device: watch, metadata: meta("stage")
            ))
        }
        // Heart rate every 5 minutes over the last 24 hours.
        let bpm = HKUnit.count().unitDivided(by: .minute())
        for step in 0..<(24 * 12) {
            let date = now.addingTimeInterval(-Double(step) * 300)
            let hour = calendar.component(.hour, from: date)
            let asleep = hour < 7 || hour >= 23
            let value = (asleep ? 54.0 : 72.0) + Double((step * 7) % 11)
            samples.append(HKQuantitySample(type: heartRate, quantity: HKQuantity(unit: bpm, doubleValue: value),
                                            start: date, end: date, device: watch, metadata: meta("hr")))
        }
        samples.append(HKQuantitySample(type: resting, quantity: HKQuantity(unit: bpm, doubleValue: 56),
                                        start: at(8, 0), end: at(8, 0), device: watch, metadata: meta("rhr")))
        samples.append(HKQuantitySample(type: hrv, quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: 48),
                                        start: at(3, 0), end: at(3, 1), device: watch, metadata: meta("hrv")))
        // Steps through the day so far, one sample per waking hour.
        let hourNow = calendar.component(.hour, from: now)
        for hour in 7..<max(8, hourNow) {
            samples.append(HKQuantitySample(type: steps, quantity: HKQuantity(unit: .count(), doubleValue: Double(300 + hour * 37)),
                                            start: at(hour, 0), end: at(hour, 50), device: watch, metadata: meta("steps")))
        }
        samples.append(HKQuantitySample(type: mass, quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: 72.4),
                                        start: at(7, 30), end: at(7, 30), metadata: meta("mass")))
        var symptom = meta("headache")
        symptom[HKMetadataKeyWasUserEntered] = true
        samples.append(HKCategorySample(type: headache, value: HKCategoryValueSeverity.mild.rawValue,
                                        start: at(13, 0, dayOffset: -1), end: at(15, 0, dayOffset: -1),
                                        metadata: symptom))
        try await store.save(samples)

        // One 30-minute run yesterday evening, through the workout builder.
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .running
        configuration.locationType = .outdoor
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: watch)
        let start = at(18, 0, dayOffset: -1)
        let end = at(18, 30, dayOffset: -1)
        try await builder.beginCollection(at: start)
        try await builder.addMetadata(meta("workout"))
        try await builder.endCollection(at: end)
        _ = try await builder.finishWorkout()
        return samples.count + 1
    }
}
#endif
