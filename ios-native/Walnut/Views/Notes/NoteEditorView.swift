import SwiftUI

/// Note editor — markdown source in a TextEditor with debounced autosave and
/// optimistic locking. On 409 the user chooses overwrite vs reload.
struct NoteEditorView: View {
    let path: String

    @Environment(NotesStore.self) private var notes
    @Environment(ConnectionStore.self) private var connection

    @State private var content: String = ""
    @State private var contentHash: String?
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var saving = false
    @State private var conflict: (serverHash: String?, serverContent: String?)?
    @State private var saveTask: Task<Void, Never>?
    @State private var dirty = false

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
            } else {
                editor
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if saving {
                    ProgressView()
                } else if dirty {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(Theme.warning)
                        .accessibilityLabel("Unsaved changes")
                }
            }
        }
        .task {
            await load()
        }
        .onDisappear {
            saveTask?.cancel()
            if dirty {
                // Fire-and-forget final save on screen pop.
                Task { await flushSave() }
            }
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
                }
                conflict = nil
            }
        } message: {
            Text("This note was changed on the server while you were editing.")
        }
    }

    private var editor: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline — edits may not save")
            }
            TextEditor(text: $content)
                .font(.system(.body, design: .monospaced))
                .scrollDismissesKeyboard(.interactively)
                .padding(.horizontal, 12)
                .disabled(!connection.online)
                .accessibilityIdentifier("note.editor")
                .onChange(of: content) { old, new in
                    guard loaded, old != new else { return }
                    dirty = true
                    scheduleAutosave()
                }
        }
    }

    // MARK: - Load / save

    private func load() async {
        do {
            let note = try await notes.loadNote(path: path)
            content = note.content
            contentHash = note.contentHash
            loaded = true
        } catch {
            loadFailed = true
        }
    }

    private func scheduleAutosave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            await flushSave()
        }
    }

    private func flushSave() async {
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
