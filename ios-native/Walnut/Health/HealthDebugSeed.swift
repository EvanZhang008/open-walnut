#if DEBUG
import CoreLocation
import Foundation
import HealthKit

/// DEBUG builds only: write a small synthetic Health dataset so the sync can be
/// checked end to end on a simulator, which has no Watch and no real data. It
/// includes one of each recording: a run's route, a heartbeat series and an
/// audiogram.
///
///     xcrun simctl launch <udid> dev.openwalnut.ios -walnut.healthDebugSeed 1
///
/// This is the ONLY code in the app that asks to WRITE to Health. A Release
/// build never compiles it, so the shipped app only ever asks to read. The
/// NSHealthUpdateUsageDescription string stays in every build all the same:
/// App Store validation requires it whenever the binary calls
/// `HKHealthStore.requestAuthorization(toShare:read:)`, which is also the only
/// way to ask to read (HealthDataSource asks with `toShare: []`). Apple refused
/// build 107 at upload when Release dropped it (2026-10-10).
///
/// Every sample carries a sync identifier made from its kind and day, so seeding
/// again the same day replaces instead of duplicating.
enum HealthDebugSeed {
    static let launchArgument = "walnut.healthDebugSeed"

    @MainActor
    static func runIfRequested() {
        guard UserDefaults.standard.bool(forKey: launchArgument), HKHealthStore.isHealthDataAvailable() else { return }
        LaunchGate.shared.whenActive {
            // On a busy simulator healthd can answer the request before the sheet
            // has been answered, so the first save finds write access still
            // undetermined. Try again until the sheet is answered (2 min): the
            // sync identifiers make a repeat replace, never duplicate.
            for attempt in 1...40 {
                do {
                    let count = try await seed()
                    AppLog.info("health", "debug seed written", ["samples": String(count), "attempt": String(attempt)])
                    return
                } catch let error as HKError where error.code == .errorAuthorizationNotDetermined && attempt < 40 {
                    try? await Task.sleep(for: .seconds(3))
                } catch {
                    AppLog.error("health", "debug seed failed", ["error": String(describing: error), "attempt": String(attempt)])
                    return
                }
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
        let audiogram = HKObjectType.audiogramSampleType()
        let heartbeats = HKSeriesType.heartbeat()
        let route = HKSeriesType.workoutRoute()
        let share: Set<HKSampleType> = [sleep, heartRate, resting, hrv, steps, mass, headache, workout,
                                        audiogram, heartbeats, route]
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
        let run = try await builder.finishWorkout()

        // Its GPS track: a made-up loop in open water, one point every 2 s.
        if let run {
            let routeBuilder = HKWorkoutRouteBuilder(healthStore: store, device: watch)
            let locations = (0..<900).map { i -> CLLocation in
                let angle = Double(i) / 900 * 2 * .pi
                return CLLocation(coordinate: CLLocationCoordinate2D(latitude: 10 + 0.01 * sin(angle),
                                                                     longitude: -30 + 0.01 * cos(angle)),
                                  altitude: 5 + Double(i % 20), horizontalAccuracy: 5, verticalAccuracy: 4,
                                  course: -1, speed: 2.8, timestamp: start.addingTimeInterval(Double(i) * 2))
            }
            try await routeBuilder.insertRouteData(locations)
            _ = try await routeBuilder.finishRoute(with: run, metadata: meta("route"))
        }

        // The beats behind last night's HRV reading: a minute, with one gap.
        let series = HKHeartbeatSeriesBuilder(healthStore: store, device: watch, start: at(3, 0))
        var offset = 0.0
        for beat in 0..<70 {
            offset += 0.85 + Double(beat % 5) * 0.02
            try await series.addHeartbeat(at: offset, precededByGap: beat == 40)
        }
        try await series.addMetadata(meta("beats"))
        _ = try await series.finishSeries()

        // A hearing test from yesterday (the per-ear test API is iOS 18.1).
        if #available(iOS 18.1, *) {
            let hz = HKUnit.hertz()
            let db = HKUnit.decibelHearingLevel()
            let levels: [(Double, Double, Double)] = [(250, 10, 10), (500, 10, 15), (1000, 15, 15), (2000, 20, 25),
                                                      (4000, 30, 35), (8000, 40, 45)]
            let points = try levels.map { freq, left, right in
                try HKAudiogramSensitivityPoint(frequency: HKQuantity(unit: hz, doubleValue: freq), tests: [
                    try HKAudiogramSensitivityTest(sensitivity: HKQuantity(unit: db, doubleValue: left), type: .air,
                                               masked: false, side: .left, clampingRange: nil),
                    try HKAudiogramSensitivityTest(sensitivity: HKQuantity(unit: db, doubleValue: right), type: .air,
                                               masked: false, side: .right, clampingRange: nil),
                ])
            }
            try await store.save(HKAudiogramSample(sensitivityPoints: points, start: at(10, 0, dayOffset: -1),
                                                   end: at(10, 10, dayOffset: -1), metadata: meta("audiogram")))
        }
        return samples.count + 4
    }
}
#endif
