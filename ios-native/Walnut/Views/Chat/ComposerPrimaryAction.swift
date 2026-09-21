/// What the composer's trailing button does right now.
///
/// ONE seat, never two: a stop that sits beside the send arrow makes the row's
/// width jump when a turn starts, and a stop in the navigation bar (where this
/// used to live) is nowhere near the thumb that just sent the message.
///
/// What the seat holds is decided by whether there is anything to SEND, not by
/// whether a turn is running. An empty composer has nothing to send, so the seat
/// belongs to stop; typed text has somewhere to go even mid-turn, because the
/// store banks it and delivers it when the turn settles. The earlier rule gave
/// stop the seat unconditionally, which left a user who had just dictated a
/// paragraph with no send button at all ("he is talking and I have no way to
/// send").
///
/// A decision rather than a chain of `if`s in the view because the interesting
/// cases are the ones that are easy to get backwards — a turn is running AND the
/// agent is blocked on a question, so the composer is the ANSWER field and must
/// still send.
enum ComposerPrimaryAction: Equatable {
    case send
    case stop
    /// Present but dead. The row only shows the button at all when there is
    /// content or a turn to stop, so this is the greyed-out send: something is
    /// typed, and the composer cannot take it yet (offline, or a busy composer
    /// with nothing to interrupt).
    case disabled

    /// `busyAcceptsSend` is whether this composer's OWNER can hold a send made
    /// while it is busy. Deliberately a parameter with no default: the chat store
    /// banks a mid-turn send, but the new-session launcher is `busy` while it
    /// CREATES a session and a second send there creates a second session, so
    /// getting this wrong in either direction is a real defect and no call site
    /// should be able to inherit an answer it did not think about.
    static func decide(
        busy: Bool, hasContent: Bool, pendingQuestion: Bool, busyAcceptsSend: Bool
    ) -> ComposerPrimaryAction {
        // Answering outranks stopping: the turn that asked the question is
        // waiting on this very field, so offering "stop" instead of "send" here
        // would hide the only control that unblocks it.
        if pendingQuestion { return hasContent ? .send : .disabled }
        // Stop only takes the seat when there is nothing to send. A composer whose
        // owner banks the words keeps its send button mid-turn; one whose owner does
        // not falls through to stop, and `availableWithStop` greys that out when
        // there is no turn behind it to abort.
        if busy { return hasContent && busyAcceptsSend ? .send : .stop }
        return hasContent ? .send : .disabled
    }

    /// Resolve against whether this composer can actually stop anything. The
    /// new-session launcher is `busy` while it creates a session, and there is
    /// no turn behind that to abort, so it keeps the greyed send it always had.
    func availableWithStop(_ canStop: Bool) -> ComposerPrimaryAction {
        self == .stop && !canStop ? .disabled : self
    }
}
