import SwiftUI

/// One chat entry — user bubble (right, walnut tint), assistant rich markdown
/// (left), a system-notification card, or a small grey chip for tool/thinking
/// history rows. Failed sends render as a red-outlined bubble with a retry
/// affordance (`onRetry` / `onDiscard` supplied by the owning view).
struct MessageRow: View {
    let message: ChatMessage
    var onRetry: (() -> Void)? = nil
    var onDiscard: (() -> Void)? = nil

    var body: some View {
        switch message.kind {
        case .tool:
            chip(icon: "wrench.and.screwdriver", text: message.text)
        case .thinking:
            chip(icon: "sparkles", text: message.text)
        case .notification:
            NotificationCard(message: message)
        case nil:
            if message.isUser {
                userBubble
            } else {
                assistantText
            }
        }
    }

    /// Soft-tint bubble with primary text (Claude-app style) — the old
    /// saturated brown block read as a wall of color on long messages and
    /// crushed CJK legibility in dark mode.
    private var userBubble: some View {
        let failed = message.failed == true
        return VStack(alignment: .trailing, spacing: 4) {
            if let images = message.localImages, !images.isEmpty {
                attachedImages(images, dimmed: message.pending == true)
            }
            if !message.text.isEmpty {
                HStack {
                    Spacer(minLength: 48)
                    Text(message.text)
                        .font(.body)
                        .lineSpacing(3)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            failed ? Theme.danger.opacity(0.08) : Theme.tintSoft,
                            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                        )
                        .overlay {
                            if failed {
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .strokeBorder(Theme.danger.opacity(0.5), lineWidth: 1)
                            }
                        }
                        .opacity(message.pending == true ? 0.65 : 1)
                        .textSelection(.enabled)
                        .contextMenu {
                            if failed {
                                if let onRetry {
                                    Button { onRetry() } label: { Label("Retry", systemImage: "arrow.clockwise") }
                                }
                                Button { UIPasteboard.general.string = message.text } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                                if let onDiscard {
                                    Button(role: .destructive) { onDiscard() } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            } else {
                                Button { UIPasteboard.general.string = message.text } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                            }
                        }
                }
            }
            if failed {
                Button {
                    onRetry?()
                } label: {
                    Label("Not sent — tap to retry", systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
                .accessibilityIdentifier("chat.retryFailed")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
    }

    /// Thumbnails for images attached to a sent user message (local to this app
    /// session — historical messages carry none). Right-aligned above the text,
    /// each rounded and capped at ~200pt so a tall photo can't dominate.
    private func attachedImages(_ datas: [Data], dimmed: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Spacer(minLength: 48)
            ForEach(Array(datas.enumerated()), id: \.offset) { _, data in
                if let image = UIImage(data: data) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 200, maxHeight: 200)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
        .opacity(dimmed ? 0.65 : 1)
    }

    /// Assistant replies render as full block markdown (headings, lists, code,
    /// tables) via the same parser the Notes reader uses — not inline-only.
    private var assistantText: some View {
        HStack {
            ChatMarkdownBody(text: message.text)
            Spacer(minLength: 32)
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

/// Block-level markdown body for chat. Short plain texts skip the parser and
/// render as a single inline-markdown Text (cheaper for the common case).
struct ChatMarkdownBody: View {
    let text: String

    var body: some View {
        if Self.isBlockMarkdown(text) {
            MarkdownView(blocks: MarkdownParser.parse(text))
        } else {
            Text(inline: text)
                .textSelection(.enabled)
        }
    }

    /// Heuristic: does this text carry block-level constructs worth the parser?
    static func isBlockMarkdown(_ text: String) -> Bool {
        guard text.contains("\n") else { return false }
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let t = line.drop(while: { $0 == " " })
            if t.hasPrefix("#") || t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("> ")
                || t.hasPrefix("```") || t.hasPrefix("|") || t.hasPrefix("1. ") {
                return true
            }
        }
        return false
    }
}

/// System-generated notification (session error, cron result, …) rendered as a
/// distinct card — colored left bar + badge header + markdown body — mirroring
/// the web console's notification styling instead of dumping raw text.
struct NotificationCard: View {
    let message: ChatMessage
    @State private var expanded = false

    /// Body longer than this starts collapsed (like the console's auto-collapse).
    private static let collapseThreshold = 280

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                header
                bodyText
            }
            .padding(.leading, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(accent.opacity(0.25), lineWidth: 0.5)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 3)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: iconName)
                .font(.caption2.weight(.semibold))
            Text(badgeLabel)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
            Spacer(minLength: 0)
            if isCollapsible {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
            }
        }
        .foregroundStyle(accent)
        .contentShape(Rectangle())
        .onTapGesture {
            guard isCollapsible else { return }
            withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
        }
    }

    @ViewBuilder
    private var bodyText: some View {
        if isCollapsible && !expanded {
            Text(inline: Self.firstMeaningfulLine(displayText))
                .font(.subheadline)
                .lineLimit(2)
                .foregroundStyle(.secondary)
        } else {
            ChatMarkdownBody(text: displayText)
                .font(.subheadline)
        }
    }

    private var isCollapsible: Bool { message.text.count > Self.collapseThreshold }

    /// Strip the leading "**Session Error** (…):" boilerplate — the badge
    /// already says what this is; the body should start with the substance.
    private var displayText: String {
        var text = message.text
        for prefix in ["**Session Error**", "**Session Result**", "**Session Delivery Failed**",
                       "**Subagent Error**", "**Subagent Result**", "**Agent Error**", "**Cron**"] {
            if text.hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count))
                // Drop the "(Task Label)" + ":" connective after the bold tag.
                if let colon = text.firstIndex(of: ":"), text.distance(from: text.startIndex, to: colon) < 120 {
                    let head = text[text.startIndex..<colon].trimmingCharacters(in: .whitespaces)
                    let rest = String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if head.isEmpty { return rest }
                    if head.hasPrefix("("), head.hasSuffix(")") {
                        let label = String(head.dropFirst().dropLast())
                        return rest.isEmpty ? label : "\(label) — \(rest)"
                    }
                }
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return text
    }

    static func firstMeaningfulLine(_ text: String) -> String {
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty && t != "---" { return t }
        }
        return text
    }

    private var isError: Bool {
        message.source == "session-error" || message.source == "agent-error"
            || message.text.contains("**Session Error**") || message.text.contains("**Subagent Error**")
    }

    private var accent: Color { isError ? Theme.danger : Theme.tint }

    private var iconName: String {
        switch message.source {
        case "session-error", "agent-error": return "exclamationmark.triangle.fill"
        case "cron": return "clock.badge.checkmark"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        case "session": return "checkmark.seal"
        case "interrupt": return "stop.circle"
        default: return isError ? "exclamationmark.triangle.fill" : "bell"
        }
    }

    private var badgeLabel: String {
        switch message.source {
        case "session-error": return "Session error"
        case "agent-error": return "Agent error"
        case "cron": return "Scheduled"
        case "compaction": return "Compacted"
        case "session": return "Session result"
        case "subagent": return "Subagent"
        case "interrupt": return "Interrupted"
        default: return "Notification"
        }
    }
}

extension Text {
    /// Render text as inline-styled markdown; fall back to plain text
    /// (AttributedString throws on some malformed markdown).
    init(inline: String) {
        if let attributed = try? AttributedString(
            markdown: inline,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            self.init(attributed)
        } else {
            self.init(verbatim: inline)
        }
    }
}
