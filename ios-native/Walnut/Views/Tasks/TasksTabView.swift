import SwiftUI

/// The Tasks tab, shaped like the Chat tab: the page IS a session, and the board lives in
/// the left drawer (the top-left button, or a swipe in from the left edge).
///
/// A task and its session are one thing (the user: a task maps one to one to its
/// session), so a tap on a task anywhere on this tab lands in its conversation, never on
/// a task page first. The task's page is one tap away from the session: its title, or
/// its ⋯ menu.
///
/// The drawer holds the WHOLE board (search, tier chips, grouping, collapse, the calendar
/// and recent entries, the one `+`) and stays alive while shut, so its scroll position
/// and search survive a round trip to a session.
struct TasksTabView: View {
    @Environment(TasksStore.self) private var tasks

    /// How far the drawer is out. A reference model: nothing in this body reads its
    /// fraction, so a drag re-renders the drawer shell, never the page.
    @State private var drawer = LeadingDrawerModel()
    @State private var router = TaskSessionRouter()
    /// The session the page shows; nil until something has been opened.
    @State private var current: WalnutSession?
    /// Pages over the session: the calendar, and a session opened from the calendar.
    @State private var path: [TasksTabRoute] = []
    /// The launch restore has run (it decides once; after that the page is the user's).
    @State private var restored = false
    @State private var draftReturnsToBoard = false
    @State private var draftReturnTask: Task<Void, Never>?
    @State private var draftTabBarHidden = false

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $path) {
            page
                .modifier(TasksPageToast(drawer: drawer))
                .navigationDestination(for: TasksTabRoute.self) { route in
                    switch route {
                    case .calendar:
                        TasksCalendarPage { task in openFromCalendar(task) }
                            // The calendar's items have no row to spin, so the page does
                            // while a tap asks the server where its session is.
                            .overlay { TasksRouterSpinner(router: router) }
                            .modifier(TasksPageToast(drawer: drawer))
                    case .session(let session):
                        SessionConversationView(session: session)
                            .modifier(TasksPageToast(drawer: drawer))
                    }
                }
        }
        .leadingDrawer(
            drawer,
            // Not over a pushed page: that edge is the page's back swipe.
            canOpen: path.isEmpty,
            identifier: "tasks.drawer",
            keepsDrawerMounted: true
        ) {
            TasksView(
                router: router,
                onShowSession: { show($0) },
                onOpenCalendar: openCalendar
            )
        }
        // The draft lives on the tab, not in the drawer: the board's `+` and a
        // sessionless task from the calendar both open it, and its session lands on
        // the page.
        .onChange(of: router.draftSeed) { _, seed in
            guard seed != nil else { return }
            restored = true
            router.supersede()
            draftReturnTask?.cancel()
            draftReturnsToBoard = drawer.isOpen
            draftTabBarHidden = true
            drawer.setOpen(false)
        }
        .sheet(item: $router.draftSeed, onDismiss: {
            let returnsToBoard = draftReturnsToBoard
            draftReturnsToBoard = false
            draftReturnTask = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(Self.afterDismissal)) }
                catch { return }
                guard router.draftSeed == nil else { return }
                // SwiftUI drops a tab bar show made in the sheet's dismissal update.
                draftTabBarHidden = false
                if returnsToBoard { drawer.setOpen(true) }
            }
        }) { seed in
            NavigationStack {
                NewSessionChatView(
                    taskId: seed.taskId,
                    taskTitle: seed.taskTitle,
                    onSavedAsTodo: {
                        draftReturnsToBoard = true
                        router.draftSeed = nil
                    }
                ) { session in
                    draftReturnsToBoard = false
                    show(session)
                    router.draftSeed = nil
                }
            }
            .presentationDetents([.large])
        }
        // Back (or any pop) drops a lookup the page it started on no longer wants.
        .onChange(of: path) { router.supersede() }
        .onChange(of: drawer.isOpen) { _, open in
            if open {
                draftReturnTask?.cancel()
                if router.draftSeed == nil { draftTabBarHidden = false }
            }
        }
        .onDisappear {
            draftReturnTask?.cancel()
            draftTabBarHidden = false
        }
        .toolbarVisibility(drawer.isOpen || draftTabBarHidden ? .hidden : .visible, for: .tabBar)
        .task { await restore() }
    }

    // MARK: - The page

    @ViewBuilder
    private var page: some View {
        if let current {
            SessionConversationView(session: current)
                // A different session is a different page: no state carries across.
                .id(current.id)
                // `show` records the opens. The page appearing is no open: the launch
                // restore and every return to this tab put it on screen, and recorded it
                // moved the restored session above what was opened after it.
                .environment(\.recordsSessionOpen, false)
                // The tab bar steps aside while the drawer is out; this keeps the
                // composer where it was through the slide (`ChatView` does the same).
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    LeadingDrawerTabBarBand(model: drawer)
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { drawerButton }
                }
        } else {
            TasksNoSessionPage(
                openBoard: { drawer.setOpen(true) },
                newSession: { router.draftSeed = .unattached }
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { drawerButton }
            }
        }
    }

    private var drawerButton: some View {
        Button {
            drawer.setOpen(!drawer.isOpen)
        } label: {
            Image(systemName: "line.3.horizontal")
        }
        .accessibilityIdentifier("tasks.menu")
        .accessibilityLabel("Tasks")
    }

    // MARK: - Routing

    /// How far apart a change to the tab bar's visibility (the drawer opening or shutting)
    /// and a dismissal (the draft sheet, the drawer's search) are kept. Run together, the
    /// dismissal swallowed the tab bar's return; kept apart by half a second or more, the
    /// bar came back on both paths (simulator experiment, 2026-10-11).
    static let afterDismissal: TimeInterval = 0.6

    /// Put a session on the page and get everything else out of the way.
    private func show(_ session: WalnutSession) {
        draftReturnTask?.cancel()
        restored = true
        tasks.recents.recordSession(session)
        router.didShow()
        current = session
        path = []
        drawer.setOpen(false)
    }

    private func openCalendar() {
        draftReturnTask?.cancel()
        restored = true
        router.supersede()
        drawer.setOpen(false)
        path = [.calendar]
    }

    /// A calendar item opens over the calendar, so Back returns to the day you were on.
    /// The session already on the page is not pushed a second time (two stores, two
    /// streams for one conversation): Back to it instead.
    private func openFromCalendar(_ task: WalnutTask) {
        router.open(task: task, tasks: tasks) { session in
            if session.id == current?.id {
                path = []
            } else {
                path.append(.session(session))
            }
        }
    }

    // MARK: - Launch

    /// Reopen what the user had open last; with nothing to reopen, the board is the
    /// first thing to see.
    private func restore() async {
        guard !restored else { return }
        // Idempotent: the store hydrates the history too; whichever runs first reads
        // the file, and the other returns at once.
        await tasks.recents.hydrate()
        guard !restored else { return }
        restored = true
        if let session = Self.restorableSession(
            tasks.recents.entries, liveSessions: tasks.sessions, inDemo: DemoMode.isActive
        ) {
            current = session
        } else {
            drawer.setOpen(true)
        }
    }

    /// The session to reopen: the newest history entry that has one, as the session
    /// list carries it now when it does (fresher status and title than the snapshot).
    ///
    /// None in the demo: it starts again from its sample data at every launch, so its
    /// history is the sample one (`DemoFixtures.recentOpens`), which nobody opened. A
    /// first look at the tab there is the board.
    static func restorableSession(
        _ entries: [RecentOpen], liveSessions: [WalnutSession], inDemo: Bool = false
    ) -> WalnutSession? {
        guard !inDemo, let snapshot = entries.lazy.compactMap(\.session).first else { return nil }
        return liveSessions.first { $0.id == snapshot.id } ?? snapshot
    }
}

