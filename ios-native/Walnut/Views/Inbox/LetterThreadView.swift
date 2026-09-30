import SwiftUI

/// The letter's conversation: the human's answers and replies, and whatever the
/// origin agent wrote back. Rendered under the body, oldest first, because a
/// letter thread is a short record to read in order, not a chat to scroll.
///
/// A turn can be plain text or carry a rich body of its own (an agent replying
/// with `wn tools call human_inbox_reply --markdown`), and the rich body goes
/// through the same two renderers the letter body uses.
///
/// Under each of the human's own turns sits its status line (`LetterReplyStatus`):
/// who it went to, when, and how far it got, tappable into that session. Replies
/// the server does not have yet (on their way, or refused) are pending bubbles
/// with the same line, in send order with the recorded turns (`LetterThreadItem`),
/// and a refused one keeps its words there with Retry and Edit until the human
/// decides.
struct LetterThreadView: View {
    let letter: Letter
    var pending: [LetterReplyStore.PendingReply] = []
    /// The status line for a recorded human turn, nil for none.
    var status: (LetterThreadEntry) -> LetterReplyStatus? = { _ in nil }
    /// The status line for a pending reply.
    var pendingStatus: (LetterReplyStore.PendingReply) -> LetterReplyStatus = { _ in
        .sending(recipient: LetterReplyStatus.unknownRecipient)
    }
    var onOpenSession: (String) -> Void = { _ in }
    var onRetryTurn: (LetterThreadEntry) -> Void = { _ in }
    var onRetryPending: (String) -> Void = { _ in }
    var onEditPending: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text("Thread")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(LetterThreadItem.ordered(entries: letter.threadEntries, pending: pending)) { item in
                VStack(alignment: .leading, spacing: 5) {
                    switch item {
                    case .turn(let entry):
                        turn(entry)
                        if entry.isHuman, let line = status(entry) {
                            LetterReplyStatusLine(
                                status: line,
                                onOpenSession: onOpenSession,
                                onRetry: { onRetryTurn(entry) },
                                onEdit: {}
                            )
                        }
                    case .pending(let reply):
                        pendingBubble(reply)
                        LetterReplyStatusLine(
                            status: pendingStatus(reply),
                            onOpenSession: onOpenSession,
                            onRetry: { onRetryPending(reply.id) },
                            onEdit: { onEditPending(reply.id) }
                        )
                    }
                }
                // What a Send scrolls to: this reply and its status line.
                .id(item.id)
            }
        }
        // `.contain` first: an identifier on a plain container is stamped onto
        // every child, which erased the turn and status-line identifiers.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.letter.thread")
    }

    private func header(isHuman: Bool, date: Date?) -> some View {
        HStack(spacing: 5) {
            Image(systemName: isHuman ? "person.fill" : "sparkles")
                .font(.system(size: 9))
            Text(isHuman ? "You" : "Agent")
                .font(.caption2.weight(.semibold))
            if let date {
                Text(date.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(.secondary)
    }

    private func turn(_ entry: LetterThreadEntry) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            header(isHuman: entry.isHuman, date: entry.date)

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
                    .accessibilityIdentifier(entry.isHuman ? "inbox.letter.humanTurn" : "inbox.letter.agentTurn")
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

    /// A reply the server does not have yet: the human's words, as they will read
    /// once recorded, so the bubble does not jump when the recorded turn replaces it.
    private func pendingBubble(_ reply: LetterReplyStore.PendingReply) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            header(isHuman: true, date: reply.createdAt)
            Text(reply.text)
                .font(.callout)
                .textSelection(.enabled)
                .accessibilityIdentifier("inbox.letter.pendingReply")
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(reply.state == .sending ? 0.7 : 1)
    }
}

/// One row of the thread: a recorded turn, or a reply the server does not have
/// yet.
///
/// ONE list, in the order things were sent. Pending replies used to follow every
/// recorded turn, so a new reply, recorded at once, rendered ABOVE an older
/// refused reply still waiting as pending (2026-09-29 gate, P1-B). Ordering them
/// by time then compared two clocks, the phone's send time and the server's
/// record time: with the server 10s behind the phone, a reply sent 3s after a
/// refused one rendered above it (r4 gate, P2-1).
///
/// So a pending reply is placed by SEQUENCE, never by a clock: right after the
/// recorded turns that were on record when it was sent (`afterTurns`), and after
/// the replies pending before it (the store keeps them in send order; a Retry of
/// a refused reply is a new send and moves it last). The thread is append-only,
/// so when the server records the reply it lands in that same slot, and its row
/// keeps its identity (`reply-<clientId>` in both forms).
enum LetterThreadItem: Identifiable, Equatable {
    case turn(LetterThreadEntry)
    case pending(LetterReplyStore.PendingReply)

    var id: String {
        switch self {
        case .turn(let entry): return entry.clientId.map { "reply-\($0)" } ?? "turn-\(entry.id)"
        case .pending(let reply): return "reply-\(reply.id)"
        }
    }

    var isHuman: Bool {
        switch self {
        case .turn(let entry): return entry.isHuman
        case .pending: return true
        }
    }

    /// Recorded turns in the server's order, each pending reply in its slot (see
    /// the type's note). A pending reply whose `clientId` is already on record is
    /// dropped: the recorded turn is the same reply.
    static func ordered(
        entries: [LetterThreadEntry], pending: [LetterReplyStore.PendingReply]
    ) -> [LetterThreadItem] {
        let recordedIds = Set(entries.compactMap(\.clientId))
        // (slot, reply): the reply goes before entries[slot]. Slots never go
        // down along the send order, so a later reply is never above an earlier one.
        var slotted: [(slot: Int, reply: LetterReplyStore.PendingReply)] = []
        var floor = 0
        for reply in pending where !recordedIds.contains(reply.id) {
            let own = reply.afterTurns ?? legacySlot(reply, in: entries)
            let slot = min(max(own, floor), entries.count)
            floor = slot
            slotted.append((slot, reply))
        }
        var out: [LetterThreadItem] = []
        out.reserveCapacity(entries.count + slotted.count)
        var next = 0
        for (index, entry) in entries.enumerated() {
            while next < slotted.count, slotted[next].slot <= index {
                out.append(.pending(slotted[next].reply))
                next += 1
            }
            out.append(.turn(entry))
        }
        out.append(contentsOf: slotted[next...].map { .pending($0.reply) })
        return out
    }

    /// A reply saved before `afterTurns` existed: after the turns recorded no
    /// later than it was sent (a tie goes to the recorded turn).
    private static func legacySlot(_ reply: LetterReplyStore.PendingReply, in entries: [LetterThreadEntry]) -> Int {
        let sent = reply.createdAt.timeIntervalSince1970 * 1000
        return entries.firstIndex { ($0.at ?? 0) > sent } ?? entries.count
    }
}

/// One reply's status line, and under it the Retry and Edit a refused reply
/// offers.
///
/// The line opens the session only when it is the one thing to tap: never while
/// Retry or Edit are shown, because they sit right under it and a tap that just
/// misses one of them must not open a different screen. Retry and Edit are 44pt
/// targets, apart from the line.
///
/// Text colours clear 4.5:1 on the page in light and dark: the system label
/// colour for a reply that went (secondaryLabel measured 3.44:1), and darker
/// shades of the red and amber for the lines that need a look (system red
/// measured 3.55:1). Measured values are in `StatusInk`.
struct LetterReplyStatusLine: View {
    let status: LetterReplyStatus
    let onOpenSession: (String) -> Void
    let onRetry: () -> Void
    let onEdit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The label is the sentence alone: the glyphs are decoration, and a
            // symbol's own spoken name ("checkmark") must not lead the line.
            if status.opensSession, let sessionId = status.sessionId {
                Button {
                    onOpenSession(sessionId)
                } label: {
                    line(tappable: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(status.text)
                .accessibilityHint("Opens the agent's session")
                .accessibilityIdentifier("inbox.letter.replyStatus")
            } else {
                line(tappable: false)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(status.text)
                    .accessibilityIdentifier("inbox.letter.replyStatus")
            }
            if status.offersRetry || status.offersEdit {
                Group {
                    if status.isBusy {
                        // The row keeps the buttons' exact size while their Retry
                        // is on the way, so nothing under it moves. Progress only:
                        // the line above already says "Sending to ...".
                        buttons.hidden().overlay(alignment: .leading) {
                            ProgressView()
                                .controlSize(.small)
                                .padding(.leading, 14)
                                .accessibilityLabel("Sending")
                                .accessibilityIdentifier("inbox.letter.replyRetrying")
                        }
                    } else {
                        buttons
                    }
                }
                .padding(.leading, 12)
            }
        }
        .padding(.horizontal, 4)
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            if status.offersRetry {
                ActionCapsuleButton(title: "Retry", identifier: "inbox.letter.replyRetry", action: onRetry)
            }
            if status.offersEdit {
                ActionCapsuleButton(title: "Edit", prominent: false, identifier: "inbox.letter.replyEdit", action: onEdit)
            }
        }
    }

    private func line(tappable: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(iconColor)
                .accessibilityHidden(true)
            // A busy line keeps the height of the words it replaced.
            ZStack(alignment: .topLeading) {
                if let reserved = status.reservedText {
                    Text(reserved)
                        .font(.caption)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .accessibilityHidden(true)
                }
                Text(status.text)
                    .font(.caption)
                    .foregroundStyle(textColor)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if tappable {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(iconColor)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var icon: String {
        switch status.tone {
        case .settled: return "checkmark.circle"
        case .waiting: return "clock"
        case .held: return "tray.full"
        case .unconfirmed: return "questionmark.circle"
        case .problem: return "exclamationmark.circle"
        }
    }

    private var textColor: Color {
        switch status.tone {
        case .settled, .waiting: return Color(.label)
        case .held, .unconfirmed: return StatusInk.amber
        case .problem: return StatusInk.red
        }
    }

    private var iconColor: Color {
        switch status.tone {
        case .settled, .waiting: return .secondary
        case .held, .unconfirmed: return StatusInk.amber
        case .problem: return StatusInk.red
        }
    }
}

/// Text colours for the status lines that need a look, dark enough for small
/// text. Contrast against the page (white / black), WCAG 2 relative luminance:
///   red    light #C4221A 5.9:1, dark #FF6B61 7.5:1
///   amber  light #8A5A00 5.9:1, dark #FFB340 11.8:1
enum StatusInk {
    static let red = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1, green: 0x6B / 255, blue: 0x61 / 255, alpha: 1)
            : UIColor(red: 0xC4 / 255, green: 0x22 / 255, blue: 0x1A / 255, alpha: 1)
    })
    static let amber = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1, green: 0xB3 / 255, blue: 0x40 / 255, alpha: 1)
            : UIColor(red: 0x8A / 255, green: 0x5A / 255, blue: 0, alpha: 1)
    })
}
