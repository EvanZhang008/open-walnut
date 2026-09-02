import SwiftUI

/// Tasks tab, Apple Reminders-style. A two-entry nav row (Pin | Calendar) scrolls
/// above the content for the active filter; the board is the default and renders as
/// V1 "edge-to-edge" bands (see `TaskBoardList`).
///
/// The board is the PINNED working set and it is now the tab's only task list — the
/// "All Tasks" pill is gone ("已经有 pin 了,为什么还会有 all task"), together with
/// the board's own "Everything else" band. Both were the whole task store rendered as
/// rows, which is where a 3,175-row `All` chip and a 460ms scroll hitch came from.
/// Unpinned work is reachable through SEARCH: typing a query still appends the
/// matching open tasks below the bands (`sections(excluding:)`) and the server hits
/// below that (`GlobalSearchSection`), neither of which runs on an idle body pass.
struct TasksView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(TasksStore.self) private var tasks

    @State private var activeFilter: TaskFilter = .sessions
    @State private var selected: WalnutTask?
    /// Explicit path so a freshly created session can push programmatically.
    @State private var navPath: [WalnutSession] = []
    /// The New Session draft, and WHICH TASK it is about (nil = no sheet).
    ///
    /// An item and not a Bool, because the sheet has two entrances that disagree about
    /// exactly one thing: the toolbar's `New Session` is about nothing
    /// (`BoardModel.BoardDraftSeed.unattached`), while every route from a TASK ROW is
    /// about that task and must link the new session to it. A Bool plus a separate
    /// `@State` task is two values that have to agree about one sheet, which is how a
    /// draft opens carrying the previous row's task — and an UNATTACHED draft reached
    /// from a task row is the orphan-session bug this state exists to close.
    @State private var newSessionSeed: BoardModel.BoardDraftSeed?
    /// The board row whose tap is currently resolving a destination (nil = none).
    /// Drives that row's spinner and keeps a second tap from starting a second lookup.
    @State private var resolvingRowId: String?
    @State private var showNewTask = false
    /// Sentence carried from the quick-add row into the full NewTaskSheet
    /// (the expand affordance) — parsed there into the form fields.
    @State private var newTaskSeedText = ""
    /// Destination carried into the full NewTaskSheet alongside the sentence
    /// (which project / pin tier the add started from).
    @State private var newTaskSeed = NewTaskSeed(project: "", pin: .unspecified)
    /// Which group header's `+` is currently open, by seed identity. Exactly one
    /// inline add row at a time: two open keyboards on one list is not a thing,
    /// and a single value makes "the other one closes" automatic.
    @State private var openAddGroup: NewTaskSeed?
    /// Local search — filters tasks (title/project) and sessions
    /// (title/task/host/cwd) in place; no server round-trip.
    @State private var searchText = ""
    /// Locate-me flash for a just-created task (scroll target + row tint).
    @State private var highlightedTaskId: String?
    /// True while the inline add row's field is focused — rapid consecutive
    /// adds must not yank the scroll position / filter out from under the
    /// keyboard (Reminders keeps you anchored on the field).
    @State private var inlineAddActive = false
    /// Multi-select edit mode (Wave 1): batch complete / delete over the
    /// partial-success batch endpoints.
    @State private var editMode: EditMode = .inactive
    @State private var selectedIds = Set<String>()
    @State private var batchBusy = false
    @State private var batchError: String?
    @State private var confirmBatchDelete = false
    /// True once the header chrome (nav row / quick add) has scrolled off the top,
    /// so the compact bar takes over its two jobs (switch filter, add a task) on
    /// the filters that have one. Driven by `onScrollGeometryChange` with
    /// hysteresis — see `TasksChromeMetrics`.
    @State private var chromeCollapsed = false
    /// Continuous scroll samples live HERE, off the view graph, and the deferred
    /// publish is coalesced through it — see `ChromeCollapseTracker`.
    @State private var collapseTracker = ChromeCollapseTracker()
    /// True once the BOARD's chip row (header row 2) has reached the top edge, so the
    /// pinned copy stands in for it. A separate state from `chromeCollapsed` because
    /// it crosses at a different place and for a different reason: the compact bar
    /// replaces chrome that has fully LEFT, the pinned chips take over the instant
    /// their own row starts to go under. See `TasksChromeMetrics.chipsPinThreshold`.
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

    // MARK: - Board state (the default filter's bands)
    //
    // Bands showing their done rows, and which band's create row is open. Both are
    // sets/optionals of BAND ids rather than per-row view state so a store refresh
    // can't reset them. (There is no expanded-row state: a row's tap opens its
    // session — the row itself never grows.)
    //
    // "Band id", not "tier id": under `By project` grouping these are
    // `proj:<name>`. The model namespaces them (`BoardModel.projectBandPrefix`)
    // precisely so the two groupings can share this state without a project
    // called "focus" inheriting the Focus tier's hide-done switch.

    /// Bands the reader has EXPANDED to show their done rows, by band id.
    ///
    /// Empty is the shipped default and it means every band folds its completions
    /// (`BoardModel.bands(shownDoneTiers:)`), so the board opens on open work: the
    /// counts on the headings and the chips are then open counts, which is what the
    /// screen is for. This set is the exception, one explicit tap per band, and it
    /// lives here (not per row, not per launch preference) for the same reason
    /// `openCreateBand` does: a store refresh must not silently re-fold a band the
    /// reader just opened.
    @State private var shownDoneBands: Set<String> = []
    /// Which band's foot create row is open, by band id (exactly one: two
    /// keyboards on one list is not a thing).
    @State private var openCreateBand: String?
    /// Which band the floating bar's chip has narrowed the board to (nil = All).
    ///
    /// A BAND id, like the two above, and it is deliberately only ever compared
    /// against the bands the board already built (`BoardModel.filtered`): a chip is
    /// a view over the assembled bands, never a second query, because two paths
    /// deciding what a band contains is how a task went missing from this screen
    /// once already.
    @State private var selectedBandId: String?

    // The board's two filters, mirroring the desktop's View dropdown (grouping +
    // date). Persisted through @AppStorage, which is how this app already keeps a
    // view preference (SettingsView's mic route, NotesView's pinnedCollapsed) and
    // the same shape as the desktop's localStorage keys. The RAW string is what
    // defaults can hold; `BoardFilterPrefs` maps it back and absorbs a value an
    // older build wrote. See BoardFilterBar.swift for the defaults and why they
    // differ from the desktop's.
    @AppStorage(BoardFilterPrefs.groupingKey) private var groupingRaw =
        BoardFilterPrefs.defaultGrouping.rawValue
    @AppStorage(BoardFilterPrefs.dateFilterKey) private var dateFilterRaw =
        BoardFilterPrefs.defaultDateFilter.rawValue

    private var isEditing: Bool { editMode == .active }

    /// The stored grouping/date strings as the typed values the model and the
    /// filter bar speak. Bindings rather than a second `@State` mirror: one source
    /// of truth means a tap writes defaults directly and nothing can drift out of
    /// sync with what was persisted.
    private var grouping: Binding<BoardGrouping> {
        Binding(
            get: { BoardFilterPrefs.grouping(groupingRaw) },
            set: { groupingRaw = $0.rawValue }
        )
    }

    private var dateFilter: Binding<BoardDateFilter> {
        Binding(
            get: { BoardFilterPrefs.dateFilter(dateFilterRaw) },
            set: { dateFilterRaw = $0.rawValue }
        )
    }

    /// ScrollViewReader id of the first scrollable row, so the compact bar can
    /// bring the real header back.
    static let topAnchorId = "tasks.top"

    /// Where the board's TOP-LEVEL quick add files a task.
    ///
    /// Two rules, and the first one is what keeps the row honest: whatever it creates has
    /// to be VISIBLE on the board that created it, and the board is the pinned working set.
    /// So the pin is never left to the server default — it is the selected band's tier when
    /// a tier band is selected, and `BoardModel.defaultTierId` otherwise, which is the same
    /// band a pin with no split lands in (so the row does not visibly hop when the
    /// authoritative split arrives).
    ///
    /// Second rule: a PROJECT band's chip pre-fills its project but cannot supply a tier
    /// (`NewTaskSeed.project` deliberately leaves the pin unspecified, because adding under
    /// a project header is about the project). Keeping that seed as-is would create an
    /// unpinned task, i.e. rule one broken, so the project survives and the pin is filled
    /// in. That is exactly the assumption the board has broken before by reading a band id
    /// as if it were a tier id.
    ///
    /// A static function over the bands rather than a lookup inside the body: it is the
    /// kind of rule that is wrong in one grouping and right in the other, which is what
    /// `CreateWithTierTests` pins.
    static func boardQuickAddSeed(bands: [BoardBand], selected: String?) -> NewTaskSeed {
        let seed = bands.first { $0.bandId == selected }?.createSeed
        if let seed, seed.pin.namesTier { return seed }
        return NewTaskSeed(project: seed?.project ?? "", pin: .tier(BoardModel.defaultTierId))
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if tasks.notSyncedYet && tasks.tasks.isEmpty {
                    notSyncedState
                } else if activeFilter == .calendar {
                    // Full-bleed: the calendar's own views scroll and page
                    // (hour timelines, day list), which a List row can't host —
                    // a pager inside a List row has no intrinsic height.
                    calendarSurface
                } else {
                    list
                }
            }
            .navigationTitle("Tasks")
            // A filter with no header entry any more (Today / In Progress / Done,
            // whose cards this rebuild removed) would render a header with nothing
            // selected over a list the user cannot switch away from. Normalising on
            // appear is the cheapest place to close that: it runs before the first
            // frame the user sees, and `TasksNavEntry.resolve` is a pure function so
            // the rule itself is unit-tested rather than trusted.
            .onAppear {
                activeFilter = TasksNavEntry.resolve(activeFilter)
                // "The Tasks screen is on screen" — the ONE thing that should make
                // the board reconcile because a person is looking at it.
                //
                // `.onAppear`, deliberately, and not the `.task` this used to live in:
                // a `.task` is tied to the lifetime of a view in the render tree, not
                // to the screen being visible, and SwiftUI re-arms it whenever the
                // subtree it sits in is re-evaluated. With a session conversation
                // pushed over the board that measured 22 re-arms against 2 body
                // passes, and since the bundle it fired writes the very lists this
                // screen renders, each fetch bought the next one: five requests every
                // ~160ms, for as long as the app was open (2026-09-01, 13 minutes,
                // ~3.7 MB/s of JSON on the production event loop).
                //
                // Gated on first activation for the original reason this was a `.task`
                // (P0-2): a background/prewarm launch must start no network work.
                // Freshness-gated in the store, so even a chatty appearance signal
                // cannot become a poll — see `BoardRefreshOrigin.minimumAge`.
                LaunchGate.shared.whenActive {
                    await tasks.refreshBoard(origin: .boardAppeared)
                }
            }
            // Apple Reminders' actual mechanism: the large title collapses to an
            // inline one as you scroll, and the search field (a nav-bar DRAWER,
            // not a List row) rides up with it. `.automatic` on the drawer is
            // what makes the field hide on scroll-down and come back on
            // scroll-up — a `.always` drawer would pin ~44pt forever.
            // GHOST PILE-UP fix: a VISIBLE navigation bar background — and ONE line,
            // never the `ShapeStyle` overload. That is the whole R30 correction, so the
            // rest of this comment is the two things it has to keep true at once.
            //
            // WHY THE BAR NEEDS A BACKGROUND AT ALL. Left at its scroll-edge appearance,
            // which on iOS 26 is transparent, band headings, task rings and titles read
            // straight THROUGH the bar and up into the status bar, overlapping the inline
            // "Tasks" title. The board makes it worse than the same omission elsewhere for
            // two reasons it also owns: it hides the List's own background and paints its
            // own page behind full-contrast text (`scrollContentBackground(.hidden)`
            // below), and the pinned chips overlay sits flush at the top of the content
            // area, so there is no opaque strip for the glass to sit on. `ChatView`,
            // `SessionConversationView` and `InboxView` all say exactly this one line and
            // none of them ghosts.
            //
            // WHY THE COLOUR OVERLOAD IS GONE, and it is not a style preference: with
            // `.toolbarBackground(BoardBandCard.page, for: .navigationBar)` in front of
            // it, the large "Tasks" title rendered ZERO pixels. Measured on the pinned
            // simulator, cold launch, light AND dark, default AND accessibility-XXXL: the
            // title's own accessibility rect came back a flat 243-246 luminance, i.e. the
            // page colour and nothing else. `InboxView`, one `.visible` and no colour,
            // draws its title fine on the same OS — which is what identified the overload
            // rather than the opacity as the cause. A screen whose title is invisible has
            // no navigation identity at all, so the colour lost.
            //
            // What the colour was FOR was the seam: an opaque bar in a colour other than
            // the board's page would step against it 44pt down the screen, and in dark
            // mode the pair actually measured a 31-level step (31.3 grey bar against the
            // List's 0). Dropping the overload fixes that too, and for the reason the
            // overload could never have: the platform's own bar background is DERIVED from
            // whatever it sits over, so there is no second colour left to disagree with
            // `BoardBandCard.page`. Two numbers that have to match became one number.
            //
            // `.visible` needs no availability gate (iOS 16+, deployment target 18.0), so
            // it ships to every supported OS. `scrollEdgeEffectStyle(.hard, for: .top)` is
            // the platform's OWN answer on iOS 26 and rides the List below
            // (`hardTopScrollEdge`), gated — complementary, not alternatives: this one
            // gives the BAR a background, that one stops the content reading through the
            // top edge in the first place.
            .toolbarBackground(.visible, for: .navigationBar)
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search tasks & sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { StatusBadge() }
                // Multi-select entry — task LIST filters only (sessions aren't
                // batch-actionable, and the calendar has no rows to select).
                // "Select" → edit mode with a bottom bar.
                if activeFilter != .sessions && activeFilter != .calendar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(isEditing ? "Done" : "Select") {
                            let entering = !isEditing
                            withAnimation {
                                editMode = entering ? .active : .inactive
                                if entering { selectedIds.removeAll() }
                            }
                        }
                        .accessibilityIdentifier("tasks.select")
                    }
                }
                // BOTH create entries show on BOTH server modes (2026-08).
                // TASK creation: the replica writes its local store and the
                // task outbox syncs it back to the primary. SESSION creation:
                // the replica relays over the bridge to the primary box
                // (narrow session.launch command → quick-start there); an
                // old cloud server / old daemon degrades to a clear error in
                // the sheet (not_supported_cloud / session_launch_needs_upgrade).
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            showNewTask = true
                        } label: {
                            Label("New Task", systemImage: "checkmark.circle")
                        }
                        .accessibilityIdentifier("tasks.create")
                        Button {
                            // The toolbar's draft is about no task in particular.
                            newSessionSeed = BoardModel.BoardDraftSeed.unattached
                        } label: {
                            Label("New Session", systemImage: "terminal")
                        }
                        .accessibilityIdentifier("sessions.create")
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(Theme.tint)
                    }
                    // Automation compat: the collapsed Menu renders as ONE
                    // accessibility element (a button), and SwiftUI surfaces
                    // the identifier applied to the Menu itself — not one on
                    // the label view. Existing Maestro flows tap "sessions.new"
                    // to start session creation, so the menu container keeps
                    // that id (tap → menu opens → tap "sessions.create").
                    // The menu ITEMS carry distinct ids ("tasks.create" /
                    // "sessions.create") so open-menu taps are unambiguous.
                    .accessibilityIdentifier("sessions.new")
                }
            }
            .sheet(item: $selected) { task in
                TaskDetailSheet(task: task)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            // Starting a session lands in a CHAT PAGE with the folder/host and
            // model pickable there (the phone's version of the web draft column),
            // instead of a form you fill in before arriving somewhere else. Full
            // height, not .medium: it hosts a composer, and a keyboard over a
            // half sheet leaves no room for the launch bar the page is about.
            // The seed carries the TASK when the draft was reached from a task row, so
            // `POST /v1/sessions` links the session it creates. Without it a draft
            // reached by mis-routing a task row (the bug this round fixes) created a
            // SECOND, unlinked session on a task that already had one — an orphan
            // nothing points at.
            .sheet(item: $newSessionSeed) { seed in
                NavigationStack {
                    NewSessionChatView(
                        taskId: seed.taskId,
                        taskTitle: seed.taskTitle
                    ) { session in
                        newSessionSeed = nil
                        navPath.append(session)
                    }
                }
                .presentationDetents([.large])
            }
            .sheet(isPresented: $showNewTask, onDismiss: {
                newTaskSeedText = ""
                newTaskSeed = NewTaskSeed(project: "", pin: .unspecified)
            }) {
                // No onCreated action: the store's optimistic insert makes the
                // new task appear in the list the moment the sheet dismisses.
                NewTaskSheet(seedText: newTaskSeedText, seed: newTaskSeed)
                    .presentationDetents([.medium, .large])
            }
            // Session rows push a full-screen conversation page instead of a sheet.
            .navigationDestination(for: WalnutSession.self) { session in
                SessionConversationView(session: session)
            }
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

    /// Case-insensitive substring match across session title, owning-task
    /// title, host, and cwd.
    static func sessionMatches(_ session: WalnutSession, query q: String) -> Bool {
        guard !q.isEmpty else { return true }
        if session.title?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.taskTitle?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.host.localizedCaseInsensitiveContains(q) { return true }
        if session.cwd?.localizedCaseInsensitiveContains(q) == true { return true }
        return false
    }

    private func sessionMatchesSearch(_ session: WalnutSession) -> Bool {
        Self.sessionMatches(session, query: trimmedQuery)
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

    private func sections(excluding: Set<String>) -> [(project: String, tasks: [WalnutTask])] {
        // The field promises "Search tasks & sessions", but the default
        // (board) filter slices tasks to the PINNED board — a task the user KNOWS
        // exists showed "No local matches" until they discovered the All segment
        // (dogfood R17). While a query is typed, search open tasks too.
        let filter = (activeFilter == .sessions && !trimmedQuery.isEmpty) ? TaskFilter.allOpen : activeFilter
        return Self.sections(from: tasks.tasks(for: filter), query: trimmedQuery, excluding: excluding)
    }

    // MARK: - Calendar surface

    /// The Calendar filter renders FULL-BLEED, not as a List row: its four views
    /// (hour timelines, day list, month grid) own their own scrolling and
    /// horizontal paging, and a pager nested in a List row has no intrinsic
    /// height. The nav row stays on top so switching back out is one tap.
    private var calendarSurface: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline — tasks are read-only from cache")
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
            }
            TasksNavRow(activeFilter: $activeFilter)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            Divider()
            CalendarTabView()
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            // Bind the derived sections ONCE per body pass — the old computed-
            // property form was evaluated at every reference (isEmpty check +
            // ForEach = 2 full filter+group+sort walks per pass).
            // Same rule for the board's bands: the band bar, the sections builder
            // and the search dedup all need them, which is three full join+group
            // walks per pass if each reads the computed property (the exact
            // anti-pattern the derived-collection perf gate exists to catch). Only
            // computed on the board — every other filter would pay for a list it
            // doesn't render.
            let bands = activeFilter == .sessions ? boardBands : []
            // The chips are derived from those same bands (counts included), and the
            // rows come from the same array filtered by the chip selection. ONE
            // assembly, two views of it: a chip can never claim a count the band
            // below it disagrees with, and a band cannot exist in the bar and not on
            // the board.
            let chips = activeFilter == .sessions ? BoardModel.chips(bands) : []
            let visibleBands = BoardModel.filtered(bands, selected: selectedBandId)
            // …and `sections` only when something actually renders THEM. The board
            // builds its OWN bands (tier or project, per the filter bar) and
            // reaches for `sections` only to append search hits (dogfood R17).
            // note that `By project` grouping does NOT change this: those bands
            // come from `BoardModel.projectBands`, which is one walk over the same
            // rows, not a second grouping pass here. Computing `sections` anyway
            // cost a full filter+group+sort over the whole projection on every
            // keystroke, measured as the single largest item in the derived pass
            // (5.17ms of an 8ms budget), spent on rows the board never draws.
            // Dedup against what is VISIBLE, not against every band — and "visible"
            // means `visibleBands`, i.e. WITH the chip selection applied, because the
            // chips KEEP filtering the board while a query is live. That is the
            // decision, not an accident: narrowing a search to one tier is useful and
            // it is what the desktop console does. (An older comment here and on the
            // bar claimed a query WIDENED the board to every band and that the chip
            // "stopped deciding anything" — it never did; the code always narrowed,
            // and the bar dimmed to ~1.3:1 contrast to advertise a rule it wasn't
            // following. The dimming is gone with the claim.) So a task matching in a
            // band the chip is hiding is NOT on screen and belongs in the hit list
            // below.
            //
            // ONE case still moves the lit chip on its own, and it stays truthful
            // rather than silent: a query that leaves the selected band with no rows
            // drops that band from `bands` entirely (`BoardModel.bands` keeps no empty
            // bands), so `selectedChip` reads `All` and the board shows every band. The
            // bar and the board agree in that state — which is the property that
            // matters, and the one dimming was standing in for.
            //
            // Computed only while a query is live, which is the only time anything
            // reads it — on the board at rest this set costs a walk over every
            // visible row for nothing.
            //
            // `searchDedupIds`, not `rowIds`: a duplicate has to be silenced whichever
            // id the row it duplicates happens to be keyed by. The board used to key a
            // row whose task is missing from the projection by the CLI session UUID, so
            // the server's hit for that same task matched nothing here and the task drew
            // TWICE, 55pt apart (R25). The row's key is the owning task id now; this set
            // also carries the session id so the dedup does not depend on that.
            //
            // ONE walk serves both readers. It is a SUPERSET of the row ids, which is
            // safe for `sections(excluding:)` because everything extra in it is an id no
            // section row can have: a session UUID, or the owning task id of a
            // session-only row — and a row is session-only precisely because the
            // projection those sections are built from does not carry that task.
            let boardExcluded: Set<String> = (activeFilter == .sessions && !trimmedQuery.isEmpty)
                ? BoardModel.searchDedupIds(visibleBands) : []
            let sections = (activeFilter == .sessions && trimmedQuery.isEmpty)
                ? []
                : self.sections(excluding: boardExcluded)
            // Everything the list above ALREADY shows, for the server-hit dedup at the
            // foot: the board's visible rows plus the local hit rows. Same reason the
            // sets above are bound once per pass — `GlobalSearchSection` must not
            // recompute this per row.
            let alreadyVisibleTaskIds: Set<String> = trimmedQuery.isEmpty
                ? []
                : sections.reduce(into: boardExcluded) { ids, section in
                    for task in section.tasks { ids.insert(task.id) }
                }
            List {
                if !connection.online {
                    OfflineBanner(text: "Offline — tasks are read-only from cache")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                // ROW 1: the nav pills, at the TOP, scrolling away with the content.
                //
                // This is the user's order and it is worth naming what it replaced: the
                // board used to open with a clear RESERVE row for a permanently
                // floating chip bar, so the chips drew ABOVE these pills at scroll-top
                // (measured 2026-08-29: chips y 236..264, pills y 290..322) — the exact
                // inverse of what was asked for. The reserve is gone; the chips are an
                // ordinary row below (see ROW 2) and only their PINNED copy floats.
                Section {
                    TasksNavRow(activeFilter: $activeFilter)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        // Scroll target for the compact bar's "back to the top"
                        // (a chip tap, which restores the search field + quick
                        // add). Must be the FIRST row of the scrollable content on
                        // every filter that HAS a compact bar.
                        .id(Self.topAnchorId)
                }
                // Header chrome (nav row / quick add) is a TOOLBAR, not a settings
                // group: the default insetGrouped gap belongs between PROJECTS, and
                // stacking it under four chrome sections pushed the first task row
                // 68% down the screen (measured, dogfood R19).
                .listSectionSpacing(2)

                // ROW 2 (board only): the tier chips, second, and the only row here
                // that pins.
                //
                // The row keeps its FIXED height whether or not it is drawing chips:
                // when the pinned copy has taken over, the content becomes clear space
                // rather than the row collapsing. A row that changed height mid-scroll
                // would move every row under it — the scroll-jump class of bug this
                // screen has shipped before.
                //
                // The constant height is also half of what makes the hand-off invisible:
                // the pinned bar covers exactly the strip this row occupies AT THE MOMENT
                // IT CROSSES, and "at the moment it crosses" is the other half — the pin
                // threshold is derived from this row's own content position
                // (`TasksChromeMetrics.rowTwoContentTop`), so the two tops meet there
                // rather than 10.66pt apart.
                //
                // Mutually exclusive with the overlay, deliberately: both draw the same
                // `board.chip.*` ids, and two live copies would make every chip
                // ambiguous to automation. WHERE that is decided moved, and the move is
                // the empty-pinned-bar fix: this row is now built UNCONDITIONALLY and
                // `BoardBandBar.drawsChips` hides whichever copy is not the live one.
                //
                // The old shape was `if boardChipsPinned { Color.clear } else { bar }`,
                // i.e. a conditional INSERTION, so every pin crossing destroyed one
                // copy and constructed the other — a brand-new `ScrollView` for the
                // rail each time. One that came up measured at zero width stayed
                // chipless for the life of that instance (the user's screenshot: a card
                // and a filters button over a mathematically flat 316pt rail). Two
                // always-present copies means two `UIScrollView`s whose content is
                // established once each, and no crossing can leave either wrong.
                //
                // It also takes the derive off the scroll path: the pin state is read
                // INSIDE the bar (`BoardChipsPinLatch`), so a crossing no longer
                // invalidates this body — see the latch's own header.
                if activeFilter == .sessions {
                    Section {
                        bandBar(
                            proxy: proxy, bands: bands, chips: chips,
                            // The List has ALREADY inset this row (measured
                            // x 16..386 of a 402pt screen), so the card takes
                            // the container it is handed whole.
                            placement: .inlineRow
                        )
                        .frame(height: TasksChromeMetrics.bandBar)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                    .listSectionSpacing(2)

                    // Row 3: the grouping + date decisions as two inline toggle chips —
                    // the desktop's own `tier-view-bar`, on the bar rather than one tap
                    // inside the band bar's filter menu ("它不是在一个菜单里面,它就是在那
                    // 个 bar 里面"). Same bindings the menu writes, so there is one source
                    // of truth and no second copy of the state; see `BoardViewBar` for why
                    // it is a row of its own and not a third zone inside the band bar's
                    // card.
                    Section {
                        BoardViewBar(grouping: grouping, dateFilter: dateFilter)
                            .frame(height: TasksChromeMetrics.viewBar)
                            .listRowInsets(EdgeInsets())
                            // A control strip on the PAGE, not a card: the chips are the
                            // objects here, and a card behind them would put three stacked
                            // cards above the board's first task row.
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                    .listSectionSpacing(2)
                }

                // Todoist-grade quick add rides the TOP of EVERY filter, the board
                // included (R30): type a sentence, hit return, the task appears instantly
                // (the AI parse upgrades it in place). The expand icon opens the full form
                // sheet seeded with the sentence.
                //
                // ON THE BOARD it is a reversal, so here is what changed. R29 argued the
                // band feet already carry this component and a top-level copy would be a
                // seventh create affordance costing 48pt at the top of a screen whose job
                // is rows. The user then picked the reference screen — which has exactly
                // this row above its first section — as the style to match, and the
                // argument does not survive it: a band foot answers "add to THIS band",
                // which you can only tap after scrolling to the band, while the thing you
                // usually want is "add something, put it where new work goes". Those are
                // different questions, and only one of them is answerable from the top of
                // the screen.
                //
                // Same COMPONENT, same flow, one different value: the destination
                // (`boardQuickAddSeed`). It is not the empty seed the other filters pass,
                // because the board only shows PINNED work — an unpinned task created here
                // would be filed correctly and then be invisible on the surface that
                // created it, which is the "I made it and can't find it" defect the board
                // has already shipped once. So it pins into the default tier, and when a
                // band chip is selected it inherits that band's project too.
                Section {
                    QuickAddRow(
                        seed: activeFilter == .sessions
                            ? Self.boardQuickAddSeed(bands: bands, selected: selectedBandId)
                            : NewTaskSeed(project: "", pin: .unspecified),
                        identifier: "tasks.quickAdd",
                        onExpand: { text, target in
                            newTaskSeedText = text
                            newTaskSeed = target
                            showNewTask = true
                        }
                    )
                }
                .listSectionSpacing(2)

                // Live sessions ride the top of every task filter (except the
                // board, where every row already carries its own session, and
                // Calendar, which is a full-bleed month grid).
                if activeFilter != .sessions && activeFilter != .calendar {
                    activeSessionsSection
                    // Pinned tasks float above the project sections (mirrors
                    // the desktop focus bar). Rows keep full swipe/menu/detail
                    // behavior; hidden while searching (results replace it).
                    if trimmedQuery.isEmpty {
                        pinnedTasksSection
                    }
                }

                if activeFilter == .sessions {
                    // The board's grouping + date pair used to be a List row here
                    // (`BoardFilterBar`). Both now live in the reserved column at the
                    // trailing edge of the chip bar (header row 2), which is also where
                    // band selection lives — ONE set of controls in ONE place, and the
                    // bar is rendered even when the bands come back EMPTY, so a `Now`
                    // that hid everything can never also hide the control that turns it
                    // off.
                    boardSections(visibleBands)
                    // Dogfood R17, still true on the board: the field promises
                    // "Search tasks & sessions", and the board only holds PINNED
                    // work — so a task the user knows exists would come back "no
                    // matches" while sitting in the Inbox. Matching open tasks
                    // render below the bands while a query is live.
                    //
                    // These rows are `taskRowButton`s, shared with every other filter,
                    // and after R29 that is no longer a compromise: the board's own rows
                    // take the same inset-grouped card, so a hit section below the bands
                    // is the same object in the same language. Its HEADING is what marks
                    // it as a different list, which is what a grouped section header is
                    // for.
                    if !trimmedQuery.isEmpty {
                        ForEach(sections, id: \.project) { section in
                            projectSection(section)
                        }
                    }
                } else if sections.isEmpty {
                    Section {
                        Text(emptyText)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 24)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                } else {
                    ForEach(sections, id: \.project) { section in
                        projectSection(section)
                    }
                }

                // Apple Reminders-style inline add — a persistent row at the
                // BOTTOM of every task list (not the Sessions tab): tap →
                // inline TextField, Return creates + keeps typing for rapid
                // consecutive adds. Goes to Inbox; the toolbar "+" menu keeps
                // the full sheet for project/priority/due picks.
                if activeFilter != .sessions {
                    Section {
                        InlineAddTaskRow(isActive: $inlineAddActive)
                    }
                }

                // Server-side global search augments the local matches while
                // a query is typed (tasks/memory/sessions; 501 on cloud →
                // a degradation notice).
                //
                // AUGMENTS, so it is handed what is already on screen. `/api/search`
                // answers a task hit AND the hit for the session that task owns, both
                // carrying the same taskId, which put one task on screen three times
                // in one viewport (its board row plus two "Server Search" rows).
                // `BoardSearchHitDedup` is where that is decided.
                if !trimmedQuery.isEmpty {
                    GlobalSearchSection(
                        query: trimmedQuery,
                        visibleTaskIds: alreadyVisibleTaskIds
                    ) { taskId in
                        if let hit = tasks.tasks.first(where: { $0.id == taskId || $0.id.hasPrefix(taskId) }) {
                            selected = hit
                        }
                    }
                }

                if let synced = tasks.syncedAt {
                    Section {
                        Text("Synced \(synced.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.insetGrouped)
            // ONE page colour for every filter, including the board (R29): the board's
            // bands are inset-grouped cards again, and cards need the grouped page behind
            // them to read as cards at all.
            //
            // Still stated explicitly rather than left to the List's own default, for two
            // reasons. It is the same SYMBOL the opaque toolbar above takes, so "no seam
            // under the nav bar" is a property of the code instead of two colour literals
            // that have to agree; and the List's default background is the platform's to
            // change (iOS 26 renders plenty of chrome as material), while the cards'
            // contrast is measured against this exact value.
            //
            // Note what did NOT change: `listStyle` is one concrete type for every filter,
            // because picking a style per filter would mean two `List` expressions, two
            // List identities, and a rebuilt scroll view (lost offset, re-armed geometry
            // observer, re-created `.searchable` drawer) on every filter switch. See
            // `TaskBoardList`'s header for the rest of the mechanism.
            .scrollContentBackground(.hidden)
            .background(BoardBandCard.page)
            // The iOS 26 half of the ghost fix, and the platform's own answer to
            // "content must not read through the top edge": a HARD scroll edge effect
            // instead of the default progressive one. The opaque toolbar above already
            // stops the reported ghost on every supported OS; this stops the content
            // reading through the edge in the first place where the OS can do it.
            .hardTopScrollEdge()
            .accessibilityIdentifier("tasks.list")
            // Watch how far the list is scrolled and flip the two floating rows. The
            // OBSERVER is what makes the header chrome disposable: the nav row, the
            // quick add and (now) the board's chip row are ordinary List rows, so they
            // already scroll away — this is what keeps their ACTIONS reachable after
            // they do, as a compact bar on the list filters and as the pinned chip row
            // on the board.
            // The sample is the OFFSET and the INSET, kept apart. It used to be their
            // sum, and that is the third defect on this handler's path: the search
            // drawer retracts as soon as a drag starts, so the whole drawer height left
            // `contentInsets.top` in ONE sample and read as travel nobody performed —
            // enough to force the chrome collapse and the chip pin together, at the top
            // of the gesture. `TasksChromeMetrics.travel` makes a sample whose INSET moved
            // report no travel of its own (the origin moved, not the content) and keeps
            // the honest `offset + insetTop` everywhere else, so rest still reads exactly
            // 0; it is the pure rule and the tracker is just its memory.
            //
            // NOTE the shape of this handler. Writing @State straight from the
            // action would publish INTO the layout pass that produced the sample
            // and re-invalidate the very subtree being measured (P0-2, see
            // ScrollBottomTracking's header — that feedback did not converge and
            // spun the main thread at 100%). So: samples land in a reference box
            // off the view graph, the decision is a pure function, and the ONE
            // publish that a threshold crossing needs is hopped to the next
            // runloop and coalesced (a second crossing while one is queued
            // replaces it rather than stacking).
            .onScrollGeometryChange(for: BoardScrollSample.self) { geo in
                BoardScrollSample(offset: geo.contentOffset.y, insetTop: geo.contentInsets.top)
            } action: { _, sample in
                let scrolled = travelTracker.travel(sample)
                // Edit mode owns the top of the screen with its own affordances,
                // and a filter switch mid-selection would silently change what is
                // selected — so the bar stays out of the way there.
                let next = !isEditing && TasksChromeMetrics.isCollapsed(
                    scrolled: scrolled,
                    wasCollapsed: chromeCollapsed,
                    filter: activeFilter,
                    offline: !connection.online
                )
                collapseTracker.request(next, current: chromeCollapsed) { value in
                    withAnimation(.snappy(duration: 0.2)) { chromeCollapsed = value }
                }
                // The board's row 2 crosses at its OWN threshold (the top of the chip
                // row, not the end of the chrome) and through its own gate, so a
                // crossing of one never publishes the other.
                //
                // Not animated, and that is only safe because the threshold IS the offset
                // where the two copies occupy the same screen rect
                // (`TasksChromeMetrics.chipsPinThreshold`, derived from `rowTwoContentTop`).
                // Animating an invisible swap only makes it visible; animating a swap that
                // is NOT invisible hides a real defect behind a slide, which is how a
                // 10.66pt vertical hop survived to a frame audit.
                //
                // The state this publishes into is the LATCH, not `@State` on this
                // view: nothing in `TasksView.body` reads `isPinned`, so a crossing
                // re-renders the two 44pt bars and leaves the board derive, the chips
                // and the List diff alone. That is the top-of-list hitch fix, and it is
                // an invariant rather than an optimisation — see `BoardChipsPinLatch`.
                let pinned = TasksChromeMetrics.hasPinnedChips(activeFilter)
                    && TasksChromeMetrics.areChipsPinned(
                        scrolled: scrolled,
                        wasPinned: chipsPinLatch.isPinned,
                        offline: !connection.online
                    )
                chipsPinTracker.request(pinned, current: chipsPinLatch.isPinned) { value in
                    chipsPinLatch.isPinned = value
                }
            }
            // Leaving edit mode must give the bar back; entering it takes the bar
            // away. Neither is a scroll event, so neither reaches the handler.
            .onChange(of: isEditing) { _, editing in
                if editing, chromeCollapsed { chromeCollapsed = false }
                // Selection owns the rows: an open group add row would keep a
                // keyboard over the batch bar and its `+` is already hidden.
                if editing { openAddGroup = nil }
            }
            // Switching filters re-groups everything, so the header that owned
            // the open row may not exist any more — a row anchored to a vanished
            // group would file into a group the user can no longer see.
            .onChange(of: activeFilter) { _, _ in
                openAddGroup = nil
                // The next filter has its own chrome height and its own drawer, so the
                // remembered sample describes a list that is no longer on screen: comparing
                // the next filter's first sample against it would read the whole difference
                // in chrome height as an inset step and absorb a real scroll position.
                travelTracker.reset()
                // A band selection means nothing off the board, and carrying a
                // stale one back would narrow the board the next time it opens
                // without the user having asked for it on THIS visit.
                selectedBandId = nil
                // Row 2's pin state is about a scroll position on the BOARD. Coming
                // back with a stale `true` and no scroll sample yet would draw the
                // pinned copy over the nav pills — the very defect this rebuild
                // removes — while the inline row held clear space. Unpinned is always
                // safe to be wrong about: the inline row simply draws the chips where
                // its own content position puts them, and the next geometry sample
                // re-pins if the list really is scrolled.
                chipsPinLatch.isPinned = false
            }
            // Switching the board's GROUPING replaces every band id at once
            // (`focus` → `proj:marina`), so an open create ring is anchored to a
            // band that no longer exists: the ring vanishes with its keyboard
            // still up and the typed text goes nowhere. Same reasoning as the
            // filter switch above, one grouping level down.
            .onChange(of: groupingRaw) { _, _ in
                openCreateBand = nil
                // Same reasoning for the chip: `focus` and `proj:marina` are
                // different id spaces, so a selection made in one is meaningless in
                // the other. `BoardModel.filtered` would fall back to the whole
                // board anyway, but clearing it keeps the lit chip honest.
                selectedBandId = nil
            }
            // The PINNED copy of row 2, and the only floating row on the board.
            //
            // An OVERLAY for the same reason the compact bar is one: anything in the
            // layout flow that appears or resizes while scrolling changes the List's
            // visible rect and moves rows. Unlike the old permanent overlay this one
            // stands in for a real content row and only once that row has reached the
            // top edge — which is what puts the chips SECOND at rest instead of over
            // the nav pills.
            //
            // No transition: the inline row and this copy are the same bar in the same
            // place at the crossing, so there is nothing to animate, and an outgoing
            // transition would briefly put two copies of every `board.chip.*` id on
            // screen at once.
            //
            // "The same place" took two rounds to actually be true, on three axes:
            //  - X (R26): this overlay is handed the List's FULL width, so the bar insets
            //    its own card (`placement: .pinnedOverlay`) instead of laying out
            //    edge-to-edge, which is what used to shift every chip 16pt left.
            //  - Y (R27): the flip happens at `chipsPinThreshold`, which is DERIVED from
            //    where the inline row sits in the content (`rowTwoContentTop`) minus this
            //    overlay's own top inset — so at the crossing frame the two cards have the
            //    same top. It used to fire `listHeaderPadding` early and hop 10.66pt up.
            //  - STYLE (R27): the bar carries its own rounded corners and its own opaque
            //    surface, so neither the radius nor the chips' contrast depends on which
            //    copy is drawing or on what is behind it.
            //
            // `pinnedChipsTopInset` is applied here rather than assumed to be zero: the
            // threshold subtracts the same constant, so a future inset moves the hand-off
            // with the bar instead of silently re-opening the hop.
            //
            // The condition is FILTER-ONLY (`hasPinnedChips`), and that is the other
            // half of the empty-pinned-bar fix. It used to be
            // `showsPinnedChips(filter:pinned:)`, i.e. it also read the pin state, so
            // this overlay was inserted and removed on every crossing and each insertion
            // built a fresh rail `ScrollView`. Now the copy exists for as long as the
            // board does and `BoardBandBar.drawsChips` decides whether it SHOWS —
            // `showsPinnedChips` is still the composed rule, it just isn't a structural
            // branch any more. It also means this body no longer depends on the pin
            // state at all, which is what keeps a crossing off the derive path.
            .overlay(alignment: .top) {
                if TasksChromeMetrics.hasPinnedChips(activeFilter) {
                    bandBar(
                        proxy: proxy, bands: bands, chips: chips,
                        placement: .pinnedOverlay
                    )
                    .padding(.top, TasksChromeMetrics.pinnedChipsTopInset)
                }
            }
            // Compact header as an OVERLAY, never a safeAreaInset: an inset that
            // appears mid-scroll changes the List's visible rect and yanks the
            // content offset (the scroll-jump class of bug). An overlay costs no
            // layout and can never move a row.
            .overlay(alignment: .top) {
                // Not on the board: its second header row already pins itself, and a
                // compact bar there would be a second floating row offering a third
                // copy of the same three destinations.
                // `TasksChromeMetrics.showsCompactBar` owns that rule so it is
                // testable without a running app.
                if TasksChromeMetrics.showsCompactBar(
                    filter: activeFilter, collapsed: chromeCollapsed
                ) {
                    TasksCompactBar(
                        activeFilter: $activeFilter,
                        scrollToTop: {
                            withAnimation(.snappy(duration: 0.3)) {
                                proxy.scrollTo(Self.topAnchorId, anchor: .top)
                            }
                        },
                        addTask: { showNewTask = true }
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            // Batch action bar rides the bottom while selecting.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if isEditing { batchActionBar }
            }
            // Failed quick-toggle: the optimistic row already rolled back —
            // tell the user why (sync-source conflict, offline, …).
            .alert("Couldn't update task", isPresented: Binding(
                get: { toggleError != nil },
                set: { if !$0 { toggleError = nil } }
            )) {
                Button("OK", role: .cancel) { toggleError = nil }
            } message: {
                Text(toggleError ?? "")
            }
            // Batch results: partial failures surface with counts + reason.
            .alert("Batch action incomplete", isPresented: Binding(
                get: { batchError != nil },
                set: { if !$0 { batchError = nil } }
            )) {
                Button("OK", role: .cancel) { batchError = nil }
            } message: {
                Text(batchError ?? "")
            }
            .confirmationDialog(
                "Delete \(selectedIds.count) task(s)?",
                isPresented: $confirmBatchDelete, titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    runBatch { await tasks.batchDelete(Array(selectedIds)) }
                }
            }
            // The folder tree rides the same refresh as the lists it groups —
            // ONE bundle per refresh, never per body pass. `pull` is the one origin
            // exempt from the funnel's rate floor: the spinner is the user's own
            // request and it has to end in a real fetch.
            .refreshable { await tasks.refreshBoard(origin: .pullToRefresh) }
            // Store-level toast surface (fire-and-forget mutations): a small
            // auto-dismissing line at the bottom — never a modal.
            .overlay(alignment: .bottom) {
                if let notice = tasks.transientNotice ?? tasks.transientError {
                    TransientToast(
                        text: notice,
                        isError: tasks.transientError != nil
                    ) {
                        tasks.transientNotice = nil
                        tasks.transientError = nil
                    }
                    .padding(.bottom, 12)
                }
            }
            .animation(.snappy(duration: 0.25), value: activeFilter)
            // Locate a just-created task: switch to a filter that shows it,
            // scroll to it, and flash its row — "created but can't find it"
            // was a real complaint. Skipped while the inline add row is
            // focused (rapid consecutive adds must not yank the scroll away
            // from the keyboard — the row appears in place instead).
            .onChange(of: tasks.lastCreatedTaskId) { _, newId in
                guard let newId else { return }
                // Same rule as the bottom inline row: while a group's add row is
                // open the user is chain-adding into THAT group — switching the
                // filter and scrolling elsewhere would rip the keyboard away
                // (and the row is right where they are looking already).
                //
                // `openCreateBand` is the board's version of that, and leaving it
                // out was a real regression caught in the real UI: typing into the
                // ring at the foot of Backlog created the task AND threw the user
                // off the board onto All Open, so the one thing the affordance
                // promises — the new row stays where you made it — was broken by
                // the locate-me handler that exists to help find it.
                guard Self.shouldRelocateToNewTask(
                    inlineAddActive: inlineAddActive,
                    openAddGroup: openAddGroup,
                    openCreateBand: openCreateBand
                ) else {
                    flashHighlight(newId)
                    return
                }
                // NO filter switch any more, and its absence is the point.
                //
                // This used to do `activeFilter = .allOpen` whenever the new row wasn't
                // in the current slice — which was fine while "All Tasks" was a header
                // pill. That pill is gone ("已经有 pin 了,为什么还会有 all task"), so
                // the same line would now land the user on a filter with NO chip
                // selected, over a list they cannot switch away from except through the
                // `onAppear` fallback: a soft dead end reached by creating a task.
                //
                // Locating happens IN PLACE instead. The board's rows carry the same
                // `task-<id>` anchor the flat list's rows did
                // (`TaskBoardList.rowAnchorId` exists for exactly this), so a task
                // created into a band — which is every task created from a band's own
                // ring — flashes and scrolls where it landed. A task created UNPINNED
                // from the toolbar `+` has no board row, so the scroll is a silent
                // no-op and the flash is all the help there is. That is the honest
                // answer on a pinned-only board: the alternative is teleporting the
                // user to a list this round deliberately removed.
                flashHighlight(newId)
                // Next runloop: the row has to exist before scrollTo can target it —
                // the band it lands in is rebuilt by the store update that produced
                // this id, and `scrollTo` for an id no view claims is a silent no-op.
                DispatchQueue.main.async {
                    withAnimation(.snappy(duration: 0.35)) {
                        proxy.scrollTo(TaskBoardList.rowAnchorId(newId), anchor: .center)
                    }
                }
            }
        }
    }

    // MARK: - Group headers with a `+` (add straight into this group)

    /// A section header that can add INTO its own group.
    ///
    /// Interaction: the `+` opens an inline add row as the first row of that
    /// section — deliberately the SAME affordance the list already ends with
    /// (`QuickAddRow` at the top, `InlineAddTaskRow` at the bottom), not a third
    /// pattern. A sheet was the alternative and is worse here: the whole point
    /// of a header `+` is that the destination is already decided by WHERE you
    /// tapped, so a modal asking for it again is ceremony, it costs a dismiss
    /// animation per task, and it breaks the rapid chain-add that keeps focus
    /// after each Return. The sheet is still one tap away from the row (its
    /// expand button) for the tasks that need dates and priorities.
    ///
    /// The `+` is a `.plain`-styled Button with its own hit shape so it can't
    /// bubble into the header/section, and the header is
    /// `.accessibilityElement(children: .contain)` — a container identifier
    /// otherwise overwrites every descendant's and the `+` becomes unaddressable.
    /// - Parameter groupName: the group's NAME for the `+`'s accessibility label,
    ///   when `title` carries decoration a screen reader shouldn't read out
    ///   ("Focus · 3" → "Add task to Focus").
    @ViewBuilder
    private func groupHeader(_ title: String, seed: NewTaskSeed, groupName: String? = nil) -> some View {
        HStack(spacing: 6) {
            Text(title)
            Spacer(minLength: 8)
            // Edit mode owns the rows (selection); adding mid-selection would
            // change what is selected under the user.
            if !isEditing {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    // Toggle: a second tap on the same header puts it away.
                    openAddGroup = (openAddGroup == seed) ? nil : seed
                } label: {
                    Image(systemName: "plus")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Theme.tint)
                        // A bigger tap target than the glyph, still inside the
                        // header's own height so no row moves.
                        .frame(width: 30, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add task to \(groupName ?? title)")
                .accessibilityIdentifier("tasks.groupAdd.\(seed.id)")
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// The inline add row a header `+` opens, rendered inside that section.
    /// Nothing when this group's `+` isn't the open one, so an unopened header
    /// costs no row at all.
    @ViewBuilder
    private func groupAddRow(_ seed: NewTaskSeed) -> some View {
        if openAddGroup == seed {
            QuickAddRow(
                seed: seed,
                // The header already states the destination; a chip repeating it
                // is noise. Re-targeting belongs to the sheet from here.
                showsDestination: false,
                identifier: "tasks.groupAdd.\(seed.id).row",
                onExpand: { text, target in
                    newTaskSeedText = text
                    newTaskSeed = target
                    openAddGroup = nil
                    showNewTask = true
                },
                autoFocus: true,
                onDismiss: { openAddGroup = nil }
            )
        }
    }

    /// One project group: header with its own `+`, the (optional) inline add
    /// row that `+` opens, then the rows. Both call sites render through here so
    /// the search results and the normal list get the same affordance.
    @ViewBuilder
    private func projectSection(_ section: (project: String, tasks: [WalnutTask])) -> some View {
        let seed = NewTaskSeed.project(section.project)
        Section {
            groupAddRow(seed)
            ForEach(section.tasks) { task in
                taskRowButton(task)
            }
        } header: {
            groupHeader(section.project, seed: seed)
        }
    }

    /// One row of the task list: edit mode = selection toggle; normal = detail
    /// sheet + swipe/context quick actions.
    @ViewBuilder
    private func taskRowButton(_ task: WalnutTask) -> some View {
        Button {
            if isEditing {
                if selectedIds.contains(task.id) { selectedIds.remove(task.id) }
                else { selectedIds.insert(task.id) }
            } else {
                selected = task
            }
        } label: {
            HStack(spacing: 10) {
                if isEditing {
                    Image(systemName: selectedIds.contains(task.id) ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selectedIds.contains(task.id) ? Theme.tint : Color(.systemGray3))
                }
                TaskRow(task: task, tierBadge: tasks.tierBadge(for: task))
            }
        }
        .buttonStyle(.plain)
        .id("task-\(task.id)")
        // Locate-me flash for a just-created task; selection tint in edit mode.
        .listRowBackground(
            isEditing && selectedIds.contains(task.id)
                ? Theme.tintSoft
                : (task.id == highlightedTaskId ? Theme.tintSoft : nil)
        )
        .accessibilityIdentifier("tasks.row.\(task.id)")
        // Quick status toggle without opening the sheet: leading swipe =
        // todo↔done (Reminders muscle memory); long-press menu mirrors it.
        .swipeActions(edge: .leading, allowsFullSwipe: !isEditing) {
            if !isEditing {
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
        }
        // Trailing swipe: pin/unpin (focus endpoints, optimistic + rollback).
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !isEditing {
                Button {
                    togglePin(task)
                } label: {
                    Label(task.pinned == true ? "Unpin" : "Pin",
                          systemImage: task.pinned == true ? "pin.slash" : "pin")
                }
                .tint(Theme.tint)
            }
        }
        .contextMenu {
            if !isEditing {
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
                // Tier mover (pinned rows only): mirrors the desktop focus
                // bar's tier set — built-ins + custom tiers, optimistic.
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

    /// Pin/unpin from a row (swipe / context menu). Optimistic via the store.
    private func togglePin(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.setPinned(task, pinned: !(task.pinned == true)) {
                toggleError = error
            }
        }
    }

    /// One-tap todo↔done from a row (swipe / context menu). Optimistic via the
    /// store; a failure surfaces as a transient alert-style banner row is
    /// overkill here — reuse the store's error line on next refresh instead.
    @State private var toggleError: String?
    private func toggleDone(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.toggleDone(task) {
                toggleError = error
            }
        }
    }

    /// Bottom bar in edit mode: Complete / Delete over the selection.
    private var batchActionBar: some View {
        HStack(spacing: 12) {
            Text("\(selectedIds.count) selected")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                runBatch { await tasks.batchSetDone(Array(selectedIds), done: true) }
            } label: {
                Label("Complete", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
            }
            .accessibilityIdentifier("tasks.batchComplete")
            Button(role: .destructive) {
                confirmBatchDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
                    .font(.subheadline.weight(.semibold))
            }
            .accessibilityIdentifier("tasks.batchDelete")
        }
        .disabled(selectedIds.isEmpty || batchBusy)
        .overlay(alignment: .center) {
            if batchBusy { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// Shared batch runner: busy-gate, run, exit edit mode, surface failures.
    private func runBatch(_ operation: @escaping () async -> String?) {
        guard !batchBusy, !selectedIds.isEmpty else { return }
        batchBusy = true
        Task {
            defer { batchBusy = false }
            let failure = await operation()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            withAnimation {
                editMode = .inactive
                selectedIds.removeAll()
            }
            if let failure { batchError = failure }
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

    private var emptyText: String {
        Self.emptyPlaceholder(filter: activeFilter, query: trimmedQuery)
    }

    /// Should a just-created task pull the user to a filter that shows it?
    ///
    /// NO whenever an add row is open, because then the user is chain-adding into
    /// a place they are already looking at, and relocating them would rip the
    /// keyboard away from a row that is right there. Pure + static so the rule is
    /// testable: a real regression (creating from a board band threw the user onto
    /// All Open) came from this condition missing one of its three inputs.
    ///
    /// - Parameter openCreateBand: the board band whose create ring is open, by
    ///   BAND id (a tier id, or `proj:<name>` under project grouping). Only its
    ///   presence matters here, never its value.
    static func shouldRelocateToNewTask(
        inlineAddActive: Bool, openAddGroup: NewTaskSeed?, openCreateBand: String?
    ) -> Bool {
        !inlineAddActive && openAddGroup == nil && openCreateBand == nil
    }

    /// Empty-state copy for a filter, search-aware. With a query active the
    /// filter wording ("No agent sessions.", "No open tasks.") reads as "your
    /// search found nothing" while the real hits sit BELOW in Server Search —
    /// a user could bail before scrolling (2026-08-23 dogfood R11). Say what
    /// actually happened and point at where the results are.
    static func emptyPlaceholder(filter: TaskFilter, query: String) -> String {
        if !query.isEmpty {
            return "No local matches — see Server Search below."
        }
        switch filter {
        case .today: return "Nothing due today."
        case .inProgress: return "No tasks in progress."
        case .sessions: return "Nothing pinned yet — pin a task to put it on the board."
        case .calendar: return "" // calendar renders its own grid, never this
        case .allOpen: return "No open tasks."
        case .done: return "No recent completions."
        }
    }

    // MARK: - Pinned tasks (top of every task filter)

    /// Open pinned tasks, capped at 8 — the phone mirror of the desktop
    /// focus bar. Uses the projection's pinned flag (live via the feed).
    /// The section's quick-add row creates a task PRE-PINNED (satellite
    /// tier default) — add straight into the working set from anywhere.
    @ViewBuilder
    private var pinnedTasksSection: some View {
        let pinned = tasks.tasks(for: activeFilter == .done ? .done : .allOpen)
            .filter { $0.pinned == true && !$0.isDone }
        if activeFilter != .done {
            // The Pinned section is the board as a whole, not one tier, so its
            // add row keeps a destination chip: "pinned" alone doesn't say WHERE,
            // and Satellite is only the default, not the only answer.
            Section("Pinned") {
                ForEach(Array(pinned.prefix(8))) { task in
                    taskRowButton(task)
                }
                QuickAddRow(
                    seed: NewTaskSeed(project: "", pin: .tier("satellite")),
                    identifier: "focus.quickAdd",
                    onExpand: { text, target in
                        newTaskSeedText = text
                        newTaskSeed = target
                        showNewTask = true
                    }
                )
            }
        }
    }

    // MARK: - Active sessions (pinned on top of every non-Sessions filter)

    /// Up to 5 alive sessions surfaced above the task list. Prefers pinned-and-
    /// alive; falls back to the most-recently-active alive sessions when nothing
    /// pinned is currently running. Hidden entirely when nothing is alive.
    @ViewBuilder
    private var activeSessionsSection: some View {
        let pinnedAlive = tasks.pinnedSessions.filter { $0.statusKind.isAlive }
        let source = pinnedAlive.isEmpty ? tasks.activeSessions : pinnedAlive
        let rows = Array(source.filter(sessionMatchesSearch).prefix(5))
        if !rows.isEmpty {
            Section("Active Sessions") {
                ForEach(rows) { session in sessionRow(session) }
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
    // The bands are grouped by pin tier by default and by PROJECT when the band
    // bar's filter menu says so: the desktop's own grouping pair. Both come out of
    // one `BoardModel.bands` call, which is what keeps this a single derived walk —
    // and the band bar's chips and the rows on screen are two views OF that one
    // call, never a second one.

    /// The bands. Bound ONCE per body pass at the call site — every reference here
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
    private var boardBands: [BoardBand] {
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
        // taskId → the task's own `session_ids`, for the tasks whose detail the phone
        // has read. Observed read, like every line above it: a detail landing while the
        // board is on screen has to re-derive the rows (its generation is part of
        // `boardInputsGen`), or a row keeps saying "no session yet" about a task we now
        // know has one.
        let knownSessionIds = tasks.sessionIdsByTask
        let filter = dateFilter.wrappedValue
        let key = BoardBandsKey(
            inputsGen: tasks.boardInputsGen,
            query: trimmedQuery,
            grouping: grouping.wrappedValue,
            dateFilter: filter,
            shownDoneBands: shownDoneBands,
            // `.all` admits every row regardless of the clock, so its bands are
            // time-independent and the bucket is a constant. Under `.now` a start date
            // that passes has to show up, and a minute is the granularity that costs one
            // rebuild a minute at rest instead of one per body pass.
            nowBucket: filter == .now ? Int(Date().timeIntervalSince1970 / 60) : 0
        )
        return bandsCache.bands(for: key) {
            BoardModel.bands(
                tasks: rows,
                sessions: sessions,
                tierOf: tierOf,
                tierOrder: tierOrder,
                customTiers: customTiers,
                query: trimmedQuery,
                grouping: grouping.wrappedValue,
                dateFilter: filter,
                // The model spells this parameter `shownDoneTiers`; what it matches
                // against is `bandId`, which is a tier id only under tier grouping.
                // Empty = every band folds its done rows, which is the default.
                shownDoneTiers: shownDoneBands,
                // Used by project grouping only. Empty (a server without the endpoint,
                // a failed fetch, an offline cold start) = the flat project bands.
                folders: folders,
                // A MISSING key is "never asked", not "no sessions" — see
                // `BoardRow.knownSessionIds`. Empty (a cold board) behaves exactly as
                // the board did before this existed.
                knownSessionIds: knownSessionIds
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
        proxy: ScrollViewProxy, bands: [BoardBand], chips: [BoardModel.BandChip],
        placement: BoardBandBarPlacement
    ) -> some View {
        BoardBandBar(
            chips: chips,
            selected: BoardModel.selectedChip(bands, selected: selectedBandId),
            grouping: grouping,
            dateFilter: dateFilter,
            onSelect: { bandId in
                selectedBandId = bandId
                // Land at the top of what you just asked for. Without this,
                // narrowing from a position deep inside Focus leaves you at an
                // arbitrary offset in Backlog — the rows changed under a scroll
                // position that meant something about the old set.
                //
                // Next runloop: the newly filtered bands have to exist before
                // `scrollTo` can target one (same hop the locate-me handler needs,
                // for the same reason).
                let target = BoardModel.filtered(bands, selected: bandId).first
                guard let target else { return }
                DispatchQueue.main.async {
                    withAnimation(.snappy(duration: 0.25)) {
                        proxy.scrollTo(TaskBoardList.anchorId(target.bandId), anchor: .top)
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
    private func boardSections(_ bands: [BoardBand]) -> some View {
        if bands.isEmpty {
            Section {
                Text(Self.boardEmptyText(
                    query: trimmedQuery, dateFilter: dateFilter.wrappedValue
                ))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else {
            TaskBoardList(
                bands: bands,
                tierChoices: tasks.allTierChoices,
                openCreateBand: openCreateBand,
                newRowId: highlightedTaskId,
                tierOf: tasks.taskTiers,
                // The row whose tap is asking the server where to go (spinner in place
                // of its state dot).
                resolvingRowId: resolvingRowId,
                onToggleHideDone: { bandId in
                    withAnimation(.snappy(duration: 0.2)) {
                        if shownDoneBands.contains(bandId) { shownDoneBands.remove(bandId) }
                        else { shownDoneBands.insert(bandId) }
                    }
                },
                onToggleCreate: { bandId in
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    openCreateBand = (openCreateBand == bandId) ? nil : bandId
                },
                onToggleDone: { row in
                    if let task = row.task { toggleDone(task) }
                },
                onPickTier: { row, token in pickTier(row, token) },
                onOpenSession: { row in openSession(row) },
                onOpenDetail: { row in
                    if let task = row.task { selected = task }
                },
                // The band hands over its OWN seed, so a project heading's ring
                // files into that project and a tier heading's into that tier.
                // This used to hardcode `NewTaskSeed.tier(bandId)`, which under
                // project grouping would have sent `focus_tier: "proj:marina"`,
                // an unknown tier the create endpoint 400s on (by design: it never
                // silently downgrades a bad tier, see TaskPinChoice).
                createRow: { bandId, seed in
                    AnyView(
                        QuickAddRow(
                            seed: seed,
                            // The band heading already states the destination;
                            // a chip repeating it is noise.
                            showsDestination: false,
                            identifier: "board.createRow.\(TaskBoardList.slug(bandId))",
                            onExpand: { text, target in
                                newTaskSeedText = text
                                newTaskSeed = target
                                openCreateBand = nil
                                showNewTask = true
                            },
                            autoFocus: true,
                            onDismiss: { openCreateBand = nil }
                        )
                    )
                }
            )
        }
    }

    /// What an empty board says, and why the date filter gets a sentence of its
    /// own: `Now` HIDES rows, so "Nothing pinned yet" over a board full of
    /// deferred work is a lie that sends the user looking for a bug. Name the
    /// filter that did it AND where the control now lives — it used to be a row
    /// directly above this text and it is now inside the band bar's filter menu,
    /// so "tap All" alone would send the user hunting.
    static func boardEmptyText(query: String, dateFilter: BoardDateFilter) -> String {
        if !query.isEmpty { return "No matches on the board." }
        if dateFilter == .now {
            return "Nothing to do right now: every task starts later. Pick All in the filter menu to see them."
        }
        return "Nothing pinned yet — pin a task to put it on the board."
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

    /// The one thing on a board row that genuinely lives elsewhere: the session's
    /// conversation page.
    ///
    /// The DECISION is `BoardModel.tapRoute` (pure, tested); this performs it. It used
    /// to be `if let session = row.session { push } else { showNewSession }`, which
    /// read "the session list has no row for this task" as "this task has never had a
    /// session" — two different facts, and the difference shipped as a bug when the
    /// server's session projection silently dropped older sessions: a tap on a pinned
    /// task that HAS a session opened a New Session draft.
    private func openSession(_ row: BoardRow) {
        switch BoardModel.tapRoute(row) {
        case .open(let session):
            navPath.append(session)
        case .resolve(let sessionId, let fallback):
            resolveThenOpen(sessionId: sessionId, row: row, fallback: fallback)
        case .probe(let taskId, let fallback):
            probeThenOpen(taskId: taskId, row: row, fallback: fallback)
        case .draft(let seed):
            newSessionSeed = seed
        }
    }

    /// Open a session the session LIST does not carry, by id.
    ///
    /// The failure branch is the point: a 404 (the record really is gone), an offline
    /// phone or the lookup deadline all land in the draft ATTACHED to the task, never
    /// in a dead end and never in an unlinked draft. The toast says why, because a tap
    /// that quietly produces a different destination than the row promised is worse
    /// than the wait.
    private func resolveThenOpen(
        sessionId: String, row: BoardRow, fallback: BoardModel.BoardDraftSeed
    ) {
        guard resolvingRowId == nil else { return }
        resolvingRowId = row.id
        Task {
            let resolved = await tasks.resolveSession(id: sessionId, task: row.task)
            resolvingRowId = nil
            guard let resolved else {
                tasks.transientError = "Couldn't open that session. Starting a new one for this task."
                newSessionSeed = fallback
                return
            }
            navPath.append(resolved)
        }
    }

    /// Nothing knows yet whether this task has sessions, so ask before routing.
    ///
    /// The slim list projection carries no `session_ids`, so a cold board cannot tell a
    /// task that never had a session from one whose session aged out of the session
    /// list. ONE `GET /v1/tasks/:id` settles it, the answer is cached
    /// (`TasksStore.sessionIdsByTask`) so the next tap on that row spends nothing, and
    /// the row spins while it runs.
    ///
    /// The cost is deliberate and bounded: a tap on a genuinely sessionless task waits
    /// one round trip (deadline `TasksStore.boardLookupDeadline`) before its draft
    /// opens. That is the price of never opening a draft on top of a real session, and
    /// it is paid once per task per app run.
    private func probeThenOpen(
        taskId: String, row: BoardRow, fallback: BoardModel.BoardDraftSeed
    ) {
        guard resolvingRowId == nil else { return }
        resolvingRowId = row.id
        Task {
            let ids = await tasks.fetchSessionIds(for: taskId)
            resolvingRowId = nil
            // A failed probe must not invent an answer: fall through to the draft
            // (attached), exactly as this row behaved before the probe existed.
            guard let sessionId = BoardModel.newestSessionId(ids) else {
                newSessionSeed = fallback
                return
            }
            resolveThenOpen(sessionId: sessionId, row: row, fallback: fallback)
        }
    }

    private func sessionRow(_ session: WalnutSession) -> some View {
        NavigationLink(value: session) {
            SessionRowView(session: session)
        }
        .accessibilityIdentifier("sessions.row.\(session.id)")
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

// MARK: - Inline add row (Apple Reminders behavior)

/// Persistent "+ New Task" row at the bottom of the task list. Tap → becomes
/// an inline TextField; Return creates immediately (Inbox, no project) and
/// KEEPS the field active for rapid consecutive adds — exactly Reminders'
/// behavior. Tap-away/dismiss with an empty field collapses back to the
/// button. Creation goes through the same TasksStore.createTask path as the
/// sheet, so the optimistic insert + pending overlay + locate-me flash all
/// apply.
struct InlineAddTaskRow: View {
    /// Bubbles focus state up so the list can suppress its scroll-to-created
    /// behavior while the user is chain-adding.
    @Binding var isActive: Bool

    @Environment(TasksStore.self) private var tasks

    @State private var title = ""
    @State private var editing = false
    @State private var submitting = false
    @State private var errorMessage: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        Group {
            if editing {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 10) {
                        Image(systemName: "circle")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                        TextField("New task", text: $title)
                            .focused($fieldFocused)
                            .submitLabel(.done)
                            .onSubmit { submit() }
                            .disabled(submitting)
                            .accessibilityIdentifier("tasks.inlineAdd.field")
                        if submitting {
                            ProgressView().controlSize(.small)
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(Theme.danger)
                    }
                }
                .onChange(of: fieldFocused) { _, focused in
                    isActive = focused
                    // Tap-away with nothing typed = cancel (Reminders behavior).
                    // Mid-submit blur (keyboard dropped by the async create)
                    // must not collapse the row before the task lands.
                    if !focused && !submitting && title.trimmingCharacters(in: .whitespaces).isEmpty {
                        collapse()
                    }
                }
            } else {
                Button {
                    editing = true
                    errorMessage = nil
                    // Next runloop: the TextField must exist before focusing.
                    DispatchQueue.main.async { fieldFocused = true }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle.fill")
                            .font(.body)
                            .foregroundStyle(Theme.tint)
                        Text("New Task")
                            .foregroundStyle(Theme.tint)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tasks.inlineAdd")
            }
        }
    }

    private func collapse() {
        editing = false
        title = ""
        errorMessage = nil
        isActive = false
    }

    private func submit() {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        // Return on an empty field = done adding (Reminders behavior).
        guard !trimmed.isEmpty else { collapse(); return }
        guard !submitting else { return }
        submitting = true
        errorMessage = nil
        Task {
            defer { submitting = false }
            do {
                _ = try await tasks.createTask(title: trimmed)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                // Stay active for the next one — clear the text, keep focus.
                title = ""
                fieldFocused = true
            } catch let APIError.server(_, _, msg, _, _) {
                errorMessage = msg
                fieldFocused = true
            } catch {
                errorMessage = error.localizedDescription
                fieldFocused = true
            }
        }
    }
}

// MARK: - The iOS 26 top scroll edge

private extension View {
    /// `scrollEdgeEffectStyle(.hard, for: .top)` where the OS has it.
    ///
    /// A helper and not an inline `if #available`, because the modifier changes the
    /// view's TYPE: branching inline would need `AnyView` or a `@ViewBuilder` wrapper at
    /// the call site, and this is the wrapper.
    ///
    /// What it buys on top of the opaque toolbar: the toolbar fix makes the BAR opaque,
    /// so content can no longer be read through it; this makes the scroll edge itself
    /// hard, which is the platform's own statement that nothing may read through the top
    /// edge — the reason `ChatView`'s bar and this one now behave the same way while the
    /// board keeps its own paper colour underneath.
    @ViewBuilder
    func hardTopScrollEdge() -> some View {
        if #available(iOS 26.0, *) {
            self.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }
}

// The SIX SMART-LIST CARDS are GONE (2026-08-29, T84).
//
// They were a horizontally scrolling 2x3 grid of 130pt summary cards, one per
// `TaskFilter`, each with a big count: 104pt of chrome offering six destinations
// on the screen whose job is showing rows. The header is now `TasksNavRow` — two
// compact chips, Pin | Calendar — and the counts that survived are the per-band
// ones on `BoardBandBar`, which are about the rows you are actually looking at.
//
// Two things the cards taught, kept because the replacements inherit them: a
// fixed-width box cannot hold a four-digit count (`Text` wrapped "2,824" BETWEEN
// digits, dogfood R19), which is why every count in the chips is
// `lineLimit(1)` + `monospacedDigit()` on an INTRINSICALLY sized capsule; and the
// `tasks.card.<filter>` ids they carried are why `TaskFilter`'s cases and
// `identifierKey` all stayed put (`TasksNavEntry` maps onto them rather than
// replacing them).


// MARK: - Transient toast (fire-and-forget mutation feedback)

/// Small bottom toast for optimistic mutations: info ("Pinned · Focus") or a
/// subtle failure line after a revert. Auto-dismisses; tap to dismiss early.
/// Deliberately NOT a modal/alert — instant-first mutations never block.
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