extension EnvironmentValues {
    /// Does a session page record itself in Recently opened when it appears
    /// (`SessionConversationView`)? Off for the Tasks tab's root page.
    @Entry var recordsSessionOpen = true
}

/// Pages pushed over the Tasks tab's session.
enum TasksTabRoute: Hashable {
    case calendar
    case session(WalnutSession)
}

/// The calendar, as a page of its own. Full width on purpose: inside the drawer its day
/// and week pagers would fight the drawer's close swipe.
struct TasksCalendarPage: View {
    @Environment(ConnectionStore.self) private var connection
    let openTask: (WalnutTask) -> Void

    var body: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline: tasks are read-only from cache")
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
            }
            CalendarTabView(onOpenTask: openTask)
        }
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// The store's toast while the drawer is shut: at the top of the page, under its
/// navigation bar and clear of a session's composer.
private struct TasksPageToast: ViewModifier {
    let drawer: LeadingDrawerModel

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            TasksToastLayer(drawer: drawer, whileDrawerOpen: false)
                .padding(.top, 6)
        }
    }
}

/// A spinner while the router asks the server where a tap goes. Its own view, so a
/// lookup re-renders this and not the page under it.
private struct TasksRouterSpinner: View {
    let router: TaskSessionRouter

    var body: some View {
        if router.resolvingRowId != nil {
            ProgressView()
                .controlSize(.large)
                .padding(18)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityIdentifier("tasks.router.spinner")
        }
    }
}

/// The page before anything has been opened: say where the work is.
struct TasksNoSessionPage: View {
    let openBoard: () -> Void
    let newSession: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No session open", systemImage: "bubble.left.and.text.bubble.right")
        } description: {
            Text("Pick a task on the board to open its session, or start a new one.")
        } actions: {
            Button("Open the board", action: openBoard)
                .buttonStyle(.borderedProminent)
                .tint(Theme.tint)
                .accessibilityIdentifier("tasks.empty.openBoard")
            Button("New Session", action: newSession)
                .accessibilityIdentifier("tasks.empty.newSession")
        }
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}
