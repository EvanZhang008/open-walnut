import SwiftUI

/// Permission-request banner shown at the top of a session conversation page
/// when the CLI is blocked on a tool-permission prompt. One card per pending
/// request (usually a single one — prompts serialize the turn), with the tool
/// name, an input summary, and Allow / Deny.
struct PermissionRequestCard: View {
    let request: PendingPermission
    let answering: Bool
    var onRespond: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text("Permission requested")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if answering { ProgressView().controlSize(.small) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(request.toolName ?? "Tool")
                    .font(.callout.weight(.medium))
                if let summary = request.inputSummary {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if let reason = request.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
            HStack(spacing: 10) {
                Button {
                    onRespond(true)
                } label: {
                    Text("Allow")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Theme.tint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.permission.allow")
                Button {
                    onRespond(false)
                } label: {
                    Text("Deny")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(Theme.danger)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.permission.deny")
            }
            .disabled(answering)
        }
        .padding(12)
        .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.warning.opacity(0.35), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .accessibilityIdentifier("session.permissionCard")
    }
}
