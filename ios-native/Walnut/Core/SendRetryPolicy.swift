import Foundation

/// The client half of the durable send contract: stable message ids + the
/// backoff schedule for a retryable send failure.
///
/// ## Why the id lives on the CLIENT
///
/// A phone send rides `POST /api/v1/sessions/:id/messages` into the server's
/// DURABLE message queue, which is idempotent by `messageId` (see
/// core/session-message-queue.ts `enqueueMessage`, and the relay ledger in
/// providers/daemon-connection.ts). That dedupe is the only thing standing
/// between "the ack got lost" and a turn delivered TWICE — and it can only
/// work if every attempt at the same user message carries the SAME id. So the
/// id is minted once, when the user hits send, and every subsequent attempt
/// (automatic backoff retry or a manual tap) reuses it. A server-minted id
/// per request would make each retry a brand-new message by construction.
///
/// ## Why `bridge_offline` deserves an automatic retry
///
/// 503 `bridge_offline` means the Mac (or the session's exec host) has no live
/// bridge to the cloud replica RIGHT NOW: a laptop lid, a Wi-Fi change, an SSH
/// flap. Nothing about the message is wrong, and the condition typically clears
/// in seconds to a minute or two. Reporting it as "Not sent" made the user the
/// retry loop. The schedule below rides it out silently, and only gives up
/// after the budget — at which point "Not sent — tap to retry" is honest.
///
/// Everything here is PURE (no clock, no network, no UI) so the schedule is
/// unit-testable with an injected time.
enum SendRetryPolicy {

    // MARK: - Stable message ids

    /// Shape the server accepts for a client-supplied id: `/^qm-[A-Za-z0-9-]{1,64}$/`
    /// (session-stream-v1.ts). `qm-mobile-` matches the vocabulary the cloud
    /// relay mints server-side, so the logs read identically either way.
    static func newMessageId() -> String {
        // 6 random bytes as hex — same entropy as the server's
        // crypto.randomBytes(6) fallback, and hex keeps it inside the
        // [A-Za-z0-9-] character class the server's regex allows.
        var bytes = [UInt8](repeating: 0, count: 6)
        for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return "qm-mobile-\(hex)"
    }

    /// Guard for the server's own validation regex, so a malformed id can never
    /// silently degrade to a server-minted one (which would break idempotency).
    static func isValidMessageId(_ id: String) -> Bool {
        guard id.count >= 4, id.count <= 67, id.hasPrefix("qm-") else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
        return id.dropFirst(3).allSatisfy(allowed.contains) && id.count > 3
    }

    // MARK: - Backoff schedule

    /// First wait, then doubling: 2, 4, 8, 16, 32 s.
    static let baseDelay: TimeInterval = 2
    /// A single wait never grows past this — a 2-minute nap would feel dead.
    static let maxDelay: TimeInterval = 32
    /// Total time we are willing to keep retrying before the bubble settles on
    /// "Not sent — tap to retry". 2 + 4 + 8 + 16 + 32 = 62 s of sleeping across
    /// 5 attempts; the budget is the wall-clock ceiling INCLUDING the round
    /// trips, so a slow-failing server can't stretch this indefinitely.
    static let budget: TimeInterval = 120
    /// Hard cap on automatic attempts, independent of the time budget: five
    /// failures in a row is enough evidence that this needs a human.
    static let maxAttempts = 5

    /// Delay before automatic attempt number `attempt` (1 = the first retry,
    /// i.e. after the original send failed). Capped at `maxDelay`.
    static func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt >= 1 else { return baseDelay }
        let raw = baseDelay * pow(2, Double(attempt - 1))
        return min(raw, maxDelay)
    }

    /// Should the store schedule automatic attempt `attempt`?
    ///
    /// - `attempt`: the attempt number about to be scheduled (1-based).
    /// - `elapsed`: seconds since the FIRST failure of this bubble.
    ///
    /// False on either exhausted budget or exhausted attempts — the caller then
    /// settles the bubble into the manual "Not sent — tap to retry" state.
    static func shouldRetry(attempt: Int, elapsed: TimeInterval) -> Bool {
        guard attempt >= 1, attempt <= maxAttempts else { return false }
        // The delay must FIT inside the remaining budget: waking up past the
        // budget only to give up wastes the user's patience silently.
        return elapsed + delay(forAttempt: attempt) <= budget
    }

    /// What auto-retries. Everything else is either the user's problem (400), a
    /// genuinely dead session (409), or an unknown state where a blind retry
    /// risks a double-delivery the queue can't dedupe (the id protects us, but a
    /// 500 might mean something else broke).
    ///
    /// Two classes qualify:
    ///  - 503 `bridge_offline` — the host's bridge is down right now.
    ///  - a transport failure with NO response at all (timeout, connection
    ///    lost, TLS handshake). Field evidence 2026-08-20: during a ~7-minute
    ///    bridge outage the app's two POSTs hit its own 30s URLSession timeout,
    ///    so the server never answered and this ladder — which used to key only
    ///    off a 503 RESPONSE — never engaged. The bubble went red on a session
    ///    that was healthy and visibly streaming, which is the exact "not the
    ///    connection, just delivery failed" report. Retrying is safe because the
    ///    bubble carries ONE stable `qm-*` id across every attempt.
    static func isRetryable(_ error: Error) -> Bool {
        if let apiError = error as? APIError {
            if apiError.isBridgeOffline { return true }
            if case .network(let underlying) = apiError {
                return isRetryableTransport(underlying as NSError)
            }
            return false
        }
        return false
    }

    /// NSURLError codes that mean "no answer came back", so the outcome is
    /// unknown rather than a refusal. Pure + separate so it is unit-testable.
    static func isRetryableTransport(_ error: NSError) -> Bool {
        guard error.domain == NSURLErrorDomain else { return false }
        switch error.code {
        case NSURLErrorTimedOut,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorCannotConnectToHost,
             NSURLErrorNotConnectedToInternet,
             NSURLErrorSecureConnectionFailed,
             NSURLErrorDNSLookupFailed,
             NSURLErrorCannotFindHost:
            return true
        default:
            return false
        }
    }

    /// Composer/bubble copy while an automatic retry is still pending. Names
    /// the HOST, matching the offline banner: a clouddev session waiting on its
    /// own bridge must not tell the user to go look at their Mac.
    static func waitingNotice(host: String) -> String {
        "Waiting for \(host)… retrying"
    }
}
