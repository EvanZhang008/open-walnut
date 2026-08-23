import SwiftUI

/// The letter's conversation: the human's answers and replies, and whatever the
/// origin agent wrote back. Rendered under the body, oldest first, because a
/// letter thread is a short record to read in order, not a chat to scroll.
///
/// A turn can be plain text or carry a rich body of its own (an agent replying
/// with `wn tools call human_inbox_reply --markdown`), and the rich body goes
/// through the same two renderers the letter body uses.
struct LetterThreadView: View {
    let letter: Letter

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text("Thread")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(letter.threadEntries) { entry in
                turn(entry)
            }
        }
        .accessibilityIdentifier("inbox.letter.thread")
    }

    private func turn(_ entry: LetterThreadEntry) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: entry.isHuman ? "person.fill" : "sparkles")
                    .font(.system(size: 9))
                Text(entry.isHuman ? "You" : "Agent")
                    .font(.caption2.weight(.semibold))
                if let when = entry.date {
                    Text(when.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(.secondary)

            if let body = entry.body, !body.isEmpty {
                if entry.isHTMLBody {
                    LetterHTMLBody(html: body)
                } else {
                    // Same remote-image block as the letter body — a thread turn
                    // is agent-authored text too.
                    LetterMarkdownBody(markdown: body)
                }
            } else if let text = entry.text, !text.isEmpty {
                Text(text)
                    .font(.callout)
                    .textSelection(.enabled)
            } else if entry.bodyFile != nil {
                // The index kept the turn but its body file is gone. Say so
                // rather than rendering an empty card.
                Text("This reply's body is no longer on disk.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            entry.isHuman ? Color(.secondarySystemBackground) : Theme.tintSoft,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }
}
