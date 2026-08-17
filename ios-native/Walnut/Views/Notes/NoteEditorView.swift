import SwiftUI
import CoreTransferable

/// A local draft saved when a final save couldn't complete (backgrounded
/// mid-PUT). `baseHash` is the server hash the draft was derived FROM: adopting
/// a draft whose base no longer matches the server would silently revert
/// whatever else changed there, so a mismatch asks the user instead.
struct NoteDraft: Codable {
    let content: String
    let baseHash: String?
}

/// Lazy share payload (audit MAIN-6): `ShareLink(item: currentMarkdown())`
/// serialized the ENTIRE note on every body evaluation — and the editor
/// flips `attributedText` per keystroke, so typing paid an O(note) markdown
/// serialization per key. This defers the serialize to the moment the user
/// actually shares; construction is two reference copies.
/// @unchecked Sendable: NSAttributedString is immutable here (the editor
/// pushes fresh snapshots; nothing mutates a pushed instance).
struct NoteShareText: Transferable, @unchecked Sendable {
    let frontmatter: String?
    let attributed: NSAttributedString

    var markdown: String {
        MarkdownSerializer.serialize(frontmatter: frontmatter, attributed: attributed)
    }

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.markdown)
    }
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
        .onAppear {
            // Attachment resolution needs to know WHICH note is asking: the same
            // image filename lives in many `_attachment/` folders, and the server
            // breaks the tie by proximity to this note.
            MediaContext.currentNotePath = path
        }
        .onDisappear {
            if MediaContext.currentNotePath == path { MediaContext.currentNotePath = nil }
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
                    // Same in-flight protection as scheduleAutosave.
                    saveTask = Task { await Task { await flushSave() }.value }
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
                    // Lazy export (audit MAIN-6): serializing here ran an
                    // O(note) markdown serialize per body eval = per keystroke.
                    ShareLink(
                        item: NoteShareText(frontmatter: frontmatter, attributed: attributedText),
                        subject: Text(title),
                        preview: SharePreview(title)
                    ) {
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
            let draft = await Self.loadDraft(path: path)
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
    private static func loadDraft(path: String) async -> NoteDraft? {
        if let draft = await DiskCache.loadAsync(NoteDraft.self, key: draftKey(path)) { return draft }
        if let legacy = await DiskCache.loadAsync(String.self, key: draftKey(path)) {
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
        saveTask = Task { await Task { await flushSave() }.value }
    }

    private func scheduleAutosave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            // Unstructured hop: cancelling the debounce (the next keystroke)
            // must NOT cancel a PUT already in flight. The server may have
            // applied that PUT — killing the response leaves contentHash
            // stale, and the next save then 409s against our OWN write
            // (bogus "Server Changed" with nothing changed elsewhere).
            await Task { await flushSave() }.value
        }
    }

    /// Tail of the serial save chain (see flushSave). Holding a completed
    /// task is fine — it's one small allocation, replaced by the next flush.
    @State private var saveChain: Task<Void, Never>?

    /// Serialized: a flush that lands while another save is in flight CHAINS
    /// after it (await the previous task), then re-checks `dirty`. Two
    /// concurrent PUTs would race the same expectedHash and the loser would
    /// surface a bogus "Server Changed" conflict. Chaining replaces the old
    /// `while saving { sleep(100ms) }` form — a 10Hz MainActor wakeup loop
    /// for the whole duration of a slow PUT (up to 30s), and unfair under
    /// several waiters (audit TMR-10).
    private func flushSave() async {
        let previous = saveChain
        let task = Task { @MainActor in
            _ = await previous?.value
            guard dirty else { return }
            await save(text: currentMarkdown(), hash: contentHash)
        }
        saveChain = task
        await task.value
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
                // Self-conflict heal: if the server's "conflicting" copy is
                // byte-identical to what we just sent (or to what we're about
                // to send), our own earlier PUT landed but its response was
                // lost (cancelled mid-flight / backgrounded). Nothing changed
                // elsewhere — adopt the hash silently instead of alarming.
                if serverContent == text || serverContent == currentMarkdown() {
                    contentHash = serverHash
                    if serverContent == currentMarkdown() {
                        dirty = false
                        DiskCache.remove(key: Self.draftKey(path))
                    } else {
                        // Editor moved on since `text` — retry with the fresh hash.
                        scheduleAutosave()
                    }
                } else {
                    conflict = (serverHash, serverContent)
                }
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
