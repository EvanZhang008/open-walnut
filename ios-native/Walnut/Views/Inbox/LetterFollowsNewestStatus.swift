import Combine
import SwiftUI
import UIKit

/// The letter's conversation pane: opens at its newest turn, keeps the newest
/// reply and the status line under it in view while the human is at the end,
/// and never moves a thread they scrolled up in.
///
/// Two kinds of change, two rules:
///  - The human's own Send (and a Retry of the newest reply) is a request to see
///    that reply: the letter ALWAYS scrolls the reply itself (`target`, its row's
///    id) to just above the reply box and the keyboard, wherever the reader was.
///    Bump `sendTick`.
///  - Everything else (the line going from "Sending to ..." to "Sent to ...", a
///    reload, the letter growing, the keyboard or the reply box changing height)
///    follows the reply only while the reader is AT the end. The conversation
///    opens there (it has its own scroll under the document, so its end is the
///    newest turn, not the bottom of a long document), and a finger takes the
///    reader away from it or back to it.
///  - A turn that arrives while the reader is up the thread moves nothing: a
///    "New reply" button over the pane says so, and a tap on it goes to the end.
///    While the reader is at the end, the pane is pinned there through size
///    changes (`defaultScrollAnchor(.bottom, for: .sizeChanges)`), so a turn
///    growing as it lays out keeps the end in view in the same layout pass;
///    while they are up the thread, it is pinned to the top, so a new turn
///    below does not push what they read.
///
/// ONE scroll per change, after the layout it depends on has settled. While the
/// keyboard is moving, a change's scroll waits for it to finish, and then the
/// letter scrolls once: scrolling while it moved was the bounce the gate filmed,
/// a first scroll to where the end was with the keyboard up, then a second one.
///
/// A SEND that puts the keyboard away (the accessibility sizes, a committed
/// composition) is the exception, because waiting is what lurched (r4 gate,
/// P2-2): the reply box grows the visible area as the keyboard goes, a reader at
/// the end is clamped back toward older turns by that, and the wait then scrolled
/// forward again to the reply, so the thread went back about 250pt and forward.
/// Two things make it one motion:
///  - At the accessibility sizes the reader holds the keyboard until the reply's
///    answer is in, half a second at most (`keyboardLeaving`, see the reader's
///    `handOver`). The reply box shrinks at the Send and the keyboard's room
///    comes back later, so the letter is not clamped back by both at once, and
///    the line is final when the keyboard goes, so nothing grows under the scroll.
///  - The send's scroll runs in the keyboard's own move when the layout without
///    the keyboard arrives during it (the scroll view's bottom inset shrinks),
///    and a change while that scroll runs aims it again over the time it has
///    left rather than starting a second scroll after it.
/// Measured on film at AX XXXL from the end of a letter (content shift frame to
/// frame in points, recorder bursts skipped; "reversal" is the smaller of the
/// two directions): waiting for the keyboard reversed by 163 (tall reply) and
/// 179 (short); following in its move by 0 to 39, but 190 down then 170 up when
/// the answer landed during the move; holding the keyboard for the answer, 0 in
/// all 8 sends (3 tall, 3 short, 2 answered after the half second) and in all 8
/// first sends from the letter's top.
///
/// Following is decided by a finger: scrolling away from the end stops it,
/// scrolling back to the end starts it again. The pane opens at the end and
/// following it; coming back to it (from a session a status line opened) keeps
/// what the reader had.
///
/// Geometry samples go into a reference box, never into observed state: an
/// `onScrollGeometryChange` action runs inside the scroll view's layout pass, and
/// publishing from it re-invalidates the view being measured (the P0-2 hang that
/// `ScrollBottomTracking` documents).
struct LetterFollowsNewestStatus: ViewModifier {
    /// Changes whenever the newest status line appears or its words change.
    let key: String
    /// The `.id` of the newest reply's row (bubble and status line). nil: the
    /// letter's end, `contentId`.
    let target: String?
    /// The `.id` of the scroll view's content, whose bottom is the letter's end.
    let contentId: String
    /// Bumped by the reader for each human Send or Retry of the newest reply.
    let sendTick: Int
    /// True from a Send whose keyboard the reader holds (it leaves with the
    /// reply's outcome, at the accessibility sizes) until it asks it to leave:
    /// that Send's scroll waits for the keyboard's move.
    var keyboardLeaving = false
    /// The thread's length: a longer thread while the reader is up it shows
    /// the "New reply" button.
    var turnCount = 0

