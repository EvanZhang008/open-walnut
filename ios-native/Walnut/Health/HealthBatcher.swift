import Foundation

/// One `POST /api/v1/health/sync` body: the batch-level header plus a slice of
/// one type's items and deleted UUIDs, each already encoded, so the size of the
/// body is known exactly before it is built.
struct HealthBatch: Sendable {
    /// The encoded header object (`{"tz":…,"kind":…}`), without item arrays.
    let header: Data
    /// `samples` (raw) or `buckets`.
    let itemsKey: String
    let items: [Data]
    /// Each one an encoded JSON string.
    let deleted: [Data]

    var count: Int { items.count + deleted.count }

    var byteCount: Int {
        HealthBatcher.bodyBytes(headerBytes: header.count, itemsKey: itemsKey,
                                itemSizes: items.map(\.count), deletedSizes: deleted.map(\.count))
    }

    /// The request body: the header with the arrays spliced in before its `}`.
    var body: Data {
        var out = Data(header.dropLast())
        let comma = UInt8(ascii: ",")
        if !items.isEmpty {
            out.append(contentsOf: Array(",\"\(itemsKey)\":[".utf8))
            for (i, item) in items.enumerated() {
                if i > 0 { out.append(comma) }
                out.append(item)
            }
            out.append(UInt8(ascii: "]"))
        }
        if !deleted.isEmpty {
            out.append(contentsOf: Array(",\"deleted\":[".utf8))
            for (i, uuid) in deleted.enumerated() {
                if i > 0 { out.append(comma) }
                out.append(uuid)
            }
            out.append(UInt8(ascii: "]"))
        }
        out.append(UInt8(ascii: "}"))
        return out
    }

    /// Split in two for a 413: deletions stay first, so each half is a valid
    /// batch on its own. Nil for a single item, which cannot be split.
    func halves() -> (HealthBatch, HealthBatch)? {
        guard count > 1 else { return nil }
        let all = deleted.map { (true, $0) } + items.map { (false, $0) }
        let mid = all.count / 2
        func make(_ slice: ArraySlice<(Bool, Data)>) -> HealthBatch {
            HealthBatch(header: header, itemsKey: itemsKey,
                        items: slice.filter { !$0.0 }.map(\.1), deleted: slice.filter(\.0).map(\.1))
        }
        return (make(all[..<mid]), make(all[mid...]))
    }
}

/// Splits one type's items and deletions into calls the server accepts: at most
/// 500 items (samples + deleted + buckets) and at most 180 KB serialized, which
/// leaves 12 KB of headroom under the server's 192 KB cap
/// (`HEALTH_MAX_ITEMS_PER_SYNC` / `HEALTH_MAX_SYNC_BYTES` in
/// src/core/health/catalog.ts). Deletions go first: they are small and the
/// Mac should drop a removed sample before anything else. Never builds an empty
/// call.
enum HealthBatcher {
    static let maxItems = 500
    static let maxBytes = 180 * 1024

    static func batches(
        header: Data, itemsKey: String, items: [Data], deleted: [String],
        maxItems: Int = maxItems, maxBytes: Int = maxBytes
    ) -> [HealthBatch] {
        let deletedData = deleted.map { encodeString($0) }
        let elements = deletedData.map { (true, $0) } + items.map { (false, $0) }
        guard !elements.isEmpty else { return [] }

        var out: [HealthBatch] = []
        var partItems: [Data] = []
        var partDeleted: [Data] = []
        // Running byte sums of the open part, so each step costs O(1).
        var itemBytes = 0
        var deletedBytes = 0

        for (isDeleted, data) in elements {
            let itemCount = partItems.count + (isDeleted ? 0 : 1)
            let deletedCount = partDeleted.count + (isDeleted ? 1 : 0)
            let trialBytes = bodyBytes(
                headerBytes: header.count, itemsKey: itemsKey,
                itemCount: itemCount, itemBytes: itemBytes + (isDeleted ? 0 : data.count),
                deletedCount: deletedCount, deletedBytes: deletedBytes + (isDeleted ? data.count : 0)
            )
            let partIsEmpty = partItems.isEmpty && partDeleted.isEmpty
            // A single element over the cap still goes out alone: dropping it
            // silently would be worse, and the engine answers its 413.
            if !partIsEmpty && (itemCount + deletedCount > maxItems || trialBytes > maxBytes) {
                out.append(HealthBatch(header: header, itemsKey: itemsKey, items: partItems, deleted: partDeleted))
                partItems = []
                partDeleted = []
                itemBytes = 0
                deletedBytes = 0
            }
            if isDeleted {
                partDeleted.append(data)
                deletedBytes += data.count
            } else {
                partItems.append(data)
                itemBytes += data.count
            }
        }
        if !partItems.isEmpty || !partDeleted.isEmpty {
            out.append(HealthBatch(header: header, itemsKey: itemsKey, items: partItems, deleted: partDeleted))
        }
        return out
    }

    /// Exact serialized size of a body built by `HealthBatch.body`.
    static func bodyBytes(headerBytes: Int, itemsKey: String, itemSizes: [Int], deletedSizes: [Int]) -> Int {
        bodyBytes(headerBytes: headerBytes, itemsKey: itemsKey,
                  itemCount: itemSizes.count, itemBytes: itemSizes.reduce(0, +),
                  deletedCount: deletedSizes.count, deletedBytes: deletedSizes.reduce(0, +))
    }

    static func bodyBytes(
        headerBytes: Int, itemsKey: String,
        itemCount: Int, itemBytes: Int, deletedCount: Int, deletedBytes: Int
    ) -> Int {
        var total = headerBytes  // `{…}`: its closing brace moves to the end
        if itemCount > 0 {
            // `,"<key>":[` + items + commas + `]`
            total += itemsKey.utf8.count + 6 + itemBytes + itemCount - 1
        }
        if deletedCount > 0 {
            // `,"deleted":[` + uuids + commas + `]`
            total += 13 + deletedBytes + deletedCount - 1
        }
        return total
    }

    /// One JSON value per item, encoded once.
    static func encode<T: Encodable>(_ items: [T]) -> [Data] {
        let encoder = JSONEncoder()
        return items.compactMap { try? encoder.encode($0) }
    }

    static func encodeString(_ value: String) -> Data {
        (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
    }
}
