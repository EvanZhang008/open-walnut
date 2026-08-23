import SwiftUI

/// One envelope in the inbox list: unread dot, pin marker, subject, the
/// system-stamped sender line (session · task · host), the agent's own short
/// preview, a type badge, and relative time.
///
/// Everything shown here comes off the index record, so the list renders with
/// no body fetch at all — a letter's document is read only when it is opened.
struct LetterEnvelopeRow: View {
    let letter: Letter

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            unreadDot
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if letter.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                    }
                    Text(letter.subject.isEmpty ? "(no subject)" : letter.subject)
                        .font(.body.weight(letter.isRead ? .regular : .semibold))
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    if let when = letter.createdDate {
                        Text(when.formatted(.relative(presentation: .named)))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                Text(senderLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if !letter.previewLine.isEmpty {
                    Text(letter.previewLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: 6) {
                    typeBadge
                    chip(letter.hostLabel, icon: letter.hostLabel == "Mac" ? "laptopcomputer" : "server.rack")
                    if letter.answered != nil {
                        chip("Answered", icon: "checkmark")
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityIdentifier("inbox.row.\(letter.id)")
    }

    /// Sender first (that is who wrote it), task second — the two facts that
    /// make a letter self-locating without opening it.
    private var senderLine: String {
        if let task = letter.taskTitle {
            return "\(letter.senderName) · \(task)"
        }
        return letter.senderName
    }

    @ViewBuilder
    private var unreadDot: some View {
        if letter.isRead {
            Circle().fill(.clear).frame(width: 8, height: 8)
        } else {
            Circle().fill(Theme.tint).frame(width: 8, height: 8)
                .accessibilityIdentifier("inbox.row.unread")
        }
    }

    private var typeBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: letter.kind.symbol).font(.system(size: 9))
            Text(letter.kind.label).font(.caption2.weight(.medium))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(badgeTint.opacity(0.15), in: Capsule())
        .foregroundStyle(badgeTint)
    }

    /// An unanswered decision is the only letter type that is *blocking*, so it
    /// is the only one that gets a warning colour.
    private var badgeTint: Color {
        letter.isAwaitingDecision ? Theme.warning : Color.secondary
    }

    private func chip(_ text: String, icon: String?) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon).font(.system(size: 9))
            }
            Text(text).font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .foregroundStyle(.secondary)
    }
}
