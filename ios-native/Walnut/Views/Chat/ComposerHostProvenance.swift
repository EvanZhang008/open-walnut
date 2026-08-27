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
///  - **The main agent** does not run on a selectable host at all: it runs
///    wherever the server process runs. The honest question there is which SERVER
///    the phone is talking to, primary (`mode: LIVE`) or cloud companion
///    (`mode: REPLICA`), which is a property of the current connection and not
///    something the user chooses per message.
///
/// Hence: no picker. A chooser that cannot change anything is worse than showing
/// nothing. It lives inside the `+` menu (not as a second pill) precisely because
/// it is provenance: the 44pt row stays for things that change the NEXT message
/// (the model), and "where am I" is one tap away.
///
/// Degradation is stated, not hidden. On the replica with the Mac's bridge down,
/// "Cloud · Mac offline" is the useful answer; a cheerful "Cloud" that conceals
/// the consequence (this is exactly when sends to Mac sessions cannot land) is
/// not.
enum ComposerHostProvenance {
    /// The main-agent chat: which server is answering.
    case chat(status: ServerStatus?, online: Bool)
    /// A coding session: which exec host it runs on (empty alias = the Mac).
    case session(hostAlias: String, cwd: String?)

    /// One-line label for the menu row.
    var label: String {
        switch self {
        case .chat(let status, let online):
            guard let status else {
                return online ? "Connecting…" : "Offline"
            }
            switch status.mode {
            case .live:
                // Talking straight to the primary box.
                return online ? "This Mac" : "This Mac · unreachable"
            case .replica:
                // The cloud companion is answering. Whether the Mac is still
                // reachable FROM it is the part that decides what the user can
                // actually do, so it is never omitted.
                if !online { return "Cloud · unreachable" }
                switch primaryReachability(status) {
                case .reachable: return "Cloud · Mac connected"
                case .offline: return "Cloud · Mac offline"
                case .unknown: return "Cloud"
                }
            }
        case .session(let hostAlias, _):
            return hostAlias.isEmpty ? "This Mac" : hostAlias
        }
    }

    /// Second line: the detail that makes the label actionable.
    var detail: String? {
        switch self {
        case .chat(let status, let online):
            guard let status else {
                return online ? nil : "Reconnecting to the server."
            }
            switch status.mode {
            case .live:
                return online ? nil : "The server isn't responding right now."
            case .replica:
                guard online else { return "The cloud companion isn't responding right now." }
                switch primaryReachability(status) {
                case .reachable:
                    return "Answers relay to your Mac."
                case .offline:
                    // The consequence, not just the state.
                    return "Your Mac isn't connected, so this box answers on its own and Mac sessions can't be reached."
                case .unknown:
                    return "Served by the cloud companion."
                }
            }
        case .session(_, let cwd):
            guard let cwd, !cwd.isEmpty else { return nil }
            return cwd
        }
    }

    var icon: String {
        switch self {
        case .chat(let status, _):
            guard let status else { return "wifi.slash" }
            return status.mode == .replica ? "cloud" : "laptopcomputer"
        case .session(let hostAlias, _):
            return NewSessionSheet.hostIcon(alias: hostAlias, label: hostAlias)
        }
    }

    /// True when the label reports a degraded state worth tinting.
    var degraded: Bool {
        switch self {
        case .chat(let status, let online):
            if !online { return true }
            guard let status, status.mode == .replica else { return false }
            return primaryReachability(status) == .offline
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
    func primaryReachability(_ status: ServerStatus) -> PrimaryReachability {
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
            // WORDS ("Mac offline" + the consequence) rather than by color alone.
            .disabled(true)
        }
    }
}
