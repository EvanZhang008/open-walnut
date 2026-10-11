import SwiftUI

/// One envelope in the inbox list: unread dot, pin marker, subject, the
/// system-stamped sender line (session · task · host), the agent's own short
/// preview, a type badge, and relative time.
///
/// Unread reads at a glance, the same way the console marks it: a filled tint
/// dot leading the row, and the subject in semibold primary ink (a read row's
/// subject is regular weight). VoiceOver hears "Unread" first.
///
/// Everything shown here comes off the index record, so the list renders with
/// no body fetch at all — a letter's document is read only when it is opened.
struct LetterEnvelopeRow: View {
    let letter: Letter

    /// Diameter of the unread dot. 10pt: the 8pt dot in the walnut tint read as a
    /// bullet rather than a state on a phone held at arm's length.
    static let unreadDotSize: CGFloat = 10

    @Environment(\.dynamicTypeSize) private var typeSize

    /// At an accessibility text size the relative time leaves the subject's line
    /// and goes under it: side by side, measured at the largest size on the pinned
    /// simulator, the time column left the subject about three letters a line
    /// ("Wee / kly / dig...").
    private var timeUnderSubject: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            unreadDot
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if letter.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                    }
                    Text(letter.subject.isEmpty ? "(no subject)" : letter.subject)
                        .font(.body.weight(letter.isRead ? .regular : .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(timeUnderSubject ? 6 : 3)
                    if !timeUnderSubject {
                        Spacer(minLength: 6)
                        relativeTime
                    }
                }
                if timeUnderSubject { relativeTime }

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
                    if Self.showsTypeBadge(letter) { typeBadge }
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

    @ViewBuilder
    private var relativeTime: some View {
        if let when = letter.createdDate {
            Text(AppClock.relativeNamed(when))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    /// Sender first (that is who wrote it), task second — the two facts that
    /// make a letter self-locating without opening it.
    private var senderLine: String {
        if let task = letter.taskTitle {
            return "\(letter.senderName) · \(task)"
        }
        return letter.senderName
    }

    /// A read row keeps the dot's width so every subject starts at one edge.
    @ViewBuilder
    private var unreadDot: some View {
        if letter.isRead {
            Color.clear
                .frame(width: Self.unreadDotSize, height: Self.unreadDotSize)
                .accessibilityHidden(true)
        } else {
            Circle().fill(Theme.tint)
                .frame(width: Self.unreadDotSize, height: Self.unreadDotSize)
                .accessibilityLabel("Unread")
                .accessibilityIdentifier("inbox.row.unread")
        }
    }

    /// An answered decision no longer needs action, so its row shows "Answered"
    /// alone, as the reader's title does (`LetterReaderView.title(for:)`).
    /// Every other kind keeps its badge.
    static func showsTypeBadge(_ letter: Letter) -> Bool {
        !(letter.kind == .actionRequired && letter.answered != nil)
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
