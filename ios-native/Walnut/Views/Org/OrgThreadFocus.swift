import SwiftUI

/// One request to show a thread on a node's Threads page: which thread, and when it was asked.
/// Two taps on the same thread are two requests (`at` differs), so each one reveals it again.
struct OrgThreadFocus: Hashable {
    let threadId: String
    let at: Date
}

/// What an Org node's page does with an open request (a thread push, a link). A request can come
/// for the node whose page is already on screen: the page takes it from `OrgNodePageLink` and
/// applies it itself, once per request time (2026-11-06 gate: a second push for the same node
/// changed nothing on screen). Pure; pinned in `OrgThreadFocusTests`.
enum OrgNodePageFocusModel {
    struct State: Equatable {
        var tab: OrgNodeTab
        /// The thread the last request asked for: shown open, scrolled to and marked.
        var focus: OrgThreadFocus?
        /// The time of the request this page applied last; nil for a page the bar opened.
        var appliedAt: Date?
    }

    static func initial(_ route: OrgNodeRoute) -> State {
        State(tab: route.tab, focus: focus(of: route), appliedAt: route.requestedAt)
    }

    static func focus(of route: OrgNodeRoute) -> OrgThreadFocus? {
        guard let id = route.threadId, !id.isEmpty else { return nil }
        return OrgThreadFocus(threadId: id, at: route.requestedAt ?? .distantPast)
    }

    /// The page's state once `route` came in for the page already shown, or nil when it is no new
    /// request: the same one again, an older one, or a route that carries no request time.
    static func apply(_ route: OrgNodeRoute, to state: State) -> State? {
        guard let at = route.requestedAt else { return nil }
        return apply(tab: route.tab, threadId: route.threadId, at: at, to: state)
    }

    /// The same for a request taken from `OrgNodePageLink` by the page on screen.
    static func apply(_ request: OrgNodePageLink.Request, to state: State) -> State? {
        apply(tab: request.tab, threadId: request.threadId, at: request.at, to: state)
    }

    private static func apply(tab: OrgNodeTab, threadId: String?, at: Date, to state: State) -> State? {
        if let applied = state.appliedAt, at <= applied { return nil }
        let focus = threadId.flatMap { $0.isEmpty ? nil : OrgThreadFocus(threadId: $0, at: at) }
        return State(tab: tab, focus: focus, appliedAt: at)
    }

    /// What stays over the page once a request came in. A request the page applied takes down
    /// what it put over itself (a task's session opened from Tasks, a Follow up composer): the
    /// view it brought forward, its thread revealed, must be what he sees. A request it did not
    /// apply (another node's, the same one again) leaves it as it was.
    static func cover(_ cover: OrgNodePageCover?, after applied: State?) -> OrgNodePageCover? {
        applied == nil ? cover : nil
    }
}

/// What an Org node's page shows over itself, one at a time: a task's session opened from a
/// Tasks row or a thread card's task chip, or a thread's Follow up composer. The page owns it and
/// its views only ask for it, so a request the page takes can take it down
/// (`OrgNodePageFocusModel.cover`); a sheet each view kept to itself stayed up over the page.
enum OrgNodePageCover: Identifiable, Equatable {
    case task(TaskOpenTarget)
    case followUp(threadId: String, title: String)

    var id: String {
        switch self {
        case .task(let target): return "task|\(target.id)"
        case .followUp(let threadId, _): return "followUp|\(threadId)"
        }
    }
}

/// Where the Threads page takes a requested thread. The page waits for a read of the threads that
/// started after the request (a thread that moved to needs a moment ago is not in an older read),
/// then scrolls to the thread, opening the fold it sits in. One the list does not hold is read by
/// its id before the page says it is no longer open: the list brings only the newest closed ones
/// (2026-11-08 review: a thread closed earlier was called gone).
enum OrgThreadRevealModel {
    enum Fold: String, Equatable { case snoozed, inProgress, closed }

    enum Outcome: Equatable {
        /// No read since the request yet (or the last one failed and the thread is not known).
        case wait
        /// The list read does not hold it: read the thread by its id (`OrgThreadsStore.probe`).
        case probe
        /// On the page; inside that fold when not nil.
        case show(Fold?)
        /// Asked by its id, the server has no such thread for him: deleted, or never his.
        case missing
        /// Asked by its id, the read failed: nothing is known; the page says it could not check.
        case unchecked
    }

