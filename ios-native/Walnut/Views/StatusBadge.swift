import SwiftUI

/// Server mode badge — LIVE (green dot) / REPLICA (amber dot) / Offline (red).
/// In the built-in demo it says "Demo": the in-process fake server answers as
/// LIVE, and a "Live" badge beside a Settings row that reads "Demo" would claim
/// a real server the phone does not have.
struct StatusBadge: View {
    @Environment(ConnectionStore.self) private var connection

    private var inDemo: Bool { DemoMode.isDemoURL(connection.serverURL) }

    private var color: Color {
        if inDemo { return Theme.tint }
        if !connection.online { return Theme.danger }
        switch connection.status?.mode {
        case .live: return Theme.success
        case .replica: return Theme.warning
        case nil: return Color(.tertiaryLabel)
        }
    }

    private var label: String {
        Self.label(online: connection.online, mode: connection.status?.mode, inDemo: inDemo)
    }

    /// The word on the badge. Internal for WalnutTests.
    static func label(online: Bool, mode: ServerStatus.Mode?, inDemo: Bool) -> String {
        if inDemo { return DemoMode.statusLabel }
        if !online { return "Offline" }
        switch mode {
        case .live: return "Live"
        case .replica: return "Replica"
        case nil: return "Unknown"
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("status.badge")
        .accessibilityLabel(inDemo ? "Status: \(label)" : "Server status: \(label)")
    }
}
