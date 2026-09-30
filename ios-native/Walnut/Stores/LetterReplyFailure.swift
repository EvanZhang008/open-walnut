import Foundation

/// What a failed reply request means for the human: the sentence under the
/// reply, and whether the server may have the reply anyway. Pure, so the whole
/// table is unit-tested (`LetterReplyStoreTests`).
extension LetterReplyStore {
    /// The sentence under a reply that did not go out. Ends with a period so the
    /// status reads as two sentences ("Not sent." then why).
    nonisolated static func failureSentence(_ error: Error) -> String { failure(error).sentence }

    /// What a failed reply request means for the human.
    ///
    /// `mayHaveArrived` is the question that decides what to offer. It is false
    /// only when the failure proves the request never reached the recorder: no
    /// connection at all, or a refusal the server answers before recording (a
    /// 4xx, a 503). A timeout, a dropped connection, or a garbled answer can
    /// come after the server recorded the reply and passed it on.
    ///
    /// Transport failures get this reply box's own words: the shared network
    /// sentence says "we retried automatically", which is not true of a reply
    /// (a POST is never retried silently, see `replyToLetter`).
    nonisolated static func failure(_ error: Error) -> Failure {
        guard let apiError = error as? APIError else {
            return Failure(sentence: finished(error.localizedDescription), mayHaveArrived: true)
        }
        switch apiError {
        case .network(let underlying):
            let ns = underlying as NSError
            guard ns.domain == NSURLErrorDomain else {
                return Failure(sentence: "Walnut did not answer.", mayHaveArrived: true)
            }
            switch ns.code {
            case NSURLErrorTimedOut:
                return Failure(sentence: "The server did not answer in time.", mayHaveArrived: true)
            case NSURLErrorCannotConnectToHost, NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost,
                 NSURLErrorDNSLookupFailed, NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed,
                 NSURLErrorSecureConnectionFailed, NSURLErrorAppTransportSecurityRequiresSecureConnection:
                return Failure(sentence: "Walnut could not be reached.", mayHaveArrived: false)
            default:
                return Failure(sentence: "The connection dropped before Walnut answered.", mayHaveArrived: true)
            }
        case .cancelled:
            return Failure(sentence: "The request stopped before Walnut answered.", mayHaveArrived: true)
        case .badResponse:
            return Failure(sentence: "Walnut's answer could not be read.", mayHaveArrived: true)
        case .rateLimited:
            return Failure(sentence: "Too many requests. Try again in a moment.", mayHaveArrived: false)
        case .unauthorized:
            return Failure(sentence: "Walnut did not accept this phone's pairing. Pair it again in Settings.",
                           mayHaveArrived: false)
        case .notConfigured:
            return Failure(sentence: "This phone is not paired with Walnut yet.", mayHaveArrived: false)
        case .server(let status, let code, let message, _, _):
            if apiError.isBridgeOffline {
                return Failure(
                    sentence: "Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back.",
                    mayHaveArrived: !provablyUnsentBridgeSentences.contains { message.hasPrefix($0) }
                )
            }
            // The route's own deadline. Its message names the route and the
            // milliseconds, which are for the log, not for the human.
            if status == 504 || code == "timeout" {
                return Failure(sentence: "The server did not answer in time.", mayHaveArrived: true)
            }
            let sentence = finished(message.isEmpty ? "Walnut refused the reply." : message)
            return Failure(sentence: sentence, mayHaveArrived: status >= 500 && status != 503)
        }
    }

    /// A cloud companion answers `503 bridge_offline` both when nothing reached
    /// the Mac (no bridge at all) and when the relayed request went out and then
    /// timed out or dropped, after which the Mac may have recorded the reply
    /// (`relayFailureProvablyUnsent` on the server). The body carries no flag
    /// for the difference, so these sentences, the ones the server writes only
    /// for the first case (`bridgeOfflineMessage`, and the daemon's "no primary
    /// server connected"), are the signal. Any other sentence counts as "may
    /// have arrived": the safe side, since it only withholds Edit.
    nonisolated static let provablyUnsentBridgeSentences = [
        "No live bridge to the primary box",
        "Your primary box (Mac) has been unreachable",
        "Your primary box (Mac) is offline",
    ]

    private nonisolated static func finished(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Check the connection and try again." }
        return trimmed.hasSuffix(".") || trimmed.hasSuffix("?") || trimmed.hasSuffix("!") ? trimmed : trimmed + "."
    }
}