    /// The last read of the threads that finished: when it started, and whether it failed.
    struct Read: Equatable {
        let startedAt: Date
        let failed: Bool
    }

    /// The last read of one thread by its id: when it started, and what it found.
    struct Probe: Equatable {
        enum Result: Equatable { case found, notFound, failed }
        let startedAt: Date
        let result: Result
    }

    /// `broughtNone`: the read answered but brought none of the threads the counts say are his
    /// (`OrgThreadModel.unreadCount`, a copy that holds no threads). It proves no more than a
    /// failed read; the page says the threads could not be read.
    /// `probe`: the last read of the focused thread by its id, if any.
    /// `byIdOnly`: threads on the page that only a read by id brought (no list read holds them):
    /// such a copy is no proof the thread is still his, so a new request reads it by id again
    /// before it is shown (2026-11-08 review, round 2: a copy kept after the thread was gone).
    static func outcome(
        _ focus: OrgThreadFocus, threads: [OrgThread]?, sections: OrgThreadModel.Sections, lastRead: Read?,
        broughtNone: Bool = false, probe: Probe? = nil, byIdOnly: Set<String> = []
    ) -> Outcome {
        guard threads != nil, let lastRead, lastRead.startedAt >= focus.at else { return .wait }
        let id = focus.threadId
        if byIdOnly.contains(id), !(lastRead.failed || broughtNone) {
            guard let probe, probe.startedAt >= focus.at else { return .probe }
            if probe.result == .failed { return .unchecked }
        }
        if sections.open.contains(where: { $0.id == id }) { return .show(nil) }
        if sections.snoozed.contains(where: { $0.id == id }) { return .show(.snoozed) }
        if sections.inProgress.contains(where: { $0.id == id }) { return .show(.inProgress) }
        if sections.closed.contains(where: { $0.id == id }) { return .show(.closed) }
        // A failed read proves nothing about the thread; the page's own error line says so.
        if lastRead.failed || broughtNone { return .wait }
        // Absence from the list is no proof either (it holds the newest closed ones only): only
        // the server's answer for this one thread, asked since the request, says it is gone.
        guard let probe, probe.startedAt >= focus.at else { return .probe }
        switch probe.result {
        case .notFound: return .missing
        case .failed: return .unchecked
        // Found, and on the list from then on (the store keeps it): the next render shows it.
        case .found: return .wait
        }
    }

    /// The read brought none of the threads the server's or the node's count says are his.
    static func broughtNone(threads: [OrgThread]?, sections: OrgThreadModel.Sections, serverCount: Int?, nodeCount: Int?) -> Bool {
        threads != nil && OrgThreadModel.unreadCount(serverCount: serverCount, nodeCount: nodeCount, read: sections.open.count) != nil
    }

    /// The page still owes `focus` its reveal (each request once, a repeated tap again).
    static func owes(_ focus: OrgThreadFocus?, revealedAt: Date?) -> Bool {
        guard let focus else { return false }
        return focus.at != revealedAt
    }

    /// Whether the cards stay out of sight for now. A page that has not shown its cards yet (it
    /// just opened, or its Threads view just came forward) keeps them hidden while it owes a
    /// reveal and waits for the read or the scroll, so it never shows other cards first and then
    /// jumps to the thread. A failed read shows them at once (its error line says why), and a
    /// page already showing cards keeps them and scrolls in view.
    static func hidesCards(
        owes: Bool, outcome: Outcome?, lastReadFailed: Bool, scrolling: Bool, cardsShown: Bool,
        waitedTooLong: Bool
    ) -> Bool {
        guard !cardsShown, owes || scrolling, !waitedTooLong else { return false }
        if scrolling { return true }
        return (outcome == .wait || outcome == .probe) && !lastReadFailed
    }

    /// What the pinned jump bar does on this render.
    enum JumpBar: Equatable {
        /// Not there: the threads are not read yet, or the read brought none of his (its page says so).
        case none
        /// In its place but out of sight, while a reveal holds the cards, so the page does not move
        /// under the thread it just jumped to.
        case held
        case shown
    }

