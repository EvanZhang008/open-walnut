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
    @Environment(TasksStore.self) private var tasks: TasksStore?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Another tab is in front (`MainTabView`): this tab is kept alive off screen.
    @Environment(\.composerCovered) private var tabHidden

    /// An ask started on the Mac, opened from the drawer: it has no chat here, so
    /// it opens as its session, pushed over the chat.
    ///
    /// The ONE binding that pushes a session over the chat, whatever opened it (an
    /// ask, an org node such as Main, a first message): every change of it is
    /// remembered (`ChatPlace`), so a launch after the system ended the app puts
    /// the user back in it. `ChatPlaceGuardTests` fails on a session pushed here
    /// any other way.
    ///
    /// One page at most over the sidebar, never a history: the chats in the drawer are peers, so
    /// opening the CEO from an ask puts the CEO in the ask's place and Back goes to the sidebar
    /// (2026-11-09, the owner: "这俩是平级 没有什么回去上一个的"). An item destination given a new
    /// value while one was shown pushed the second over the first.
    private var openedAskSession: WalnutSession? {
        get { chatPath.last }
        nonmutating set {
            // The chat already on the page, opened again: left as it is (a new value of the
            // same session would push its page again and start its store over).
            if let newValue, chatPath.count == 1, chatPath[0].id == newValue.id { return }
            chatPath = newValue.map { [$0] } ?? []
        }
    }
    /// The session on the page has a page of its own over it (`SessionPageOverKey`): the left
    /// edge is that page's Back, not the sidebar.
    @State private var sessionPageOver = false
    /// The session the launch put back (`restorePlace`): showing it again is no open, so it
    /// is not recorded in the synced Recent list until the user opens it themself.
    @State private var restoredAtLaunch: String?
    @State private var chatPath: [WalnutSession] = []
    @State private var orgLink = OrgNodeLink.shared
    /// The launch restore of the pushed session has run (it decides once; after
    /// that the page is the user's).
    @State private var placeRestored = false
    /// The voice Quick Action talks to the chat's own composer (`ComposerView`).
    @State private var quickAction = VoiceQuickAction.shared
    /// An ask with no session yet: its first message here starts one.
    @State private var sessionlessAsk: AskSummary?
    /// An org node (the CEO or a VP) with no session yet: its first message here starts one.
    @State private var sessionlessOrgNode: OrgNodeStart?
    @State private var orgFirstMessageDraft = ""
    /// The page kept over the restored Org node's chat (`ViewMemory`), put back with it at launch only.
    @State private var restoredOrgPage: (sessionId: String, tab: OrgNodeTab)?
    /// The node `orgFirstMessageDraft` was written for: the dialog for that node opens on it again.
    @State private var orgFirstMessageFor: String?
    /// The org node a tap is opening; a newer tap, or any navigation of his own, replaces it.
    @State private var orgOpening: OrgOpening?
    /// The next change of `openedAskSession` is an open's (a tap, a link, a launch restore), not
    /// his own: his own (Back, the drawer, a chat he picked) makes an open on its way give way.
    @State private var presentingOnRequest = false
    /// The launch restore gave way to an open still on its way: a failed open puts the last place
    /// back, a successful one is the place.
    @State private var restoreWaitsForOpen = false
    /// The tab is out of sight, as the notice's clock reads it (a task cannot read the environment).
    @State private var noticeOutOfSight = false
    /// His own moves outside this view's stack (Back from a node's page, its bar), which end an open.
    @State private var userMoves = OrgUserNavigation.shared
    /// The Chat tab's node pages on screen, by chat (`presentOnRequest` waits for one to leave).
    @State private var pages = OrgPagesOnScreen.shared
    /// The chat an open replaces the one on screen with, once that chat's page has left
    /// (`OrgChatSwap`): the swap's own state, which only a move of his ends.
    @State private var swap: OrgChatSwap?
    /// Where the last swap got to (shown to the UI tests in DEBUG builds).
    @State private var swapPhaseShown: OrgChatSwap.Phase?
    /// The chat whose page lifts the screen's curtain once it is up (`ScreenCurtain`).
    @State private var curtainFor: String?
    /// A read of a node's threads answered (`OrgReadNews`): the offline notice goes.
    @State private var readNews = OrgReadNews.shared
    /// An Org node open that did not happen, shown over whichever page of this tab is in front
    /// (`OrgOpenNotice`); the chat's own error bar sits under a pushed session.
    @State private var orgOpenNotice: OrgOpenNotice?
    @State private var firstMessageDraft = ""
    /// Talk to CEO's "Open chat" on an email (`ContentActionButtons`).
    @State private var contentLink = ContentActionLink.shared

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
    /// True while a touch of `edgeDrag` is down. A drag the system takes away (a scroll view, the
    /// navigation stack) never reaches `onEnded`; this going false is when such a drag is over, so
    /// a rejected one cannot keep the next swipe from opening the sidebar.
    @GestureState private var edgeTouch = false
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
            // A strip above the NavigationStack, so above a pushed chat or Org page too, and the
            // whole stack moves down for it: it covers no title, no bar and no card on any page of
            // this tab (2026-11-08 review, round 3: as a safe-area inset outside the stack it sat
            // over the VP page's title and its Threads, Tasks and Brief switch).
            VStack(spacing: 0) {
                orgOverlay
                chatStack
            }
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
        .onChange(of: edgeTouch) { _, touching in
            guard !touching else { return }
            dragRejected = false
            DispatchQueue.main.async { suppressDrawerTaps = false }
            // Taken away mid-drag: settle where the drawer is.
            guard dragOrigin != nil else { return }
            dragOrigin = nil
            setDrawer(open: ChatDrawerGeometry.settlesOpen(progress: drawer, velocityX: 0))
        }
        .onChange(of: tabHidden, initial: true) { _, hidden in
            noticeOutOfSight = hidden
            // He went to another tab: an open still on its way gives way to that.
            if hidden { userNavigated() }
        }
        .onChange(of: userMoves.serial) { _, _ in userNavigated() }
        // The server answers again: a notice saying it does not goes at once.
        .onChange(of: connection.online) { _, online in
            if online { clearOfflineNotice() }
        }
        .onChange(of: readNews.answeredAt) { _, _ in clearOfflineNotice() }
        // The page of the chat being replaced has left: the next chat goes up. Its page is up:
        // the swap is done.
        .onChange(of: pages.sessions) { _, _ in
            if let waiting = curtainFor, pages.has(waiting) { liftCurtain() }
            guard let swap else { return }
            switch swap.phase {
            case .lowering:
                if let shown = openedAskSession, shown.id != swap.target.id, !pages.has(shown.id) { swapNow() }
            case .pushing:
                if pages.has(swap.target.id) { swapEnded(.done) }
            default:
                break
            }
        }
        #if DEBUG
        // Where the last swap stopped, for the UI tests' failure hierarchy.
        .overlay(alignment: .topLeading) {
            if let phase = swapPhaseShown { DebugSwapPhaseMarker(phase: phase.rawValue) }
        }
        #endif
    }

    /// The two page measurements the drawer needs, in one geometry read.
    private struct PageMetrics: Equatable {
        let width: CGFloat
        let height: CGFloat
    }

    private var chatStack: some View {
        NavigationStack(path: $chatPath) {
            VStack(spacing: 0) {
                if !connection.online {
                    OfflineBanner(text: "Offline: showing cached data")
                }
                if let error = chat.errorMessage {
                    ErrorBanner(text: error) { chat.errorMessage = nil }
                }
                if chat.pendingQuestion {
                    questionBanner
                }
                MessageListView()
            }
            .navigationDestination(for: WalnutSession.self) { session in
                // The node page a thread push asks for reaches this chat through
                // `OrgNodePageLink`, which the chat and its page observe; a value passed
                // here does not reach a chat that is already shown.
                SessionConversationView(
                    session: session, followsOrgLinks: true,
                    restoredOrgPage: restoredOrgPage?.sessionId == session.id ? restoredOrgPage?.tab : nil)
                    // Another session is another page (`presentOnRequest` swaps one for another
                    // by taking the first down before the next goes up).
                    .id(session.id)
                    // A peer of the chat, not a page above it (2026-11-09, the owner: "当然是回去
                    // side bar啊 这俩是平级"): no Back, the sidebar button instead, and the left
                    // edge opens the sidebar (`edgeDrag`).
                    .navigationBarBackButtonHidden(true)
                    .environment(\.orgPagePlace, .chat)
                    .environment(\.recordsSessionOpen, session.id != restoredAtLaunch)
                    .onPreferenceChange(SessionPageOverKey.self) { sessionPageOver = $0 }
                    // The sidebar opens over this page too, and the tab bar steps aside for it:
                    // the same band as the chat's keeps the composer where it was.
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        if tabBarCompensation > 0 {
                            Rectangle()
                                .fill(ComposerCard.backdrop)
                                .frame(height: tabBarCompensation)
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                setDrawer(open: !isOpen)
                            } label: {
                                Image(systemName: "line.3.horizontal")
                            }
                            .accessibilityIdentifier("chat.session.menu")
                            .accessibilityLabel("Conversations and agents")
                        }
                    }
            }
            // Every push and every pop, from any entry: Back is the user leaving
            // it, so a launch then opens the chat underneath.
            .onChange(of: openedAskSession) { _, session in
                if session?.id != restoredAtLaunch { restoredAtLaunch = nil }
                ChatPlace.saveOpenSession(session)
                // A page a push asked for belongs to that open: the same chat opened later
                // from the drawer opens on the chat itself, not on that thread again.
                OrgNodePageLink.shared.drop(unlessSession: session?.id)
                if presentingOnRequest {
                    presentingOnRequest = false
                } else {
                    userNavigated()
                }
            }
            // The voice Quick Action speaks to the main agent through the chat's own
            // composer, which a pushed session covers: the session steps aside.
            .onChange(of: quickAction.pending != nil) { _, pending in
                if pending, openedAskSession != nil { openedAskSession = nil }
            }
            // After the first activation, like every other launch job: a
            // background prewarm must not open a session (LaunchGate).
            .task { LaunchGate.shared.whenActive { restorePlace() } }
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
                    // Under a pushed session, or on a tab out of sight, it is off
                    // screen (`composerCovered`).
                    .environment(\.composerCovered, tabHidden || openedAskSession != nil)
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
                    // The composer's own backdrop, so the band reads as more page
                    // under the card rather than a strip of material.
                    Rectangle()
                        .fill(ComposerCard.backdrop)
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
        .alert(sessionlessAsk?.title ?? "Start this conversation", isPresented: Binding(
            get: { sessionlessAsk != nil },
            set: { if !$0 { sessionlessAsk = nil } }
        )) {
            TextField("First message", text: $firstMessageDraft)
            Button("Cancel", role: .cancel) { sessionlessAsk = nil }
            Button("Send") {
                let ask = sessionlessAsk
                let text = firstMessageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                sessionlessAsk = nil
                guard let ask, !text.isEmpty else { return }
                firstMessageDraft = ""
                Task { await startAsk(ask, message: text) }
            }
        } message: {
            Text("This conversation has not started yet. Its first message starts it.")
        }
        // MainTabView has brought this tab forward; the CEO's chat opens over it.
        .onChange(of: contentLink.chat) { _, request in
            if request != nil { openContentChat() }
        }
        .onAppear { if contentLink.chat != nil { openContentChat() } }
        // A thread push: the node's chat, with its Threads page on top.
        .onChange(of: orgLink.pending) { _, request in
            if request != nil { openLinkedOrgNode() }
        }
        .onAppear { if orgLink.pending != nil { openLinkedOrgNode() } }
        .alert(sessionlessOrgNode?.name ?? "Start this conversation", isPresented: Binding(
            get: { sessionlessOrgNode != nil },
            set: { if !$0 { sessionlessOrgNode = nil } }
        )) {
            TextField("First message", text: $orgFirstMessageDraft)
            Button("Cancel", role: .cancel) {
                sessionlessOrgNode = nil
                orgFirstMessageDraft = ""
            }
            Button("Send") {
                let node = sessionlessOrgNode
                let text = orgFirstMessageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                sessionlessOrgNode = nil
                orgFirstMessageDraft = ""
                guard let node, !text.isEmpty else { return }
                Task { await startOrgNode(node, message: text) }
            }
            .disabled(orgFirstMessageDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("No chat with \(sessionlessOrgNode?.name ?? "it") yet. Its first message starts one.")
        }
    }

    /// Put back the session the user had open over the chat when the app last ran.
    /// The chat under it (agent, conversation) is the store's (`ChatStore.initialize`).
    private func restorePlace() {
        guard !placeRestored else { return }
        // A chat being opened on request (a tapped thread push, Open chat) wins over the one
        // left open last time, and the saved place stays as it was should that open fail: then
        // it is put back (`openEnded`). On a cold launch the thread tap may still sit in its own
        // mailbox (`MainTabView` hands it to `OrgNodeLink` from the same activation queue this
        // runs in), or not be here at all yet (the scene said a tap launched the app, and the
        // notification delegate hands it over after the first frame), so both count too.
        if orgOpening != nil || contentLink.chat != nil || orgLink.pending != nil
            || ThreadDeepLink.shared.waitsToOpen() {
            restoreWaitsForOpen = true
            // A tap the scene announced that never came: the last place comes back after all.
            Task {
                try? await Task.sleep(for: .seconds(ThreadDeepLink.launchTapWait + 0.5))
                guard restoreWaitsForOpen, orgOpening == nil, orgLink.pending == nil,
                      contentLink.chat == nil, !ThreadDeepLink.shared.waitsToOpen() else { return }
                restoreWaitsForOpen = false
                restorePlace()
            }
            return
        }
        placeRestored = true
        guard openedAskSession == nil, let session = ChatPlace.sessionToRestore(
            saved: ChatPlace.savedOpenSession(),
            liveSessions: tasks?.sessions ?? [],
            voiceActionPending: VoiceQuickAction.shared.pending != nil
                || VoiceQuickAction.shared.armedInThisProcess,
            inDemo: DemoMode.isActive
        ) else {
            // Not put back (a voice Quick Action took the chat): the user is on
            // the chat itself now, so that is what a later launch opens.
            if openedAskSession == nil { ChatPlace.saveOpenSession(nil) }
            return
        }
        restoredAtLaunch = session.id
        // The page he had open over an Org node's chat comes back over it (`ViewMemory`, kept per
        // node while it is open); only here, at the launch restore: a chat opened on purpose
        // later opens as the chat, and a push or a link of this run wins (`OrgNodePageHost.restore`).
        let keptPage = session.taskId.flatMap { ViewMemory.readOptional("org", "page", id: $0, as: OrgNodeTab.self) }
        restoredOrgPage = keptPage.map { (session.id, $0) }
        presentOnRequest(session)
        // The task may have moved on to another session since (Main restarts, an
        // ask resumed elsewhere): its current one is where the user's chat is now.
        guard let taskId = session.taskId, !taskId.isEmpty else { return }
        Task {
            let detail: TaskDetail
            do {
                detail = try await WalnutAPI().taskDetail(id: taskId)
            } catch APIError.server(let status, _, _, _, _) where status == 404 {
                // The task was deleted: nothing to return to, the chat is the place.
                if openedAskSession?.id == session.id {
                    presentingOnRequest = true
                    openedAskSession = nil
                }
                return
            } catch {
                return
            }
            guard let current = detail.currentSessionId, current != session.id,
                  openedAskSession?.id == session.id else { return }
            tasks?.noteSessionIds(taskId: taskId, ids: detail.sessionIds ?? [])
            let resolved = await tasks?.resolveSession(id: current, task: tasks?.tasks.first { $0.id == taskId })
            guard let resolved, openedAskSession?.id == session.id else { return }
            if let keptPage { restoredOrgPage = (resolved.id, keptPage) }
            restoredAtLaunch = resolved.id
            presentOnRequest(resolved.claimed(byTask: taskId, title: detail.title))
        }
    }

    /// Push `session` over the chat for an open (a tap, a link, the launch restore), with `page`,
    /// the node page it asks for, posted for that chat. The chat already on screen is not pushed
    /// again (a new copy of one session churned the page). Another chat on screen is replaced in
    /// place, never popped to the chat list first (2026-11-08 review, round 2: a 60 ms pause
    /// flashed three screens), and without animation. When that chat has its node's page up, the
    /// page goes down first, at once, and the swap waits until it has left the stack: the stack
    /// left a page that was still up on screen when the chat under it changed (2026-11-08 fleet
    /// run). This chat's page then goes up without animation too.
    private func presentOnRequest(_ session: WalnutSession, page: OrgNodePageLink.Request? = nil) {
        if (swap?.target ?? openedAskSession)?.id == session.id {
            if swap != nil {
                swap?.target = session
                if let page { swap?.page = page }
            }
            // Its page, when up, takes the request itself; the chat pushes one when not.
            if let page { OrgNodePageLink.shared.post(page) }
            return
        }
        let shown = openedAskSession
        let replacing = shown != nil
        if var page {
            page.instant = replacing
            OrgNodePageLink.shared.post(page)
        }
        if let shown, pages.has(shown.id) {
            let started = OrgChatSwap(target: session, page: page, from: shown.id)
            swap = started
            swapPhaseShown = .lowering
            // He sees the old page until the next one is up, never the old chat between them.
            ScreenCurtain.cover()
            curtainFor = session.id
            pages.lower(shown.id)
            watchSwap(started.token)
            return
        }
        swap = nil
        presentingOnRequest = true
        if replacing {
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { openedAskSession = session }
        } else {
            openedAskSession = session
        }
    }

    /// The swap `token` is checked against what is on screen, not against how it got there: past
    /// `OrgChatSwap.lowerSeconds` with the old chat still up, it goes ahead (the long way when the
    /// old page is still up too); past `OrgChatSwap.pushSeconds` with the next chat up but not its
    /// page, the page is asked for again; with the next chat not up at all, the long way. A move
    /// of his ends it (`userNavigated`).
    private func watchSwap(_ token: UUID) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(OrgChatSwap.lowerSeconds))
            guard let swap, swap.token == token, swap.phase == .lowering else { return }
            if let shown = openedAskSession, shown.id != swap.target.id, pages.has(shown.id) {
                swapThroughTheChatList()
            } else {
                swapNow()
            }
        }
    }

    /// The chat waiting in `swap` replaces the one on screen, without animation.
    private func swapNow() {
        guard var current = swap else { return }
        pages.endLowering()
        let next = current.target
        current.phase = .pushing
        swap = current
        swapPhaseShown = .pushing
        if openedAskSession?.id != next.id {
            presentingOnRequest = true
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { openedAskSession = next }
        }
        if pages.has(next.id) {
            swapEnded(.done)
            return
        }
        let token = current.token
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(OrgChatSwap.pushSeconds))
            guard let swap, swap.token == token, swap.phase == .pushing else { return }
            if pages.has(swap.target.id) {
                swapEnded(.done)
            } else if openedAskSession?.id == swap.target.id {
                // Its chat is up and its page is not: the page is asked for again, once, as a new
                // request (the same value again would change nothing its chat observes).
                if let page = swap.page {
                    var again = OrgNodePageLink.Request(nodeId: page.nodeId, sessionId: page.sessionId, tab: page.tab,
                                                        threadId: page.threadId, at: Date())
                    again.instant = true
                    OrgNodePageLink.shared.post(again)
                }
                swapEnded(.done)
            } else {
                swapThroughTheChatList()
            }
        }
    }

    private func clearOfflineNotice() {
        guard orgOpenNotice?.kind == .offline else { return }
        withAnimation(reduceMotion ? nil : .snappy) { orgOpenNotice = nil }
    }

    private func liftCurtain() {
        curtainFor = nil
        ScreenCurtain.lift()
    }

    private func swapEnded(_ phase: OrgChatSwap.Phase) {
        // Done: the next page is up. Dropped: he moved. The long way keeps it until the page is up.
        if phase != .longWay { liftCurtain() }
        swap = nil
        swapPhaseShown = phase
        pages.endLowering()
    }

    /// The last resort, for a swap that did not take: the stack goes back to the chat list and
    /// up again on the next chat, as it did before the swap in place (a frame of the list on the
    /// way, but the right page at the end, never the old one left up).
    private func swapThroughTheChatList() {
        guard let current = swap else { return }
        let next = current.target
        let page = current.page
        swapEnded(.longWay)
        AppLog.warn("org", "a chat swap did not take; going through the chat list", ["sessionId": next.id])
        let instant: Transaction = {
            var t = Transaction()
            t.disablesAnimations = true
            return t
        }()
        presentingOnRequest = true
        withTransaction(instant) { openedAskSession = nil }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            // He went somewhere meanwhile: nothing goes up over it.
            guard openedAskSession == nil else { return }
            // Leaving for the chat list dropped the request for the next chat's page.
            if var page {
                page.instant = true
                OrgNodePageLink.shared.post(page)
            }
            presentingOnRequest = true
            var again = Transaction()
            again.disablesAnimations = true
            withTransaction(again) { openedAskSession = next }
        }
    }

    /// He went somewhere himself (Back, the drawer, a chat he picked): an open still on its way
    /// gives way, and where he is now is the place (2026-11-08 review: a slow push read put the
    /// node's chat over the one he had picked meanwhile).
    private func userNavigated() {
        if orgOpening != nil { orgOpening = nil }
        // The kept page belongs to the launch's restore: a chat he opens or leaves himself later
        // opens as the chat.
        if restoredOrgPage != nil { restoredOrgPage = nil }
        if swap != nil {
            AppLog.info("org", "chat swap dropped: he moved", ["sessionId": swap?.target.id ?? ""])
            swapEnded(.dropped)
        }
        if restoreWaitsForOpen {
            restoreWaitsForOpen = false
            placeRestored = true
        }
    }

    /// The open `token` is over: its chat is on screen (`opened`), or it did not happen. A launch
    /// restore that waited for it puts the last place back when it did not.
    private func openEnded(_ token: UUID, opened: Bool) {
        guard orgOpening?.token == token else { return }
        orgOpening = nil
        guard restoreWaitsForOpen else { return }
        if opened {
            restoreWaitsForOpen = false
            placeRestored = true
        } else if orgLink.pending == nil, contentLink.chat == nil, !ThreadDeepLink.shared.waitsToOpen() {
            restoreWaitsForOpen = false
            restorePlace()
        }
    }

    /// Start a sessionless ask with its first message and open it, the way a
    /// launch from the Tasks tab hands its session over (stash, then push).
    private func startAsk(_ ask: AskSummary, message: String) async {
        do {
            let created = try await WalnutAPI().launchAsk(taskId: ask.id, message: message)
            SessionLaunchContext.stash(sessionId: created.sessionId, message: message)
            let now = ISO8601DateFormatter().string(from: Date())
            openedAskSession = WalnutSession(
                id: created.sessionId, title: created.title, taskId: created.taskId,
                taskTitle: ask.title,
                project: AskProjectName.storedProject(agentID: chat.activeAgentID, agentName: chat.activeAgent?.name), host: "",
                processStatus: "idle", model: nil, mode: nil,
                startedAt: now, lastActiveAt: now, messageCount: 0,
                cwd: nil, pinned: nil, focusTier: nil, description: nil
            )
            if let tasks { Task { await tasks.loadSessions() } }
            await chat.refreshAsks()
        } catch {
            chat.errorMessage = "Couldn't start \"\(ask.title)\": \(error.localizedDescription)"
        }
    }

    /// Open an org node's chat: its current session, pushed over the chat like an ask from the
    /// Mac. The task's own detail names its sessions (the slim list does not), so it is asked each
    /// time: a session the node started since the last look is the one to open. A node not made
    /// yet (no Main, a project still without its VP) is asked for first, the way the web Org page
    /// reaches it; one with no session at all takes its first message here.
    private func openOrgNode(_ row: ChatOrgModel.Row) {
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { drawer = 0 }
        let token = UUID()
        orgOpening = OrgOpening(token: token, name: row.name, shows: true)
        orgOpenNotice = nil
        // The sidebar opens over a session too: the page under the tap is what a later open
        // replaces, and a change meanwhile is the user moving on.
        let shownAtTap = openedAskSession?.id
        Task {
            defer { if orgOpening?.token == token { orgOpening = nil } }
            let api = WalnutAPI()
            do {
                let taskId: String
                if let known = row.contactId {
                    taskId = known
                } else if row.kind == .ceo {
                    taskId = try await api.orgMain()
                } else {
                    taskId = try await api.orgContact(project: row.project)
                }
                let detail = try await api.taskDetail(id: taskId)
                tasks?.noteSessionIds(taskId: taskId, ids: detail.sessionIds ?? [])
                // The user moved on (another tap, another chat) while this was asked: drop it.
                guard orgOpening?.token == token, openedAskSession?.id == shownAtTap else { return }
                guard let sessionId = detail.currentSessionId else {
                    // His first words for this node, from a dialog a push closed, come back.
                    if orgFirstMessageFor != taskId {
                        orgFirstMessageDraft = ""
                        orgFirstMessageFor = taskId
                    }
                    sessionlessOrgNode = OrgNodeStart(id: taskId, name: row.name, isCEO: row.kind == .ceo)
                    return
                }
                await openOrgSession(sessionId, taskId: taskId, name: row.name, token: token, detail: detail)
            } catch {
                guard orgOpening?.token == token else { return }
                orgOpenFailed(Self.orgFailure(row.name, error))
            }
        }
    }

    /// Open the node's session `sessionId` over the chat, with `page` (its node page) posted for
    /// it. `detail`: the node's task as the open just read it, so a session read by id that came
    /// back without its task still knows whose it is. False when it did not open.
    @discardableResult
    private func openOrgSession(
        _ sessionId: String, taskId: String, name: String, token: UUID?,
        detail: TaskDetail? = nil, page: OrgNodePageLink.Request? = nil
    ) async -> Bool {
        let task = tasks?.tasks.first { $0.id == taskId }
        let ownerTitle = task?.title ?? detail?.title
        if let known = tasks?.sessions.first(where: { $0.id == sessionId }) {
            if let token, orgOpening?.token != token { return false }
            presentOnRequest(known.claimed(byTask: taskId, title: ownerTitle), page: page)
            if orgOpenNotice?.kind == .failure { orgOpenNotice = nil }
            return true
        }
        let session = await tasks?.resolveSession(id: sessionId, task: task)
        if let token, orgOpening?.token != token { return false }
        if let session {
            presentOnRequest(session.claimed(byTask: taskId, title: ownerTitle), page: page)
            if orgOpenNotice?.kind == .failure { orgOpenNotice = nil }
            return true
        }
        orgOpenFailed("Couldn't open \(name). Try again in a moment.")
        return false
    }

    /// An Org node a push or a link named by its task: its current session, with the page it asked
    /// for opened over it. A node with no session yet says so instead.
    ///
    /// The chat the phone already holds for the node (the one on screen, else the newest row it
    /// has, `OrgOpenPlan`) opens at once, offline too, and the node's record is read behind it: a
    /// newer chat it names replaces it. Only with nothing held does the open wait on the read, and
    /// then it says so over whatever page is in front.
    private func openLinkedOrgNode() {
        guard let request = orgLink.consume() else { return }
        // A push is opening a page: a first-message dialog left from an earlier tap, and its
        // keyboard, close now, before the node is read. An open that fails (no chat, no network)
        // then shows its notice with nothing left over it.
        dismissChatPrompts()
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { drawer = 0 }
        let name = nodeName(request)
        let token = UUID()
        let openedAt = Date()
        orgOpenNotice = nil
        func page(_ sessionId: String) -> OrgNodePageLink.Request {
            OrgNodePageLink.Request(nodeId: request.taskId, sessionId: sessionId, tab: request.tab,
                                    threadId: request.threadId, at: request.requestedAt)
        }
        let local = OrgOpenPlan.localSession(
            taskId: request.taskId, shown: openedAskSession,
            knownIds: tasks?.knownSessionIds(for: request.taskId), sessions: tasks?.sessions ?? [])
        orgOpening = OrgOpening(token: token, name: name, shows: local == nil)
        if let local {
            // The chat (or its page, when it is up) takes the request from the mailbox it
            // observes: a chat already on screen is not handed a new value by SwiftUI.
            presentOnRequest(local.claimed(byTask: request.taskId, title: nil), page: page(local.id))
            if !connection.online { noteOfflineOpen(name: name, taskId: request.taskId, token: token, openedAt: openedAt) }
        }
        Task {
            var held = local
            var opened = held != nil
            defer { openEnded(token, opened: opened) }
            // A cold launch: the phone's own copy of its sessions may not be read from disk yet
            // (the app reads it after its connection and chat), so the chat it holds for the node
            // was not found. It waits for that copy before it gives up on what the phone holds
            // (2026-11-08 review, round 3: offline at a cold launch the open failed and the last
            // place came back, though the phone held the VP's chat and threads).
            if held == nil, let tasks, !tasks.cacheAdopted {
                _ = await tasks.waitForCacheAdoption(timeout: Self.coldCacheWait)
                if orgOpening?.token == token, let late = OrgOpenPlan.localSession(
                    taskId: request.taskId, shown: openedAskSession,
                    knownIds: tasks.knownSessionIds(for: request.taskId), sessions: tasks.sessions) {
                    held = late
                    opened = true
                    orgOpening = OrgOpening(token: token, name: name, shows: false)
                    presentOnRequest(late.claimed(byTask: request.taskId, title: nil), page: page(late.id))
                    if !connection.online { noteOfflineOpen(name: name, taskId: request.taskId, token: token, openedAt: openedAt) }
                }
            }
            do {
                let detail = try await WalnutAPI().taskDetail(id: request.taskId)
                tasks?.noteSessionIds(taskId: request.taskId, ids: detail.sessionIds ?? [])
                guard orgOpening?.token == token else { return }
                guard let sessionId = detail.currentSessionId else {
                    if held == nil {
                        orgOpenFailed("\(TaskMentions.shownTitle(detail.title, orgRole: detail.orgRole)) has no chat yet.")
                    }
                    return
                }
                if held != nil, !OrgOpenPlan.follows(current: sessionId, local: held?.id, shown: openedAskSession?.id) {
                    return
                }
                if await openOrgSession(sessionId, taskId: request.taskId, name: name, token: token,
                                        detail: detail, page: page(sessionId)) {
                    opened = true
                }
            } catch {
                guard orgOpening?.token == token else { return }
                if held == nil {
                    orgOpenFailed(Self.orgFailure(name, error))
                } else if case APIError.network = error {
                    // Opened from what the phone holds, the page stays: it says the server could
                    // not be reached (the app's own offline line may not have caught up yet).
                    connection.reportReachability(false, source: "org-open-rest", endpoint: "/api/v1/tasks/:id", error: error)
                    if orgOpenNotice == nil {
                        // What the page shows: its threads as last read, or only the notification.
                        let cached = await OrgThreadsCache.shared.has(request.taskId)
                        // A read has answered meanwhile: Walnut is reachable, whatever this one met.
                        guard orgOpenNotice == nil, !readNews.answered(since: openedAt) else { return }
                        let text = OrgOpenNotice.unreachable(name, cached: cached)
                        orgOpenNotice = OrgOpenNotice(text: text, kind: .offline)
                        AccessibilityNotification.Announcement(text).post()
                    }
                }
            }
        }
    }

    /// How long a cold launch's open waits for the phone's copy of its sessions.
    static let coldCacheWait: TimeInterval = 20

    /// The page opened from what the phone holds while it is offline: it says so.
    private func noteOfflineOpen(name: String, taskId: String, token: UUID, openedAt: Date) {
        Task {
            let cached = await OrgThreadsCache.shared.has(taskId)
            guard orgOpening?.token == token || orgOpening == nil, orgOpenNotice == nil,
                  // A read has answered meanwhile: it is not offline.
                  !readNews.answered(since: openedAt), !connection.online else { return }
            let text = OrgOpenNotice.offline(name, cached: cached)
            orgOpenNotice = OrgOpenNotice(text: text, kind: .offline)
            AccessibilityNotification.Announcement(text).post()
        }
    }

    /// The CEO chat Talk to CEO wrote into: the CEO's current session (it may have restarted
    /// since), else the one the server named, the way the web opens Main's chat.
    private func openContentChat() {
        guard let request = contentLink.consumeChat() else { return }
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { drawer = 0 }
        let token = UUID()
        orgOpening = OrgOpening(token: token, name: "CEO", shows: true)
        orgOpenNotice = nil
        Task {
            var opened = false
            defer { openEnded(token, opened: opened) }
            var sessionId = request.sessionId
            var taskId = request.taskId ?? ""
            var failure: Error?
            do {
                if taskId.isEmpty { taskId = try await WalnutAPI().orgMain() }
                let detail = try await WalnutAPI().taskDetail(id: taskId)
                tasks?.noteSessionIds(taskId: taskId, ids: detail.sessionIds ?? [])
                if let current = detail.currentSessionId, !current.isEmpty { sessionId = current }
            } catch {
                failure = error
            }
            guard orgOpening?.token == token else { return }
            guard let sessionId, !sessionId.isEmpty, !taskId.isEmpty else {
                orgOpenFailed(failure.map { Self.orgFailure("the CEO", $0) }
                    ?? "The CEO chat is starting. Open it again in a moment.")
                return
            }
            opened = await openOrgSession(sessionId, taskId: taskId, name: "CEO", token: token)
        }
    }

    /// Start an org node that has no session with its first message, then open it. The CEO
    /// starts the way the web starts it (`POST /sessions` with `walnutAgent`, its persona and the
    /// server's own folder); a VP through `POST /tasks/:id/start`, which finds the VP's folder.
    private func startOrgNode(_ node: OrgNodeStart, message: String) async {
        do {
            let started: TaskStartReply
            if node.isCEO {
                let created = try await WalnutAPI().launchAsk(taskId: node.id, message: message)
                started = TaskStartReply(taskId: created.taskId, title: created.title, sessionId: created.sessionId)
            } else {
                started = try await WalnutAPI().startTask(taskId: node.id, message: message)
            }
            let title = started.title, taskId = started.taskId
            guard let sessionId = started.sessionId, !sessionId.isEmpty else {
                // An engine that names its own session: the next open finds it.
                orgOpenFailed("\(node.name) is starting. Open it again in a moment.")
                return
            }
            SessionLaunchContext.stash(sessionId: sessionId, message: message)
            let now = ISO8601DateFormatter().string(from: Date())
            orgOpenNotice = nil
            openedAskSession = WalnutSession(
                id: sessionId, title: title, taskId: taskId,
                taskTitle: title, project: nil, host: "",
                processStatus: "idle", model: nil, mode: nil,
                startedAt: now, lastActiveAt: now, messageCount: 0,
                cwd: nil, pinned: nil, focusTier: nil, description: nil
            )
            if let tasks { Task { await tasks.loadSessions() } }
        } catch let APIError.server(status, code, _, _, _) where status == 409 && code == "session_exists" {
            // A session started meanwhile (on the Mac, or by the node itself): open that one.
            if let detail = try? await WalnutAPI().taskDetail(id: node.id), let sessionId = detail.currentSessionId {
                await openOrgSession(sessionId, taskId: node.id, name: node.name, token: nil)
            } else {
                orgOpenFailed("\(node.name) already has a chat. Open it again in a moment.")
            }
        } catch {
            orgOpenFailed(Self.orgFailure(node.name, error))
        }
    }

    /// A companion cannot make an org node or start one (`501`): those run on the Mac. A task
    /// that is gone (`404`) says the chat is no longer there, not that the network failed.
    static func orgFailure(_ name: String, _ error: Error) -> String {
        OrgOpenNotice.failure(name, error)
    }

    /// A push is opening a page: the "First message" dialogs of this tab close, and the keyboard
    /// goes with them. What he typed in them stays: the same dialog opens on it again
    /// (2026-11-08 review, round 3: a push wiped a VP's first message).
    private func dismissChatPrompts() {
        if sessionlessOrgNode != nil { sessionlessOrgNode = nil }
        if sessionlessAsk != nil { sessionlessAsk = nil }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// Say an Org node open did not happen, over whatever page of this tab is in front.
    private func orgOpenFailed(_ text: String) {
        withAnimation(reduceMotion ? nil : .snappy) { orgOpenNotice = OrgOpenNotice(text: text) }
        AccessibilityNotification.Announcement(text).post()
    }

    /// What an Org node open says over whatever page of this tab is in front, under its
    /// navigation bar: that it did not happen (or happened offline), else that it is on its way
    /// while it waits on the server.
    @ViewBuilder
    private var orgOverlay: some View {
        Group {
            if let notice = orgOpenNotice {
                orgOpenNoticeView(notice)
            } else if let opening = orgOpening, opening.shows {
                openingPill(opening)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, orgOverlayShown ? 6 : 0)
        .frame(maxWidth: .infinity)
        // The strip's own ground, up under the status bar, while it shows something.
        .background {
            if orgOverlayShown { Color(uiColor: .systemGroupedBackground).ignoresSafeArea(edges: .top) }
        }
    }

    private var orgOverlayShown: Bool { orgOpenNotice != nil || orgOpening?.shows == true }

    /// The node a request names, as he knows it: its task's title, else the title a chat of it
    /// carries, else the thread the notification named.
    private func nodeName(_ request: OrgNodeLink.Request) -> String {
        if let task = tasks?.tasks.first(where: { $0.id == request.taskId }) {
            return TaskMentions.shownTitle(task.title, orgRole: task.orgRole)
        }
        if let title = tasks?.sessions.first(where: { $0.taskId == request.taskId })?.taskTitle, !title.isEmpty {
            return title
        }
        if let title = request.title, !title.isEmpty { return "\u{201C}\(title)\u{201D}" }
        return "the chat"
    }

    /// The node is being read before its chat can open: says so over the page in front.
    private func openingPill(_ opening: OrgOpening) -> some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(verbatim: "Opening \(opening.name)\u{2026}")
                .font(.footnote.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
        .overlay(Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.orgOpening")
    }

    /// The failed (or offline) open's notice: closed by its X, by a later open, or after it was in
    /// view a few seconds (`OrgOpenNoticeClock`, which counts no time under a sheet or with the
    /// tab out of sight).
    private func orgOpenNoticeView(_ notice: OrgOpenNotice) -> some View {
        let offline = notice.kind == .offline
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: offline ? "wifi.slash" : "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(offline ? Color.secondary : Theme.danger)
                .padding(.top, 13)
                .accessibilityHidden(true)
            Text(notice.text)
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            // The full 44 pt square takes the tap (the gate measured 32 pt).
            Button { withAnimation(reduceMotion ? nil : .snappy) { orgOpenNotice = nil } } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: OrgOpenNotice.closeSide, height: OrgOpenNotice.closeSide)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("chat.orgOpenNotice.close")
        }
        .padding(.leading, 14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder((offline ? Color(uiColor: .separator) : Theme.danger.opacity(0.35)), lineWidth: 1))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.orgOpenNotice")
        .task(id: notice.id) {
            var clock = OrgOpenNoticeClock()
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                let visible = UIApplication.shared.applicationState == .active
                    && !noticeOutOfSight
                    && ApprovalCenter.shared.presented == nil
                    && !PresentationLowering.somethingPresented
                if clock.tick(0.5, visible: visible) { break }
            }
            if !Task.isCancelled, orgOpenNotice?.id == notice.id {
                withAnimation(reduceMotion ? nil : .snappy) { orgOpenNotice = nil }
            }
        }
    }

    /// Open an ask that has no chat here as its session: the one the tasks store
    /// holds, else the board's by-id lookup. A lookup that finds nothing says so
    /// on the chat's error banner rather than opening an empty page.
    private func openAsk(_ ask: AskSummary) {
        // The drawer goes at once, not on its slide: a slide under the page
        // pushing in from the other side showed both moving for half a second,
        // with the tab bar over the drawer's rows.
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { drawer = 0 }
        guard let sessionId = ask.sessionId, !sessionId.isEmpty else {
            sessionlessAsk = ask
            return
        }
        if let known = tasks?.sessions.first(where: { $0.id == sessionId }) {
            openedAskSession = known
            return
        }
        Task {
            let task = tasks?.tasks.first { $0.id == ask.id }
            if let session = await tasks?.resolveSession(id: sessionId, task: task) {
                openedAskSession = session
            } else {
                chat.errorMessage = "Couldn't open \"\(ask.title)\". Try again in a moment."
            }
        }
    }

    /// The chat itself on the page, with no slide: the sidebar was the way there.
    private func showChat() {
        guard openedAskSession != nil else { return }
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { openedAskSession = nil }
    }

    // MARK: - Drawer

    private var drawerLayer: some View {
        ChatDrawer(suppressTaps: $suppressDrawerTaps, close: { setDrawer(open: false) }, openAsk: openAsk,
                   isOpen: drawer > 0, openOrgNode: openOrgNode, showChat: showChat)
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
        if open {
            // Going to another chat himself: an open on its way gives way.
            userNavigated()
            dismissKeyboard()
            // An ask started on the Mac since the last read joins the list as
            // the drawer comes out.
            if drawer < 1 { Task { await chat.refreshAsks() } }
        }
        withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86)) {
            drawer = open ? 1 : 0
        }
    }

    private var edgeDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($edgeTouch) { _, touching, _ in touching = true }
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
                    // A page over the session (an Org page, a fork) has a Back of its own.
                    guard openedAskSession == nil || !sessionPageOver else {
                        dragRejected = true
                        return
                    }
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
            Text("\(chat.activeAgentName) has a question. Reply below to answer.")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.tint.opacity(0.10))
        .accessibilityIdentifier("chat.questionBanner")
    }

    /// The active conversation's title, when it has one (`ChatStore.barTitle`).
    private var conversationTitle: String? {
        ChatStore.barTitle(conversationID: chat.activeID, conversations: chat.conversations, asks: chat.asks)
            // An ask on its placeholder ("Ask Walnut") reads as a quick question.
            .map { AskProjectName.displayTitle($0, project: AskProjectName.storedProject(
                agentID: chat.activeAgentID, agentName: chat.activeAgent?.name)) }
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

/// An Org node open on its way. A newer open, or a navigation of his own, replaces it (`token`).
struct OrgOpening: Equatable {
    let token: UUID
    let name: String
    /// Says "Opening <name>…" over the page in front: only while the open waits on the server
    /// (a chat the phone already holds opens at once and says nothing).
    let shows: Bool
}

/// An org node that has no session yet, waiting for its first message.
struct OrgNodeStart: Equatable {
    let id: String
    let name: String
    let isCEO: Bool
}
