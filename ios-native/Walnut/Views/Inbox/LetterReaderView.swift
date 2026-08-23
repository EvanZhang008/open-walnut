import SwiftUI

/// The letter reader: header, one-click decision buttons, the document body,
/// the thread, and a reply box.
///
/// Two rules the design leans on. First, the body is rendered, never
/// paraphrased: HTML goes through the locked-down `LetterHTMLBody`, markdown
/// through `LetterMarkdownBody` (the app's `MarkdownView` plus the same
/// no-remote-subresource rule), so a letter reads the same here as in the
/// console and neither format can phone home. Second, an answer is recorded
/// before it is delivered — a 200
/// always means "on record", and the delivery line says how far it got toward
/// the agent, so the human is never left guessing whether their decision stuck.
struct LetterReaderView: View {
    let letterId: String

    @Environment(InboxStore.self) private var inbox
    @Environment(TasksStore.self) private var tasks

    @State private var letter: Letter?
    @State private var loadError: String?
    @State private var loading = false
    /// Free-text note attached to a decision ("option B, after the tests pass").
    @State private var decisionNote = ""
    @State private var replyText = ""
    @State private var busyActionId: String?
    @State private var sendingReply = false
    /// Last delivery outcome, shown non-blocking under the thread.
    @State private var deliveryNote: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let letter {
                    header(letter)
                    if !letter.openActions.isEmpty { decisionCard(letter) }
                    if let answer = letter.answered { answeredCard(letter, answer) }
                    bodySection(letter)
                    taskRefs(letter)
                    if !letter.threadEntries.isEmpty { LetterThreadView(letter: letter) }
                    if let note = deliveryNote { deliveryLine(note) }
                } else if loading {
                    ProgressView().controlSize(.large)
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else if let loadError {
                    ContentUnavailableView {
                        Label("Can't open this letter", systemImage: "envelope.badge.shield.half.filled")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("Try Again") { Task { await load() } }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .navigationTitle(letter?.kind.label ?? "Letter")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarButtons }
        .safeAreaInset(edge: .bottom) { composer }
        .freezeScreen("inbox-letter")
        .task { await load() }
    }

    // MARK: - Header

    private func header(_ letter: Letter) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(letter.subject.isEmpty ? "(no subject)" : letter.subject)
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
                .accessibilityIdentifier("inbox.letter.subject")
            HStack(spacing: 6) {
                Image(systemName: letter.kind.symbol).font(.caption2)
                Text(letter.senderName).font(.caption)
                if let task = letter.taskTitle {
                    Text("· \(task)").font(.caption).lineLimit(1)
                }
            }
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(letter.hostLabel)
                if let when = letter.createdDate {
                    Text("· \(when.formatted(date: .abbreviated, time: .shortened))")
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Decision buttons

    /// One tap and the human is done. The optional note rides WITH the choice so
    /// "option B, but only after the tests pass" doesn't need a second message.
    private func decisionCard(_ letter: Letter) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("This letter needs a decision", systemImage: "hand.raised")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.warning)
            ForEach(letter.openActions) { action in
                Button {
                    Task { await answer(action) }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(action.label)
                                .font(.subheadline.weight(.semibold))
                                .multilineTextAlignment(.leading)
                            if let description = action.description, !description.isEmpty {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 4)
                        if busyActionId == action.id { ProgressView().controlSize(.small) }
                    }
                    .padding(.vertical, 9)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.tintSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(busyActionId != nil)
                .accessibilityIdentifier("inbox.letter.action.\(action.id)")
            }
            TextField("Add a note with your choice (optional)", text: $decisionNote, axis: .vertical)
                .lineLimit(1...3)
                .font(.callout)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("inbox.letter.decisionNote")
        }
        .padding(12)
        .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.warning.opacity(0.35), lineWidth: 1)
        }
    }

    private func answeredCard(_ letter: Letter, _ answer: LetterAnswer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Answered", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.success)
            Text(answer.label ?? answer.actionId)
                .font(.callout.weight(.medium))
            if let note = answer.freeText, !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if let when = answer.date {
                Text(when.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.success.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityIdentifier("inbox.letter.answered")
    }

    // MARK: - Body

    @ViewBuilder
    private func bodySection(_ letter: Letter) -> some View {
        if letter.bodyMissing == true {
            Text(letter.displayBody.isEmpty ? "This letter's body is no longer on disk." : letter.displayBody)
                .font(.callout)
                .foregroundStyle(.secondary)
        } else if letter.body == nil && loading {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
        } else if letter.displayBody.isEmpty {
            Text(letter.previewLine.isEmpty ? "This letter has no body." : letter.previewLine)
                .font(.callout)
                .foregroundStyle(.secondary)
        } else if letter.isHTMLBody {
            LetterHTMLBody(html: letter.displayBody)
        } else {
            // Not MarkdownView directly: a markdown body needs the same
            // no-remote-subresource floor the html body's CSP gives it.
            LetterMarkdownBody(markdown: letter.displayBody)
                .accessibilityIdentifier("inbox.letter.markdownBody")
        }
        if letter.bodyWasClipped {
            Text("Only the first \(Letter.phoneBodyCap / 1000)K characters are shown here — open this letter in the web console for the whole document.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func taskRefs(_ letter: Letter) -> some View {
        let refs = letter.taskRefs ?? []
        if !refs.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text("Tasks").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(refs, id: \.self) { ref in
                    HStack(spacing: 5) {
                        Image(systemName: "checklist").font(.system(size: 9))
                        Text(taskLabel(ref)).font(.caption).lineLimit(1)
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// A cited task shows its title when the Tasks tab already knows it; the raw
    /// id is a poor label, but inventing one would be worse.
    private func taskLabel(_ id: String) -> String {
        tasks.tasks.first { $0.id == id }?.title ?? id
    }

    private func deliveryLine(_ note: String) -> some View {
        Text(note)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("inbox.letter.delivery")
    }

    // MARK: - Toolbar + composer

    @ToolbarContentBuilder
    private var toolbarButtons: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let letter {
                    Button {
                        Task { await inbox.setPinned(id: letter.id, pinned: !letter.isPinned) }
                    } label: {
                        Label(letter.isPinned ? "Unpin" : "Pin", systemImage: letter.isPinned ? "pin.slash" : "pin")
                    }
                    Button {
                        Task { await inbox.setRead(id: letter.id, read: false) }
                    } label: {
                        Label("Mark Unread", systemImage: "envelope.badge")
                    }
                    Button {
                        Task { await inbox.setArchived(id: letter.id, archived: !letter.isArchived) }
                    } label: {
                        Label(
                            letter.isArchived ? "Unarchive" : "Archive",
                            systemImage: letter.isArchived ? "tray.and.arrow.up" : "archivebox"
                        )
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityIdentifier("inbox.letter.menu")
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply to the agent", text: $replyText, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .accessibilityIdentifier("inbox.letter.replyField")
            Button {
                Task { await sendReply() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? Theme.tint : Color(.tertiaryLabel))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityIdentifier("inbox.letter.send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !sendingReply && !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    /// Paint from the row we already have, then read the full letter. Opening
    /// marks THIS letter read (and nothing else).
    private func load() async {
        if letter == nil { letter = inbox.letter(id: letterId) }
        loading = true
        defer { loading = false }
        do {
            letter = try await inbox.detail(id: letterId)
            loadError = nil
            inbox.markReadOnOpen(id: letterId)
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            // A failed re-read must not blank a letter already on screen.
            if letter == nil { loadError = error.localizedDescription }
        }
    }

    private func answer(_ action: LetterAction) async {
        guard busyActionId == nil else { return }
        busyActionId = action.id
        defer { busyActionId = nil }
        let note = decisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
        switch await inbox.answer(id: letterId, actionId: action.id, freeText: note.isEmpty ? nil : note) {
        case .success(let result):
            decisionNote = ""
            adopt(result)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .failure(let error):
            // 409 = someone answered from another surface. The buttons must not
            // stay armed over a decision that is already made — re-read instead.
            if let apiError = error as? APIError, apiError.isConflict {
                deliveryNote = "This letter was already answered somewhere else."
                await load()
                return
            }
            deliveryNote = error.localizedDescription
        }
    }

    private func sendReply() async {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sendingReply else { return }
        sendingReply = true
        defer { sendingReply = false }
        switch await inbox.reply(id: letterId, text: text) {
        case .success(let result):
            replyText = ""
            adopt(result)
        case .failure(let error):
            deliveryNote = error.localizedDescription
        }
    }

    /// Adopt the server's letter, but never trade a body-inlined document for a
    /// payload that lost it (an older/relayed response) — the reader would blank
    /// the letter the human is reading. Keep what's on screen and re-read.
    private func adopt(_ result: LetterActionResult) {
        deliveryNote = result.delivery?.humanText ?? "Saved"
        guard let updated = result.letter else {
            Task { await load() }
            return
        }
        if updated.body != nil || letter?.body == nil {
            letter = updated
        } else {
            Task { await load() }
        }
    }
}
