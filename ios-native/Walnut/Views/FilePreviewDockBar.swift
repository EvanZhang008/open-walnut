import SwiftUI

/// App-scoped host for the collapsed preview: the bar itself plus the sheet that
/// tapping it re-presents.
///
/// A separate view, not code inlined into `MainTabView`, for a render-cost reason
/// this app has already paid for once (the whole-station UI freeze from task-list
/// render storms): `MainTabView.body` builds all five tabs, and if it read the
/// dock's observable state then every collapse, reopen, and close would re-run
/// that build. Reading the store HERE keeps the invalidation inside a leaf whose
/// body is one bar.
///
/// It also owns the reopen presentation, and that placement is deliberate. The
/// timeline surfaces present the FIRST open (from a link tap) and dismiss it into
/// the dock; by the time the bar exists their sheet is gone. Re-presenting from
/// the app level instead means the reopen works from ANY tab, which is the whole
/// point: he collapses the report on the chat tab, wanders off to look at a task,
/// and the seat is still there.
///
/// The "already presenting" hazard that usually comes with presenting from an
/// ancestor is closed by geometry rather than by a guard: the bar sits at the
/// bottom of the tab content, so any sheet that is up (a task detail at its medium
/// detent, a session file browser) is drawn over it, and a covered bar cannot be
/// tapped.
struct FilePreviewDockOverlay: View {
    /// Optional so roots that never inject a dock still build — `RootView` has
    /// three DEBUG harness entry points that bypass the store wiring entirely.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    @State private var reopened: FilePreviewTarget?
    /// The keyboard is up somewhere in the app. Not derived from the safe area:
    /// the bar deliberately ignores keyboard safe-area insets (see below), so the
    /// only honest source is the notification.
    @State private var keyboardUp = false

    /// Does the seat paint right now? One rule, evaluated in one place, so the
    /// hide-while-unknown leg of the P1 fix cannot be forgotten by a second caller.
    private var barVisible: Bool {
        guard let dock else { return false }
        return FilePreviewDockBar.isVisible(
            hasSeat: dock.dockBarVisible, keyboardUp: keyboardUp, composer: dock.composerClearance
        )
    }

