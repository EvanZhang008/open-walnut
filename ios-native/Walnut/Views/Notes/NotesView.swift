import SwiftUI

/// Push-navigation routes for the Notes tab.
enum NotesRoute: Hashable {
    case folder(String)
    case note(String)
    /// Freshly created note — opens straight into edit mode, keyboard up.
    case noteEditing(String)
}

/// Notes tab — Apple Notes-style home: Pinned section, folder push navigation,
/// search, compose. One folder level renders at a time (2700-note vault safe).
struct NotesView: View {
    @Environment(NotesStore.self) private var notes

    @State private var path: [NotesRoute] = []
    @State private var searchText = ""
    @State private var searchPresented = false

    var body: some View {
        NavigationStack(path: $path) {
            FolderContentView(folderPath: "", navigationPath: $path)
                .navigationTitle("Notes")
                .navigationDestination(for: NotesRoute.self) { route in
                    switch route {
                    case .folder(let folderPath):
                        FolderContentView(folderPath: folderPath, navigationPath: $path)
                            .navigationTitle(folderPath.components(separatedBy: "/").last ?? folderPath)
                            .navigationBarTitleDisplayMode(.large)
                    case .note(let notePath):
                        NoteDetailView(path: notePath)
                    case .noteEditing(let notePath):
                        NoteDetailView(path: notePath, startEditing: true)
                    }
                }
                .searchable(
                    text: $searchText, isPresented: $searchPresented,
                    placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search"
                )
                .overlay {
                    if !searchText.isEmpty {
                        NoteSearchView(query: searchText) { resultPath in
                            path.append(.note(resultPath))
                        }
                    }
                }
                // Walnut's mic over the keyboard while the search is up, above the results.
                .voiceSearch(text: $searchText, isPresented: $searchPresented, surface: "notes-search", box: "notes-search")
        }
    }
}

/// One level of the vault: Pinned (root only) + subfolders + notes.
struct FolderContentView: View {
    let folderPath: String
    @Binding var navigationPath: [NotesRoute]

    @Environment(ConnectionStore.self) private var connection
    @Environment(NotesStore.self) private var notes

    @AppStorage("notes.pinnedCollapsed", store: AppPrefs.defaults) private var pinnedCollapsed = false
    @State private var showCreate = false
    @State private var newNoteName = ""
    @State private var deleteCandidate: String?

    private var isRoot: Bool { folderPath.isEmpty }

    private var children: [NoteTreeNode] {
        notes.children(of: folderPath) ?? []
    }

    private var folders: [NoteTreeNode] {
        // Hide attachment-only folders (e.g. `_attachment`) — nothing to open.
        children.filter { $0.type == .folder && NotesStore.noteCount(in: $0) > 0 }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var files: [NoteTreeNode] {
        children.filter { $0.type == .file && !$0.isAttachment }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        Group {
            if children.isEmpty && notes.loadingTree {
                skeleton
            } else if folders.isEmpty && files.isEmpty {
                WalnutEmptyState(title: "No notes yet",
                                 hint: "Tap the compose button to write your first note.",
                                 systemImage: "doc.text", size: .pane)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    // A name a push closed the dialog over is offered again; Create and Cancel end it.
                    showCreate = true
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityIdentifier("notes.create")
            }
        }
        // A small sheet with Walnut's mic (an alert hosts none); the name stays in this view's
        // state until Create or Cancel, so a push that closes the sheet keeps it.
        .sheet(isPresented: $showCreate) {
            DictatedTextPrompt(
                title: "New Note",
                message: isRoot ? "Created at the top level." : "Created in \(folderPath.components(separatedBy: "/").last ?? folderPath).",
                placeholder: "Title", text: $newNoteName,
                surface: "new-note-title:\(folderPath)", box: "new-note-title",
                confirmTitle: "Create", identifier: "notes.createPrompt", autocorrect: false,
                onCancel: {
                    newNoteName = ""
                    showCreate = false
                },
                onConfirm: { _ in
                    showCreate = false
                    createNote()
                }
            )
        }
        .alert(
            "Delete Note",
            isPresented: .init(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let target = deleteCandidate {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    Task { await notes.remove(path: target) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Delete \"\(displayTitle(deleteCandidate ?? ""))\"? Git history keeps a copy.")
        }
    }

    private var list: some View {
        List {
            if !connection.online {
                OfflineBanner(text: "Offline: notes are read-only from cache")
                    .listRowInsets(EdgeInsets())
            }
            if isRoot && !notes.pinned.isEmpty {
                pinnedSection
            }
            if !folders.isEmpty {
                Section {
                    ForEach(folders) { folder in
                        FolderRow(node: folder)
                    }
                } header: {
                    if isRoot { Text("Folders") }
                }
            }
            if !files.isEmpty {
                Section {
                    ForEach(files) { file in
                        NoteRow(node: file, onDelete: { deleteCandidate = file.path })
                    }
                } header: {
                    if isRoot && !folders.isEmpty { Text("Notes") }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await notes.refreshTree()
            await notes.refreshPinned()
        }
        .animation(.snappy(duration: 0.25), value: notes.pinned)
    }

    private var pinnedSection: some View {
        Section {
            if !pinnedCollapsed {
                ForEach(notes.pinned, id: \.self) { pinnedPath in
                    PinnedNoteRow(path: pinnedPath, onDelete: { deleteCandidate = pinnedPath })
                }
            }
        } header: {
            Button {
                withAnimation(.snappy(duration: 0.25)) { pinnedCollapsed.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.tint)
                    Text("Pinned")
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(pinnedCollapsed ? 0 : 90))
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(.secondary)
        }
    }

    private var skeleton: some View {
        List {
            ForEach(0..<8, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 5) {
                    Text("Placeholder note title")
                    Text("Placeholder preview text for loading")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .redacted(reason: .placeholder)
    }

    private func createNote() {
        var name = newNoteName.trimmingCharacters(in: .whitespacesAndNewlines)
        newNoteName = ""
        if name.lowercased().hasSuffix(".md") { name = String(name.dropLast(3)) }
        guard !name.isEmpty, !name.contains("/") else { return }
        let newPath = isRoot ? name : "\(folderPath)/\(name)"
        Task {
            if await notes.create(path: newPath) {
                navigationPath.append(.noteEditing(newPath + ".md"))
            }
        }
    }

    private func displayTitle(_ notePath: String) -> String {
        (notePath.components(separatedBy: "/").last ?? notePath)
            .replacingOccurrences(of: ".md", with: "")
    }
}