    @State private var intent = FollowIntent()
    /// Published copies of `intent.following`, written only outside layout (a
    /// scroll phase change, a tap): what the size-change anchor and the button read.
    @State private var pinnedToEnd = true
    @State private var newBelow = false
    /// The first appearance opened the pane at its end. A later one (back from a
    /// session a status line opened) keeps where the reader was.
    @State private var opened = false

    final class FollowIntent {
        var following = false
        var distanceFromEnd: CGFloat = 0
        /// The visible height of the pane, above the reply box and keyboard.
        var viewport: CGFloat = 0
        var userScrolling = false
        /// Between a keyboard's will-show/hide and its did-show/hide.
        var keyboardMoving = false
        /// A scroll asked for while the keyboard moved, run when it stops.
        var scrollWanted = false
        /// A send's scroll, waiting for the layout without the keyboard.
        var sendScrollOnInset = false
        /// The bottom inset already shrank in this keyboard move.
        var insetShrank = false
        /// When the send's own scroll (in the keyboard's move) ends; a change
        /// before then aims that scroll again instead of starting another.
        var sendScrollEnds: ContinuousClock.Instant?
        /// `scroll` is scheduled and has not run yet.
        var scrollPending = false
        var scroll: Task<Void, Never>?
        var keyboardFallback: Task<Void, Never>?
    }

    /// One sample of the scroll view: how far the letter's end is below the
    /// visible area (the part not covered by the reply box and keyboard), and
    /// how tall that covered part is.
    struct Sample: Equatable {
        var distanceFromEnd: CGFloat
        var bottomInset: CGFloat
        var viewport: CGFloat
    }

