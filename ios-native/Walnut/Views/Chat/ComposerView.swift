import SwiftUI

/// Reusable chat input bar — rounded field + circular send button. Owns only
/// the draft text; the parent decides `busy`/`disabled` and does the actual
/// send via `onSend`, which returns `true` on success (keeps the draft) or
/// `false` on failure (restores it).
///
/// - `busy`: a reply is in flight — show the waiting placeholder + lock input
///   (Chat's per-turn contract). Session pages leave this false: sessions
///   accept mid-turn messages, so the field stays open while the agent works.
/// - `disabled`: hard block (offline / dead session). Shows `disabledNotice`.
struct ComposerBar: View {
    let placeholder: String
    var busy: Bool = false
    var disabled: Bool = false
    var disabledNotice: String? = nil
    let onSend: (String) async -> Bool

    @State private var draft = ""
    @FocusState private var focused: Bool

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !busy && !disabled && !trimmed.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            if disabled, let notice = disabledNotice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(busy ? "Waiting for reply…" : placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                    .focused($focused)
                    .disabled(busy || disabled)
                    .accessibilityIdentifier("chat.composer")

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(canSend ? Theme.onTint : Color(.tertiaryLabel))
                        .frame(width: 32, height: 32)
                        .background(canSend ? Theme.tint : Color(.tertiarySystemFill), in: Circle())
                }
                .disabled(!canSend)
                .padding(.bottom, 3)
                .accessibilityIdentifier("chat.send")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func send() {
        let text = trimmed
        guard !text.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        draft = ""
        Task {
            let ok = await onSend(text)
            if !ok { draft = text } // restore the draft on failure
        }
    }
}

/// Chat tab's composer — a thin ChatStore wrapper around ComposerBar. Disabled
/// while a turn is running (contract: 409 turn_active means wait for message-end).
struct ComposerView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        ComposerBar(
            placeholder: "Message \(chat.activeAgentName)",
            busy: chat.sending || chat.streaming,
            disabled: !connection.online,
            disabledNotice: connection.online ? nil : "Offline — reconnecting…"
        ) { text in
            let ok = await chat.send(text)
            // Keep the draft only when the failure surfaced an error banner.
            return ok || chat.errorMessage == nil
        }
    }
}

// MARK: - Banners

struct OfflineBanner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Theme.warning.opacity(0.15))
            .foregroundStyle(.primary)
    }
}

struct ErrorBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.danger.opacity(0.12))
        .foregroundStyle(.primary)
    }
}
