import Foundation
import os
@testable import Walnut

/// A scripted Health store: samples carry a sequence number, an anchor is the
/// last sequence number returned, so anchored paging works exactly like
/// HealthKit's without HealthKit.
final class FakeHealthSource: HealthDataSource, @unchecked Sendable {
    struct Sample {
        let seq: Int
        let wire: HealthWireSample
        let start: Date
    }

    struct StatisticsCall: Equatable {
        let type: String
        let interval: Int
        let from: Date
        let to: Date
        let includeEmpty: Bool
    }

    private let lock = NSLock()
    private var samples: [String: [Sample]] = [:]
    private var deletions: [String: [(seq: Int, uuid: String)]] = [:]
    private var nextSeq = 1
    private var _queried: [String] = []
    private var _statisticsCalls: [StatisticsCall] = []
    var lockedTypes: Set<String> = []
    /// Runs on every anchored query (a test clock can move with it).
    var onAnchoredQuery: () -> Void = {}
    /// Read access off for these types, as HealthKit answers it: every query
    /// empty, yet the anchor still moves past the whole history.
    var deniedTypes: Set<String> = []
    var characteristicValues: [HealthCharacteristicValue] = []
    var bucketsPerCall: [HealthWireBucket] = [
        HealthWireBucket(start: "2026-09-20T00:00:00-04:00", intervalSec: 86_400, sum: 1234),
    ]
    var isAvailable = true
    /// The demo must never read HealthKit: every touch while set is counted.
    var failIfTouched = false
    private(set) var forbiddenTouches = 0

    var queried: [String] { lock.withLock { _queried } }
    var statisticsCalls: [StatisticsCall] { lock.withLock { _statisticsCalls } }

    func add(_ type: String, start: Date, minutes: Double = 1, uuid: String? = nil, value: Double = 60) {
        lock.withLock {
            let id = uuid ?? "U\(nextSeq)"
            let zone = TimeZone(identifier: "America/New_York")!
            let wire = HealthWireSample(
                uuid: id, start: HealthWireTime.iso(start, in: zone),
                end: HealthWireTime.iso(start.addingTimeInterval(minutes * 60), in: zone), value: value,
                source: HealthWireSource(bundleId: "com.apple.health.test", name: "Watch")
            )
            samples[type, default: []].append(Sample(seq: nextSeq, wire: wire, start: start))
            nextSeq += 1
        }
    }

    func delete(_ type: String, uuid: String) {
        lock.withLock {
            deletions[type, default: []].append((nextSeq, uuid))
            nextSeq += 1
        }
    }

    private func touch(_ type: String) throws {
        if failIfTouched { forbiddenTouches += 1 }
        _queried.append(type)
        if lockedTypes.contains(type) { throw HealthSourceError.locked }
    }

    func requestReadAuthorization(for specs: [HealthTypeSpec], characteristics: Bool) async throws {
        lock.withLock { if failIfTouched { forbiddenTouches += 1 } }
    }

    func anchored(_ spec: HealthTypeSpec, anchor: Data?, limit: Int, encode: Bool,
                  batchTimeZone: TimeZone) async throws -> HealthAnchoredPage {
        onAnchoredQuery()
        return try lock.withLock {
            try touch(spec.name)
            let after = anchor.flatMap { Int(String(decoding: $0, as: UTF8.self)) } ?? 0
            if deniedTypes.contains(spec.name) {
                let latest = max(after, nextSeq - 1)
                return HealthAnchoredPage(samples: [], deleted: [], anchor: Data(String(latest).utf8),
                                          fetched: 0, earliestStart: nil)
            }
            var events: [(seq: Int, sample: Sample?, deleted: String?)] =
                (samples[spec.name] ?? []).filter { $0.seq > after }.map { ($0.seq, $0, nil) }
            events += (deletions[spec.name] ?? []).filter { $0.seq > after }.map { ($0.seq, nil, $0.uuid) }
            events.sort { $0.seq < $1.seq }
            let page = Array(events.prefix(limit))
            let pageSamples = page.compactMap(\.sample)
            let last = page.last?.seq ?? after
            return HealthAnchoredPage(
                samples: encode ? pageSamples.map(\.wire) : [],
                deleted: page.compactMap(\.deleted),
                anchor: Data(String(last).utf8),
                fetched: pageSamples.count,
                earliestStart: pageSamples.map(\.start).min()
            )
        }
    }

    func recent(_ spec: HealthTypeSpec, since: Date, limit: Int, batchTimeZone: TimeZone) async throws -> [HealthWireSample] {
        try lock.withLock {
            try touch(spec.name)
            if deniedTypes.contains(spec.name) { return [] }
            return (samples[spec.name] ?? []).filter { $0.start >= since }
                .sorted { $0.start > $1.start }.prefix(limit).map(\.wire)
        }
    }

    func statistics(_ spec: HealthTypeSpec, interval: HealthBucketInterval, from: Date, to: Date,
                    includeEmpty: Bool, batchTimeZone: TimeZone) async throws -> [HealthWireBucket] {
        try lock.withLock {
            try touch(spec.name)
            _statisticsCalls.append(StatisticsCall(type: spec.name, interval: interval.seconds, from: from, to: to,
                                                   includeEmpty: includeEmpty))
            return (samples[spec.name] ?? []).isEmpty || deniedTypes.contains(spec.name) ? [] : bucketsPerCall
        }
    }