    /// A finger that leaves the end by more than this stops the following...
    static let stopFollowingBeyond: CGFloat = 160
    /// ...or by a third of a short pane. With the keyboard up the conversation
    /// pane can be under 200pt tall, where one swipe moves less than 160pt: the
    /// reader stayed "at the end" and the next status change put them back.
    static func stopFollowingDistance(viewport: CGFloat) -> CGFloat {
        min(stopFollowingBeyond, max(followAgainWithin * 2, viewport / 3))
    }
    /// ...and one that comes back within this starts it again. Between the two,
    /// the last choice stands, so a small drag near the end changes nothing.
    static let followAgainWithin: CGFloat = 40
    /// The longest a scroll waits for a keyboard that said it would move. The
    /// keyboard's own animation is 0.25s; this is only for a did-notification
    /// that never comes.
    static let keyboardWaitCeiling: Duration = .milliseconds(700)

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .onScrollGeometryChange(for: Sample.self) { geometry in
                    Sample(
                        distanceFromEnd: max(
                            0, geometry.contentSize.height - (geometry.visibleRect.maxY - geometry.contentInsets.bottom)
                        ),
                        bottomInset: geometry.contentInsets.bottom,
                        viewport: max(0, geometry.visibleRect.height - geometry.contentInsets.bottom)
                    )
                } action: { old, new in
                    intent.distanceFromEnd = new.distanceFromEnd
                    intent.viewport = new.viewport
                    if intent.keyboardMoving, new.bottomInset < old.bottomInset {
                        intent.insetShrank = true
                        if intent.sendScrollOnInset {
                            intent.sendScrollOnInset = false
                            scrollWithTheKeyboard(proxy)
                            return
                        }
                    }
                    if intent.userScrolling {
                        Self.decide(intent)
                    } else if new.bottomInset != old.bottomInset, intent.following {
                        // The keyboard or the reply box changed height under a
                        // reader at the end: keep the reply above them.
                        requestScroll(proxy)
                    }
                }
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(pinnedToEnd ? .bottom : .top, for: .sizeChanges)
                .onScrollPhaseChange { _, phase in
                    intent.userScrolling = phase == .interacting || phase == .decelerating
                    if phase == .idle {
                        // Where the finger left the reader is what the pane holds to.
                        if pinnedToEnd != intent.following { pinnedToEnd = intent.following }
                        if intent.following, newBelow { newBelow = false }
                    }
                    if intent.userScrolling {
                        // A finger wins over every scroll still to come.
                        intent.sendScrollEnds = nil
                        intent.sendScrollOnInset = false
                        intent.scroll?.cancel()
                        intent.scrollPending = false
                        intent.scrollWanted = false
                        Self.decide(intent)
                    }
                }
                .onChange(of: key) { _, _ in
                    guard intent.following, !intent.userScrolling else { return }
                    requestScroll(proxy)
                }
                .onChange(of: turnCount) { old, new in
                    guard new > old, !intent.following, !newBelow else { return }
                    newBelow = true
                    AccessibilityNotification.Announcement("New reply").post()
                }
                .onChange(of: sendTick) { _, _ in
                    intent.following = true
                    pinnedToEnd = true
                    newBelow = false
                    guard intent.keyboardMoving || keyboardLeaving else {
                        requestScroll(proxy)
                        return
                    }
                    // The send puts the keyboard away: follow inside its move.
                    intent.scroll?.cancel()
                    intent.scrollPending = false
                    intent.scrollWanted = false
                    if intent.keyboardMoving, intent.insetShrank {
                        scrollWithTheKeyboard(proxy)
                    } else {
                        intent.sendScrollOnInset = true
                    }
                }
                .onChange(of: keyboardLeaving) { _, leaving in
                    guard !leaving else { return }
                    // Asked to leave, the keyboard has said it is moving by now.
                    // One that stays (a follow-up is being typed) or is not there
                    // at all: the send's scroll runs as any change's does.
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(100))
                        guard !intent.keyboardMoving, intent.sendScrollOnInset else { return }
                        intent.sendScrollOnInset = false
                        guard intent.following, !intent.userScrolling else { return }
                        requestScroll(proxy)
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                    keyboardWillMove(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    keyboardWillMove(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                    keyboardStopped(proxy)
                }
                // The keyboard coming up for a follow-up covers the end: keep the
                // reply above the keyboard for a reader who is there.
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    if intent.following, !intent.userScrolling { intent.scrollWanted = true }
                    keyboardStopped(proxy)
                }
                .onAppear {
                    guard !opened else { return }
                    opened = true
                    intent.following = true
                    pinnedToEnd = true
                    newBelow = false
                }
                .overlay(alignment: .bottom) {
                    if newBelow {
                        Button {
                            intent.following = true
                            pinnedToEnd = true
                            newBelow = false
                            withAnimation(.easeOut(duration: 0.3)) {
                                proxy.scrollTo(contentId, anchor: .bottom)
                            }
                        } label: {
                            Label("New reply", systemImage: "arrow.down")
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .frame(minHeight: 44)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.onTint)
                        .background(Theme.tint, in: Capsule())
                        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
                        .padding(.bottom, 10)
                        .transition(.opacity)
                        .accessibilityIdentifier("inbox.letter.newReply")
                    }
                }
        }
    }

    /// Scroll the newest reply into view once layout has settled. Coalesced: a
    /// newer request replaces an older one, so a burst of changes is one scroll,
    /// and a request while the keyboard moves waits for it to stop.
    private func requestScroll(_ proxy: ScrollViewProxy) {
        if let ends = intent.sendScrollEnds, ContinuousClock.now < ends {
            // The send's own scroll is still running (the line's words changed
            // under it, "Sending" became "Queued"): aim it at the new place from
            // where it is, ending when it would have. A second scroll after it
            // was a slow settle the other way on film.
            retargetSendScroll(proxy, ends: ends)
            return
        }
        // The send's scroll has not run yet, and it will see this change.
        if intent.sendScrollOnInset { return }
        intent.scroll?.cancel()
        intent.scrollPending = false
        if intent.keyboardMoving {
            intent.scrollWanted = true
            return
        }
        intent.scrollPending = true
        intent.scroll = Task { @MainActor in
            // Let the new or longer line lay out first.
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            intent.scrollPending = false
            withAnimation(.easeOut(duration: 0.25)) {
                proxy.scrollTo(target ?? contentId, anchor: .bottom)
            }
        }
    }

    /// The send's one scroll, inside the keyboard's move (see the type's note):
    /// animated over the keyboard's own time, to the reply's place in the layout
    /// without the keyboard.
    private func scrollWithTheKeyboard(_ proxy: ScrollViewProxy) {
        let to = target ?? contentId
        intent.sendScrollEnds = .now + .milliseconds(Int(Self.sendScrollSeconds * 1000))
        Task { @MainActor in
            withAnimation(.easeOut(duration: Self.sendScrollSeconds)) { proxy.scrollTo(to, anchor: .bottom) }
        }
    }

    /// The send's scroll, aimed again while it runs, over the time it has left.
    private func retargetSendScroll(_ proxy: ScrollViewProxy, ends: ContinuousClock.Instant) {
        intent.scroll?.cancel()
        intent.scrollPending = false
        let to = target ?? contentId
        let left = ContinuousClock.now.duration(to: ends).components
        let seconds = max(Self.shortestRetarget, Double(left.seconds) + Double(left.attoseconds) / 1e18)
        Task { @MainActor in
            withAnimation(.easeOut(duration: seconds)) { proxy.scrollTo(to, anchor: .bottom) }
        }
    }

    /// The keyboard's own time.
    static let sendScrollSeconds: Double = 0.25
    /// A retarget at the very end of the send's scroll still eases, not jumps.
    static let shortestRetarget: Double = 0.1

    private func keyboardWillMove(_ proxy: ScrollViewProxy) {
        if !intent.keyboardMoving { intent.insetShrank = false }
        intent.keyboardMoving = true
        if intent.scrollPending {
            // A scroll that was about to run would aim at the old layout.
            intent.scroll?.cancel()
            intent.scrollPending = false
            intent.scrollWanted = true
        }
        intent.keyboardFallback?.cancel()
        intent.keyboardFallback = Task { @MainActor in
            try? await Task.sleep(for: Self.keyboardWaitCeiling)
            guard !Task.isCancelled else { return }
            keyboardStopped(proxy)
        }
    }

    private func keyboardStopped(_ proxy: ScrollViewProxy) {
        intent.keyboardFallback?.cancel()
        intent.keyboardFallback = nil
        intent.keyboardMoving = false
        intent.insetShrank = false
        // The layout without the keyboard never came (nothing moved): the send
        // scrolls now, like any change.
        if intent.sendScrollOnInset {
            intent.sendScrollOnInset = false
            intent.scrollWanted = true
        }
        guard intent.scrollWanted else { return }
        intent.scrollWanted = false
        guard intent.following, !intent.userScrolling else { return }
        requestScroll(proxy)
    }

    /// Only ever called while a finger is scrolling.
    static func decide(_ intent: FollowIntent) {
        if intent.distanceFromEnd > stopFollowingDistance(viewport: intent.viewport) {
            intent.following = false
        } else if intent.distanceFromEnd < followAgainWithin {
            intent.following = true
        }
    }
}
