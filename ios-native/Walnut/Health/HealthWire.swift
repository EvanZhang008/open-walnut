import Foundation

// The JSON shapes of `POST /api/v1/health/sync` (docs/reference/api-v1.md,
// Apple Health). Optional fields are omitted when nil, so an item carries only
// what it has: the 192 KB per-call cap is the budget every byte comes out of.

struct HealthWireSource: Codable, Equatable, Sendable {
    let bundleId: String
    let name: String
}

struct HealthWireMeta: Codable, Equatable, Sendable {
    var userEntered: Bool?
    var activity: String?
    var energyKcal: Double?
    var distanceM: Double?
    var kind: String?
    var labels: [String]?
    var associations: [String]?

    var isEmpty: Bool {
        userEntered == nil && activity == nil && energyKcal == nil && distanceM == nil
            && kind == nil && labels == nil && associations == nil
    }
}

/// One raw item: a catalog sample or a generic `q.` / `c.` / `x.` one.
struct HealthWireSample: Codable, Equatable, Sendable {
    var uuid: String
    /// ISO-8601 with the sample's own offset.
    var start: String
    var end: String
    var value: Double?
    var code: Int?
    var source: HealthWireSource?
    var device: String?
    /// The sample's zone, omitted when it equals the batch zone.
    var tz: String?
    var meta: HealthWireMeta?
}

/// One statistics bucket (`intervalSec` 3600 or 86400).
struct HealthWireBucket: Codable, Equatable, Sendable {
    var start: String
    var intervalSec: Int
    var sum: Double?
    var avg: Double?
    var min: Double?
    var max: Double?
}

/// Batch-level fields, everything except the item arrays (the batcher splices
/// those in after measuring them).
struct HealthSyncHeader: Encodable, Sendable {
    struct Device: Encodable, Sendable {
        let installId: String?
        let model: String?
        let os: String?
    }

    let storeId: String?
    let device: Device?
    let tz: String
    let kind: String
    /// Raw calls name the type...
    let type: String?
    /// ...bucket calls the metric.
    let metric: String?
    let unit: String?
    let agg: String?

    init(spec: HealthTypeSpec, storeId: String?, device: Device?, tz: String) {
        self.storeId = storeId
        self.device = device
        self.tz = tz
        kind = spec.kind.rawValue
        type = spec.kind == .raw ? spec.name : nil
        metric = spec.kind == .buckets ? spec.name : nil
        unit = spec.wireUnit
        agg = spec.wireAgg
    }

    /// A characteristic call (`x.BiologicalSex` ...): raw, no unit.
    init(characteristic name: String, storeId: String?, device: Device?, tz: String) {
        self.storeId = storeId
        self.device = device
        self.tz = tz
        kind = HealthUploadKind.raw.rawValue
        type = name
        metric = nil
        unit = nil
        agg = nil
    }
}

/// Instants on the wire: ISO-8601 with the zone's own offset (`-04:00`), and
/// milliseconds only when there are some. Built by hand: the system ISO style
/// writes `-0400`, which JavaScript's `Date.parse` does not reliably accept.
enum HealthWireTime {
    static func iso(_ date: Date, in zone: TimeZone) -> String {
        let totalMs = Int64((date.timeIntervalSince1970 * 1000).rounded())
        let seconds = floorDiv(totalMs, 1000)
        let ms = Int(totalMs - seconds * 1000)
        let offset = zone.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(seconds)))
        let local = seconds + Int64(offset)
        let days = floorDiv(local, 86_400)
        let secondOfDay = Int(local - days * 86_400)
        let (year, month, day) = civil(fromDays: days)
        var out = String(format: "%04d-%02d-%02dT%02d:%02d:%02d", year, month, day,
                         secondOfDay / 3600, (secondOfDay % 3600) / 60, secondOfDay % 60)
        if ms != 0 { out += String(format: ".%03d", ms) }
        let absOffset = abs(offset)
        out += String(format: "%@%02d:%02d", offset < 0 ? "-" : "+", absOffset / 3600, (absOffset % 3600) / 60)
        return out
    }

    private static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    /// Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant's algorithm).
    private static func civil(fromDays days: Int64) -> (Int, Int, Int) {
        let z = days + 719_468
        let era = floorDiv(z, 146_097)
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        return (Int(year), Int(month), Int(day))
    }
}
