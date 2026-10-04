import SwiftUI

/// "Where is this running?" for a composer, as READ-ONLY provenance.
///
/// Two different questions wear the same words ("cloud or Mac?") and conflating
/// them ships a lie, so this type keeps them apart:
///
///  - **A coding session** genuinely runs on a chosen exec host. That is a real
///    per-session fact (`host::cwd`, empty host = the primary box) and it is
///    PICKED at creation time (NewSessionChatView). Once the CLI is up it cannot
///    move, so in a live session's composer it is provenance, not a control.
///  - **The main agent** runs wherever the box that answers runs. On the primary
///    (`mode: LIVE`) that is the Mac. On the cloud companion (`mode: REPLICA`) the
///    turn is RELAYED to the Mac whenever the Mac's bridge is up, so the Mac still
///    answers; only with the Mac out of reach does the cloud box answer on its own.
///
/// THE RULE THE COPY FOLLOWS: the row names the machine that computes the reply,
/// "Mac" or "Cloud", and nothing else while things work. The network path is not
/// the user's business ("Cloud · Mac connected" / "Answers relay to your Mac." read
/// as noise, and as "it runs on the cloud" when the Mac was answering). A second
/// line appears only when something is wrong, and then it says what that means
/// for the next message.
///
/// Hence: no picker. A chooser that cannot change anything is worse than showing
/// nothing. It lives inside the `+` menu (not as a second pill) precisely because
/// it is provenance: the 44pt row stays for things that change the NEXT message
/// (the model), and "where am I" is one tap away.
enum ComposerHostProvenance {
    /// The main-agent chat: which server is answering.
    case chat(status: ServerStatus?, online: Bool)
    /// A coding session: which exec host it runs on (empty alias = the Mac).
    case session(hostAlias: String, cwd: String?)

    /// Who computes the main agent's replies right now, as far as the phone can
    /// tell. The label, detail and icon are all read off this one verdict.
    enum ChatVerdict: Equatable {
        /// No status yet and the transport is up.
        case connecting
        /// The transport to the server is down.
        case offline(ServerStatus.Mode?)
        /// The Mac answers (directly, or relayed through the cloud companion).
        case mac
        /// The cloud companion answers on its own: the Mac is out of its reach, or
        /// the companion is too old to report its bridges.
        case cloud(macOffline: Bool)
    }

    static func verdict(status: ServerStatus?, online: Bool) -> ChatVerdict {
        guard let status else { return online ? .connecting : .offline(nil) }
        guard online else { return .offline(status.mode) }
        switch status.mode {
        case .live:
            return .mac
        case .replica:
            switch primaryReachability(status) {
            case .reachable: return .mac
            case .offline: return .cloud(macOffline: true)
            case .unknown: return .cloud(macOffline: false)
            }
        }
    }

    /// One word for the menu row: the machine, or the state when there is none.
    var label: String {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting: return "Connecting…"
            case .offline: return "Offline"
            case .mac: return "Mac"
            case .cloud: return "Cloud"
            }
        case .session(let hostAlias, _):
            return hostAlias.isEmpty ? "Mac" : hostAlias
        }
    }

    /// Second line, only when something is wrong: what it means for the next
    /// message. Nil whenever the label alone is the whole story.
    var detail: String? {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting, .mac, .cloud(macOffline: false):
                return nil
            case .offline(let mode):
                switch mode {
                case .live: return "Your Mac isn't responding right now."
                case .replica: return "The cloud server isn't responding right now."
                case nil: return "Can't reach Walnut right now. Reconnecting."
                }
            case .cloud(macOffline: true):
                // The consequence, not just the state.
                return "Your Mac is offline, so Mac sessions can't be reached."
            }
        case .session(_, let cwd):
            guard let cwd, !cwd.isEmpty else { return nil }
            return cwd
        }
    }

    var icon: String {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting: return "arrow.triangle.2.circlepath"
            case .offline: return "wifi.slash"
            case .mac: return "laptopcomputer"
            case .cloud: return "cloud"
            }
        case .session(let hostAlias, _):
            return NewSessionSheet.hostIcon(alias: hostAlias, label: hostAlias)
        }
    }

    /// True when the label reports a degraded state worth tinting.
    var degraded: Bool {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting, .mac, .cloud(macOffline: false): return false
            case .offline, .cloud(macOffline: true): return true
            }
        case .session:
            return false
        }
    }

    // MARK: - Primary reachability (REPLICA only)

    enum PrimaryReachability { case reachable, offline, unknown }

    /// Is the primary box's daemon dialled into this cloud companion?
    ///
    /// `bridgeHosts` is ADDITIVE and only present on a REPLICA (see the /status
    /// route). The primary's own bridge registers under the reserved alias
    /// `__local__`, so its presence is the one honest signal that the Mac is
    /// currently reachable from the cloud. An ABSENT `bridgeHosts` key means the
    /// server is too old to say (`.unknown`) — distinct from an empty list, which
    /// means it can say and the answer is "nothing is connected".
    static func primaryReachability(_ status: ServerStatus) -> PrimaryReachability {
        guard let bridgeHosts = status.bridgeHosts else { return .unknown }
        return bridgeHosts.contains { $0.hostAlias == "__local__" } ? .reachable : .offline
    }
}

/// The `+` menu's host row. Non-interactive by design (see the enum comment): it
/// states where this conversation is served from and, when that is degraded, what
/// the consequence is.
struct ComposerHostRow: View {
    let provenance: ComposerHostProvenance

    var body: some View {
        // A Section header + disabled text, not a Button: a tappable row implies
        // it opens a chooser, and there is nothing to choose.
        Section("Running on") {
            Label {
                VStack(alignment: .leading, spacing: 1) {
                    Text(provenance.label)
                    if let detail = provenance.detail {
                        Text(detail).font(.caption2)
                    }
                }
            } icon: {
                Image(systemName: provenance.icon)
            }
            .accessibilityIdentifier("composer.hostRow")
            // Menu rows can't be styled, so the degraded case is carried by the
            // WORDS (the second line names the consequence) rather than by color alone.
            .disabled(true)
        }
    }
}
