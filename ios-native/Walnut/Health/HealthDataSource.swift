import Foundation
import HealthKit

/// Why a HealthKit read failed, in the terms the engine acts on.
enum HealthSourceError: Error, Equatable {
    /// The phone is locked (HKError.errorDatabaseInaccessible): stop quietly,
    /// keep every anchor, sync after the next unlock.
    case locked
    /// This type was never offered for permission (a type added by an update).
    case notAuthorized
    /// No HealthKit on this device, or not this type.
    case unavailable
    case failed
}

/// One anchored page of a type.
struct HealthAnchoredPage: Sendable {
    /// Encoded items (empty for bucket types, which are never sent raw).
    var samples: [HealthWireSample]
    var deleted: [String]
    /// Archived `HKQueryAnchor` to continue from.
    var anchor: Data?
    /// Samples the query returned, including any the encoder dropped. Together
    /// with `deleted.count` it tells whether the page was full.
    var fetched: Int
    /// Earliest sample start in the page.
    var earliestStart: Date?
}

enum HealthBucketInterval: Sendable {
    case hour, day

    var seconds: Int { self == .hour ? 3600 : 86_400 }
}

struct HealthCharacteristicValue: Sendable, Equatable {
    /// `BiologicalSex`, `DateOfBirth`, … (the part after `x.`).
    let name: String
    /// The HealthKit enum raw value; DateOfBirth is yyyymmdd.
    let code: Int
}

/// Everything the engine reads from Health, as a seam: HealthKitDataSource is the
/// one real implementation, the engine tests inject a scripted one.
protocol HealthDataSource: Sendable {
    var isAvailable: Bool { get }
    func requestReadAuthorization(for specs: [HealthTypeSpec], characteristics: Bool) async throws
    /// Samples and deletions after `anchor` (nil: from the beginning), at most `limit`.
    func anchored(_ spec: HealthTypeSpec, anchor: Data?, limit: Int, encode: Bool,
                  batchTimeZone: TimeZone) async throws -> HealthAnchoredPage
    /// Samples that started at or after `since`, newest first (the first-sync priming).
    func recent(_ spec: HealthTypeSpec, since: Date, limit: Int, batchTimeZone: TimeZone) async throws -> [HealthWireSample]
    /// Statistics buckets over [from, to). `includeEmpty` sends zero sums for
    /// intervals with no data (after a deletion emptied one).
    func statistics(_ spec: HealthTypeSpec, interval: HealthBucketInterval, from: Date, to: Date,
                    includeEmpty: Bool, batchTimeZone: TimeZone) async throws -> [HealthWireBucket]
    /// The characteristics that are set.
    func characteristics() async throws -> [HealthCharacteristicValue]
}

/// HealthKit, read-only. Never asks to share (write) anything: only the DEBUG
/// seeding tool writes, from its own store (HealthDebugSeed.swift).
final class HealthKitDataSource: HealthDataSource, @unchecked Sendable {
    static let shared = HealthKitDataSource()

    let store = HKHealthStore()

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func requestReadAuthorization(for specs: [HealthTypeSpec], characteristics: Bool) async throws {
        let read = HealthTypeCatalog.readTypes(for: specs, characteristics: characteristics)
        do {
            try await store.requestAuthorization(toShare: [], read: read)
        } catch {
            let ns = error as NSError
            AppLog.error("health", "HealthKit authorization error", [
                "domain": ns.domain, "code": String(ns.code), "description": ns.localizedDescription,
            ])
            throw Self.map(error)
        }
    }

    /// Whether the read sheet still has anything to ask (a type added by an
    /// update, or a first run). False once every type was offered.
    func shouldRequestAuthorization(for specs: [HealthTypeSpec]) async -> Bool {
        let read = HealthTypeCatalog.readTypes(for: specs, characteristics: true)
        let status = try? await store.statusForAuthorizationRequest(toShare: [], read: read)
        return status != .unnecessary
    }

