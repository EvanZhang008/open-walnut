import SwiftUI

/// Note screen — RENDERED markdown by default (Apple Notes feel); pencil
/// toggles a raw markdown editor with debounced autosave + optimistic locking.
/// Task checkboxes in rendered mode toggle and save immediately.
struct NoteDetailView: View {
    let path: String
    var startEditing = false

    @Environment(NotesStore.self) private var notes
    @Environment(ConnectionStore.self) private var connection
    @Environment(\.dismiss) private var dismiss

    @State private var content: String = ""
    @State private var blocks: [MarkdownBlock] = []
    @State private var contentHash: String?
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var editing = false
    @State private var saving = false
    @State private var dirty = false
    @State private var conflict: (serverHash: String?, serverContent: String?)?
    @State private var saveTask: Task<Void, Never>?
    @State private var showDeleteConfirm = false
    @FocusState private var editorFocused: Bool

    private var title: String {
        (path.split(separator: "/").last.map(String.init) ?? path)
            .replacingOccurrences(of: ".md", with: "")
    }

    var body: some View {
        Group {
            if loadFailed {
                ContentUnavailableView(
                    "Couldn't load this note",
                    systemImage: "exclamationmark.triangle",
                    description: Text("Check the connection and try again.")
                )
            } else if !loaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if editing {
                rawEditor
            } else {
                rendered
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task { await load() }
        .onDisappear {
            saveTask?.cancel()
            if dirty {
                // Fire-and-forget final save on screen pop.
                Task { await flushSave() }
            }
        }
        .confirmationDialog("Delete this note?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                Task {
                    if await notes.remove(path: path) { dismiss() }
                }
            }
        } message: {
            Text("Git history keeps a copy.")
        }
        .alert(
            "Server Changed",
            isPresented: .init(
                get: { conflict != nil },
                set: { if !$0 { conflict = nil } }
            )
        ) {
            Button("Overwrite") {
                let mine = content
                conflict = nil
                Task { await save(text: mine, hash: nil) } // no expectedHash = last-write-wins
            }
            Button("Reload Server Version", role: .cancel) {
                if let server = conflict?.serverContent {
                    content = server
                    contentHash = conflict?.serverHash
                    dirty = false
                    reparse()
                }
                conflict = nil
            }
        } message: {
            Text("This note was changed on the server while you were editing.")
        }
    }

    // MARK: - Rendered mode

    private var rendered: some View {
        ScrollView {
            if !connection.online {
                OfflineBanner(text: "Offline — showing cached copy")
            }
            MarkdownView(blocks: blocks) { sourceLine, checked in
                toggleTask(sourceLine: sourceLine, checked: checked)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 40)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: - Raw editor mode

    private var rawEditor: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline — edits may not save")
            }
            TextEditor(text: $content)
                .font(.system(.subheadline, design: .monospaced))
                .lineSpacing(3)
                .scrollDismissesKeyboard(.interactively)
                .padding(.horizontal, 14)
                .padding(.top, 4)
                .focused($editorFocused)
                .disabled(!connection.online)
                .accessibilityIdentifier("note.editor")
                .onChange(of: content) { old, new in
                    guard loaded, old != new else { return }
                    dirty = true
                    scheduleAutosave()
                }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if saving {
                ProgressView()
            } else if dirty {
                Image(systemName: "circle.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(Theme.warning)
                    .accessibilityLabel("Unsaved changes")
            }

            if editing {
                Button("Done") {
                    editorFocused = false
                    editing = false
                    reparse()
                    saveTask?.cancel() // avoid racing the pending autosave
                    Task { await flushSave() }
                }
                .fontWeight(.semibold)
            } else if loaded {
                Button {
                    editing = true
                    editorFocused = true
                } label: {
                    Image(systemName: "pencil")
                }
                .accessibilityIdentifier("note.edit")

                Menu {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await notes.togglePin(path) }
                    } label: {
                        Label(
                            notes.isPinned(path) ? "Unpin" : "Pin",
                            systemImage: notes.isPinned(path) ? "pin.slash" : "pin"
                        )
                    }
                    ShareLink(item: content, subject: Text(title)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    Divider()
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityIdentifier("note.menu")
            }
        }
    }

    // MARK: - Load / parse / save

    private func load() async {
        guard !loaded else { return }
        do {
            let note = try await notes.loadNote(path: path)
            content = note.content
            contentHash = note.contentHash
            loaded = true
            reparse()
            if startEditing {
                editing = true
                // Small delay so focus lands after the view is on screen.
                try? await Task.sleep(for: .milliseconds(350))
                editorFocused = true
            }
        } catch {
            loadFailed = true
        }
    }

    private func reparse() {
        blocks = MarkdownParser.parse(content)
    }

    /// Rendered-mode checkbox tap: rewrite the exact source line, save, re-render.
    private func toggleTask(sourceLine: Int, checked: Bool) {
        guard let updated = MarkdownParser.togglingTask(in: content, sourceLine: sourceLine, to: checked) else {
            return
        }
        content = updated
        dirty = true
        reparse()
        saveTask?.cancel()
        saveTask = Task { await flushSave() }
    }

    private func scheduleAutosave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            await flushSave()
        }
    }

    /// Serialized: a flush that lands while another save is in flight waits for
    /// it, then re-checks. Two concurrent PUTs would race the same expectedHash
    /// and the loser would surface a bogus "Server Changed" conflict.
    private func flushSave() async {
        while saving {
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard dirty else { return }
        await save(text: content, hash: contentHash)
    }

    private func save(text: String, hash: String?) async {
        saving = true
        defer { saving = false }
        do {
            let outcome = try await notes.save(path: path, content: text, expectedHash: hash)
            switch outcome {
            case .saved(let result):
                // Adopt the server's hash — it may stamp frontmatter into new notes.
                contentHash = result.contentHash
                dirty = false
            case .conflict(let serverHash, let serverContent):
                conflict = (serverHash, serverContent)
            }
        } catch {
            // Keep dirty=true so the next edit or screen pop retries.
        }
    }
}
