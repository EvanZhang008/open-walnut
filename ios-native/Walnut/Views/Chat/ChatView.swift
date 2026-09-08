import SwiftUI
import UIKit

/// Chat tab — drops straight into the most recent conversation.
///
/// TOP BAR (redesigned 2026-09-07 to the shape the user asked for). Everything
/// that switches agent or conversation lives behind ONE control at the top-left:
/// `chat.menu` slides in `ChatDrawer` from the leading edge, pushing the chat
/// aside, and an edge swipe does the same thing interactively. The centre is a
/// plain, non-interactive title. The top-right is EMPTY — the mode badge is gone
/// from this tab on purpose ("I don't even know what replica means"), and the
/// only server state a chat actually needs, being offline, is still announced by
/// the banner under the bar. Stop moved onto the composer's own send button,
/// where the thumb already is.
struct ChatView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How far the drawer is out: 0 shut, 1 open. A fraction rather than a Bool
    /// because the edge swipe tracks the finger and can be released anywhere,
    /// and because every drawer modifier here (offset, scrim, shadow) is then a
    /// value SwiftUI can interpolate — so one `withAnimation` on this drives the
    /// whole thing and an interrupted drag has nothing to unwind.
    @State private var drawer: Double = 0
    /// The fraction the live drag started from; nil when no drag is tracked.
    @State private var dragOrigin: Double?
    /// Set once a drag has been judged NOT the drawer's, so a scroll that turns
    /// sideways halfway down the transcript cannot suddenly grab the drawer.
    @State private var dragRejected = false
    /// True for the life of a claimed drag: while it is up, nothing inside the
    /// drawer acts on a tap. A close drag starts ON a row, and a full-width
    /// `Button` fires on release even after the finger has travelled 200pt, so
    /// without this the drawer closed AND switched conversation (found on device,
    /// 2/2 at both a 1.2s drag and a 90ms fling). Lives here rather than in the
    /// drawer because the gesture that has to be known about is here.
    @State private var suppressDrawerTaps = false
    @State private var containerWidth: CGFloat = 0
    /// The page's height right now, and the tallest it has been while the tab bar
    /// was present. Their difference is what the bar occupies — see
    /// `ChatDrawerGeometry.tabBarCompensation`. Height rather than
    /// `safeAreaInsets`: a proxy for a view laid out INSIDE the safe area reports
    /// no insets at all (measured: zero, which is how the first cut silently
    /// compensated by nothing and dropped the composer 49pt).
    @State private var pageHeight: CGFloat = 0
    @State private var tallestWithTabBar: CGFloat = 0

    private var isOpen: Bool { drawer > 0.5 }
    private var drawerWidth: CGFloat { ChatDrawerGeometry.width(container: containerWidth) }
    private var tabBarHidden: Bool { ChatDrawerGeometry.tabBarHidden(progress: drawer) }

    private var tabBarCompensation: CGFloat {
        ChatDrawerGeometry.tabBarCompensation(
            pageHeight: pageHeight, tallestWithTabBar: tallestWithTabBar
        )
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            chatStack
                // Hand the tab bar's room back to the chat as PADDING. An outer
                // `safeAreaInset` was the first try and measured as a no-op: the
                // composer is placed by an inset INSIDE this NavigationStack, and
                // adding another one outside it left the composer 49pt lower all
                // the same. Padding shrinks the region the inner inset measures
                // against, which is what actually pins the composer.
                .offset(x: drawerWidth * drawer)
            scrimLayer
            drawerLayer
        }
        .onGeometryChange(for: PageMetrics.self) {
            PageMetrics(width: $0.size.width, height: $0.size.height)
        } action: { metrics in
            containerWidth = metrics.width
            pageHeight = metrics.height
            tallestWithTabBar = ChatDrawerGeometry.rememberedHeight(
                tallestWithTabBar: tallestWithTabBar,
                pageHeight: metrics.height,
                tabBarHidden: tabBarHidden
            )
        }
        // The floating tab bar paints OVER the tab's content, so an open drawer
        // would have it hovering above its rows, undimmed by the scrim (the scrim
        // lives inside the tab, the bar does not). Driven by the same fraction as
        // everything else, so it leaves and returns with the drawer.
        .toolbarVisibility(tabBarHidden ? .hidden : .visible, for: .tabBar)
        // SIMULTANEOUS, not `gesture`/`highPriorityGesture`: the transcript under
        // this is a scroll view and a high-priority drag would swallow every
        // scroll. Running alongside it, `ChatDrawerGeometry.tracksDrag` is what
        // keeps the two apart.
        .simultaneousGesture(edgeDrag)
    }

    /// The two page measurements the drawer needs, in one geometry read.
    private struct PageMetrics: Equatable {
        let width: CGFloat
        let height: CGFloat
    }

    private var chatStack: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !connection.online {
                    OfflineBanner(text: "Offline — showing cached data")
                }
                if let error = chat.errorMessage {
                    ErrorBanner(text: error) { chat.errorMessage = nil }
                }
                if chat.pendingQuestion {
                    questionBanner
                }
                MessageListView()
            }
            // Pin the stack to the height the page offered. `safeAreaInset` places
            // the composer relative to THIS content, so any sibling that reports a
            // taller ideal size than the keyboard-shrunk proposal pushes the
            // composer down by half its overflow — which is exactly how the send
            // button ended up under the predictive bar (P0, 2026-08-29: the empty
            // state's fixed 120pt padding overflowed by 48, and 24 of it landed on
            // chat.send). See `KeyboardSafeComposerContent`.
            .keyboardSafeComposerContent()
            // safeAreaInset (not a VStack sibling) so the bar rides the
            // keyboard: the keyboard grows the bottom safe area and the inset
            // content stays above it. A plain VStack child does NOT get that
            // treatment when the scroll view is bottom-anchored.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ComposerView()
            }
            // Hand the tab bar's room back to the chat, BELOW the composer, so the
            // composer's content stays exactly where it was while the bar is away
            // (without this it drops by the bar's height the moment the drawer
            // starts opening, and hops back on close — measured at 49pt).
            //
            // An inset here rather than padding on the stack, and OUTSIDE the
            // composer's inset on purpose: SwiftUI extends the OUTERMOST bottom
            // inset's background through the home-indicator area — that is what
            // draws the composer's material to the very bottom of the screen
            // today — so the band has to be the outermost one or it leaves a bare
            // strip under itself. Zero-height (no compensation) means no inset at
            // all, which keeps the everyday closed state untouched.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if tabBarCompensation > 0 {
                    Rectangle()
                        .fill(.bar)
                        .frame(height: tabBarCompensation)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    titleLines
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        setDrawer(open: !isOpen)
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                    .accessibilityIdentifier("chat.menu")
                    .accessibilityLabel("Conversations and agents")
                }
            }
        }
    }

    // MARK: - Drawer

    private var drawerLayer: some View {
        ChatDrawer(suppressTaps: $suppressDrawerTaps, close: { setDrawer(open: false) })
            .frame(width: drawerWidth)
            .frame(maxHeight: .infinity, alignment: .top)
            .background {
                // The BACKGROUND ignores the top AND bottom safe areas (the drawer
                // paints under the status bar and, once the tab bar has stepped
                // aside, all the way down past the home indicator) while the
                // content above stays inside them. The shadow's alpha rides
                // `drawer` so a shut drawer — parked at exactly -width, i.e. with
                // its right edge on the screen's left edge — cannot smear a dark
                // strip down the side of the chat.
                Color(.secondarySystemBackground)
                    .ignoresSafeArea(edges: [.top, .bottom])
                    .shadow(color: .black.opacity(0.22 * drawer), radius: 14, x: 3, y: 0)
            }
            .offset(x: drawerWidth * (drawer - 1))
            // Mounted at all times so opening is a pure animation with no view
            // to build first, and inert while shut: an off-screen view that still
            // takes taps or shows up in VoiceOver is a trap, not a drawer.
            .allowsHitTesting(isOpen)
            .accessibilityHidden(!isOpen)
    }

    /// Dims the chat behind the drawer. The DIM covers the screen; the CLOSER is
    /// only the sliver of chat still showing beside the drawer, since the rest of
    /// this layer is under the drawer, which sits above it.
    ///
    /// XCTest used to report this element's frame as the WHOLE SCREEN, and since
    /// automation taps the centre of the element it matched, a tap on
    /// `chat.drawer.scrim` landed in the middle of the drawer and selected whatever
    /// row was there. It still closed the drawer, which is why it read as working.
    /// Measured cause: the container adopted its one labelled child's identifier
    /// and reported its own bounds, so `children: .contain` below is the fix. The
    /// explicit widths are kept because the closer has to BE the sliver.
    /// The DIM and the CLOSER are two different things and are built as two now.
    ///
    /// The dim is decoration: it covers the screen, takes no touch, has no label,
    /// and is mounted at all times so its `.opacity` can FADE with the slide (an
    /// `if` cannot — SwiftUI evaluates the branch against the TARGET value, so a
    /// conditional scrim pops off on the first frame of the close).
    ///
    /// The closer is a control, so it EXISTS ONLY WHILE THE DRAWER IS OPEN.
    /// `.accessibilityHidden(!isOpen)` on the shared container was not enough:
    /// measured in the real hierarchy after a close, `chat.drawer.scrim` was still
    /// there, enabled, labelled "Close menu", reporting the WHOLE SCREEN as its
    /// frame — a full-screen invisible button over the chat is the worst shape a
    /// stale element can take. Not rendering it is the only state that cannot be
    /// misread. Its width is still the SLIVER of chat beside the drawer, because
    /// automation taps the centre of what it matched and the drawer sits above the
    /// rest of this layer (a centre tap on a full-screen closer lands on a
    /// conversation row and selects it).
    private var scrimLayer: some View {
        ZStack(alignment: .trailing) {
            Color.black.opacity(ChatDrawerGeometry.maxScrimOpacity)
                .opacity(drawer)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            if isOpen {
                Color.clear
                    .frame(width: max(0, containerWidth - drawerWidth * drawer))
                    .contentShape(Rectangle())
                    .onTapGesture { setDrawer(open: false) }
                    .accessibilityIdentifier("chat.drawer.scrim")
                    .accessibilityLabel("Close menu")
                    .accessibilityAddTraits(.isButton)
            }
        }
        // `children: .contain` so the layer stays a plain container: without it the
        // container adopts its one labelled child's identifier and reports the
        // WHOLE SCREEN as that element's frame.
        .accessibilityElement(children: .contain)
        .ignoresSafeArea()
    }

    private func setDrawer(open: Bool) {
        if open { dismissKeyboard() }
        withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86)) {
            drawer = open ? 1 : 0
        }
    }

    private var edgeDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                // A travelled touch is not a tap, EVEN ONE THE DRAWER DOES NOT
                // CLAIM. The rejected drags matter as much as the claimed ones:
                // a vertical drag over the drawer scrolls its list, and the row
                // it started on was firing on release just the same (a scroll
                // switched conversation on device). `minimumDistance` above is
                // what makes this safe for real taps — 12pt of travel is more
                // than a tap and less than a scroll.
                if isOpen { suppressDrawerTaps = true }
                if dragOrigin == nil {
                    guard !dragRejected else { return }
                    guard ChatDrawerGeometry.tracksDrag(
                        startX: value.startLocation.x,
                        translation: value.translation,
                        isOpen: isOpen
                    ) else {
                        dragRejected = true
                        return
                    }
                    dragOrigin = drawer
                    // The touch is the drawer's from here, so whatever row it
                    // happened to start on must not act on its release.
                    suppressDrawerTaps = true
                    dismissKeyboard()
                }
                guard let origin = dragOrigin else { return }
                drawer = ChatDrawerGeometry.progress(
                    from: origin, translationX: value.translation.width, width: drawerWidth
                )
            }
            .onEnded { value in
                dragRejected = false
                // A RUNLOOP TURN LATER, never inline: the lift-off that ends this
                // drag is the same event a row's Button acts on, and the two are
                // delivered in one pass in an order nothing here decides. Clearing
                // the lock in this handler therefore lets the drag's own release
                // select the row it started on, which is the whole bug.
                DispatchQueue.main.async { suppressDrawerTaps = false }
                guard dragOrigin != nil else { return }
                dragOrigin = nil
                setDrawer(open: ChatDrawerGeometry.settlesOpen(
                    progress: drawer, velocityX: value.velocity.width
                ))
            }
    }

    /// The drawer slides over the composer, so a keyboard left standing would
    /// shrink the region the drawer is sized against and cover its own pill.
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    // MARK: - Title

    /// The centre of the bar: a label, not a control. Nothing here is tappable —
    /// switching agent or conversation is the drawer's job.
    private var titleLines: some View {
        let lines = TitleLines.decide(
            conversationTitle: conversationTitle,
            agentName: chat.activeAgentName,
            agentCount: chat.agents.count
        )
        return VStack(spacing: 0) {
            Text(verbatim: lines.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let caption = lines.caption {
                Text(verbatim: caption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        // Cap the label — a long conversation title must not overflow the
        // principal toolbar slot into the side buttons.
        .frame(maxWidth: 210)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.title")
    }

    /// Which two lines the centre of the bar shows.
    ///
    /// Pure, because the rule is a judgement and not a layout: the caption only
    /// earns its line when it says something the title does not. The agent's name
    /// is news when a conversation title took the first line AND there is more
    /// than one agent to be on; it is noise when it is already the title.
    enum TitleLines {
        static func decide(
            conversationTitle: String?, agentName: String, agentCount: Int
        ) -> (title: String, caption: String?) {
            let trimmed = conversationTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let trimmed, !trimmed.isEmpty else { return (agentName, nil) }
            let caption = agentCount > 1 && trimmed != agentName ? agentName : nil
            return (trimmed, caption)
        }
    }

    /// Banner shown while the agent is blocked on a user_ask question. The
    /// composer doubles as the answer field (send routes to POST /answer);
    /// this banner explains the state and offers a one-tap skip.
    private var questionBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.subheadline)
                .foregroundStyle(Theme.tint)
            Text("\(chat.activeAgentName) has a question — reply below to answer.")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.tint.opacity(0.10))
        .accessibilityIdentifier("chat.questionBanner")
    }

    /// The active conversation's own title, when it has one.
    private var conversationTitle: String? {
        guard let id = chat.activeID,
              let title = chat.conversations.first(where: { $0.id == id })?.title,
              !title.isEmpty
        else { return nil }
        return title
    }
}

