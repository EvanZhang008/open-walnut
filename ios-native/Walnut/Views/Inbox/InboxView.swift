import SwiftUI

/// Human Inbox tab — the letters agents wrote for the human, newest first with
/// pinned ones on top, and an Archived shelf behind the toolbar button.
///
/// Reading a letter marks THAT letter read; opening this tab marks nothing.
/// That exception is the whole point of a letter (a document you read one at a
/// time) versus a notification (an event a panel-open can clear).
struct InboxView: View {
    @Environment(InboxStore.self) private var inbox

    /// Push-navigation path of letter ids. A deep link from a push replaces it.
    @State private var path: [String] = []
    @State private var showArchived = false
    @State private var deepLink = LetterDeepLink.shared

    private var rows: [Letter] { showArchived ? inbox.archivedLetters : inbox.letters }

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
        .onAppear { openDeepLinkedLetter() }
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
            } else if inbox.loading {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let message = inbox.errorMessage {
                ContentUnavailableView {
                    Label("Can't load your inbox", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await inbox.refresh() } }
                }
            } else {
                ContentUnavailableView(
                    "No letters yet",
                    systemImage: "envelope",
                    description: Text("When an agent finishes something worth reading, or needs a decision, its letter shows up here.")
                )
            }
        } else {
            list
        }
    }

    private var list: some View {
        List {
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
                        Task { await inbox.setRead(id: letter.id, read: !letter.isRead) }
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
        .listStyle(.plain)
        .accessibilityIdentifier("inbox.list")
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
