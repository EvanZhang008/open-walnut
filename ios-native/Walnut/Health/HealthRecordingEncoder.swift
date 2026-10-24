import CoreLocation
import Foundation
import HealthKit

/// A recording (an audiogram, a heartbeat series, a workout route) → the chunk
/// items `POST /api/v1/health/sync` takes for its `s.` type. Pure: the points are
/// read by the data source and handed in, so every rule is unit-tested with
/// objects built in memory.
///
/// Rules (each pinned by HealthRecordingEncoderTests):
///  - columns follow src/core/health/series-catalog.ts exactly;
///  - offsets are whole milliseconds from the object's start;
///  - a point with a value that is not finite is left out (the Mac would drop
///    the whole chunk for it);
///  - coordinates keep 6 decimals (about 10 cm), altitude, accuracy and speed 1
///    or 2: enough for any reading of a route, and a third of the bytes;
///  - a long series is cut into chunks of `maxPointsPerChunk`, all under one uuid.
enum HealthRecordingEncoder {
    static let maxPointsPerChunk = 1000
    /// The Mac takes at most 100 chunks of a route and 20 of a heartbeat series
    /// (`maxChunks` in series-catalog.ts), so a longer one is cut down here
    /// instead of being refused there.
    static let maxRoutePoints = 100 * maxPointsPerChunk
    static let maxHeartbeats = 20 * maxPointsPerChunk
    static let maxAudiogramPoints = 64

    /// A route over the cap is thinned evenly, keeping its first and last point;
    /// a heartbeat series keeps its first beats (thinning would invent intervals).
    static func capped(_ points: [[Double?]], object: HealthObjectKind) -> [[Double?]] {
        switch object {
        case .workoutRoute where points.count > maxRoutePoints:
            let step = Double(points.count - 1) / Double(maxRoutePoints - 1)
            return (0..<maxRoutePoints).map { points[Int((Double($0) * step).rounded())] }
        case .heartbeatSeries where points.count > maxHeartbeats:
            return Array(points.prefix(maxHeartbeats))
        case .audiogram where points.count > maxAudiogramPoints:
            return Array(points.prefix(maxAudiogramPoints))
        default:
            return points
        }
    }

    // MARK: - Points

    /// `[frequencyHz, leftDbHL|nil, rightDbHL|nil]` per sensitivity point.
    static func audiogramPoints(_ sample: HKAudiogramSample) -> [[Double?]] {
        let hz = HKUnit.hertz()
        let db = HKUnit.decibelHearingLevel()
        return sample.sensitivityPoints.compactMap { point in
            let frequency = point.frequency.doubleValue(for: hz)
            var left: Double?
            var right: Double?
            if #available(iOS 18.1, *) {
                for test in point.tests where test.type == .air {
                    let value = test.sensitivity.doubleValue(for: db)
                    if test.side == .left { left = left ?? value } else { right = right ?? value }
                }
            } else {
                left = point.leftEarSensitivity?.doubleValue(for: db)
                right = point.rightEarSensitivity?.doubleValue(for: db)
            }
            return audiogramPoint(frequencyHz: frequency, left: left, right: right)
        }
    }

    static func audiogramPoint(frequencyHz: Double, left: Double?, right: Double?) -> [Double?]? {
        guard frequencyHz.isFinite else { return nil }
        let l = left.flatMap { $0.isFinite ? round($0, 1) : nil }
        let r = right.flatMap { $0.isFinite ? round($0, 1) : nil }
        guard l != nil || r != nil, (1...40_000).contains(frequencyHz) else { return nil }
        return [round(frequencyHz, 1), l.flatMap { (-20...150).contains($0) ? $0 : nil },
                r.flatMap { (-20...150).contains($0) ? $0 : nil }]
    }

    /// `[offsetMs, precededByGap 0|1]` per beat, as HKHeartbeatSeriesQuery hands them out.
    static func heartbeatPoints(_ beats: [(sinceStart: TimeInterval, precededByGap: Bool)]) -> [[Double?]] {
        beats.compactMap { beat in
            guard beat.sinceStart.isFinite, beat.sinceStart >= 0 else { return nil }
            return [(beat.sinceStart * 1000).rounded(), beat.precededByGap ? 1 : 0]
        }
    }

    /// `[offsetMs, lat, lon, altitudeM|nil, hAccuracyM|nil, speedMps|nil]` per
    /// location, offset from `start`. A negative accuracy or speed is iOS saying
    /// "invalid", so it becomes nil, and so does the altitude of a location whose
    /// vertical accuracy is invalid.
    static func routePoints(_ locations: [CLLocation], start: Date) -> [[Double?]] {
        locations.compactMap { loc in
            let c = loc.coordinate
            let offset = loc.timestamp.timeIntervalSince(start) * 1000
            guard offset.isFinite, c.latitude.isFinite, c.longitude.isFinite,
                  abs(c.latitude) <= 90, abs(c.longitude) <= 180 else { return nil }
            // The Mac's ranges (series-catalog.ts): a reading outside one is left out.
            let alt: Double? = loc.verticalAccuracy >= 0 && loc.altitude.isFinite && (-1000...20_000).contains(loc.altitude)
                ? round(loc.altitude, 1) : nil
            let acc: Double? = loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= 10_000 ? round(loc.horizontalAccuracy, 1) : nil
            let speed: Double? = loc.speed >= 0 && loc.speed <= 300 ? round(loc.speed, 2) : nil
            return [max(0, offset.rounded()), round(c.latitude, 6), round(c.longitude, 6), alt, acc, speed]
        }
    }

    // MARK: - Items

    /// The chunk items for one recording. An object with no point at all still
    /// goes out as one empty chunk, so the Mac knows it exists and the anchor
    /// can move past it.
    static func items(
        _ sample: HKSample, points: [[Double?]], batchTimeZone: TimeZone,
        maxPointsPerChunk: Int = maxPointsPerChunk
    ) -> [HealthWireRecordingItem] {
        let zone = HealthSampleEncoder.sampleTimeZone(sample, fallback: batchTimeZone)
        let size = max(1, maxPointsPerChunk)
        let chunks = max(1, (points.count + size - 1) / size)
        return (0..<chunks).map { index in
            HealthWireRecordingItem(
                uuid: sample.uuid.uuidString,
                start: HealthWireTime.iso(sample.startDate, in: zone),
                end: HealthWireTime.iso(sample.endDate, in: zone),
                source: HealthWireSource(
                    bundleId: sample.sourceRevision.source.bundleIdentifier,
                    name: sample.sourceRevision.source.name
                ),
                device: sample.device?.model ?? sample.device?.name,
                tz: zone.identifier == batchTimeZone.identifier ? nil : zone.identifier,
                chunk: index,
                chunks: chunks,
                points: Array(points[min(points.count, index * size)..<min(points.count, (index + 1) * size)])
            )
        }
    }

    private static func round(_ value: Double, _ places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (value * scale).rounded() / scale
    }
}
