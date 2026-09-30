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

    /// The live list under the current filter; the Archived shelf is shown whole.
    private var rows: [Letter] {
        showArchived ? inbox.archivedLetters : inbox.visibleRows(nowMs: graceNowMs)
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(showArchived ? "Archived" : "Inbox")
                // GHOST PILE-UP, the same one the board had: with no toolbar background
                // the bar keeps its transparent scroll-edge appearance, and letter
                // titles, body lines and their chips read straight through the "Inbox"
                // title while scrolling. Same one-line fix `ChatView` and
                // `SessionConversationView` already carry.
                .toolbarBackground(.visible, for: .navigationBar)
                .navigationDestination(for: String.self) { id in
                    LetterReaderView(letterId: id)
                }
                .toolbar {
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

    private var list: some View {
        List {
            Section {
                listRows
            } header: {
                if !showArchived { filterBar }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("inbox.list")
    }

    @ViewBuilder
    private var listRows: some View {
        if !showArchived, !inbox.readRetryIds.isEmpty {
            InboxReadRetryNotice(count: inbox.readRetryIds.count)
                .listRowSeparator(.hidden)
        }
        if rows.isEmpty, !showArchived {
            filteredEmptyState
                .frame(maxWidth: .infinity, minHeight: 360)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
        ForEach(rows) { letter in
            NavigationLink(value: letter.id) {
                LetterEnvelopeRow(letter: letter)
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    Task { await inbox.setPinned(id: letter.id, pinned: !letter.isPinned) }
                } label: {
                    Label(letter.isPinned ? "Unpin" : "Pin", systemImage: letter.isPinned ? "pin.slash" : "pin")
                }
                .tint(Theme.tint)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
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
                    inbox.mark(id: letter.id, read: !letter.isRead)
                } label: {
                    Label(
                        letter.isRead ? "Unread" : "Read",
                        systemImage: letter.isRead ? "envelope.badge" : "envelope.open"
                    )
                }
                .tint(Theme.warning)
            }
        }
    }

    /// Consume the mailbox and push that letter. Consuming CLEARS it, so a
    /// stale link can't re-open the same letter on every appear.
    private func openDeepLinkedLetter() {
        guard let request = deepLink.consume() else { return }
        showArchived = false
        if path.last != request.letterId {
            path = [request.letterId]
        }
    }
}