    var body: some View {
        // A ZStack rather than a bare `if`, so this view is a stable layout node
        // that always exists: the `.sheet` below hangs off it, and a presentation
        // modifier attached to something that comes and goes is how a sheet ends
        // up refusing to present.
        ZStack(alignment: .bottom) {
            if barVisible, let dock, let target = dock.docked {
                FilePreviewDockBar(
                    target: target,
                    onOpen: { reopened = target },
                    onClose: { dock.closeDocked() },
                    composer: dock.composerClearance
                )
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.snappy(duration: 0.26), value: dock?.dockBarVisible ?? false)
        // The bar must NOT ride the keyboard. The composer already rises with it
        // (its own safeAreaInset), so a bar that rose too would land exactly on
        // the send button — the one thing this must never cover.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        // WHILE TYPING THE SEAT IS HIDDEN OUTRIGHT. Of the two honest options
        // (hide, or ride above the keyboard) this is the one picked, for three
        // reasons: riding the keyboard puts the bar directly onto the composer's
        // control row, which is the exact defect this file was just fixed for
        // (P2, 2026-08-29: the bar's frame CONTAINED chat.composer); a seat is a
        // navigation affordance and nobody navigates mid-sentence; and "hidden"
        // cannot cover the send button under ANY keyboard height, whereas "above
        // the keyboard" is a clearance sum that needs to be right every time.
        // Nothing is lost — the seat, the file and the scroll position all survive
        // in the store, and the bar reappears when the keyboard goes down.
        //
        // Hiding on FOCUS instead of on the keyboard was considered for the "tall
        // composer" complaint (a six-line draft with thumbnails leaves the capsule
        // floating mid-transcript, reading like a stray notification) and rejected,
        // 2026-08-29. Focus would be a second published channel that can get STUCK
        // true: a composer whose `onDisappear` never runs (the same asymmetry that
        // caused the P1 above) would hide the seat forever, and an unreachable seat is
        // a worse bug than a high one. The keyboard notification is app-wide and
        // self-correcting: it cannot get stuck without the keyboard itself being
        // stuck. On a phone there is no editing without a keyboard, so the practical
        // coverage is the same.
        // The two directions are driven by TRANSACTIONS rather than by an
        // `.animation(_:value:)` modifier, and that is the DOCK-b fix — see
        // `keyboardTransitionRationale`.
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillShowNotification)) { _ in
                withTransaction(Self.instant) { keyboardUp = true }
            }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillHideNotification)) { note in
                // The keyboard's OWN announced duration, so the seat and the composer
                // settle together instead of the seat arriving late.
                let curve = Animation.easeOut(
                    duration: FilePreviewDockBar.keyboardDuration(note.userInfo)
                )
                withTransaction(Transaction(animation: curve)) { keyboardUp = false }
            }
        .sheet(item: $reopened) { target in
            HTMLFilePreviewSheet(target: target)
        }
    }

    /// A transaction that no animation already in flight can talk out of being
    /// instant. `animation: nil` alone is not enough: it leaves the ambient
    /// transaction's animation in place, which is exactly how the seat kept animating.
    ///
    /// # Why the keyboard's two directions are driven from here
    ///
    /// The bar's hide is INSTANT and its return rides the keyboard.
    ///
    /// ROUND 1 (P2, 2026-08-29) — both directions were one `.snappy(duration: 0.2)`:
    ///  - SHOW: the bar animated DOWN while the composer animated UP, so the two
    ///    crossed and the capsule was painted over mic/send for 2-3 frames. There is
    ///    no exit animation worth 3 frames of a control being covered.
    ///  - HIDE: `snappy` is a spring, so its visible settle outlasts its 0.2s
    ///    "duration" and the seat arrived ~170ms after the composer had already
    ///    landed, reading as a late notification rather than as the bar coming back.
    ///
    /// Round 1 expressed that as `.animation(keyboardAnimation, value: keyboardUp)`
    /// with a nil curve on the way out, and the seat STILL slid down and faded
    /// (DOCK-b, 2026-08-29 refutation). Two reasons, both fixed here:
    ///
    ///  1. `.animation(nil, value:)` does not defeat an animation that is ALREADY IN
    ///     FLIGHT. Collapsing the preview into the seat starts a 0.26s `snappy` on
    ///     `dockBarVisible`, and tapping the composer inside that window is the
    ///     ordinary way to hit this: the removal was rendered inside the live
    ///     transaction and animated after all. A `Transaction` with
    ///     `disablesAnimations = true`, applied at the state write, cannot be
    ///     overridden that way.
    ///  2. The transition itself was `.move(edge: .bottom)`, i.e. the exit path went
    ///     DOWN THROUGH the composer. Even a correctly un-animated hide would still
    ///     put the seat over mic/send for any frame that did animate, and the return
    ///     leg travelled the same corridor upward. The bar now fades in place
    ///     (`.transition(.opacity)`), so the only rectangle it ever occupies is its
    ///     seat above the composer: zero crossing frames by construction, not by
    ///     timing.
    ///
    /// The curve is picked at the WRITE now rather than from the destination state,
    /// which is also why there is no longer an `.animation(_:value:)` on `keyboardUp`:
    /// one mechanism, and the notification that knows the duration is the thing that
    /// applies it.
    private static var instant: Transaction {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        return transaction
    }
}

/// The collapsed preview's "seat": a compact bar naming the docked file, tappable
/// to get back to it at the remembered scroll position, with its own `x` as the
/// only thing that really throws the preview away.
///
/// ## Why the caller places this as an .overlay and never a safeAreaInset
///
/// A view that APPEARS or RESIZES mid-scroll must never be a `safeAreaInset`: an
/// inset changes the enclosing scroll view's visible rect, so the content offset
/// gets yanked — and this bar appears at exactly the wrong moment, right as the
/// user dismisses the preview and starts scrolling the timeline again. Painted as
/// an overlay, the scroll view never learns it exists.
struct FilePreviewDockBar: View {
    let target: FilePreviewTarget
    let onOpen: () -> Void
    let onClose: () -> Void
    /// What is known about the composer beneath the seat. Passed in (not read from
    /// the store here) so the bar stays a pure function of its inputs and
    /// `FilePreviewDockTests` can drive the clearance rule directly.
    ///
    /// A `ComposerClearance`, not a `CGFloat?`: the optional could not tell "no
    /// composer here" apart from "composer here, height unknown", and reading the
    /// second as the first is what painted the seat across the whole control row
    /// after a background/return (see `ComposerClearance`).
    var composer: ComposerClearance = .noComposer

