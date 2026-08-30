import Foundation

/// Time-tracking heartbeats — the phone's half of the console's human-time
/// clocks (docs/reference/api-v1.md, time section).
///
/// A new file rather than an addition to the Wave files, matching the
/// one-file-per-feature-slice convention (`WalnutAPIPush.swift`).
extension WalnutAPI {
    /// POST /api/v1/time/heartbeats — bank closed attention windows.
    ///
    /// Success is **204 with an empty body**, so this cannot ride the normal
    /// `send()` funnel (its `decode` would fail parsing nothing as `T`). Status
    /// mapping the caller depends on:
    ///
    ///  - **204** — banked. The samples may be dropped from the queue.
    ///  - **503** — the server can't persist right now (a cloud replica whose
    ///    primary is offline). Keep the samples and retry later; the `ts` of each
    ///    one is the START of its window, so a late delivery still lands on the
    ///    day it happened.
    ///  - anything else — also keep and retry. Telemetry never gets to lose data
    ///    just because a response was unexpected.
    ///
    /// Batch size is bounded by the caller (`TimeSampleQueueState.maxBatch`, 200)
    /// because the server takes the first 200 and still answers 204 — an
    /// over-long batch would be reported as banked with its tail silently gone.
    func postTimeHeartbeats(_ samples: [TimeHeartbeatSample]) async throws {
        guard !samples.isEmpty else { return }
        struct Body: Encodable { let samples: [TimeHeartbeatSample] }
        guard let base = AppConfig.serverURL, let token = AppConfig.token else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/v1/time/heartbeats") else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // Short: this is background telemetry and must never sit on a connection
        // the user's own requests could be using.
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(samples: samples))
        // retrySafe: false — not for safety (every sample carries an idempotency
        // `id` now, so a duplicate is deduped server-side), but because the QUEUE
        // is the retry owner. A transport-level retry would stack a second 20s
        // request on a link that just proved slow, at the one moment the app may
        // be seconds from suspension, and buy nothing: the samples stay queued and
        // are only dropped on a real 204.
        let (data, response) = try await perform(request, retrySafe: false)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if (200...299).contains(http.statusCode) { return }
        // Reuse the shared error mapping (401 broadcast, v1 envelope decode).
        _ = try Self.decode(EmptyHeartbeatAck.self, data: data, response: response)
    }
}

/// Placeholder for the error path only — a 2xx never decodes a body here.
private struct EmptyHeartbeatAck: Decodable {}
