import SwiftUI

/// How one route's last probe reads in Settings. Pure, so the copy is pinned
/// by WalnutTests.
enum RouteProbeDisplay: Equatable {
    case notChecked
    case reachable(latencyMs: Int)
    case unreachable
    case wrongServer
    case tokenRefused

    /// A refused token wins over the probe: the probe carries no token, so a box
    /// that refuses this phone still answers it.
    static func from(_ outcome: ProbeOutcome?, rejected: Bool) -> RouteProbeDisplay {
        if rejected { return .tokenRefused }
        switch outcome {
        case nil: return .notChecked
        case let .ok(_, latencyMs)?: return .reachable(latencyMs: latencyMs)
        case .mismatch?: return .wrongServer
        case .unreachable?: return .unreachable
        case .rejected401?: return .tokenRefused
        }
    }

    var text: String {
        switch self {
        case .notChecked: return "Not checked"
        case let .reachable(ms): return "Reachable · \(ms) ms"
        case .unreachable: return "Unreachable"
        case .wrongServer: return "Wrong server"
        case .tokenRefused: return "Token refused"
        }
    }

    var color: Color {
        switch self {
        case .notChecked: return Color(.tertiaryLabel)
        case .reachable: return Theme.success
        case .unreachable: return Color(.secondaryLabel)
        case .wrongServer: return Theme.warning
        case .tokenRefused: return Theme.danger
        }
    }

    /// The Settings row: "Connected via Wi-Fi · 192.168.1.20:3456" while the
    /// server answers, "Trying Wi-Fi · …" while it does not (the Status row
    /// right below says Offline; the address row must not claim a connection).
    static func summary(route: ServerRoute, online: Bool) -> String {
        "\(online ? "Connected via" : "Trying") \(route.kind.displayName) · \(route.displayHost)"
    }
}

/// The Server section's address row (a NavigationLink to the route list).
struct ConnectionRouteSummary: View {
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        let route = AppConfig.activeRoute(in: connection.routing.routes, serverURL: connection.serverURL)
            ?? .custom(connection.serverURL)
        Text(RouteProbeDisplay.summary(route: route, online: connection.online))
            .lineLimit(1)
            .truncationMode(.middle)
    }
}

/// Every known route to the paired Walnut, with its last probe, and a manual
/// "Check now" (which also switches if a better route answers).
struct ConnectionRoutesView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(\.scenePhase) private var scenePhase
    /// nil until first read on appear, so no advice flashes before it is known.
    @State private var phoneHasTailnet: Bool?

    var body: some View {
        let routing = connection.routing
        let rejected = routing.rejectedOrigins()
        List {
            Section {
                ForEach(routing.routes, id: \.normalizedOrigin) { route in
                    RouteRow(
                        route: route,
                        isCurrent: ServerRoute.sameOrigin(route.origin, connection.serverURL),
                        display: RouteProbeDisplay.from(
                            routing.probes[route.normalizedOrigin]?.outcome,
                            rejected: rejected.contains(route.normalizedOrigin)
                        )
                    )
                }
            } header: {
                Text("Routes")
            } footer: {
                Text("Walnut uses the first route in this list that answers, and switches on its own. Your device token is only sent once a route proves it reaches your own Walnut.")
            }
            if let phoneHasTailnet {
                TailscaleGuidanceSection(guidance: .derive(
                    routes: routing.routes,
                    probes: routing.probes.mapValues(\.outcome),
                    hint: routing.tailscaleHint,
                    phoneHasTailnet: phoneHasTailnet,
                    online: connection.online,
                    activeKind: AppConfig.activeRoute(in: routing.routes, serverURL: connection.serverURL)?.kind
                ))
            }
            Section {
                Button {
                    Task { await routing.checkNow() }
                } label: {
                    HStack {
                        Label(routing.checking ? "Checking…" : "Check Now", systemImage: "arrow.clockwise")
                        Spacer()
                        if routing.checking { ProgressView() }
                    }
                }
                .disabled(routing.checking)
                .accessibilityIdentifier("routes.checkNow")
            }
        }
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            routing.refreshRoutes()
            phoneHasTailnet = TailnetInterface.hasTailnetInterface()
        }
        // Back from the Tailscale app, or a check just finished: read the tunnel again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { phoneHasTailnet = TailnetInterface.hasTailnetInterface() }
        }
        .onChange(of: routing.checking) { _, checking in
            if !checking { phoneHasTailnet = TailnetInterface.hasTailnetInterface() }
        }
    }
}

private struct RouteRow: View {
    let route: ServerRoute
    let isCurrent: Bool
    let display: RouteProbeDisplay

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(route.kind.displayName)
                        .font(.body.weight(isCurrent ? .semibold : .regular))
                    if isCurrent {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.tint)
                            .accessibilityLabel("In use")
                    }
                }
                Text(route.origin)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            HStack(spacing: 5) {
                Circle()
                    .fill(display.color)
                    .frame(width: 7, height: 7)
                Text(display.text)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("routes.row.\(route.kind.rawValue)")
    }
}
