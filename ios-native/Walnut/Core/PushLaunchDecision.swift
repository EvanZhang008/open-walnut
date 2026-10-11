import CryptoKit
import Foundation

/// What a fresh APNs token means for this launch, decided by pure functions.
///
/// Split out of `PushRegistration` because the wiring, not the policy, is what
/// broke: the reconcile call used to live after an early `return` inside a
/// `guard else`, and moving it two lines up made it fire on EVERY token callback
/// while the whole test target stayed green. A decision that needs no simulator,
/// no server and no token is one that cannot drift unnoticed, and it reduces
/// `didRegister` to a `switch` that is hard to reorder by accident.
extension PushRegistration {
    enum LaunchAction: Equatable {
        /// The memo disagrees with the token APNs just handed us, so POST it. No
        /// status call belongs on this path: the upload IS the reconcile.
        case upload
        /// The memo agrees. Ask the box that SENDS whether it agrees too.
        case reconcile
        /// Nothing to do: unpaired, or this launch already settled the question.
        case none
    }

    /// The one decision `didRegister` makes.
    ///
    /// `inFlight` is separate from `reconcileDone` on purpose. Two token callbacks
    /// inside one launch are the normal case rather than a corner (see
    /// `uploadInFlight`), so in-flight has to suppress the second GET; but a GET
    /// that FAILED must leave `reconcileDone` false, or a phone that launches while
    /// the bridge is down never reconciles again for the life of the process.
    nonisolated static func launchAction(
        memoMatches: Bool, reconcileDone: Bool, inFlight: Bool, paired: Bool
    ) -> LaunchAction {
        // Unpaired: no server to POST to, and none to ask. `upload(token:)` guards
        // on this as well — that is the guard that runs, this is the one that is
        // tested, and neither is worth removing.
        guard paired else { return .none }
        guard memoMatches else { return .upload }
        return reconcileDone || inFlight ? .none : .reconcile
    }

    /// Which rule decided, for the log line. `token` is authoritative, `identity`
    /// is the old-server fallback, `none` means there was no answer to read.
    enum DecisionRule: String {
        case token, identity, none
    }

    nonisolated static func decisionRule(for status: WalnutAPI.PushStatus?) -> DecisionRule {
        guard let status else { return .none }
        return status.tokens == nil ? .identity : .token
    }

    /// How a device token is named anywhere but the APNs request itself: the first
    /// 8 hex characters of its SHA-256. The server computes the same value
    /// (`tokenTag()` in core/push/send.ts) for each row's `token_tag` and for its
    /// own log lines, so a phone finds its row without the server ever showing a
    /// slice of the token, and the app's log lines line up with the server's.
    nonisolated static func tokenTag(_ token: String) -> String {
        let hex = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(8))
    }

    /// A row's legacy `token_prefix` reduced to something safe to compare, or nil
    /// when it cannot carry a decision. Read only for a row with no `token_tag`,
    /// that is, from a server older than token tags.
    ///
    /// The stored value is hex characters plus a literal `"..."`. Anything short
    /// enough to collide by accident is worse than useless here (it would confirm a
    /// row that belongs to another phone), so a stripped prefix under
    /// `minComparablePrefix` is dropped rather than compared.
    nonisolated static let minComparablePrefix = 8

    nonisolated static func comparablePrefix(_ raw: String?) -> String? {
        guard var value = raw?.lowercased() else { return nil }
        while value.hasSuffix(".") { value.removeLast() }
        return value.count >= minComparablePrefix ? value : nil
    }

    /// True only when the sending box demonstrably does not hold THIS token.
    ///
    /// Three rules, in order of how much they can be trusted. The memo cannot decide
    /// this at all: it proves the token was ACCEPTED by whatever answered the POST,
    /// and a replica on pre-relay code accepted it into its own machine-local config.
    /// `registeredThisDevice` cannot decide it either, because it is computed from the
    /// caller's bearer-key NAME, and a phone calling over a trusted LAN with no
    /// verifiable bearer is filed under a SHARED placeholder name: two such phones
    /// where only the first registered would both read `true`, and the second would
    /// never register while believing it had. So when the server lists its rows, the
    /// token itself decides, since that is the one value that means the same thing on
    /// every box. The name rule survives only as the fallback for a server too old to
    /// list rows, and no answer at all decides nothing.
    ///
    /// A row is matched by its `token_tag` when it has one. Only a row without a tag
    /// (a server older than token tags) falls back to the legacy prefix, so a tag
    /// that names another phone is a "not mine" even when the prefixes agree.
    nonisolated static func shouldReregister(
        after status: WalnutAPI.PushStatus?, myToken: String
    ) -> Bool {
        guard let status else { return false }
        guard let rows = status.tokens else { return status.registeredThisDevice == false }
        let mine = myToken.lowercased()
        // The app uploads its token lowercase; the second tag keeps a case
        // difference from reading as "not my row", as the prefix rule always has.
        let myTags: Set<String> = [tokenTag(myToken), tokenTag(mine)]
        return !rows.contains { row in
            if let tag = row.tokenTag?.lowercased(), !tag.isEmpty {
                return myTags.contains(tag)
            }
            guard let prefix = comparablePrefix(row.tokenPrefix) else { return false }
            return mine.hasPrefix(prefix)
        }
    }
}
