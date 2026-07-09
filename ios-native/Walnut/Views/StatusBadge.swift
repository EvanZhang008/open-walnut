import SwiftUI

/// Server mode badge — LIVE (green dot) / REPLICA (amber dot) / Offline (red).
struct StatusBadge: View {
    @Environment(ConnectionStore.self) private var connection

    private var color: Color {
        if !connection.online { return Theme.danger }
        switch connection.status?.mode {
        case .live: return Theme.success
        case .replica: return Theme.warning
        case nil: return Color(.tertiaryLabel)
        }
    }

    private var label: String {
        if !connection.online { return "Offline" }
        switch connection.status?.mode {
        case .live: return "Live"
        case .replica: return "Replica"
        case nil: return "—"
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
        .accessibilityLabel("Server status: \(label)")
    }
}