    func characteristics() async throws -> [HealthCharacteristicValue] {
        try lock.withLock {
            try touch("characteristics")
            return characteristicValues
        }
    }
}

/// A scripted Mac. Records every sync body, decoded.
final class FakeHealthTransport: HealthSyncTransport, @unchecked Sendable {
    private let lock = NSLock()
    var status: HealthStatusResponse
    var statusError: Error?
    /// Decides each sync reply; default: stored.
    var reply: (_ body: [String: Any], _ index: Int) -> HealthSyncReply = { _, _ in .ok(FakeHealthTransport.stored) }
    /// An error the call with this index throws instead of answering (its body is still recorded).
    var syncError: (_ index: Int) -> Error? = { _ in nil }
    private var _bodies: [[String: Any]] = []
    var onCall: () -> Void = {}

    static let stored = HealthSyncResult(accepted: 1, inserted: 1, deleted: 0, rejected: nil, storeId: "hs-1",
                                         paused: false, unsupported: nil, categoryDisabled: nil,
                                         unitMismatch: nil, refused: nil)

    init(status: HealthStatusResponse = FakeHealthTransport.status()) {
        self.status = status
    }

    var bodies: [[String: Any]] { lock.withLock { _bodies } }

    func bodies(for type: String) -> [[String: Any]] {
        bodies.filter { ($0["type"] as? String ?? $0["metric"] as? String) == type }
    }

    /// `held` lists the types the Mac has samples of; nil leaves `types` out
    /// (an older server), so nothing is read again from the beginning.
    static func status(storeId: String = "hs-1", paused: Bool = false, generic: Bool = true,
                       raw: [String]? = nil, buckets: [String]? = nil, held: [String: String?]? = nil) -> HealthStatusResponse {
        var supported: [String: Any] = [:]
        if let raw { supported["raw"] = raw }
        if let buckets { supported["buckets"] = buckets }
        if generic { supported["generic"] = ["prefixes": ["q", "c", "x"], "covered": [String]()] }
        var object: [String: Any] = ["storeId": storeId, "paused": paused, "supported": supported]
        if let held {
            object["types"] = held.map { name, last in
                ["type": name, "enabled": true, "lastSampleAt": last.map { $0 as Any } ?? NSNull()] as [String: Any]
            }
        }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(HealthStatusResponse.self, from: data)
    }

    func healthStatus(timeout: TimeInterval) async throws -> HealthStatusResponse {
        onCall()
        if let statusError { throw statusError }
        return status
    }

    func healthSync(body: Data, timeout: TimeInterval) async throws -> HealthSyncReply {
        onCall()
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let index = lock.withLock { () -> Int in
            _bodies.append(object)
            return _bodies.count - 1
        }
        if let error = syncError(index) { throw error }
        return reply(object, index)
    }

    func healthSetPaused(_ paused: Bool) async throws -> HealthSettingsResponse {
        HealthSettingsResponse(paused: paused)
    }

    func healthDeleteData() async throws -> HealthDeleteResponse {
        HealthDeleteResponse(storeId: "hs-2", paused: true, removed: 0)
    }

    static func result(paused: Bool = false, unsupported: Bool = false, unitMismatch: Bool = false) -> HealthSyncResult {
        HealthSyncResult(accepted: 0, inserted: 0, deleted: 0, rejected: nil, storeId: "hs-1", paused: paused,
                         unsupported: unsupported ? true : nil, categoryDisabled: nil,
                         unitMismatch: unitMismatch ? HealthPresence() : nil, refused: nil)
    }
}

/// A clock the test moves (each transport call can advance it).
final class FakeHealthClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date) { current = start }

    var now: Date { lock.withLock { current } }

    func advance(_ seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

extension HealthSyncEnvironment {
    static func test(clock: FakeHealthClock, enabled: Bool = true, demo: Bool = false) -> HealthSyncEnvironment {
        HealthSyncEnvironment(
            isEnabled: { enabled }, isPaired: { true }, isDemo: { demo }, now: { clock.now },
            timeZone: { TimeZone(identifier: "America/New_York")! }, deviceModel: "iPhone17,1", deviceOS: "iOS 26.0"
        )
    }
}

extension HealthTypeSpec {
    static func testRaw(_ name: String, generic: Bool = false, unit: String? = nil) -> HealthTypeSpec {
        HealthTypeSpec(name: name, object: .category("HKCategoryTypeIdentifierSleepAnalysis"), kind: .raw,
                       unit: unit, scale: 1, isGeneric: generic, bucketStat: nil, immediateDelivery: false)
    }

    static func testBuckets(_ name: String, generic: Bool = false, unit: String = "count") -> HealthTypeSpec {
        HealthTypeSpec(name: name, object: .quantity("HKQuantityTypeIdentifierStepCount"), kind: .buckets,
                       unit: unit, scale: 1, isGeneric: generic, bucketStat: .sum, immediateDelivery: false)
    }
}
