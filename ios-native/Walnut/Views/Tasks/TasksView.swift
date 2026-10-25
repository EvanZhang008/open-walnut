import SwiftUI

/// The board: the Tasks tab's drawer (`TasksTabView`), rendered as inset-grouped bands
/// (see `TaskBoardList`). A tap on any task here opens its SESSION on the tab's page.
///
/// The board is the PINNED working set and it is the tab's only task list — the
/// "All Tasks" pill is gone ("已经有 pin 了,为什么还会有 all task"), together with
/// the board's own "Everything else" band. Both were the whole task store rendered as
/// rows, which is where a 3,175-row `All` chip and a 460ms scroll hitch came from.
/// Unpinned work is reachable through SEARCH: typing a query still appends the
/// matching open tasks below the bands (`sections(excluding:)`) and the server hits
/// below that (`GlobalSearchSection`), neither of which runs on an idle body pass.
///
/// ONE way to make work: the toolbar's `+`, whose page picks the project and can save
/// the text as a todo instead of starting a session. The per-band, per-heading and
/// top-of-list add rows are gone (the user: a section needs no add row of its own).
struct TasksView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(TasksStore.self) private var tasks
    /// Read only to pin the navigation bar's appearance to it (`toolbarColorScheme` below).
    @Environment(\.colorScheme) private var colorScheme
    /// The drawer this board is in, for its tap suppression (a close drag that starts and
    /// ends on a row must not also open that row).
    @Environment(\.leadingDrawer) private var drawer

    /// Opens a task's session (or its attached draft) on the tab's page.
    let router: TaskSessionRouter
    /// Put a resolved session on the tab's page.
    let onShowSession: (WalnutSession) -> Void
    /// Show the calendar as a page of its own.
    let onOpenCalendar: () -> Void

    /// The task whose details sheet is up (a row's long-press `Details`).
    @State private var selected: WalnutTask?
    /// The drawer's own pages (Recently opened).
    @State private var navPath: [TasksDrawerRoute] = []
    /// Local search — filters tasks (title/project) and sessions
    /// (title/task/host/cwd) in place; no server round-trip.
    @State private var searchText = ""
    /// The search field is up (focused, or showing its Cancel). While it is, the bar has
    /// no room for the toolbar's calendar and `+`, so leaving for a session ends it
    /// (`endSearch`): the drawer reopens on the board, not on an old query.
    @State private var searchPresented = false
    /// The server half of the search ("More Results"), scheduled from here on every
    /// query change so it never waits for its lazy section to be drawn.
    @State private var globalSearch = GlobalSearchModel()
    /// Locate-me flash for a just-created task (scroll target + row tint).
    @State private var highlightedTaskId: String?
    /// The folded board groups (tier bands, or whole projects), persisted. See
    /// `BoardCollapse`.
    @AppStorage(BoardCollapse.storageKey, store: AppPrefs.defaults) private var collapsedRaw = ""
    /// True once the BOARD's chip row (header row 1) has reached the top edge, so the
    /// pinned copy stands in for it. See `TasksChromeMetrics.chipsPinThreshold`.
    ///
    /// It is a REFERENCE OBJECT and not a `@State Bool`, and the whole point is that
    /// **nothing in this view's `body` may read it** — the two `BoardBandBar` copies
    /// do, so a pin crossing costs 44pt of chrome instead of a full board derive plus
    /// a List diff. `BoardChipsPinLatch`'s header has the measurement.
    @State private var chipsPinLatch = BoardChipsPinLatch()
    /// Its own coalescing gate — same contract, separate crossing.
    @State private var chipsPinTracker = ChromeCollapseTracker()
    /// Turns each raw geometry sample into content travel the search drawer's inset
    /// cannot fake. Both machines above read its answer, so a drawer that retracts
    /// mid-gesture can no longer step them across their thresholds in one frame —
    /// see `TasksChromeMetrics.travel`.
    @State private var travelTracker = BoardScrollTravelTracker()
    /// The board's bands, memoized on the values they are built from. A reference box
    /// off the view graph (never `@Observable`): a body pass that changes nothing the
    /// bands read must not pay for a rebuild. See `BoardBandsCache`.
    @State private var bandsCache = BoardBandsCache()

    // MARK: - Board state
    //
    // (There is no expanded-row state: a row's tap opens its session — the row itself
    // never grows.)

    /// The filters menu's `Show done`: every band shows its completed rows.
    ///
    /// Off is the default, so the board opens on open work and the counts on the headings
    /// and the chips are open counts. It is ONE switch in the filters menu, not a control
    /// on every heading: showing finished work is rare, and a `show done (N)` capsule on
    /// each band was noise on the screen whose job is the open rows.
    @AppStorage(BoardFilterPrefs.showDoneKey, store: AppPrefs.defaults) private var showDone = false
    /// `Show waiting`, beside it: off by default, so a WAITING task leaves the board until
    /// it wakes, as on the console.
    @AppStorage(BoardFilterPrefs.showWaitingKey, store: AppPrefs.defaults) private var showWaiting = false
    // The board's three view decisions — WHICH TIER (the chip rail), how its rows are
    // headed (grouping), and which dates are admitted — all persisted through @AppStorage,
    // which is how this app already keeps a view preference (SettingsView's mic route,
    // NotesView's pinnedCollapsed) and the same shape as the desktop's localStorage keys.
    // The RAW string is what defaults can hold; `BoardFilterPrefs` maps it back and absorbs
    // a value an older build wrote. See BoardFilterBar.swift for the defaults and why they
    // differ from the desktop's.

    /// LEGACY grouping value, read only so an installed build's setting migrates into the
    /// per-tier map (`BoardFilterPrefs.grouping(scope:modes:legacy:)`). Never written.
    @AppStorage(BoardFilterPrefs.groupingKey, store: AppPrefs.defaults) private var legacyGroupingRaw =
        BoardFilterPrefs.defaultGrouping.rawValue
    /// grouping per tier, as JSON. The grouping belongs to the tier you are looking at, so
    /// each tier remembers its own mode instead of one global value being carried over.
    @AppStorage(BoardFilterPrefs.groupingModesKey, store: AppPrefs.defaults) private var groupingModesRaw = ""
    @AppStorage(BoardFilterPrefs.dateFilterKey, store: AppPrefs.defaults) private var dateFilterRaw =
        BoardFilterPrefs.defaultDateFilter.rawValue
    /// Which TIER the rail's chip has narrowed the board to ("" = All).
    ///
    /// A TIER id, and only ever a tier id: the rail is always the tier rail, under every
    /// grouping. It used to be a BAND id in `@State`, which is why switching grouping had
    /// to clear it (`focus` and `proj:marina` are different id spaces) — that whole problem
    /// is gone, so the scope is an ordinary persisted preference and survives a grouping
    /// switch, a tab switch and a relaunch.
    ///
    /// It is still only ever honoured against the rail the board just built
    /// (`BoardAssembly.scope`): a stale or emptied tier shows the whole board rather than an
    /// empty one, because two paths deciding what a band contains is how a task went
    /// missing from this screen once already.
    @AppStorage(BoardFilterPrefs.tierScopeKey, store: AppPrefs.defaults) private var tierScopeRaw = ""

    /// The tier the rail is narrowed to, as the model speaks it.
    private var tierScope: String? { BoardFilterPrefs.scope(tierScopeRaw) }

    /// The stored grouping/date strings as the typed values the model and the
    /// filter bar speak. Bindings rather than a second `@State` mirror: one source
    /// of truth means a tap writes defaults directly and nothing can drift out of
    /// sync with what was persisted.
    ///
    /// The grouping binding is SCOPE-AWARE on both sides: it reads the mode stored for the
    /// tier currently on screen and writes back into that tier's slot, so the chip always
    /// shows what this tier is doing and a tap never reaches another tier.
    private var grouping: Binding<BoardGrouping> {
        Binding(
            get: {
                BoardFilterPrefs.grouping(
                    scope: tierScope, modes: groupingModesRaw, legacy: legacyGroupingRaw
                )
            },
            set: {
                groupingModesRaw = BoardFilterPrefs.withGrouping(
                    $0, scope: tierScope, modes: groupingModesRaw
                )
            }
        )
    }

    private var dateFilter: Binding<BoardDateFilter> {
        Binding(
            get: { BoardFilterPrefs.dateFilter(dateFilterRaw) },
            set: { dateFilterRaw = $0.rawValue }
        )
    }

    /// ScrollViewReader id of the first scrollable row, so a chip tap can land at the top
    /// of what it just asked for.
    static let topAnchorId = "tasks.top"

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if tasks.notSyncedYet && tasks.tasks.isEmpty {
                    notSyncedState
                } else {
                    list
                }
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                // "The board is on screen" — the ONE thing that should make it reconcile
                // because a person is looking at it.
                //
                // `.onAppear`, deliberately, and not a `.task`: a `.task` is tied to the
                // lifetime of a view in the render tree, not to the screen being visible,
                // and SwiftUI re-arms it whenever the subtree it sits in is re-evaluated.
                // With a session conversation pushed over the board that measured 22
                // re-arms against 2 body passes, and since the bundle it fired writes the
                // very lists this screen renders, each fetch bought the next one: five
                // requests every ~160ms, for as long as the app was open (2026-09-01).
                //
                // The drawer keeps this view mounted while it is shut, so this runs once
                // per tab visit rather than once per drawer open; a drawer open that wants
                // fresh rows has pull to refresh.
                //
                // Gated on first activation (P0-2): a background/prewarm launch must start
                // no network work. Freshness-gated in the store, so even a chatty
                // appearance signal cannot become a poll (`BoardRefreshOrigin.minimumAge`).
                LaunchGate.shared.whenActive {
                    await tasks.refreshBoard(origin: .boardAppeared)
                }
            }
            // GHOST PILE-UP fix: a VISIBLE navigation bar background, and ONE line, never
            // the `ShapeStyle` overload.
            //
            // Left at its scroll-edge appearance, which on iOS 26 is transparent, band
            // headings, task rings and titles read straight THROUGH the bar. The board
            // hides the List's own background and paints its own page behind full-contrast
            // text (`scrollContentBackground(.hidden)` below), and the pinned chips overlay
            // sits flush at the top of the content area, so there is no opaque strip for
            // the glass to sit on.
            //
            // The colour overload is gone for a measured reason: with
            // `.toolbarBackground(BoardBandCard.page, for: .navigationBar)` the large
            // "Tasks" title rendered ZERO pixels on the pinned simulator. The platform's
            // own bar background is DERIVED from what it sits over, so there is no second
            // colour left to disagree with `BoardBandCard.page`.
            .toolbarBackground(.visible, for: .navigationBar)
            // The bar's appearance is the app's, stated. Left to iOS 26 it is inferred from
            // what scrolls under the bar, and on the board it inferred LIGHT in dark mode:
            // the toolbar glyphs went dark on the black page and vanished.
            .toolbarColorScheme(colorScheme, for: .navigationBar)
            .searchable(
                text: $searchText, isPresented: $searchPresented,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: "Search tasks & sessions"
            )
            .onChange(of: router.shownCount) {
                // After the drawer has shut, not with it: the search's dismissal, run
                // while the drawer shut, swallowed the tab bar's return
                // (`TasksTabView.afterDismissal`).
                DispatchQueue.main.asyncAfter(deadline: .now() + TasksTabView.afterDismissal) {
                    endSearch()
                    navPath = []
                }
            }
            .toolbar {
                // History: everything opened from this phone, newest first. A page of the
                // drawer, so Back returns to the board with its scroll and search intact.
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        guard drawer?.suppressTaps != true else { return }
                        navPath.append(.recents)
                    } label: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                    .accessibilityLabel("Recently opened")
                    .accessibilityIdentifier("tasks.recents")
                }
                // The calendar opens as a page of its own over the session: its day and
                // week pagers swipe sideways edge to edge, which inside the drawer would
                // fight the drawer's close swipe.
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        guard drawer?.suppressTaps != true else { return }
                        onOpenCalendar()
                    } label: {
                        Image(systemName: "calendar")
                    }
                    .accessibilityLabel("Calendar")
                    .accessibilityIdentifier("tasks.calendar")
                }
                // The ONE way to make work (the user: one plus is enough): the draft page, where the
                // project is picked and the text can be saved as a todo instead of starting
                // a session. Every per-band, per-heading and top-of-list add row is gone.
                // Shows on BOTH server modes: the replica relays the launch over the
                // bridge to the primary box; an old cloud server / old daemon degrades to
                // a clear error in the page (not_supported_cloud /
                // session_launch_needs_upgrade).
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        guard drawer?.suppressTaps != true else { return }
                        // The toolbar's draft is about no task in particular.
                        router.draftSeed = BoardModel.BoardDraftSeed.unattached
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(Theme.tint)
                    }
                    .accessibilityLabel("New")
                    // The id the Maestro flows and the UI tests already tap to start a
                    // session.
                    .accessibilityIdentifier("sessions.new")
                }
            }
            .sheet(item: $selected) { task in
                TaskDetailSheet(task: task)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .navigationDestination(for: TasksDrawerRoute.self) { route in
                switch route {
                case .recents:
                    TasksRecentsPage(
                        open: { openRecent($0) },
                        details: { selected = $0 }
                    )
                }
            }
        }
    }

    // MARK: - Recently opened

    /// A session put on the page ends the search and leaves Recently opened
    /// (`TaskSessionRouter.shownCount`), so the drawer reopens on the board with its
    /// calendar and `+`. Kept up, the search bar owns the navigation bar, and the
    /// history page has neither, until a Cancel or a Back was found. Ended when the
    /// session SHOWS, not at the tap: a hit that has to ask the server spins in place
    /// until then, and a draft cancelled over the search goes back to it.
    private func endSearch() {
        guard searchPresented || !searchText.isEmpty else { return }
        searchPresented = false
        searchText = ""
    }

    /// Route a task from the drawer to its session (or draft).
    private func open(_ task: WalnutTask) {
        router.open(task: task, tasks: tasks, show: onShowSession)
    }

    /// A row of the history: back to the conversation it names, or to the task's
    /// session when only the task was opened (a task tap is a session tap).
    private func openRecent(_ destination: RecentDestination) {
        switch destination {
        case .session(let session):
            onShowSession(session)
        case .task(let task):
            open(task)
        }
    }

    // MARK: - Search
    //
    // Derived-collection discipline (audit MAIN-5, 2026-08-08): every helper
    // below is a STATIC PURE function over (rows, query) so (a) the perf gate
    // in TasksDerivedPerfTests can drive the exact production code, and
    // (b) body passes can bind the result ONCE instead of recomputing per
    // reference. The store memoizes its slices per data generation; these
    // helpers are the remaining O(visible rows) per body pass.

    /// Trimmed search query ("" = match everything).
    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespaces)
    }

    /// Case-insensitive substring match across task title + project.
    /// (The v1 projection has no separate category field — project is the
    /// grouping layer, so title/project covers what the list shows.)
    static func taskMatches(_ task: WalnutTask, query q: String) -> Bool {
        guard !q.isEmpty else { return true }
        return task.title.localizedCaseInsensitiveContains(q)
            || task.project.localizedCaseInsensitiveContains(q)
    }

    // MARK: - List

    /// Group already-sorted task rows by project, headers A→Z.
    ///
    /// `excluding` drops ids that are already rendered elsewhere on the screen.
    /// It exists for the board: a search there shows the matching bands AND the
    /// matching open tasks, and without this a pinned task that matched appeared
    /// TWICE — once in its tier band, once again under its project heading. Two
    /// rows for one task on one screen is the confusion this redesign is about.
    static func sections(
        from rows: [WalnutTask], query: String, excluding: Set<String> = []
    ) -> [(project: String, tasks: [WalnutTask])] {
        let filtered = rows.filter { !excluding.contains($0.id) && taskMatches($0, query: query) }
        let grouped = Dictionary(grouping: filtered) { task in
            task.project.isEmpty ? "Inbox" : task.project
        }
        // Preserve each group's already-sorted order; sort the headers A→Z.
        return grouped
            .map { (project: $0.key, tasks: $0.value) }
            .sorted { $0.project.localizedCaseInsensitiveCompare($1.project) == .orderedAscending }
    }

    /// The open tasks a live query also searches. The board holds only PINNED work, and
    /// the field promises "Search tasks & sessions": a task the user KNOWS exists came
    /// back "No local matches" while it sat in the Inbox (dogfood R17).
    private func sections(excluding: Set<String>) -> [(project: String, tasks: [WalnutTask])] {
        Self.sections(from: tasks.tasks(for: .allOpen), query: trimmedQuery, excluding: excluding)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            // ONE assembly per body pass, three views of it, all from the same population
            // walk: the TIER rail (always tiers, never the rendered bands), the bands the
            // scope leaves on screen, and the scope the board actually honoured — which is
            // what the lit chip reads, so the bar can never claim a tier the rows disagree
            // with. Every reference to the computed property would re-run the walk (the
            // derived-collection discipline `TasksDerivedPerfTests` pins).
            let assembly = boardAssembly
            let bands = assembly.bands
            let chips = assembly.rail
            let query = trimmedQuery
            // What the folds leave on screen. Ignored while a query is live: a hit hidden
            // inside a folded group would read as "no match".
            let collapsed = query.isEmpty ? BoardCollapse.decode(collapsedRaw) : []
            let entries = BoardCollapse.entries(bands, collapsed: collapsed)
            // Dedup the search hits against what the board SHOWS (with the chip's scope
            // applied, because the chips keep narrowing while a query is live). Computed
            // only while a query is live, which is the only time anything reads it.
            //
            // `searchDedupIds`, not row ids: a duplicate has to be silenced whichever id
            // the row it duplicates happens to be keyed by (R25: one task drew TWICE,
            // 55pt apart, because the board keyed it by the CLI session UUID).
            let boardExcluded: Set<String> = query.isEmpty ? [] : BoardModel.searchDedupIds(bands)
            let sections = query.isEmpty ? [] : self.sections(excluding: boardExcluded)
            // Everything the list above ALREADY shows, for the server-hit dedup at the
            // foot. Bound once per pass so `GlobalSearchSection` never recomputes it per row.
            let alreadyVisibleTaskIds: Set<String> = query.isEmpty
                ? []
                : sections.reduce(into: boardExcluded) { ids, section in
                    for task in section.tasks { ids.insert(task.id) }
                }
            List {
                if !connection.online {
                    OfflineBanner(text: "Offline: tasks are read-only from cache")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                // ROW 1: the tier chips, and the only row here that pins.
                //
                // The row keeps its FIXED height whether or not it is drawing chips: when
                // the pinned copy has taken over, the content becomes clear space rather
                // than the row collapsing. A row that changed height mid-scroll would move
                // every row under it.
                //
                // The pinned copy (the overlay below) covers exactly the strip this row
                // occupies AT THE MOMENT IT CROSSES, because the pin threshold is derived
                // from this row's own content position (`TasksChromeMetrics.rowOneContentTop`).
                //
                // Built UNCONDITIONALLY, and `BoardBandBar.drawsChips` hides whichever copy
                // is not the live one: a conditional insertion destroyed one copy and built
                // the other on every crossing, and a rail `ScrollView` that came up measured
                // at zero width stayed chipless for the life of that instance.
                Section {
                    bandBar(
                        proxy: proxy, selected: assembly.scope, chips: chips,
                        // The List has ALREADY inset this row, so the card takes the
                        // container it is handed whole.
                        placement: .inlineRow
                    )
                    .frame(height: TasksChromeMetrics.bandBar)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    // Scroll target for a chip tap ("land at the top of what you asked
                    // for"). The FIRST row of the scrollable content.
                    .id(Self.topAnchorId)
                }
                // Header chrome is a TOOLBAR, not a settings group: the default
                // insetGrouped gap belongs between bands (measured, dogfood R19).
                .listSectionSpacing(2)

                // ROW 2: grouping, date filter and collapse-all as inline toggle chips —
                // the desktop's own `tier-view-bar`, on the bar rather than one tap inside a
                // menu (the user: not in a menu, on the bar itself).
                Section {
                    BoardViewBar(
                        grouping: grouping,
                        dateFilter: dateFilter,
                        // Disabled while searching: the folds do not apply then, so the
                        // button would claim a state the rows are not in.
                        collapse: query.isEmpty && !bands.isEmpty
                            ? BoardViewBar.Collapse(
                                allCollapsed: BoardCollapse.allCollapsed(bands, collapsed: collapsed),
                                toggle: {
                                    withAnimation(.snappy(duration: 0.25)) {
                                        collapsedRaw = BoardCollapse.encode(
                                            BoardCollapse.togglingAll(bands, collapsed: collapsed)
                                        )
                                    }
                                }
                            )
                            : nil
                    )
                    .frame(height: TasksChromeMetrics.viewBar)
                    .listRowInsets(EdgeInsets())
                    // A control strip on the PAGE, not a card.
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                .listSectionSpacing(2)

                boardSections(entries, isEmpty: bands.isEmpty, hidden: assembly.hidden)
                // Matching open tasks below the bands while a query is live (dogfood R17).
                // Its HEADING is what marks it as a different list.
                if !query.isEmpty {
                    ForEach(sections, id: \.project) { section in
                        projectSection(section)
                    }
                }

                // "More Results" augments the local matches while a query is typed: the
                // completed tasks that match, and the Mac's keyword + semantic search over
                // tasks and session transcripts (`SearchArrangement`). A hit opens its
                // task's SESSION like every other task tap on this tab, never a task page
                // first (the user: a task maps one to one to its session).
                //
                // AUGMENTS, so it is handed what is already on screen (`BoardSearchHitDedup`).
                if !query.isEmpty {
                    GlobalSearchSection(
                        query: query,
                        search: globalSearch,
                        visibleTaskIds: alreadyVisibleTaskIds,
                        nothingAbove: alreadyVisibleTaskIds.isEmpty,
                        localDone: tasks.tasks(for: .done),
                        storeTasks: tasks.tasks,
                        taskRow: { task, snippet in AnyView(taskRowButton(task, matchSnippet: snippet)) }
                    ) { hit in
                        openSearchHit(hit)
                    }
                }

                // What the filters took out, under the rows they took it from: the
                // console's footer, so a count that differs from what the user expected
                // (or a new task that starts later) always has a visible reason.
                if query.isEmpty, let hiddenText = assembly.hidden.footerText {
                    Section {
                        Text(hiddenText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                            .accessibilityIdentifier("board.hiddenCounts")
                    }
                }

                if let synced = tasks.syncedAt {
                    Section {
                        Text("Synced \(AppClock.relativeNamed(synced))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.insetGrouped)
            // The board's bands are inset-grouped cards, and cards need the grouped page
            // behind them to read as cards at all. Stated explicitly rather than left to the
            // List's default: the cards' contrast is measured against this exact value.
            .scrollContentBackground(.hidden)
            .background(BoardBandCard.page)
            .accessibilityIdentifier("tasks.list")
            // Watch how far the list is scrolled and pin the chip row once it reaches the
            // top edge.
            //
            // The sample is the OFFSET and the INSET, kept apart: the search drawer
            // retracts as soon as a drag starts, so the whole drawer height left
            // `contentInsets.top` in ONE sample and read as travel nobody performed.
            // `TasksChromeMetrics.travel` makes a sample whose INSET moved report no travel
            // of its own.
            //
            // Writing state straight from the action would publish INTO the layout pass that
            // produced the sample and re-invalidate the subtree being measured (P0-2, see
            // ScrollBottomTracking's header). So: samples land in a reference box off the
            // view graph, the decision is a pure function, and the ONE publish a crossing
            // needs is hopped to the next runloop and coalesced.
            //
            // The state this publishes into is the LATCH: nothing in `TasksView.body` reads
            // `isPinned`, so a crossing re-renders the two bars and leaves the board derive
            // and the List diff alone (`BoardChipsPinLatch`).
            .onScrollGeometryChange(for: BoardScrollSample.self) { geo in
                BoardScrollSample(offset: geo.contentOffset.y, insetTop: geo.contentInsets.top)
            } action: { _, sample in
                let scrolled = travelTracker.travel(sample)
                let pinned = TasksChromeMetrics.areChipsPinned(
                    scrolled: scrolled,
                    wasPinned: chipsPinLatch.isPinned,
                    offline: !connection.online
                )
                chipsPinTracker.request(pinned, current: chipsPinLatch.isPinned) { value in
                    chipsPinLatch.isPinned = value
                }
            }
            .onChange(of: query, initial: true) { _, query in
                globalSearch.schedule(query)
            }
            // The PINNED copy of row 1, and the only floating row on the board.
            //
            // An OVERLAY because anything in the layout flow that appears or resizes while
            // scrolling changes the List's visible rect and moves rows. No transition: the
            // inline row and this copy are the same bar in the same place at the crossing,
            // and an outgoing transition would briefly put two copies of every
            // `board.chip.*` id on screen. Same X (R26: `.pinnedOverlay` insets its own
            // card), same Y (R27: `chipsPinThreshold`), same style (R27: one radius, one
            // opaque surface).
            .overlay(alignment: .top) {
                bandBar(
                    proxy: proxy, selected: assembly.scope, chips: chips,
                    placement: .pinnedOverlay
                )
                .padding(.top, TasksChromeMetrics.pinnedChipsTopInset)
            }
            // Failed quick-toggle: the optimistic row already rolled back — tell the user
            // why (sync-source conflict, offline, …).
            .alert("Couldn't update task", isPresented: Binding(
                get: { toggleError != nil },
                set: { if !$0 { toggleError = nil } }
            )) {
                Button("OK", role: .cancel) { toggleError = nil }
            } message: {
                Text(toggleError ?? "")
            }
            // `pull` is the one origin exempt from the funnel's rate floor: the spinner is
            // the user's own request and it has to end in a real fetch.
            .refreshable { await tasks.refreshBoard(origin: .pullToRefresh) }
            // Store-level toast surface (fire-and-forget mutations): a small
            // auto-dismissing line at the bottom, never a modal. Here only while the
            // drawer is out; shut, the page under it shows the line (`TasksTabView`).
            .overlay(alignment: .bottom) {
                TasksToastLayer(drawer: drawer, whileDrawerOpen: true)
                    .padding(.bottom, 12)
            }
            // Locate a just-created task (a todo saved from the `+` page): flash its row
            // and scroll to it, in place. The board's rows carry a `task-<id>` anchor
            // (`TaskBoardList.rowAnchorId`); a task with no board row makes the scroll a
            // silent no-op. Next runloop: the band it lands in is rebuilt by the store
            // update that produced this id, and `scrollTo` for an id no view claims does
            // nothing.
            //
            // The drawer opened to show this row, so a board that would not draw it is
            // widened first: a tier the chips narrowed away goes back to All, and the
            // group it landed in unfolds (on the next runloop, against the widened board).
            .onChange(of: tasks.lastCreatedTaskId) { _, newId in
                guard let newId else { return }
                if tierScope != nil, !BoardCollapse.contains(taskId: newId, in: bands) {
                    tierScopeRaw = BoardFilterPrefs.rawScope(nil)
                }
                flashHighlight(newId)
                DispatchQueue.main.async {
                    let folds = BoardCollapse.decode(collapsedRaw)
                    let open = BoardCollapse.unfolding(taskId: newId, in: boardAssembly.bands, collapsed: folds)
                    if open != folds { collapsedRaw = BoardCollapse.encode(open) }
                    DispatchQueue.main.async {
                        withAnimation(.snappy(duration: 0.35)) {
                            proxy.scrollTo(TaskBoardList.rowAnchorId(newId), anchor: .center)
                        }
                    }
                }
            }
        }
    }

    /// A server search hit the phone could not draw as a task row: open its task's
    /// session, like every other task tap on this tab. A task the local list does not
    /// carry (completed long ago, filtered out of the projection) still opens: the
    /// router needs only its id, and the conversation page loads the rest.
    ///
    /// A hit in a session's transcript opens THAT session, which need not be the task's
    /// newest.
    private func openSearchHit(_ hit: GlobalSearchResult) {
        guard drawer?.suppressTaps != true, let taskId = hit.ownerTaskId, !taskId.isEmpty else { return }
        // Exact first: a prefix is only for the short ids an older server sends.
        let task = tasks.tasks.first(where: { $0.id == taskId })
            ?? tasks.tasks.first(where: { $0.id.hasPrefix(taskId) })
            ?? SessionTaskRow.placeholder(id: taskId, title: hit.type == "task" ? hit.title : nil)
        if hit.type == "session", let sessionId = hit.resultId, !sessionId.isEmpty {
            router.open(sessionId: sessionId, task: task, tasks: tasks, show: onShowSession)
        } else {
            open(task)
        }
    }

    // MARK: - Search hit rows

    /// One project group of search hits: a plain heading, then the rows. No `+`: there
    /// is one way to make work, the toolbar's.
    @ViewBuilder
    private func projectSection(_ section: (project: String, tasks: [WalnutTask])) -> some View {
        Section {
            ForEach(section.tasks) { task in
                taskRowButton(task)
            }
        } header: {
            Text(section.project)
        }
    }

    /// One search hit row: a tap opens the task's SESSION, never a task page first; the
    /// details are in the long-press menu and on the session's title.
    @ViewBuilder
    private func taskRowButton(_ task: WalnutTask, matchSnippet: String? = nil) -> some View {
        Button {
            guard drawer?.suppressTaps != true else { return }
            open(task)
        } label: {
            HStack(spacing: 10) {
                TaskRow(task: task, tierBadge: tasks.tierBadge(for: task), matchSnippet: matchSnippet)
                // The tap is asking the server where this task's session is.
                if router.resolvingRowId == task.id {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .buttonStyle(.plain)
        .id("task-\(task.id)")
        // Locate-me flash for a just-created task.
        .listRowBackground(task.id == highlightedTaskId ? Theme.tintSoft : nil)
        .accessibilityIdentifier("tasks.row.\(task.id)")
        // Leading swipe = todo↔done (Reminders muscle memory). No trailing swipe: in the
        // drawer a leftward drag is the drawer's own close gesture.
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                toggleDone(task)
            } label: {
                Label(
                    task.isDone ? "Reopen" : "Done",
                    systemImage: task.isDone ? "arrow.uturn.backward.circle" : "checkmark.circle.fill"
                )
            }
            .tint(task.isDone ? .secondary : Theme.success)
        }
        .contextMenu {
            Button {
                toggleDone(task)
            } label: {
                Label(
                    task.isDone ? "Mark as To Do" : "Mark as Done",
                    systemImage: task.isDone ? "circle" : "checkmark.circle.fill"
                )
            }
            Button {
                togglePin(task)
            } label: {
                Label(task.pinned == true ? "Unpin" : "Pin",
                      systemImage: task.pinned == true ? "pin.slash" : "pin")
            }
            // Tier mover (pinned rows only): mirrors the desktop focus bar's tier set —
            // built-ins + custom tiers, optimistic.
            if task.pinned == true {
                Menu {
                    let currentTier = tasks.tierId(for: task.id) ?? "satellite"
                    ForEach(tasks.allTierChoices, id: \.id) { choice in
                        Button {
                            moveTier(task, tier: choice.id)
                        } label: {
                            if choice.id == currentTier {
                                Label(choice.label, systemImage: "checkmark")
                            } else {
                                Text(choice.label)
                            }
                        }
                    }
                } label: {
                    Label("Move to Tier", systemImage: "square.stack.3d.up")
                }
            }
            Button {
                selected = task
            } label: {
                Label("Details", systemImage: "info.circle")
            }
        }
    }

    /// Tier move from a row's context menu. Optimistic via the store.
    private func moveTier(_ task: WalnutTask, tier: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.setTier(taskId: task.id, tier: tier) {
                toggleError = error
            }
        }
    }

    /// Pin/unpin from a row's context menu. Optimistic via the store.
    private func togglePin(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.setPinned(task, pinned: !(task.pinned == true)) {
                toggleError = error
            }
        }
    }

    /// One-tap todo↔done from a row (swipe / context menu). Optimistic via the store; a
    /// failure (the row already rolled back) says why in an alert.
    @State private var toggleError: String?
    private func toggleDone(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.toggleDone(task) {
                toggleError = error
            }
        }
    }

    /// Tint the row for a few seconds, then fade the highlight out.
    private func flashHighlight(_ taskId: String) {
        withAnimation(.easeIn(duration: 0.2)) { highlightedTaskId = taskId }
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if highlightedTaskId == taskId {
                withAnimation(.easeOut(duration: 0.6)) { highlightedTaskId = nil }
            }
        }
    }

    // MARK: - The board (default filter): one scroll, sticky bands, tap into the session
    //
    // This REPLACED a parallel session list (a Pinned/Recent/All scope picker over
    // session rows). Two reasons, both from the design this implements: a session
    // is a task that has a session, so a second list of the same work read as
    // clutter and made "which one do I tap" a question; and a scope picker is
    // 44pt of chrome on the screen whose job is showing rows.
    //
    // The bands are grouped by pin tier by default and by PROJECT when the view bar's
    // grouping chip says so: the desktop's own grouping pair, remembered PER TIER. Both come
    // out of one `BoardModel.assemble` call, which is what keeps this a single derived walk —
    // and the band bar's rail, the rows on screen and the honoured scope are three views OF
    // that one call, never a second one.
    //
    // Which tier is on screen is the OTHER decision, and the two are deliberately not the
    // same axis any more: the rail is always the tier rail, and the grouping only changes
    // how the tier's rows are headed and ordered.

    /// The board's whole answer for one pass: the tier rail, the scope's bands, and the
    /// scope that was honoured. Bound ONCE per body pass at the call site — every reference
    /// here
    /// would otherwise re-run the whole join+group+filter walk (the derived-
    /// collection discipline the perf gate pins; see `TasksDerivedPerfTests`).
    ///
    /// `now` is left to the model's default (call time), and the memo below keeps it
    /// honest with a per-minute bucket under the ONE filter whose answer depends on the
    /// clock (`.now`). Deliberately not a repeating timer: a clock that rebuilt every
    /// band would spend the whole derived budget to move one row, and any touch,
    /// keystroke or store update already re-derives.
    ///
    /// MEMOIZED, which is the second half of the top-of-list hitch fix (the first is
    /// that the board is the pinned working set, so the walk is over ~264 rows and not
    /// ~3,000). A body pass is published by every `@State` write, every ≤4Hz SSE batch
    /// and every keystroke, and most of them change nothing here — those are now a key
    /// comparison. See `BoardBandsCache`.
    ///
    /// The OBSERVED reads happen first, unconditionally, before the cache is consulted:
    /// on a hit the closure never runs, so a body that only touched `boardInputsGen`
    /// (which is deliberately not observable) would register no dependency on the lists
    /// and the board would stop updating. This is the same order `TasksStore`'s slice
    /// getters use, for the same reason.
    private var boardAssembly: BoardAssembly {
        let rows = tasks.tasks
        let sessions = tasks.sessions
        let tierOf = tasks.taskTiers
        let tierOrder = tasks.taskTierOrder
        let customTiers = tasks.customTiers
        // The project→folder hierarchy, read here for the same reason as everything
        // above it: the store's getter touches the OBSERVED folder array first, so the
        // board re-nests when the tree lands even though the memo key only compares
        // `boardInputsGen` (which the folder generation is part of).
        let folders = tasks.boardFolderIndex
        // The console's project order, which places the project groups. Observed read for
        // the same reason (its generation is part of `boardInputsGen`).
        let projectOrder = tasks.projectOrder
        // taskId → the task's own `session_ids`, for the tasks whose detail the phone
        // has read. Observed read, like every line above it: a detail landing while the
        // board is on screen has to re-derive the rows (its generation is part of
        // `boardInputsGen`), or a row keeps saying "no session yet" about a task we now
        // know has one.
        let knownSessionIds = tasks.sessionIdsByTask
        let filter = dateFilter.wrappedValue
        // Read once: BOTH the memo key and the build below need the same answer, and the
        // grouping's own getter depends on the scope (each tier remembers its own mode).
        let scope = tierScope
        let activeGrouping = grouping.wrappedValue
        let key = BoardBandsKey(
            inputsGen: tasks.boardInputsGen,
            query: trimmedQuery,
            grouping: activeGrouping,
            dateFilter: filter,
            // In the key because the scope now narrows the row set at CONSTRUCTION time: a
            // chip tap changes which rows exist, and a key without it would leave the
            // previous tier on screen until some unrelated input moved the key.
            scope: scope,
            showDone: showDone,
            showWaiting: showWaiting,
            // `.all` admits every row regardless of the clock, so its bands are
            // time-independent and the bucket is a constant. Under `.now` a start date
            // that passes has to show up, and a minute is the granularity that costs one
            // rebuild a minute at rest instead of one per body pass.
            nowBucket: filter == .now ? Int(AppClock.now().timeIntervalSince1970 / 60) : 0
        )
        return bandsCache.assembly(for: key) {
            BoardModel.assemble(
                tasks: rows,
                sessions: sessions,
                tierOf: tierOf,
                tierOrder: tierOrder,
                customTiers: customTiers,
                query: trimmedQuery,
                grouping: activeGrouping,
                dateFilter: filter,
                // The filters menu's one switch; off = every band folds its done rows.
                showDone: showDone,
                showWaiting: showWaiting,
                // Used by project grouping only. Empty (a server without the endpoint,
                // a failed fetch, an offline cold start) = the flat project bands.
                folders: folders,
                // A MISSING key is "never asked", not "no sessions" — see
                // `BoardRow.knownSessionIds`. Empty (a cold board) behaves exactly as
                // the board did before this existed.
                knownSessionIds: knownSessionIds,
                // The tier the rail is narrowed to. Applied INSIDE, before the grouping
                // branch, so both band builders inherit it (`BoardModel.assemble`).
                scope: scope,
                // Places the project groups exactly as the console does (`PinnedTierOrder`).
                projectOrder: projectOrder
            )
        }
    }

    // `boardRowIds` is gone: the list now dedups against `BoardModel.searchDedupIds`,
    // which is the same walk over the visible bands plus the other ids one row can be
    // named by (see the binding in `body`). A private forwarder that returned the
    // NARROWER set was how the session-UUID row escaped the dedup in the first place.

    /// Header ROW 2: the tier chips.
    ///
    /// ONE builder for both places it is drawn — the inline content row under the nav
    /// pills, and the pinned overlay that stands in for that row once it reaches the
    /// top edge. BOTH are always constructed; `BoardBandBar.drawsChips` decides which
    /// one is visible, so they are still never on screen together and neither is ever
    /// re-created by a pin crossing (the empty-pinned-bar fix). They must also land on
    /// the same pixels when they trade places — which ONE builder is necessary but was
    /// not sufficient for (R26): a shared call site still produced two layouts, because
    /// the containers differ.
    ///
    /// `placement` is the ONE thing the two calls differ in, and it is not a style knob:
    /// the two copies are handed different CONTAINERS (an inset List row vs the List's
    /// full width), and it tells the bar's geometry which, so both resolve to the same
    /// card at the same screen x. See `BoardBandRailGeometry.cardInset`.
    ///
    /// It reaches the CARD INSET and nothing else, which is what leaves the vertical
    /// hand-off and the card's style out of its hands: the Y is owned by
    /// `TasksChromeMetrics.chipsPinThreshold` (the offset where the two cards coincide)
    /// and the style by `BoardBandRailGeometry.cardCornerRadius` / `BoardBandBar
    /// .cardSurface`, both of which are the same value in both copies by construction.
    private func bandBar(
        proxy: ScrollViewProxy, selected: String?, chips: [BoardModel.BandChip],
        placement: BoardBandBarPlacement
    ) -> some View {
        BoardBandBar(
            chips: chips,
            // The scope the board HONOURED, not the one stored: a tier that emptied under
            // the reader reads as `All`, which is what the rows below it show.
            selected: selected,
            grouping: grouping,
            dateFilter: dateFilter,
            showDone: $showDone,
            showWaiting: $showWaiting,
            onSelect: { bandId in
                tierScopeRaw = BoardFilterPrefs.rawScope(bandId)
                // Land at the top of what you just asked for. Without this, narrowing from
                // a position deep inside Focus leaves you at an arbitrary offset in
                // Backlog — the rows changed under a scroll position that meant something
                // about the old set.
                //
                // The TOP anchor, not the selected band's: the scope narrows the board at
                // construction, so the tier you asked for IS the whole board now and its
                // first band is the top of the list. (Targeting a band read off the
                // PREVIOUS pass's array, which is what the old code had in hand here, would
                // aim at a band the next pass may not build at all.)
                //
                // Next runloop: the newly scoped bands have to exist before `scrollTo` can
                // land (same hop the locate-me handler needs, for the same reason).
                DispatchQueue.main.async {
                    withAnimation(.snappy(duration: 0.25)) {
                        proxy.scrollTo(Self.topAnchorId, anchor: .top)
                    }
                }
            },
            placement: placement,
            // Handed the LATCH, not a Bool: the bar reads `isPinned` itself, so a pin
            // crossing registers its Observation dependency in the bar's body instead of
            // in this view's. Passing a Bool here would put the read back in
            // `TasksView.body` and bring the 460ms hitch with it.
            pinLatch: chipsPinLatch
        )
    }

    @ViewBuilder
    private func boardSections(
        _ entries: [BoardCollapse.Entry], isEmpty: Bool, hidden: BoardHiddenCounts
    ) -> some View {
        if isEmpty {
            Section {
                Text(Self.boardEmptyText(
                    query: trimmedQuery, dateFilter: dateFilter.wrappedValue,
                    hidden: hidden
                ))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else {
            TaskBoardList(
                entries: entries,
                tierChoices: tasks.allTierChoices,
                newRowId: highlightedTaskId,
                tierOf: tasks.taskTiers,
                // The row whose tap is asking the server where to go (spinner in its
                // leading gutter, where the unread dot sits).
                resolvingRowId: router.resolvingRowId,
                // Folding only while there is no query (`BoardCollapse.entries`); a
                // heading tap mid-search would change nothing on screen.
                onToggleGroup: trimmedQuery.isEmpty ? { key in
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.snappy(duration: 0.25)) {
                        collapsedRaw = BoardCollapse.encode(
                            BoardCollapse.toggling(key, in: BoardCollapse.decode(collapsedRaw))
                        )
                    }
                } : nil,
                onToggleDone: { row in
                    if let task = row.task { toggleDone(task) }
                },
                onPickTier: { row, token in pickTier(row, token) },
                onOpenSession: { row in
                    guard drawer?.suppressTaps != true else { return }
                    router.open(row, tasks: tasks, show: onShowSession)
                },
                onOpenDetail: { row in
                    if let task = row.task {
                        tasks.markRead(taskId: task.id)
                        selected = task
                    }
                }
            )
        }
    }

    /// What an empty board says, and why the date filter gets a sentence of its
    /// own: `Now` HIDES rows, so "Nothing pinned yet" over a board full of
    /// deferred work is a lie that sends the user looking for a bug. Name the
    /// filter that did it AND where the control lives.
    ///
    /// `hidden` says what the filters took out. When it is waiting or done work, "every
    /// task starts later" would be the same kind of lie, so the sentence points at the
    /// filters menu and the footer line under it lists what is there.
    static func boardEmptyText(
        query: String, dateFilter: BoardDateFilter, hidden: BoardHiddenCounts = .zero
    ) -> String {
        if !query.isEmpty { return "No matches in Pins." }
        // Blame the dates only when they are what emptied it: rows are hidden as not
        // available yet, and nothing else is. A fresh install opens on Now, so an empty
        // board that hides nothing must say "Nothing pinned yet", not "pick All".
        let onlyLater = hidden.notAvailable > 0 && hidden.waiting == 0 && hidden.done == 0
        if dateFilter == .now, onlyLater {
            return "Nothing to do right now: every task starts later. Pick All in the filter menu to see them."
        }
        if !hidden.isEmpty {
            return "Nothing open here. The filter menu can show what is hidden."
        }
        return "Nothing pinned yet. Pin a task to keep it here."
    }

    /// A tapped tier token. The DECISION is `BoardModel.action` (pure, tested);
    /// this only performs it. A token that is already selected costs no request.
    private func pickTier(_ row: BoardRow, _ token: BoardModel.TierToken) {
        guard let task = row.task else { return }
        let current = tasks.tierId(for: task.id)
        switch BoardModel.action(for: token, current: current) {
        case .noop:
            return
        case .setTier(let tier):
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task {
                // A task that isn't pinned yet can't take a tier (the endpoint
                // 400s), so the pin rides along — which is what the user meant
                // by tapping a tier on an unpinned row.
                if current == nil, let error = await tasks.setPinned(task, pinned: true) {
                    toggleError = error
                    return
                }
                if let error = await tasks.setTier(taskId: task.id, tier: tier) {
                    toggleError = error
                }
            }
        case .unpin:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task {
                if let error = await tasks.setPinned(task, pinned: false) {
                    toggleError = error
                }
            }
        }
    }

    // MARK: - 503 not-synced state

    private var notSyncedState: some View {
        ContentUnavailableView {
            Label("Tasks not synced yet", systemImage: "arrow.triangle.2.circlepath")
        } description: {
            Text("This companion hasn't received its first task sync. Check back in a moment.")
        } actions: {
            Button("Retry") { Task { await tasks.loadTasks() } }
                .buttonStyle(.borderedProminent)
                .tint(Theme.tint)
        }
    }
}

/// Pages pushed inside the drawer, over the board.
enum TasksDrawerRoute: Hashable {
    case recents
}

// MARK: - Transient toast (fire-and-forget mutation feedback)

/// Small bottom toast for optimistic mutations: info ("Pinned · Focus") or a
/// subtle failure line after a revert. Auto-dismisses; tap to dismiss early.
/// Deliberately NOT a modal/alert — instant-first mutations never block.
/// The store's toast, on whichever of the Tasks tab's two surfaces is in front: the
/// board while the drawer is out, the page while it is shut. One surface alone hid it:
/// the board is invisible while shut, and the toast's timer ran out unseen (a failed
/// delete from a session's task page said nothing). Its own view, so the drawer's
/// fraction re-renders this line and not the board.
struct TasksToastLayer: View {
    @Environment(TasksStore.self) private var tasks
    let drawer: LeadingDrawerModel?
    let whileDrawerOpen: Bool

    var body: some View {
        if (drawer?.isOpen ?? true) == whileDrawerOpen,
           let notice = tasks.transientNotice ?? tasks.transientError {
            TransientToast(text: notice, isError: tasks.transientError != nil) {
                tasks.transientNotice = nil
                tasks.transientError = nil
            }
        }
    }
}

struct TransientToast: View {
    let text: String
    let isError: Bool
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.caption)
            Text(text)
                .font(.caption.weight(.medium))
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: Capsule())
        .foregroundStyle(isError ? Theme.danger : Theme.tint)
        .onTapGesture(perform: dismiss)
        .task {
            try? await Task.sleep(for: .seconds(isError ? 5 : 2.5))
            dismiss()
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityIdentifier("tasks.toast")
    }
}