    /// The bar follows the page's rule (`Sections.showsJumps`: while it lists any thread, the last
    /// card for him gone included), and fades only while the hold keeps the cards out of sight,
    /// then comes back where it was.
    static func jumpBar(threadsRead: Bool, sections: OrgThreadModel.Sections, broughtNone: Bool, hides: Bool) -> JumpBar {
        guard threadsRead, sections.showsJumps(unreadable: broughtNone) else { return .none }
        return hides ? .held : .shown
    }

    /// The longest the cards stay hidden for a reveal, whatever the read does.
    static let holdSeconds: Double = 3

    /// How long the revealed card stays marked.
    static let highlightSeconds: Double = 2.5

    /// The longest a reveal keeps checking that its jump landed (`OrgThreadsView.land`).
    static let landSeconds: Double = 2

    /// Where a card sits in the list's viewport: the top of card `id`, from the viewport's top.
    struct CardTop: Equatable {
        let id: String
        let top: CGFloat
    }

    /// The jump to `threadId` landed: its card's top is in the upper part of the viewport, or,
    /// when the list cannot bring it higher (`previous`: where the last check found it, after a
    /// jump), still where it was and in view above the tab bar. Unknown (no report for that card,
    /// no viewport yet) is not landed.
    static func landed(_ card: CardTop?, threadId: String, viewport: CGFloat, previous: CardTop? = nil) -> Bool {
        guard let card, card.id == threadId, viewport > 0, card.top >= -8 else { return false }
        if card.top <= viewport * 0.6 { return true }
        guard let previous, previous.id == card.id, abs(previous.top - card.top) < 1 else { return false }
        return card.top <= viewport - 140
    }

    /// DEBUG: how long the UI tests' reveal mark stays (`DebugRevealMarker`). Longer than the
    /// outline, because a UI test reads the screen a second or more after a push lands; his own
    /// drag of the list ends it at once, as it ends the reveal.
    static let testMarkSeconds: Double = 8

    /// The revealed card's tint, drawn behind its text and buttons (the outline goes on top).
    static let highlightTint: Double = 0.5

    /// A read by id answered that the thread is not his: a closed one is still found by its id, so
    /// this is a thread removed, or one that is no longer his to see.
    static let missingText = "That thread is gone."
    /// Under `missingText`: what happened, and where he is now.
    static let missingDetail = "It was removed, or it is no longer yours, after the notification was sent. Your open threads are below."
    static let uncheckedText = "Couldn't check that thread just now. Pull down to try again."
}

/// The thread card's layout rules, pure so they are pinned without a snapshot.
enum OrgThreadCardLayout {
    /// At accessibility text sizes the header stacks: the state on its own line, then when and
    /// who opened it, wrapping at word boundaries. In one row the state label was squeezed to a
    /// few letters and broke inside its word ("Need / s you"), and "Opened by" was cut off.
    static func headerStacks(_ size: DynamicTypeSize) -> Bool { size.isAccessibilitySize }

    /// From XXXL up the action buttons stack, one full-width button a row, each label on one
    /// line. Side by side at those sizes they were squeezed until their words broke
    /// ("Ac-kno-wle-dge", "Sn oo ze"). Below XXXL they stay in a row while it fits.
    static func actionsStack(_ size: DynamicTypeSize) -> Bool { size >= .xxxLarge }

    /// An action label keeps to one line: a word too long for its button shrinks a little
    /// (`actionLabelMinScale`) rather than break inside itself.
    static let actionLabelLines = 1
    static let actionLabelMinScale: CGFloat = 0.8

    /// The header's second part: "18m ago · Opened by Growth VP".
    static func metaLine(timeAgo: String, openedBy: String?) -> String {
        var parts: [String] = []
        if !timeAgo.isEmpty { parts.append(timeAgo) }
        if let openedBy, !openedBy.isEmpty { parts.append("Opened by \(openedBy)") }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The open conversation closes from its end too, but only when it runs long enough to push
    /// its top toggle off screen; a short one showed "Hide the conversation" twice in a row.
    static func closesFromEnd(_ t: OrgThread) -> Bool {
        let exchanges = OrgThreadModel.exchanges(t)
        if exchanges.count >= 3 { return true }
        let words = t.messages.reduce(0) { $0 + $1.text.count + ($1.answer?.text.count ?? 0) }
            + (t.opener?.text.count ?? 0)
        return words > 900
    }
}