/// Personal AI chat message list on the UIKit timeline engine (Timeline/):
/// parsing/measurement on a background actor, O(visible) main-thread attach.
/// Replaced the ScrollView+LazyVStack body — same structural fix as
/// SessionConversationView (0x8BADF00D full-tree-diff class). The
/// KeyboardRepinMachine stays as the behavior layer; its repin pulses the
/// timeline's scroll signal.
private struct MessageListView: View {
    @Environment(ChatStore.self) private var chat
    @State private var keyboardGeometryFrozen = false
    @State private var programmaticGeometryFrozen = false
    @State private var programmaticFreezeTask: Task<Void, Never>?
    @State private var repinSignal = 0

    var body: some View {
        ChatTimelineBody(
            chat: chat,
            repinSignal: repinSignal,
            keyboardGeometryFrozen: { keyboardGeometryFrozen || programmaticGeometryFrozen },
            onRefresh: {
                if let id = chat.activeID {
                    await chat.loadMessages(id)
                }
                await chat.refreshConversations()
            }
        )
        .modifier(KeyboardBottomRepin(
            keyboardGeometryFrozen: $keyboardGeometryFrozen,
            isPinned: { chat.bottomPinned },
            programmaticFrozen: { programmaticGeometryFrozen },
            repin: { scrollToBottom() }
        ))
        .onDisappear {
            // Clear the flag too: cancelling the reset task alone would leave
            // a retained (tab-switched) view permanently geometry-frozen.
            programmaticFreezeTask?.cancel()
            programmaticGeometryFrozen = false
        }
    }

