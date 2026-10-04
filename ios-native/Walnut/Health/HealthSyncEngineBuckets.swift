import Foundation

// Bucket types and characteristics: the parts of a run that do not send raw
// samples. Split from HealthSyncEngine.swift to keep each file readable.
extension HealthSyncEngine {
    // MARK: - Bucket types

    /// The type's anchored query is read only to learn WHEN something changed
    /// (the earliest start among new samples); the samples themselves are never
    /// sent. Then the day buckets from that day on, and the hour buckets for at
    /// most the last 30 days, are recomputed with HealthKit statistics (Health's
    /// own source merge), always including the last 2 days, and sent.
    ///
    /// The anchor advances page by page TOGETHER with `bucketPendingFrom`, the
    /// record of what still has to be recomputed, so a budget that ends between
    /// paging and sending loses nothing: `bucketPendingFrom` is cleared only
    /// after the buckets were stored.
    func bucketRound(_ spec: HealthTypeSpec, _ run: Run) async throws -> Step {
        var reachedEnd = false
        for _ in 0..<Self.bucketPagesPerRound {
            try check(run)
            let anchor = state.read().anchors[spec.name]
            let page: HealthAnchoredPage
            do {
                page = try await source.anchored(spec, anchor: anchor, limit: Self.anchoredLimit, encode: false,
                                                 batchTimeZone: run.zone)
            } catch {
                try stopIfFatal(error)
                return .skipped
            }
            let now = env.now()
            state.update(generation: run.generation) { snapshot in
                if let next = page.anchor { snapshot.anchors[spec.name] = next }
                if let start = page.earliestStart {
                    snapshot.bucketPendingFrom[spec.name] = Self.earlier(snapshot.bucketPendingFrom[spec.name], start)
                    snapshot.bucketEarliest[spec.name] = Self.earlier(snapshot.bucketEarliest[spec.name], start)
                }
                if !page.deleted.isEmpty {
                    // A deletion carries no date: recompute everything this type has.
                    let from = snapshot.bucketEarliest[spec.name] ?? now.addingTimeInterval(-Self.hourlyWindow)
                    snapshot.bucketPendingFrom[spec.name] = Self.earlier(snapshot.bucketPendingFrom[spec.name], from)
                    snapshot.bucketPendingDeletes.insert(spec.name)
                }
            }
            if page.fetched + page.deleted.count < Self.anchoredLimit {
                reachedEnd = true
                break
            }
        }
        guard reachedEnd else { return .more }
        let snapshot = state.read()
        guard let pendingFrom = snapshot.bucketPendingFrom[spec.name] else { return .finished }

        try check(run)
        let now = env.now()
        let window = Self.bucketWindow(pendingFrom: pendingFrom, now: now, zone: run.zone)
        let includeEmpty = snapshot.bucketPendingDeletes.contains(spec.name)
        var buckets: [HealthWireBucket] = []
        do {
            buckets += try await source.statistics(spec, interval: .day, from: window.dayFrom, to: now,
                                                   includeEmpty: includeEmpty, batchTimeZone: run.zone)
            buckets += try await source.statistics(spec, interval: .hour, from: window.hourFrom, to: now,
                                                   includeEmpty: includeEmpty, batchTimeZone: run.zone)
        } catch {
            try stopIfFatal(error)
            return .skipped
        }
        if !buckets.isEmpty {
            guard try await post(spec, items: HealthBatcher.encode(buckets), deleted: [], run) else { return .skipped }
        }
        state.update(generation: run.generation) { snapshot in
            // Only what this recompute covered is cleared; a page that arrived
            // in between moved the pending date earlier and keeps it.
            if let current = snapshot.bucketPendingFrom[spec.name], current >= pendingFrom {
                snapshot.bucketPendingFrom[spec.name] = nil
            }
            snapshot.bucketPendingDeletes.remove(spec.name)
            snapshot.bucketSentThrough[spec.name] = now
            snapshot.oldestDate = Self.earlier(snapshot.oldestDate, buckets.isEmpty ? nil : window.dayFrom)
        }
        return .finished
    }

    /// Day buckets from the start of the earlier of (the pending date, 2 days
    /// ago); hour buckets from the later of (that day, 30 days ago).
    static func bucketWindow(pendingFrom: Date, now: Date, zone: TimeZone) -> (dayFrom: Date, hourFrom: Date) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let from = min(pendingFrom, now.addingTimeInterval(-lateWindow))
        let dayFrom = calendar.startOfDay(for: from)
        let hourCut = calendar.dateInterval(of: .hour, for: now.addingTimeInterval(-hourlyWindow))?.start
            ?? now.addingTimeInterval(-hourlyWindow)
        return (dayFrom, max(dayFrom, hourCut))
    }

    // MARK: - Characteristics

    /// One raw item per characteristic, uuid `char-<name>-<code>`, start = end =
    /// now. When a value changes, the old uuid goes in `deleted` in the same call.
    func syncCharacteristics(_ run: Run) async throws {
        try check(run)
        let values: [HealthCharacteristicValue]
        do {
            values = try await source.characteristics()
        } catch {
            try stopIfFatal(error)
            return
        }
        let now = HealthWireTime.iso(env.now(), in: run.zone)
        for name in HealthTypeCatalog.characteristicNames {
            let code = values.first { $0.name == name }?.code
            let uuid = code.map { Self.characteristicUUID(name: name, code: $0) }
            let previous = state.read().characteristicUUIDs[name]
            guard uuid != previous else { continue }
            let samples = uuid.map { id in
                [HealthWireSample(uuid: id, start: now, end: now, code: code,
                                  source: HealthWireSource(bundleId: "com.apple.Health", name: "Health"))]
            } ?? []
            let header = HealthSyncHeader(characteristic: "x.\(name)", storeId: state.read().storeId,
                                          device: run.device, tz: run.zone.identifier)
            let stored = try await send(header: header, itemsKey: "samples", items: HealthBatcher.encode(samples),
                                        deleted: previous.map { [$0] } ?? [], run)
            guard stored else { continue }
            state.update(generation: run.generation) { $0.characteristicUUIDs[name] = uuid }
        }
    }

    static func characteristicUUID(name: String, code: Int) -> String {
        "char-\(name.lowercased())-\(code)"
    }
}
