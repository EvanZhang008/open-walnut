import SwiftUI

/// "Where is this running?" for a composer, as READ-ONLY provenance.
///
/// Two different questions wear the same words ("cloud or Mac?") and conflating
/// them ships a lie, so this type keeps them apart:
///
///  - **A coding session** genuinely runs on a chosen exec host. That is a real
///    per-session fact (`host::cwd`, empty host = the primary box, the Mac) and it
///    is PICKED at creation time (NewSessionChatView). Once the CLI is up it cannot
///    move, so in a live session's composer it is provenance, not a control.
///  - **The main agent** runs wherever the box that answers runs. On the leader
///    (the Mac) that is the Mac. On a replica (the cloud companion, or the Walnut
///    server on a host) the turn is RELAYED to the Mac whenever the Mac is reachable,
///    so the Mac still answers; only when the Mac is out of reach can the cloud box
///    answer on its own, and only if it has an engine for that (`cloudChat`). A host
///    replica has none: it refuses the turn until the Mac is back.
///
/// THE RULE THE COPY FOLLOWS: the headline names the machine that computes the
/// reply, never the network path. "Cloud · Mac connected" read as "it runs on the
/// cloud" when the answer was being computed on the Mac, which is the report this
/// shape answers ("Mac is Mac, cloud is cloud"). The path is not mentioned at all:
/// a healthy row is the machine's name with no second line, which only appears when
/// something is wrong (2026-10-03). "Cloud" is the headline ONLY when the
/// cloud box really answers, and "Mac" is spelled plainly (never "This Mac": the
/// device in the user's hand is a phone).
///
/// Hence: no picker. A chooser that cannot change anything is worse than showing
/// nothing. It lives inside the `+` menu (not as a second pill) precisely because
/// it is provenance: the 44pt row stays for things that change the NEXT message
/// (the model), and "where am I" is one tap away.
///
/// Degradation is stated, not hidden: when the Mac is out of reach the detail says
/// what happens to the next message, which is whatever the server really does
/// (see `macOffline`).
enum ComposerHostProvenance {
    /// The main-agent chat: which machine answers.
    case chat(status: ServerStatus?, online: Bool)
    /// A coding session: which exec host it runs on (empty alias = the Mac).
    case session(hostAlias: String, cwd: String?)

    /// Where replies to this chat are computed right now, as far as the phone can
    /// tell. Every label, detail and icon below is derived from this one verdict.
    enum ChatVerdict: Equatable {
        /// No status yet; `online` says whether the transport is up.
        case connecting
        /// The transport to the server is down.
        case offline(Server?)
        /// The Mac answers. `relayed` = reached through a replica.
        case mac(relayed: Bool)
        /// A replica too old to say whether it reaches the Mac: the relay will TRY the Mac.
        case macUnknown
        /// The Mac is out of reach from the cloud companion; `cloudChat` is what
        /// the companion says about answering on its own (nil = it does not say).
        case macOffline(cloudChat: ServerStatus.CloudChat?)
        /// The Mac is out of reach from the Walnut server on a host, which cannot
        /// answer a chat turn itself.
        case macOfflineFromHost
    }

    /// Which kind of server the phone talks to, by the server's own facts when it sends them.
    enum Server: Equatable {
        case mac, cloud, host

        init(_ status: ServerStatus) {
            self = !status.isReplica ? .mac : (status.isOnCloud ? .cloud : .host)
        }
    }

    static func verdict(status: ServerStatus?, online: Bool) -> ChatVerdict {
        guard let status else { return online ? .connecting : .offline(nil) }
        let server = Server(status)
        guard online else { return .offline(server) }
        if server == .mac { return .mac(relayed: false) }
        switch primaryReachability(status) {
        case .reachable: return .mac(relayed: true)
        case .unknown: return .macUnknown
        case .offline: return server == .cloud ? .macOffline(cloudChat: status.cloudChat) : .macOfflineFromHost
        }
    }

    /// One-line label for the menu row.
    var label: String {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting: return "Connecting…"
            case .offline: return "Offline"
            case .mac, .macUnknown: return "Mac"
            case .macOfflineFromHost: return "Mac offline"
            case .macOffline(let cloudChat):
                // Only a box that SAYS it can answer gets the Cloud headline.
                return cloudChat == .available ? "Cloud" : "Mac offline"
            }
        case .session(let hostAlias, _):
            return hostAlias.isEmpty ? "Mac" : hostAlias
        }
    }

    /// Second line: how the machine is reached, or what happens to the next
    /// message when it cannot be.
    var detail: String? {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting:
                return nil
            case .offline(let server):
                switch server {
                case .mac: return "Your Mac isn't responding right now."
                case .cloud: return "The cloud relay to your Mac isn't responding right now."
                case .host: return "The Walnut server between this phone and your Mac isn't responding right now."
                case nil: return "Can't reach Walnut right now. Reconnecting."
                }
            case .mac, .macUnknown:
                // Healthy: the machine's name is the whole story. The relay path is
                // not the user's business (2026-10-03: "Mac or Cloud, no more words").
                return nil
            case .macOfflineFromHost:
                // The host replica refuses the turn (503 needs_leader); nothing answers it.
                return "Your Mac isn't answering, so new messages can't go out until it's back."
            case .macOffline(let cloudChat):
                switch cloudChat {
                case .available:
                    // The cloud-chat fallback (server: routes/cloud-chat-fallback.ts)
                    // answers text turns only, with no Walnut tools and no Mac sessions.
                    return "Your Mac is offline, so the cloud server answers text messages for now. Mac sessions can't be reached."
                case .unavailable:
                    // The relay fails and the turn ends with the server's
                    // "primary is unreachable" error; nothing is answered.
                    return "The cloud server can't answer without your Mac, so new messages get an error until it's back."
                case nil:
                    // An older replica does not say. The one deployed before the
                    // field existed answers on its own with its built-in agent; ones
                    // in between fail the turn. Both are possible, so say "may".
                    return "Your Mac isn't connected. The cloud server may answer on its own, without your Mac's sessions."
                }
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
            case .offline(let server): return server == .mac ? "laptopcomputer.slash" : "wifi.slash"
            case .mac, .macUnknown: return "laptopcomputer"
            case .macOfflineFromHost: return "laptopcomputer.slash"
            case .macOffline(let cloudChat): return cloudChat == .available ? "cloud" : "laptopcomputer.slash"
            }
        case .session(let hostAlias, _):
            return NewSessionSheet.hostIcon(alias: hostAlias, label: hostAlias)
        }
    }

    /// True when the label reports a degraded state worth tinting: anything
    /// other than "the Mac answers" or "still finding out".
    var degraded: Bool {
        switch self {
        case .chat(let status, let online):
            switch Self.verdict(status: status, online: online) {
            case .connecting, .mac, .macUnknown: return false
            case .offline, .macOffline, .macOfflineFromHost: return true
            }
        case .session:
            return false
        }
    }

    // MARK: - Primary reachability (replicas only)

    typealias PrimaryReachability = ServerStatus.LeaderReach

    /// Does this replica reach the Mac right now? The server's own `leader.answers`
    /// when it sends it, else the companion's bridge list (see `ServerStatus.leaderReach`).
    static func primaryReachability(_ status: ServerStatus) -> PrimaryReachability {
        status.leaderReach
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
            // WORDS ("Mac offline" + what happens to the next message) rather than
            // by color alone.
            .disabled(true)
        }
    }
}