    /// Standard iPhone portrait tab bar, excluding the home-indicator safe area
    /// (which the overlay already respects). The overlay is attached to the
    /// `TabView` itself, whose bounds INCLUDE the tab bar, so without this the
    /// bar would be drawn on top of the tab items.
    static let tabBarHeight: CGFloat = 49

    /// Small visual gap so the bar reads as floating rather than welded to the
    /// composer.
    static let gap: CGFloat = 6

    /// Horizontal inset that seats the bar on the SAME rails as the floating tab pill
    /// underneath it.
    ///
    /// Measured (R26): `file.dock.bar` spanned x 12..390 while the tab pill spans
    /// x 21..381 on a 402pt screen, so the seat overhung its own seat-back by 9pt on each
    /// side and read as a mis-cut piece of chrome rather than a card sitting on the tab
    /// bar. 21 is the pill's own inset, so the two capsules share a left and right edge.
    static let horizontalInset: CGFloat = 21

    /// Clearance used when a composer is known to be on screen but its height is
    /// not. Deliberately taller than any composer measured on a 390pt phone (an
    /// empty one is ~90pt, a six-line draft with a thumbnail strip ~230pt): in this
    /// state floating too high is a cosmetic complaint, while sitting too low is the
    /// P1 that ate a draft.
    ///
    /// `isVisible` hides the bar in this state, so nothing should reach it. It exists
    /// because the two rules live in two functions, and a future caller that paints
    /// the bar without asking `isVisible` must still not land on the send button.
    static let assumedComposerHeight: CGFloat = 260

    /// Fallback when a keyboard notification carries no duration. 0.25s is what UIKit
    /// has announced for the standard show/hide for years, so a missing value lands
    /// on the same timing rather than on an invented one.
    static let defaultKeyboardDuration: Double = 0.25

    /// Where the seat sits: directly above the tab bar, and above the WHOLE
    /// composer whenever one is on screen.
    ///
    /// This replaced `tabBarHeight + 46 + gap`, where the 46 was the composer's
    /// BOTTOM CONTROL ROW derived by hand (2026-08-29 review). Two ways that was
    /// wrong, both measured:
    ///  - On the chat tab the bar [12,694][390,739] fully CONTAINED the field
    ///    `chat.composer` [28,714][374,736]: the seat sat ON the text field. The
    ///    composer is a STACK — notices, a voice-retry row, a thumbnail strip, a
    ///    field that grows to six lines, then the control row — so the control row's
    ///    height was never the number to clear.
    ///  - On a composer-less tab (Settings) the bar floated 46pt above the tab bar
    ///    for no reason: it was clearing a composer that is not there.
    ///
    /// So the rule, not a sum: `tab bar + published composer height` when a composer
    /// reports one, `tab bar` alone when none does — plus `gap` either way.
    ///
    /// The gap is NOT conditional any more (R25). "Welded to the tab bar is the correct
    /// look when the tab bar is all there is" was the argument for spending it only over
    /// a composer, and the built binary refuted it: on Settings / Notes / Inbox the
    /// capsule's rounded corners met the tab bar's top edge with nothing between them,
    /// so a floating pill read as a botched piece of the tab bar. A seat is the same
    /// object on every tab; 6pt is what makes it look like it is floating there rather
    /// than growing out of the chrome below it.
    ///
    /// The height is a real measurement (`ComposerBar` publishes it into
    /// `FilePreviewDock`) because the composer's height is genuinely dynamic: no
    /// constant can be right for both an empty draft and a six-line one.
    ///
    /// The input is a THREE-state `ComposerClearance` rather than `CGFloat?` because
    /// the optional version shipped the P1 above: a background/return left the height
    /// unknown, `nil` meant "no composer", and the seat painted across
    /// `chat.plus`/pill/`chat.mic`/`chat.send`. The invariant this function now
    /// carries, pinned in `FilePreviewDockTests`: whenever a composer surface is on
    /// screen the clearance is STRICTLY MORE than the tab bar, whatever is known
    /// about its height.
    ///
    /// `.noComposer` is not "no composer reported lately" — it is "the surface ON SCREEN
    /// has never had one" (`FilePreviewDock.composerClearance`, scoped by
    /// `ComposerSurfaceID`). The distinction is the 2026-08-30 P1: a composer on a
    /// retained tab kept the seat 171pt up on Settings, Notes, Inbox and Tasks alike,
    /// stranded over a row of content, because "a composer exists" was being read as
    /// "a composer is under the seat".
    static func bottomClearance(composer: ComposerClearance) -> CGFloat {
        switch composer {
        case .noComposer:
            // Same breathing room the composer case gets: the seat floats above the
            // chrome on EVERY tab, never welded to it.
            return tabBarHeight + gap
        case .measured(let height) where height > 0:
            return tabBarHeight + height + gap
        case .measured, .unknownHeight:
            // A non-positive "measurement" is the unknown case wearing a number.
            return tabBarHeight + assumedComposerHeight + gap
        }
    }

