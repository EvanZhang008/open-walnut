import SwiftUI

/// One envelope in the inbox list: unread dot, pin marker, who it is from
/// (`LetterOriginBadge`, first), the subject, the agent's own short preview,
/// a type badge, and relative time.
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
    /// The list's Select mode (`InboxView` hands its edit mode down).
    @Environment(\.editMode) private var editMode

    private var isSelecting: Bool { editMode?.wrappedValue.isEditing == true }

    /// The preview line as the inline markdown renderer draws it: the same pass
    /// every other agent text takes (`MarkdownParser.inline`).
    static func preview(_ line: String) -> AttributedString {
        MarkdownParser.inline(line)
    }

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
                // Who it is from leads the row, in Walnut's tint: a letter is
                // never outside mail, whatever company its subject names.
                HStack(alignment: .center, spacing: 5) {
                    if letter.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                    }
                    LetterOriginBadge(origin: letter.resolvedOrigin)
                    if !timeUnderSubject {
                        Spacer(minLength: 6)
                        relativeTime
                    }
                }

                Text(letter.subject.isEmpty ? "(no subject)" : letter.subject)
                    .font(.body.weight(letter.isRead ? .regular : .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(timeUnderSubject ? 6 : 3)
                if timeUnderSubject { relativeTime }

                if !letter.previewLine.isEmpty {
                    // The agent's own words, through the shared inline renderer (task,
                    // file, URL and letter links), and a link opens what it names instead
                    // of the row opening the letter. In Select mode a tap selects the
                    // row, so the links step aside.
                    Text(Self.preview(letter.previewLine))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .allowsHitTesting(!isSelecting)
                        .handlingFilePathLinks(source: letter.linkSource)
                }

                HStack(spacing: 6) {
                    if Self.showsTypeBadge(letter) { typeBadge }
                    chip(letter.hostLabel, icon: letter.hostLabel == "Mac" ? "laptopcomputer"
                         : letter.hostLabel == Letter.unknownHostLabel ? "questionmark.circle" : "server.rack")
                    if let answer = letter.answered {
                        chip(answer.by.map { "Answered by \($0.displayName)" } ?? "Answered", icon: "checkmark")
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
            // One line (two at accessibility sizes): a task's name may run to 200 characters.
            Text(text).font(.caption2).lineLimit(timeUnderSubject ? 2 : 1).truncationMode(.tail)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .foregroundStyle(.secondary)
    }
}