    /// The types nearly every iPhone has samples of: the phone counts steps and
    /// distance by itself, and a Watch adds heart rate, energy and sleep.
    static let probeTypes: [HKSampleType] = [
        HKQuantityType(.stepCount), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.heartRate),
        HKQuantityType(.activeEnergyBurned), HKCategoryType(.sleepAnalysis), HKQuantityType(.bodyMass),
    ]

    /// Whether HealthKit hands Walnut any sample at all. Apps cannot see a read
    /// denial, but with access off every query answers empty, and an iPhone with
    /// none of these types is all but unheard of. One sample per type at most.
    func canReadAnySample() async -> Bool {
        for type in Self.probeTypes {
            let found: Bool = await withCheckedContinuation { continuation in
                let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: nil) { _, samples, _ in
                    continuation.resume(returning: !(samples ?? []).isEmpty)
                }
                store.execute(query)
            }
            if found { return true }
        }
        return false
    }

    func anchored(_ spec: HealthTypeSpec, anchor: Data?, limit: Int, encode: Bool,
                  batchTimeZone: TimeZone) async throws -> HealthAnchoredPage {
        guard let type = spec.sampleType else { throw HealthSourceError.unavailable }
        let start = anchor.flatMap(Self.unarchive)
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: start, limit: limit) {
                _, samples, deleted, newAnchor, error in
                if let error {
                    continuation.resume(throwing: Self.map(error))
                    return
                }
                let samples = samples ?? []
                let page = HealthAnchoredPage(
                    samples: encode
                        ? samples.compactMap { HealthSampleEncoder.encode($0, spec: spec, batchTimeZone: batchTimeZone) }
                        : [],
                    deleted: (deleted ?? []).map(\.uuid.uuidString),
                    anchor: newAnchor.flatMap(Self.archive),
                    fetched: samples.count,
                    earliestStart: samples.map(\.startDate).min()
                )
                continuation.resume(returning: page)
            }
            store.execute(query)
        }
    }

    func recent(_ spec: HealthTypeSpec, since: Date, limit: Int, batchTimeZone: TimeZone) async throws -> [HealthWireSample] {
        guard let type = spec.sampleType else { throw HealthSourceError.unavailable }
        let predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: [])
        let newestFirst = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit,
                                      sortDescriptors: newestFirst) { _, samples, error in
                if let error {
                    continuation.resume(throwing: Self.map(error))
                    return
                }
                continuation.resume(returning: (samples ?? []).compactMap {
                    HealthSampleEncoder.encode($0, spec: spec, batchTimeZone: batchTimeZone)
                })
            }
            store.execute(query)
        }
    }

    func statistics(_ spec: HealthTypeSpec, interval: HealthBucketInterval, from: Date, to: Date,
                    includeEmpty: Bool, batchTimeZone: TimeZone) async throws -> [HealthWireBucket] {
        guard let type = spec.sampleType as? HKQuantityType, let unit = spec.hkUnit, from < to else {
            throw HealthSourceError.unavailable
        }
        let options: HKStatisticsOptions = spec.bucketStat == .average
            ? [.discreteAverage, .discreteMin, .discreteMax] : .cumulativeSum
        var components = DateComponents()
        if interval == .day { components.day = 1 } else { components.hour = 1 }
        let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
        let scale = spec.scale
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: type, quantitySamplePredicate: predicate, options: options,
                anchorDate: from, intervalComponents: components
            )
            query.initialResultsHandler = { _, collection, error in
                if let error {
                    continuation.resume(throwing: Self.map(error))
                    return
                }
                var out: [HealthWireBucket] = []
                collection?.enumerateStatistics(from: from, to: to) { stats, _ in
                    let start = HealthWireTime.iso(stats.startDate, in: batchTimeZone)
                    if options.contains(.cumulativeSum) {
                        let sum = stats.sumQuantity()?.doubleValue(for: unit)
                        guard sum != nil || includeEmpty else { return }
                        let value = (sum ?? 0) * scale
                        guard value.isFinite else { return }
                        out.append(HealthWireBucket(start: start, intervalSec: interval.seconds, sum: value))
                    } else {
                        guard let avg = stats.averageQuantity()?.doubleValue(for: unit), avg.isFinite else { return }
                        out.append(HealthWireBucket(
                            start: start, intervalSec: interval.seconds, avg: avg * scale,
                            min: stats.minimumQuantity().map { $0.doubleValue(for: unit) * scale },
                            max: stats.maximumQuantity().map { $0.doubleValue(for: unit) * scale }
                        ))
                    }
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }

    func characteristics() async throws -> [HealthCharacteristicValue] {
        var out: [HealthCharacteristicValue] = []
        func read(_ name: String, _ body: () throws -> Int?) throws {
            do {
                if let code = try body() { out.append(HealthCharacteristicValue(name: name, code: code)) }
            } catch {
                // A locked phone stops the run; anything else (never asked,
                // not set) just leaves this characteristic out.
                if Self.map(error) == .locked { throw HealthSourceError.locked }
            }
        }
        try read("BiologicalSex") {
            let value = try store.biologicalSex().biologicalSex
            return value == .notSet ? nil : value.rawValue
        }
        try read("BloodType") {
            let value = try store.bloodType().bloodType
            return value == .notSet ? nil : value.rawValue
        }
        try read("DateOfBirth") {
            let parts = try store.dateOfBirthComponents()
            guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
            return year * 10_000 + month * 100 + day
        }
        try read("FitzpatrickSkinType") {
            let value = try store.fitzpatrickSkinType().skinType
            return value == .notSet ? nil : value.rawValue
        }
        try read("WheelchairUse") {
            let value = try store.wheelchairUse().wheelchairUse
            return value == .notSet ? nil : value.rawValue
        }
        try read("ActivityMoveMode") {
            Int(try store.activityMoveMode().activityMoveMode.rawValue)
        }
        return out
    }

    // MARK: - Helpers

    static func map(_ error: Error) -> HealthSourceError {
        if let known = error as? HealthSourceError { return known }
        guard let hk = error as? HKError else { return .failed }
        switch hk.code {
        case .errorDatabaseInaccessible: return .locked
        case .errorAuthorizationNotDetermined, .errorAuthorizationDenied: return .notAuthorized
        case .errorHealthDataUnavailable, .errorHealthDataRestricted: return .unavailable
        default: return .failed
        }
    }

    static func archive(_ anchor: HKQueryAnchor) -> Data? {
        try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }

    static func unarchive(_ data: Data) -> HKQueryAnchor? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }
}
