import SwiftUI

/// A local draft saved when a final save couldn't complete (backgrounded
/// mid-PUT). `baseHash` is the server hash the draft was derived FROM: adopting
/// a draft whose base no longer matches the server would silently revert
/// whatever else changed there, so a mismatch asks the user instead.
struct NoteDraft: Codable {
    let content: String
    let baseHash: String?
}

/// Note screen — Apple Notes-style: the WYSIWYG editor IS the note, always.
/// No separate "rendered" vs "raw editor" mode; tapping anywhere just moves
/// the caret there. A ••• menu item drops to a plain-markdown sheet for the
/// rare case someone wants to see/edit the literal source.
struct NoteDetailView: View {
    let path: String
    var startEditing = false

    @Environment(NotesStore.self) private var notes
    @Environment(ConnectionStore.self) private var connection
    @Environment(\.dismiss) private var dismiss

    @State private var frontmatter: String?
    @State private var attributedText = NSAttributedString()
    @State private var contentHash: String?
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var saving = false
    @State private var dirty = false
    @State private var conflict: (serverHash: String?, serverContent: String?)?
    /// A recovered local draft whose baseline no longer matches the server.
    @State private var draftConflict: NoteDraft?
    @State private var saveTask: Task<Void, Never>?
    @State private var showDeleteConfirm = false
    @State private var showRawEditor = false
    @State private var rawContent = ""

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
        .toolbar { toolbarContent }
        .task { await load() }
        .onDisappear {
            saveTask?.cancel()
            if dirty {
                // Persist a local draft FIRST: the fire-and-forget final save
                // can be cancelled by backgrounding (now classified .cancelled
                // and rethrown), which silently lost the text. The draft is
                // adopted on next open and cleared on any successful save.
                DiskCache.save(
                    NoteDraft(content: currentMarkdown(), baseHash: contentHash),
                    key: Self.draftKey(path)
                )
                Task { await flushSave() }
            }
        }
        .sheet(isPresented: $showRawEditor, onDismiss: adoptRawEdits) {
            RawMarkdownSheet(text: $rawContent)
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
                let mine = currentMarkdown()
                conflict = nil
                Task { await save(text: mine, hash: nil) } // no expectedHash = last-write-wins
            }
            Button("Reload Server Version", role: .cancel) {
                if let server = conflict?.serverContent {
                    adopt(content: server, hash: conflict?.serverHash)
                    dirty = false
                }
                conflict = nil
            }
        } message: {
            Text("This note was changed on the server while you were editing.")
        }
        .alert(
            "Unsaved Draft Recovered",
            isPresented: .init(
                get: { draftConflict != nil },
                set: { if !$0 { draftConflict = nil } }
            )
        ) {
            Button("Use My Draft") {
                if let draft = draftConflict {
                    adopt(content: draft.content, hash: contentHash)
                    dirty = true
                    scheduleAutosave()
                }
                draftConflict = nil
            }
            Button("Keep Server Version", role: .cancel) {
                // Never delete the draft here: it stays under a recovery key so
                // the text is still retrievable if the user changes their mind.
                if let draft = draftConflict {
                    DiskCache.save(draft, key: "note-draft-recovered-\(path)")
                }
                DiskCache.remove(key: Self.draftKey(path))
                draftConflict = nil
            }
        } message: {
            Text("A draft from an interrupted save doesn't match the current server version — the note changed elsewhere too. Keeping the server version stores your draft for recovery.")
        }
    }

    // MARK: - Editor

    private var editor: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline — edits may not save")
            }
            WysiwygEditor(
                attributedText: $attributedText,
                isEditable: connection.online,
                notePath: path,
                autoFocus: startEditing,
                onChange: {
                    dirty = true
                    scheduleAutosave()
                },
                onCheckboxToggle: {
                    dirty = true
                    saveTask?.cancel()
                    saveTask = Task { await flushSave() }
                }
            )
            .accessibilityIdentifier("note.editor")
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

            if loaded {
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
                    Button {
                        rawContent = currentMarkdown()
                        showRawEditor = true
                    } label: {
                        Label("View Markdown Source", systemImage: "text.alignleft")
                    }
                    ShareLink(item: currentMarkdown(), subject: Text(title)) {
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

    static func draftKey(_ path: String) -> String { "note-draft-\(path)" }

    private func load() async {
        guard !loaded else { return }
        do {
            let note = try await notes.loadNote(path: path)
            contentHash = note.contentHash
            // A leftover draft means the last final save never landed
            // (backgrounded mid-PUT).
            let draft = Self.loadDraft(path: path)
            if let draft, draft.content != note.content {
                if draft.baseHash == note.contentHash {
                    // Server is still exactly what the draft was based on — the
                    // draft is a pure superset of it, adopt silently.
                    adopt(content: draft.content, hash: note.contentHash)
                    dirty = true
                    scheduleAutosave()
                } else {
                    // The note ALSO changed elsewhere (agent, web console,
                    // another device). Auto-adopting would revert those edits
                    // invisibly, so show the server copy and let the user choose.
                    adopt(content: note.content, hash: note.contentHash)
                    draftConflict = draft
                }
            } else {
                adopt(content: note.content, hash: note.contentHash)
            }
            loaded = true
        } catch {
            loadFailed = true
        }
    }

    /// Reads the current draft record, transparently upgrading the legacy
    /// bare-string format (no baseline hash → treated as unknown baseline).
    private static func loadDraft(path: String) -> NoteDraft? {
        if let draft = DiskCache.load(NoteDraft.self, key: draftKey(path)) { return draft }
        if let legacy = DiskCache.load(String.self, key: draftKey(path)) {
            return NoteDraft(content: legacy, baseHash: nil)
        }
        return nil
    }

    private func adopt(content: String, hash: String?) {
        let parsed = MarkdownAttributed.parse(content, maxImageWidth: UIScreen.main.bounds.width - 32)
        frontmatter = parsed.frontmatter
        attributedText = parsed.attributed
        contentHash = hash
    }

    private func currentMarkdown() -> String {
        MarkdownSerializer.serialize(frontmatter: frontmatter, attributed: attributedText)
    }

    private func adoptRawEdits() {
        guard rawContent != currentMarkdown() else { return }
        adopt(content: rawContent, hash: contentHash)
        dirty = true
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
        await save(text: currentMarkdown(), hash: contentHash)
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
                DiskCache.remove(key: Self.draftKey(path))
            case .conflict(let serverHash, let serverContent):
                conflict = (serverHash, serverContent)
            }
        } catch {
            // Keep dirty=true so the next edit or screen pop retries.
            AppLog.error("notes", "save failed — will retry", ["path": path, "error": String(describing: error)])
        }
    }
}

/// Plain-markdown fallback editor, reached via ••• → "View Markdown Source".
private struct RawMarkdownSheet: View {
    @Binding var text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .font(.system(.subheadline, design: .monospaced))
                .padding(.horizontal, 10)
                .navigationTitle("Markdown Source")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
