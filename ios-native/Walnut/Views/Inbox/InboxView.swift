import SwiftUI

/// Human Inbox tab — the letters agents wrote for the human, newest first with
/// pinned ones on top, a filter row (All, Unread, Action needed, and the letter
/// types), and an Archived shelf behind the toolbar button.
///
/// Reading a letter marks THAT letter read; opening this tab marks nothing.
/// That exception is the whole point of a letter (a document you read one at a
/// time) versus a notification (an event a panel-open can clear). Which letters
/// count as unread, and which still want a decision, are the console's rules
/// (see `InboxFilter.swift`).
///
/// Marking without opening works the way Mail does: swipe a row right for Read
/// or Unread, or Select (the button, or a two-finger drag down the rows) and
/// mark the picked letters, or all of them, from the bar at the bottom. Each is
/// the human's own choice per letter, so none of it breaks the rule above.
struct InboxView: View {
    @Environment(InboxStore.self) private var inbox

    /// Push-navigation path of letter ids. A deep link from a push replaces it.
    @State private var path: [String] = []
    @State private var showArchived = false
    @State private var deepLink = LetterDeepLink.shared
    /// The clock the Action needed grace window is judged against. Re-taken on
    /// appear and on a filter change, and advanced by ONE timer armed for the
    /// next expiry (the console's `graceNow`), so a read decision leaves the list
    /// on time without anything polling.
    @State private var graceNowMs = InboxListing.nowMs()
    /// Select mode, Mail's: the Select button or a two-finger drag down the rows
    /// (the List turns it on through this binding) shows the checkmarks and the
    /// Mark bar. Live inbox only: on the Archived shelf a read flag counts nowhere.
    @State private var editMode: EditMode = .inactive
    @State private var selection: Set<String> = []

    private var isSelecting: Bool { editMode.isEditing }

