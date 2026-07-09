import SwiftUI

/// One chat entry — user bubble (right, walnut tint), assistant text (left,
/// plain markdown), or a small grey chip for tool/thinking history rows.
struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        switch message.kind {
        case .tool:
            chip(icon: "wrench.and.screwdriver", text: message.text)
        case .thinking:
            chip(icon: "sparkles", text: message.text)
        case nil:
            if message.isUser {
                userBubble
            } else {
                assistantText
            }
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 60)
            Text(message.text)
                .foregroundStyle(Theme.onTint)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.tint, in: UnevenRoundedRectangle(
                    topLeadingRadius: 18, bottomLeadingRadius: 18,
                    bottomTrailingRadius: 5, topTrailingRadius: 18,
                    style: .continuous
                ))
                .opacity(message.pending == true ? 0.65 : 1)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
    }

    private var assistantText: some View {
        HStack {
            Text(markdown: message.text)
                .textSelection(.enabled)
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
    }

    private func chip(icon: String, text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .padding(.horizontal, 16)
        .padding(.vertical, 1)
    }
}

private extension Text {
    /// Render assistant text as inline-styled markdown; fall back to plain text
    /// (AttributedString throws on some malformed markdown).
    init(markdown: String) {
        if let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            self.init(attributed)
        } else {
            self.init(verbatim: markdown)
        }
    }
}
