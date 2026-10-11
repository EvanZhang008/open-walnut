import SwiftUI

/// Fork this session: a sibling task with a copy of the conversation, opened
/// from the composer's `+` menu (the web's Fork). An optional first message
/// starts the fork working right away.
struct SessionForkSheet: View {
    let session: WalnutSession
    /// Called with the pre-seeded fork right before dismissal; the presenter
    /// pushes its conversation page.
    var onForked: (WalnutSession) -> Void

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()
    @State private var message = ""
    @State private var forking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
                Section {
                    TextField("Optional first message for the fork", text: $message, axis: .vertical)
                        .lineLimit(2...6)
                        .accessibilityIdentifier("session.forkMessage")
                } footer: {
                    Text("Creates a sibling task with a copy of this conversation. The original keeps running untouched.")
                }
            }
            .navigationTitle("Fork Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.disabled(forking)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if forking {
                        ProgressView()
                    } else {
                        Button("Fork") { Task { await fork() } }
                            .fontWeight(.semibold)
                            .accessibilityIdentifier("session.fork")
                    }
                }
            }
            .interactiveDismissDisabled(forking)
        }
    }

    private func fork() async {
        guard !forking else { return }
        forking = true
        errorMessage = nil
        defer { forking = false }
        do {
            let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
            let created = try await api.forkSession(id: session.id, message: text.isEmpty ? nil : text)
            // Same launch-stash pattern as NewSessionSheet: paint the first
            // message instantly on the pushed page (spawn is async).
            if !text.isEmpty {
                SessionLaunchContext.stash(sessionId: created.sessionId, message: text)
            }
            AppLog.info("session", "forked session", [
                "sourceSessionId": session.id, "sessionId": created.sessionId,
            ])
            let now = ISO8601DateFormatter().string(from: AppClock.now())
            onForked(WalnutSession(
                id: created.sessionId,
                title: created.title,
                taskId: created.taskId,
                taskTitle: created.title,
                project: session.project,
                host: session.host,
                processStatus: "idle",
                model: session.model,
                mode: session.mode,
                startedAt: now,
                lastActiveAt: now,
                messageCount: 0,
                cwd: session.cwd,
                pinned: nil,
                focusTier: nil,
                description: nil
            ))
            dismiss()
        } catch {
            errorMessage = SessionControlsSheet.friendlyControlError(error)
        }
    }
}

/// The session's note: the user's own words about it (the web's Note), kept on
/// the session record (`human_note`), opened from the composer's `+` menu.
struct SessionNoteSheet: View {
    let sessionId: String

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()
    @State private var note = ""
    /// The note as the server last had it, so Save knows whether anything changed.
    @State private var saved = ""
    @State private var loading = true
    /// The note could not be read. Save stays off: saving over a note we never
    /// saw would replace it.
    @State private var loadFailed = false
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
                Section {
                    if loading {
                        HStack {
                            ProgressView()
                            Text("Loading note…").foregroundStyle(.secondary)
                        }
                    } else if loadFailed {
                        Button("Try again") { Task { await load() } }
                            .accessibilityIdentifier("session.noteRetry")
                    } else {
                        TextField("A note for yourself about this session", text: $note, axis: .vertical)
                            .lineLimit(4...16)
                            .accessibilityIdentifier("session.noteField")
                    }
                } footer: {
                    Text("Only you see this note. The agent does not.")
                }
            }
            .navigationTitle("Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(loading || loadFailed || note == saved)
                            .accessibilityIdentifier("session.noteSave")
                    }
                }
            }
            .interactiveDismissDisabled(saving || note != saved)
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        loadFailed = false
        errorMessage = nil
        defer { loading = false }
        do {
            let current = try await api.sessionDetail(id: sessionId).session.humanNote ?? ""
            note = current
            saved = current
        } catch let error as APIError where error.isCancelled {
            loadFailed = true
        } catch {
            loadFailed = true
            errorMessage = "Couldn't load the note: \(SessionControlsSheet.friendlyControlError(error))"
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            _ = try await api.setSessionNote(id: sessionId, note: note)
            saved = note
            AppLog.info("session", "saved session note", ["sessionId": sessionId, "chars": String(note.count)])
            dismiss()
        } catch {
            errorMessage = "Couldn't save the note: \(SessionControlsSheet.friendlyControlError(error))"
        }
    }
}
