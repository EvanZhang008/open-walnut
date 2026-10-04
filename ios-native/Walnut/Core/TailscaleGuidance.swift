import Foundation

/// The Mac's own Tailscale state, as `GET /api/v1/routes` reports it on the
/// Mac (the primary). Absent on a cloud replica, on an older server, and while
/// the Mac's first check of Tailscale is still out. Every field is optional:
/// nil means "not said", never "no".
struct TailscaleHint: Decodable, Equatable, Sendable {
    var installed: Bool?
    var running: Bool?
    var dnsName: String?

    init(installed: Bool? = nil, running: Bool? = nil, dnsName: String? = nil) {
        self.installed = installed
        self.running = running
        self.dnsName = dnsName
    }

    private enum CodingKeys: String, CodingKey { case installed, running, dnsName }

    /// Lenient per field: a value of the wrong type reads as not said.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = (try? c.decodeIfPresent(Bool.self, forKey: .installed)) ?? nil
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? nil
        let name = (try? c.decodeIfPresent(String.self, forKey: .dnsName)) ?? nil
        dnsName = (name?.isEmpty ?? true) ? nil : name
    }

    /// Says nothing at all (an empty object on the wire).
    var isEmpty: Bool { installed == nil && running == nil && dnsName == nil }

    /// The Mac said Tailscale is missing, or installed but not running.
    var macNeedsSetUp: Bool { installed == false || running == false }
}

/// What the Connection screen says about reaching the Mac from outside the
/// house. Pure and total: the same inputs always give the same answer.
struct TailscaleGuidance: Equatable, Sendable {
    enum Kind: String, CaseIterable, Sendable {
        /// Nothing to say: Tailscale already works, or the app cannot tell.
        case none
        /// No Tailscale route, and the Mac says Tailscale is missing or stopped.
        case setUpOnMac
        /// The Mac has a Tailscale route this iPhone cannot use: no tunnel here.
        case installOnPhone
        /// This iPhone has a tunnel, but the Tailscale route did not answer.
        case turnOnOrSameAccount
    }

    let kind: Kind
    /// Shown as a muted footnote instead of a regular row: the phone is on the
    /// Mac's Wi-Fi and the Mac answers there right now, so the advice is only
    /// about later, away from home.
    let isMuted: Bool

    static let none = TailscaleGuidance(kind: .none, isMuted: false)

    static let appStoreURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!

    var text: String? {
        switch kind {
        case .none:
            return nil
        case .setUpOnMac:
            return "To reach this Mac from anywhere without the cloud, set up Tailscale on it: Walnut on the Mac, Settings, Phones & Cloud."
        case .installOnPhone:
            return "Install Tailscale on this iPhone and sign in with the same account as on the Mac. Walnut then reaches the Mac from anywhere."
        case .turnOnOrSameAccount:
            return "The Tailscale route did not answer. Check that Tailscale is connected on this iPhone, that both devices use the same account, and that the Mac is awake."
        }
    }

    var actionTitle: String? { kind == .installOnPhone ? "Get Tailscale" : nil }
    var actionURL: URL? { kind == .installOnPhone ? Self.appStoreURL : nil }

    /// - Parameters:
    ///   - probes: last probe per origin (any spelling; normalized here).
    ///   - hint: the Mac's own Tailscale state, nil when the server did not say.
    ///   - phoneHasTailnet: `TailnetInterface.hasTailnetInterface()`.
    ///   - online: the current route answers.
    ///   - activeKind: the kind of the route in use (nil = not a known route).
    static func derive(
        routes: [ServerRoute],
        probes: [String: ProbeOutcome],
        hint: TailscaleHint?,
        phoneHasTailnet: Bool,
        online: Bool,
        activeKind: ServerRoute.Kind?
    ) -> TailscaleGuidance {
        let advice = classify(
            routes: routes, probes: probes, hint: hint,
            phoneHasTailnet: phoneHasTailnet, online: online, activeKind: activeKind
        )
        guard advice != .none else { return .none }
        return TailscaleGuidance(kind: advice, isMuted: online && activeKind == .lan)
    }

    private static func classify(
        routes: [ServerRoute],
        probes: [String: ProbeOutcome],
        hint: TailscaleHint?,
        phoneHasTailnet: Bool,
        online: Bool,
        activeKind: ServerRoute.Kind?
    ) -> Kind {
        // Talking through Tailscale right now: it works.
        if online, activeKind == .tailnet { return .none }

        let tailnet = routes.filter { $0.kind == .tailnet }
        guard !tailnet.isEmpty else {
            // No Tailscale route: only the Mac's own word can say why.
            return hint?.macNeedsSetUp == true ? .setUpOnMac : .none
        }

        var byOrigin: [String: ProbeOutcome] = [:]
        for (origin, outcome) in probes { byOrigin[ServerRoute.normalizeOrigin(origin)] = outcome }
        let outcomes = tailnet.map { byOrigin[$0.normalizedOrigin] }

        if outcomes.contains(where: { if case .ok? = $0 { return true } else { return false } }) { return .none }
        // A refused token is not a Tailscale problem (the route row already
        // says "Token refused"), and Tailscale advice would send the user the
        // wrong way.
        if outcomes.contains(.rejected401) { return .none }
        // No tunnel on this phone: the route cannot work, checked or not.
        if !phoneHasTailnet { return .installOnPhone }
        // A tunnel is up. Say "did not answer" only once a probe has said so.
        let failed = outcomes.contains { outcome in
            switch outcome {
            case .unreachable?, .mismatch?: return true
            default: return false
            }
        }
        return failed ? .turnOnOrSameAccount : .none
    }
}