    /// Does the seat paint at all?
    ///
    /// Pure, so the one leg that is easy to lose in a view body is testable: with a
    /// composer on screen and NO height to place the bar from, the bar is hidden. The
    /// alternative (paint it anyway, from a guess) is what the P1 proved unsafe, and
    /// hiding costs nothing durable: the seat, the file and the scroll position all
    /// live in `FilePreviewDock`, so the bar comes back the moment a height arrives.
    static func isVisible(hasSeat: Bool, keyboardUp: Bool, composer: ComposerClearance) -> Bool {
        guard hasSeat, !keyboardUp else { return false }
        if case .unknownHeight = composer { return false }
        return true
    }

    /// How long the keyboard says its own animation takes, from a keyboard
    /// notification's `userInfo`. Pure so the parse can be tested without a keyboard;
    /// a missing or nonsense value falls back rather than animating in zero time.
    static func keyboardDuration(_ userInfo: [AnyHashable: Any]?) -> Double {
        guard let raw = userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double,
              raw > 0.01 else { return defaultKeyboardDuration }
        return raw
    }

    var body: some View {
        HStack(spacing: 10) {
            // The tappable region is the whole bar EXCEPT the close button, so a
            // fat thumb can't confuse "take me back" with "throw it away".
            Button(action: onOpen) {
                HStack(spacing: 10) {
                    Image(systemName: "doc.richtext")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(target.displayName)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reopen \(target.displayName)")

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file.dock.close")
            .accessibilityLabel("Close preview")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule(style: .continuous))
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.14), radius: 8, y: 2)
        // The tab pill's own insets, not a hand-picked 12 — see `horizontalInset`.
        .padding(.horizontal, Self.horizontalInset)
        .padding(.bottom, Self.bottomClearance(composer: composer))
        // `.contain` BEFORE the identifier: a bare id on a container FLATTENS
        // onto every descendant and would clobber `file.dock.close` (the lesson
        // the composer's bottom row records, learned when Maestro stopped finding
        // `chat.voiceRetry`). Both ids stay inside [A-Za-z0-9._-] because
        // automation matches them as regexes.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("file.dock.bar")
        // FADE IN PLACE, never `.move(edge: .bottom)` (DOCK-b, 2026-08-29). A move
        // transition's exit path runs DOWN through the composer, so any frame of it
        // paints the seat over mic/send — the one thing this bar must never cover.
        // Opacity keeps the seat inside its own rectangle for its whole life, which
        // makes "zero crossing frames" a property of the geometry rather than of the
        // timing being right. See `instant` for the animation half of the same fix.
        .transition(.opacity)
    }

    /// Where the file lives. The host matters: the same path can exist on the Mac
    /// and on a remote exec box, and those are two different documents with two
    /// different remembered positions.
    private var subtitle: String {
        if let host = target.host, !host.isEmpty {
            return "Tap to reopen · \(host)"
        }
        return "Tap to reopen"
    }
}
