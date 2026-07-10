import SwiftUI

/// Chat input bar — rounded field + circular send button. Disabled while a
/// turn is running (contract: 409 turn_active means wait for message-end).
struct ComposerView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(ConnectionStore.self) private var connection

    @State private var draft = ""
    @FocusState private var focused: Bool

    private var busy: Bool { chat.sending || chat.streaming }
    private var canSend: Bool {
        !busy && connection.online && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(busy ? "Waiting for reply…" : "Message \(chat.activeAgentName)", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .focused($focused)
                .disabled(busy)
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
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        draft = ""
        Task {
            let ok = await chat.send(text)
            if !ok, chat.errorMessage != nil {
                draft = text // restore the draft on failure
            }
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
