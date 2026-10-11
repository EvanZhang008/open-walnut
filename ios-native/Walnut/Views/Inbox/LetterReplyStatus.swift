import Foundation

/// The line under the human's own reply in a letter thread: who it went to, when,
/// and how far it got. Pure, so every state's copy is unit-tested.
///
/// It names a recipient and a time because "Sent" alone was the report: the old
/// line said "Sent to the agent" for every outcome, sat under the whole thread
/// rather than under the reply, and was gone after the letter was reopened. The
/// words come from the delivery the server RECORDED on the turn, so they are the
/// same after a reopen.
struct LetterReplyStatus: Equatable {
    enum Tone: Equatable {
        /// It went where it was going.
        case settled
        /// On its way, or held for a moment the agent controls.
        case waiting
        /// Kept in the letter, but nothing went to an agent (no session left to
        /// answer). Its own look, because it must never read as a success.
        case held
        /// The phone lost the answer: the reply may or may not be on record.
        case unconfirmed
        /// Nothing reached the agent. Offers a way forward.
        case problem
    }

    let text: String
    let tone: Tone
    /// Tapping the line opens this session's conversation. nil = not tappable.
    let sessionId: String?
    let offersRetry: Bool
    let offersEdit: Bool
    /// A Retry of this line is on its way: the button row stays, at the same
    /// height, with progress in place of the buttons (see `busy(recipient:)`).
    var isBusy = false
    /// While busy: the words the line held when its Retry went out, kept only
    /// for their size, so the line does not change height under the finger.
    var reservedText: String?

    /// The recipient's name when nothing better is known.
    static let unknownRecipient = "the agent"

    /// Longest recipient name the line carries before an ellipsis.
    static let recipientLimit = 60

    // MARK: - States

    /// A reply the server has on record, with the delivery it recorded (or, from
    /// an older server, the one its response carried).
    static func recorded(
        _ delivery: LetterDelivery, recipient: String, at: Date?,
        canRetry: Bool, now: Date = AppClock.now(), calendar: Calendar = .current
    ) -> LetterReplyStatus {
        let when = at.map { " · " + timeLabel($0, now: now, calendar: calendar) } ?? ""
        let session = delivery.sessionId.flatMap { $0.isEmpty ? nil : $0 }
        switch delivery.status {
        case "queued", "delivered":
            return .init(text: "Sent to \(recipient)\(when)", tone: .settled,
                         sessionId: session, offersRetry: false, offersEdit: false)
        case "deferred":
            return .init(
                text: "Queued for \(recipient)\(when). It is waiting on a permission prompt, and your reply reaches it after that.",
                tone: .waiting, sessionId: session, offersRetry: false, offersEdit: false
            )
        case "skipped":
            let why: String
            switch delivery.reason {
            case "no_origin_session": why = "This letter has no agent session to answer, so nothing was sent."
            case "origin_session_gone": why = "The agent that wrote this letter has ended, so nothing was sent."
            default: why = "Nothing was sent to the agent."
            }
            // Not tappable: there is no session left to open.
            return .init(text: "Saved\(when). \(why)", tone: .held,
                         sessionId: nil, offersRetry: false, offersEdit: false)
        case "failed":
            return .init(
                text: failedText(recipient: recipient, when: when),
                tone: .problem, sessionId: session, offersRetry: canRetry, offersEdit: false
            )
        case "pending":
            // On record, still being delivered: the server says so on the turn.
            return .sending(recipient: recipient)
        default:
            return .init(text: "Saved\(when)", tone: .held,
                         sessionId: nil, offersRetry: false, offersEdit: false)
        }
    }

    /// Handed to the server, no answer yet; or on record with its delivery still
    /// running (the phone re-reads the letter until the outcome is in).
    static func sending(recipient: String) -> LetterReplyStatus {
        .init(text: "Sending to \(recipient)…", tone: .waiting,
              sessionId: nil, offersRetry: false, offersEdit: false)
    }

    /// The request failed in a way that proves nothing reached the server: the
    /// words stay in the thread with Retry and Edit.
    static func sendFailed(_ sentence: String) -> LetterReplyStatus {
        .init(text: "Not sent. \(sentence)", tone: .problem,
              sessionId: nil, offersRetry: true, offersEdit: true)
    }

    /// The answer was lost (a timeout, a dropped connection), or the delivery
    /// never reported back while the phone kept checking: the server may have
    /// recorded the reply and passed it on. Retry is safe because it reuses the
    /// reply's id; Edit is not offered, because an edited reply goes out under a
    /// new id and the agent would read it twice. A turn with no id (a decision
    /// answer, a reply from the console) has no safe Retry, so none is offered.
    static func unconfirmed(recipient: String, canRetry: Bool = true) -> LetterReplyStatus {
        .init(
            text: canRetry
                ? "Not confirmed. It may have reached \(recipient). Retry is safe, it will not send twice."
                : "Not confirmed. It may have reached \(recipient).",
            tone: .unconfirmed, sessionId: nil, offersRetry: canRetry, offersEdit: false
        )
    }

    /// A recorded turn whose delivery failed, and whose Retry failed too. The
    /// reply is still on record, so there is nothing to edit back out. The same
    /// words as before the Retry, so the line does not change size under the
    /// finger that tapped it; why the Retry failed goes to the log.
    static func retryFailed(
        recipient: String, at: Date?, sessionId: String?,
        now: Date = AppClock.now(), calendar: Calendar = .current
    ) -> LetterReplyStatus {
        let when = at.map { " · " + timeLabel($0, now: now, calendar: calendar) } ?? ""
        return .init(text: failedText(recipient: recipient, when: when), tone: .problem,
                     sessionId: sessionId, offersRetry: true, offersEdit: false)
    }

    /// This line while its Retry is on the way: it says what is happening now,
    /// "Sending to ...", in the space the old words took, with progress in place
    /// of the buttons, so nothing under it moves. The red failure above a
    /// "Sending" row read as two opposite states at once (2026-09-29 gate, r4).
    func busy(recipient: String) -> LetterReplyStatus {
        guard offersRetry || offersEdit else { return self }
        return .init(
            text: Self.sending(recipient: recipient).text, tone: .waiting, sessionId: nil,
            offersRetry: offersRetry, offersEdit: offersEdit, isBusy: true, reservedText: text
        )
    }

    /// The same line without a way into the session: for a session this phone
    /// cannot open, so a tap never ends in "couldn't open".
    func withoutSession() -> LetterReplyStatus {
        .init(text: text, tone: tone, sessionId: nil, offersRetry: offersRetry, offersEdit: offersEdit,
              isBusy: isBusy, reservedText: reservedText)
    }

    /// Whether a tap on the line opens the session. Never while Retry or Edit
    /// are offered: those sit right under the line, and a tap that just misses
    /// one of them must not open a different screen.
    var opensSession: Bool { sessionId != nil && !offersRetry && !offersEdit }

    // MARK: - Pieces

    private static func failedText(recipient: String, when: String) -> String {
        "Not sent to \(recipient)\(when). Your reply is saved in this letter."
    }

    /// Who the line names. The tasks store's title first (it is the live name the
    /// Tasks tab shows), then the title the server stamped on the letter when it
    /// was sent, then "the agent".
    static func recipientName(storeTitle: String?, stampedTitle: String?) -> String {
        for candidate in [storeTitle, stampedTitle] {
            let line = Letter.oneLine(candidate ?? "", limit: recipientLimit)
            if !line.isEmpty { return line }
        }
        return unknownRecipient
    }

    /// "1:46 PM" today, "Sep 27, 1:46 PM" on any other day.
    static func timeLabel(_ date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