    private func scrollToBottom() {
        programmaticGeometryFrozen = true
        repinSignal += 1
        programmaticFreezeTask?.cancel()
        programmaticFreezeTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            programmaticGeometryFrozen = false
        }
    }
}

/// Live "what the agent is doing right now" row: an icon that breathes plus the
/// running tool's name (or "Thinking…").
///
/// CONTRAST, not decoration. This row carries the one thing the user asked to be
/// able to see, and it used to fade the WHOLE row — text included — between
/// 1.85:1 and 3.39:1, for ever. The text is fixed at a readable colour now
/// (`ReadableText`) and only the leading glyph breathes, between `shimmerFloor`
/// and full, which keeps even the dim end of the cycle above the 3:1 non-text
/// minimum. Motion is off under Reduce Motion and while the scene is not active.
///
/// NO TAP, on purpose. This is a STATUS line, and the action a reader wants
/// while it is on screen — stop the turn — already has a real control: the
/// composer's primary button turns into Stop for exactly the same period
/// (`ComposerView.stopButton`). Making the status line a second, unlabelled way
/// to do that would be a hidden gesture; making it tappable for anything ELSE
/// would be a control that appears and vanishes with the turn. It is exposed as
/// a frequently-updating status element instead, so VoiceOver reads it and does
/// not offer to activate it.
struct ThinkingRow: View {
    let activity: String?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    private var isThinking: Bool { activity == nil || activity == "Thinking" }
    private var label: String {
        activity.map { $0 == "Thinking" ? "Thinking…" : "\($0)…" } ?? "Thinking…"
    }
    private var animates: Bool { scenePhase == .active && !reduceMotion }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isThinking ? "sparkles" : "wrench.and.screwdriver")
                .font(.caption)
                .opacity(breathing ? ReadableText.shimmerFloor : 1)
                .animation(
                    animates
                        ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                        : nil,
                    value: breathing
                )
            Text(label)
                .font(.footnote)
        }
        .foregroundStyle(ReadableText.secondary)
        .onAppear { breathing = animates }
        .onChange(of: scenePhase) { _, _ in breathing = animates }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("chat.activity")
        .accessibilityLabel(label)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
