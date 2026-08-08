import Foundation

/// Wire format of `POST /api/v1/client-logs` — the ONE place the client's log
/// shape is defined.
///
/// Kept separate from `AppLog` (which owns levels, batching and retry) because
/// this is the contract half: the server's ingest route and every `jq` / `grep`
/// over `/tmp/open-walnut/ios-client/<device>-<day>.log` depends on these exact
/// keys. Changing anything here without changing the route is how a forensic
/// dump silently stops matching the queries people run against it.
///
/// Shape, per line:
/// ```
/// {"ts":"…Z","level":"debug|info|warn|error","subsystem":"…","message":"…",
///  "seq":"…","m_<metaKey>":"…", …}
/// ```
/// - `m_` prefix on meta: the server flattens each line into one JSON object, so
///   meta keys must not collide with the envelope's own fields.
/// - Meta is `[String: String]` by design — the server parses it as such, and a
///   flat string map is the only shape that survives the flattening unambiguously.
/// - `seq` is a monotonic per-process counter. It rides as a STRING for
///   uniformity with meta. It is what lets the server spot the duplicate batch a
///   kill-between-2xx-and-cursor-advance produces, and a jump with no
///   accompanying `dropped lines` marker means the app died holding lines.
enum ClientLogWire {
    /// One log line as a JSON object string (no trailing newline).
    static func encodeLine(
        ts: String, level: String, subsystem: String, message: String,
        seq: UInt64, meta: [String: String]?
    ) -> String {
        var object: [String: String] = [
            "ts": ts, "level": level, "subsystem": subsystem,
            "message": message, "seq": String(seq),
        ]
        meta?.forEach { object["m_\($0.key)"] = $0.value }
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8)
        else {
            // [String: String] is always serializable, so this is unreachable —
            // but never lose the FACT that a line existed.
            return #"{"level":"warn","subsystem":"applog","message":"unencodable line"}"#
        }
        return text
    }

    /// The request body: an envelope around already-encoded lines.
    ///
    /// Splices the lines in rather than decoding and re-encoding them. They came
    /// off disk as JSON text and go up as JSON text, so a round-trip through
    /// `JSONSerialization` would cost CPU (and peak memory, on a 512 KB batch)
    /// for a byte-identical result.
    static func encodeBody(lines: [String], device: String, appVersion: String, os: String) -> Data {
        var body = Data()
        body.append(contentsOf: #"{"device":"#.utf8)
        body.append(jsonString(device))
        body.append(contentsOf: #","appVersion":"#.utf8)
        body.append(jsonString(appVersion))
        body.append(contentsOf: #","os":"#.utf8)
        body.append(jsonString(os))
        body.append(contentsOf: #","lines":["#.utf8)
        for (index, line) in lines.enumerated() {
            if index > 0 { body.append(UInt8(ascii: ",")) }
            body.append(contentsOf: line.utf8)
        }
        body.append(contentsOf: "]}".utf8)
        return body
    }

    /// JSON-quote one string. Needed because the envelope is hand-built: device
    /// names really do contain quotes, apostrophes and emoji ("Evan's iPhone"),
    /// and naive interpolation would emit invalid JSON that the server rejects
    /// with a 400 — after which the client retries the same bad batch forever
    /// and every log queued behind it is stuck.
    static func jsonString(_ value: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: [value]))
            .flatMap { data -> Data? in
                // `["x"]` → `"x"`
                guard data.count > 2 else { return nil }
                return data.subdata(in: (data.startIndex + 1)..<(data.endIndex - 1))
            } ?? Data(#""?""#.utf8)
    }

    /// O(1), allocation-light ISO-8601 UTC stamp.
    ///
    /// `ISO8601DateFormatter()` was constructed per log line by the previous
    /// implementation — affordable at a few error lines per session, not in
    /// full-dump mode where this runs thousands of times a day on hot paths.
    /// `gmtime_r` is the reentrant variant, so this is safe from any thread
    /// (including the watchdog queue during a freeze).
    static func timestamp() -> String {
        var tv = timeval()
        gettimeofday(&tv, nil)
        var parts = tm()
        var seconds = time_t(tv.tv_sec)
        gmtime_r(&seconds, &parts)
        let millis = Int(tv.tv_usec) / 1000
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            parts.tm_year + 1900, parts.tm_mon + 1, parts.tm_mday,
            parts.tm_hour, parts.tm_min, parts.tm_sec, millis
        )
    }
}