    /// The live list under the current filter; the Archived shelf is shown whole.
    private var rows: [Letter] {
        showArchived ? inbox.archivedLetters : inbox.visibleRows(nowMs: graceNowMs)
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(navigationTitle)
                // GHOST PILE-UP, the same one the board had: with no toolbar background
                // the bar keeps its transparent scroll-edge appearance, and letter
                // titles, body lines and their chips read straight through the "Inbox"
                // title while scrolling. Same one-line fix `ChatView` and
                // `SessionConversationView` already carry.
                .toolbarBackground(.visible, for: .navigationBar)
                .navigationDestination(for: String.self) { id in
                    LetterReaderView(letterId: id)
                }
                .toolbar { toolbarItems }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if isSelecting {
                        InboxSelectionBar(
                            plan: InboxSelectionPlan(rows: rows, selection: selection),
                            onMark: markSelection
                        )
                    }
                }
                .refreshable {
                    if showArchived {
                        await inbox.refreshArchived()
                    } else {
                        await inbox.refresh()
                    }
                }
        }
        // A tapped push arms LetterDeepLink; MainTabView brings this tab
        // forward and this view opens the letter. Both edges are needed: a cold
        // launch has the mailbox armed before this view exists (`onAppear`), a
        // warm one arms it while the tab is already on screen (`onChange`).
        .onAppear {
            graceNowMs = InboxListing.nowMs()
            openDeepLinkedLetter()
        }
        // The one grace timer: sleeps until the next read decision's window ends,
        // then moves the clock. Re-armed whenever the letters or the clock change.
        .task(id: InboxListing.nextGraceExpiry(inbox.letters, nowMs: graceNowMs)) {
            guard let next = InboxListing.nextGraceExpiry(inbox.letters, nowMs: graceNowMs) else { return }
            let wait = max(0, next - InboxListing.nowMs()) + 50
            try? await Task.sleep(for: .milliseconds(Int(wait)))
            guard !Task.isCancelled else { return }
            graceNowMs = InboxListing.nowMs()
        }
        .onChange(of: deepLink.pending) { _, request in
            if request != nil { openDeepLinkedLetter() }
        }
        // A selection only ever holds rows that are on screen: a filter change or
        // a refresh that drops a row drops it from the selection too, so the bar
        // never acts on a letter the human can no longer see.
        .onChange(of: rows.map(\.id)) { _, ids in
            if !selection.isEmpty { selection.formIntersection(ids) }
        }
        .onChange(of: selection) { _, picked in openTapped(picked) }
        .onChange(of: editMode) { _, mode in
            if !mode.isEditing, !selection.isEmpty { selection = [] }
        }
        // Leaving the tab ends the selection, as the Unread keep set does.
        .onDisappear { endSelecting() }
        // Ask for notification permission HERE, not at first launch. iOS asks
        // once per install and a denial is recoverable only through Settings, so
        // the prompt has to land where the user can see what it is for — the
        // Inbox, with the letters a notification would announce on screen. Gated
        // on activation because a prewarm launch must not prompt.
        .task {
            LaunchGate.shared.whenActive {
                await PushRegistration.shared.requestPermissionAndRegister()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if rows.isEmpty {
            if showArchived {
                ContentUnavailableView(
                    "Nothing archived",
                    systemImage: "archivebox",
                    description: Text("Letters you archive land here.")
                )
            } else if inbox.loading && inbox.letters.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let message = inbox.errorMessage, inbox.letters.isEmpty {
                ContentUnavailableView {
                    Label("Can't load your inbox", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await inbox.refresh() } }
                }
            } else if inbox.letters.isEmpty {
                ContentUnavailableView(
                    "No letters yet",
                    systemImage: "envelope",
                    description: Text("When an agent finishes something worth reading, or needs a decision, its letter shows up here.")
                )
            } else {
                // Letters exist, none under this filter: the list stays, so the
                // filter row stays with it and says which filter is empty.
                list
            }
        } else {
            list
        }
    }

    /// The filter row. It is the list's pinned SECTION HEADER, not a
    /// `safeAreaInset` on the list: an inset above the scroll view hid the large
    /// "Inbox" title outright (measured on the pinned simulator), while a plain
    /// list's header scrolls up under the collapsed title and then sticks there.
    /// Not on the Archived shelf: its counts would describe the live inbox.
    private var filterBar: some View {
        InboxFilterBar(
            selection: inbox.filter,
            count: { inbox.count(for: $0) },
            onSelect: { filter in
                inbox.filter = filter
                graceNowMs = InboxListing.nowMs()
            }
        )
        .listRowInsets(EdgeInsets())
        .textCase(nil)
    }

    /// The inbox has letters, just none under this filter: say which filter, and
    /// offer the way back to everything.
    private var filteredEmptyState: some View {
        let copy = InboxEmptyCopy(filter: inbox.filter)
        return ContentUnavailableView {
            Label(copy.title, systemImage: copy.symbol)
                // On the title, not the whole view: an identifier on a container
                // is handed to every child, the button below included.
                .accessibilityIdentifier("inbox.empty.\(inbox.filter.rawValue)")
        } description: {
            Text(copy.detail)
        } actions: {
            Button("Show All Letters") {
                inbox.filter = .all
                graceNowMs = InboxListing.nowMs()
            }
            .accessibilityIdentifier("inbox.empty.showAll")
        }
    }

    /// `List(selection:)` is what gives the rows Mail's checkmarks AND the
    /// two-finger drag that starts selecting; outside Select mode a tap still
    /// opens the letter. The Archived shelf gets a plain list, so the drag cannot
    /// start a selection there either.
    @ViewBuilder
    private var list: some View {
        if showArchived {
            List {
                Section { listRows }
            }
            .listStyle(.plain)
            .accessibilityIdentifier("inbox.list")
        } else {
            List(selection: $selection) {
                Section {
                    listRows
                } header: {
                    filterBar
                }
            }
            .listStyle(.plain)
            .environment(\.editMode, $editMode)
            .accessibilityIdentifier("inbox.list")
        }
    }

    @ViewBuilder
    private var listRows: some View {
        if !showArchived, !inbox.readRetryIds.isEmpty {
            InboxReadRetryNotice(count: inbox.readRetryIds.count)
                .listRowSeparator(.hidden)
                .selectionDisabled()
        }
        if rows.isEmpty, !showArchived {
            filteredEmptyState
                .frame(maxWidth: .infinity, minHeight: 360)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .selectionDisabled()
        }
        ForEach(rows) { letter in
            row(letter)
            // Mail's swipes: right marks read or unread, left archives (a full
            // swipe) with Pin beside it.
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if !isSelecting {
                    Button {
                        inbox.mark(id: letter.id, read: !letter.isRead)
                    } label: {
                        Label(
                            letter.isRead ? "Unread" : "Read",
                            systemImage: letter.isRead ? "envelope.badge" : "envelope.open"
                        )
                    }
                    .tint(Theme.tint)
                    .accessibilityIdentifier("inbox.swipe.read")
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if !isSelecting {
                    Button {
                        Task { await inbox.setArchived(id: letter.id, archived: !letter.isArchived) }
                    } label: {
                        Label(
                            letter.isArchived ? "Unarchive" : "Archive",
                            systemImage: letter.isArchived ? "tray.and.arrow.up" : "archivebox"
                        )
                    }
                    .tint(.secondary)
                    Button {
                        Task { await inbox.setPinned(id: letter.id, pinned: !letter.isPinned) }
                    } label: {
                        Label(letter.isPinned ? "Unpin" : "Pin", systemImage: letter.isPinned ? "pin.slash" : "pin")
                    }
                    .tint(Theme.warning)
                }
            }
        }
    }

    /// A row of the live list is a plain row, not a NavigationLink: inside
    /// `List(selection:)` a tap SELECTS the row and a link never fires (measured on
    /// the pinned simulator: the row turned grey and nothing opened). Outside
    /// Select mode that selection is turned into the open, in `openTapped`. The
    /// Archived shelf has no selection, so its rows stay links.
    @ViewBuilder
    private func row(_ letter: Letter) -> some View {
        if showArchived {
            NavigationLink(value: letter.id) {
                LetterEnvelopeRow(letter: letter)
            }
        } else {
            // One element, as the link made it: without it the row's identifier
            // lands on every child, and VoiceOver steps through the dot, the
            // subject and each chip one by one.
            LetterEnvelopeRow(letter: letter)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(isSelecting ? [] : .isButton)
                .accessibilityIdentifier("inbox.row.\(letter.id)")
        }
    }

    /// Outside Select mode a selection is a tap on a row: open that letter and
    /// leave nothing selected. A two-finger drag turns Select mode on as it
    /// selects, so its rows are never opened.
    private func openTapped(_ picked: Set<String>) {
        guard !isSelecting, let id = picked.first else { return }
        selection = []
        if path.last != id { path.append(id) }
    }

    private var navigationTitle: String {
        if showArchived { return "Archived" }
        guard isSelecting else { return "Inbox" }
        return selection.isEmpty ? "Select Letters" : "\(selection.count) Selected"
    }

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        if isSelecting {
            ToolbarItem(placement: .topBarLeading) {
                let allSelected = !rows.isEmpty && selection.count == rows.count
                Button(allSelected ? "Deselect All" : "Select All") {
                    selection = allSelected ? [] : Set(rows.map(\.id))
                }
                .accessibilityIdentifier("inbox.selectAll")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { endSelecting() }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("inbox.selectDone")
            }
        } else {
            if !showArchived, !rows.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Select") {
                        withAnimation { editMode = .active }
                    }
                    .accessibilityIdentifier("inbox.select")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showArchived.toggle()
                    if showArchived { Task { await inbox.refreshArchived() } }
                } label: {
                    Image(systemName: showArchived ? "tray" : "archivebox")
                }
                .accessibilityIdentifier("inbox.toggleArchived")
            }
        }
    }

    /// The bar's Mark Read / Mark Unread / Mark All Read. Mail leaves Select
    /// mode once the letters are marked, and so does this.
    private func markSelection(_ ids: [String], read: Bool) {
        let changed = inbox.mark(ids: ids, read: read)
        AppLog.info("inbox", "batch mark", [
            "read": String(read), "asked": String(ids.count), "changed": String(changed),
        ])
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        endSelecting()
    }

    private func endSelecting() {
        guard isSelecting || !selection.isEmpty else { return }
        withAnimation {
            editMode = .inactive
            selection = []
        }
    }

    /// Consume the mailbox and push that letter. Consuming CLEARS it, so a
    /// stale link can't re-open the same letter on every appear.
    private func openDeepLinkedLetter() {
        guard let request = deepLink.consume() else { return }
        endSelecting()
        showArchived = false
        if path.last != request.letterId {
            path = [request.letterId]
        }
    }
}
