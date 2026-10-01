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
    @State private var busyActionId: String?
    /// A problem that belongs to no single reply (a decision the server refused),
    /// shown non-blocking under the thread. A reply's own outcome is on its
    /// status line instead (`LetterReplyStatus`).
    @State private var deliveryNote: String?
    /// Drafts and replies on their way live in the app-wide store, so leaving the
    /// letter can never lose them.
    private let replies = LetterReplyStore.shared
    @State private var replyField = LetterReplyFieldController()
    @State private var replyFocused = false
    /// True from the Send tap until the reply is handed to the store: the commit
    /// step waits on the input session, and a second tap in that window is the
    /// same send.
    @State private var committingSend = false
    /// Walnut's own speech-to-text, the one the chat composer uses.
    @State private var voice = VoiceRecorder()
    /// The session a status line opened.
    @State private var openedSession: WalnutSession?
    /// Sessions a status line names that the tasks store does not hold, looked
    /// up by id: found ones open, the rest make the line plain text, so a tap
    /// never ends in "couldn't open that session".
    @State private var lookedUpSessions: [String: WalnutSession] = [:]
    @State private var unopenableSessions: Set<String> = []
    /// Bumped by each Send (and a Retry of the newest reply): the letter scrolls
    /// that reply into view wherever the reader was.
    @State private var followTick = 0
    /// From a Send at the accessibility sizes until its keyboard is asked to
    /// leave (see `handOver`); the letter's scroll for that Send waits for it.
    @State private var keyboardLeavesAfterSend = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// A DEFERRED document (over the server's inline threshold) is streamed to a
    /// local file and rendered from there — never held as a String, so a 100MB
    /// audio digest costs the app nothing beyond one copy chunk.
    @State private var deferredBodyFile: URL?
    @State private var deferredBodyLoading = false
    @State private var deferredBodyError: String?

    /// The reader's title: the letter's kind until it is answered, then the same
    /// "Answered" the inbox row shows. "Action needed" over a letter whose action
    /// was already taken told the reader to do something already done.
    static func title(for letter: Letter?) -> String {
        guard let letter else { return "Letter" }
        return letter.answered != nil ? "Answered" : letter.kind.label
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let letter {
                    header(letter)
                    if !letter.openActions.isEmpty { decisionCard(letter) }
                    if let answer = letter.answered { answeredCard(letter, answer) }
                    bodySection(letter)
                    taskRefs(letter)
                    if !letter.threadEntries.isEmpty || !replies.pendingReplies(for: letterId).isEmpty {
                        thread(letter)
                    }
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
            .id(Self.contentId)
        }
        // Dragging the letter down puts the keyboard away, as in a chat.
        .scrollDismissesKeyboard(.interactively)
        // A sent reply and its status line come into view above the reply box.
        .modifier(LetterFollowsNewestStatus(
            key: newestStatusKey, target: newestReplyItem?.id, contentId: Self.contentId, sendTick: followTick,
            keyboardLeaving: keyboardLeavesAfterSend
        ))
        // A reply on record whose delivery is still running: re-read the letter
        // until the outcome is in, so "Sending" turns into what happened.
        .modifier(LetterDeliveryWatch(
            waitingKey: deliveryWaitKey,
            lateKey: deliveryLateKey,
            reload: { await load() },
            giveUp: { replies.markDeliveryUnconfirmed(letterId: letterId, entries: turnsAwaitingDelivery) }
        ))
        .navigationTitle(Self.title(for: letter))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarButtons }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationDestination(item: $openedSession) { session in
            SessionConversationView(session: session)
        }
        .freezeScreen("inbox-letter")
        .task { await load() }
        .task(id: sessionsToLookUp) { await lookUpSessions(sessionsToLookUp) }
        .onAppear { attachVoice() }
        .onDisappear {
            // Opening a reply's session pushes over the reader, which stays in the
            // stack: its streamed document must still be on disk on the way back.
            if openedSession == nil { LetterBodyDownload.clearCache() }
            // Same rule as the chat composer: a view the user left must not keep
            // the mic open. The take is PRESERVED, never deleted, and comes back
            // as the saved-recording row.
            if voice.state == .recording { voice.preserveAndStop(reason: "view-dismissed") }
        }
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
        } else if letter.isBodyDeferred {
            deferredBody(letter)
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
            Text("Only the first \(Letter.phoneBodyCap / 1000)K characters are shown here. Open this letter in the web console for the whole document.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    /// The big-document path. There is nothing to apologise for here: the WHOLE
    /// letter arrives, it just comes over its own streamed request, so the only
    /// state worth showing is progress and a retry.
    @ViewBuilder
    private func deferredBody(_ letter: Letter) -> some View {
        if let file = deferredBodyFile {
            // Always the HTML frame, and that is not a shortcut: a markdown body
            // is capped at 200KB server-side, well under the inline threshold, so
            // a deferred document is by construction html.
            LetterHTMLBody(fileURL: file)
        } else if let deferredBodyError {
            VStack(alignment: .leading, spacing: 6) {
                Text(deferredBodyError).font(.callout).foregroundStyle(.secondary)
                Button("Try Again") { Task { await loadDeferredBody(letter) } }
                    .font(.callout)
            }
            .accessibilityIdentifier("inbox.letter.deferredBodyError")
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(deferredBodySizeLabel(letter)).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("inbox.letter.deferredBodyLoading")
            .task(id: letter.id) { await loadDeferredBody(letter) }
        }
    }

    private func deferredBodySizeLabel(_ letter: Letter) -> String {
        guard let bytes = letter.bodyBytes, bytes > 0 else { return "Loading the document…" }
        let mb = Double(bytes) / 1_048_576
        return mb >= 1
            ? String(format: "Loading the document (%.1f MB)…", mb)
            : "Loading the document…"
    }

    private func loadDeferredBody(_ letter: Letter) async {
        guard !deferredBodyLoading, deferredBodyFile == nil else { return }
        guard let url = letter.bodyStreamURL else {
            deferredBodyError = "This letter's body couldn't be located on the server."
            return
        }
        deferredBodyLoading = true
        deferredBodyError = nil
        defer { deferredBodyLoading = false }
        do {
            deferredBodyFile = try await LetterBodyDownload.fetchDocument(from: url, isHTML: true)
        } catch {
            deferredBodyError = error.localizedDescription
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

    // MARK: - Thread + reply status

    private func thread(_ letter: Letter) -> some View {
        let recipient = recipientName(letter)
        return LetterThreadView(
            letter: letter,
            pending: replies.pendingReplies(for: letterId),
            status: { entry in turnStatus(entry, recipient: recipient) },
            pendingStatus: { reply in pendingStatus(reply, recipient: recipient) },
            onOpenSession: openSession,
            onRetryTurn: { entry in
                // The newest reply is scrolled into view; an older one is where
                // the finger that tapped Retry already is.
                if newestReplyItem?.id == LetterThreadItem.turn(entry).id {
                    followTick += 1
                }
                Task {
                    if let result = await replies.retryRecordedTurn(letterId: letterId, entry: entry) {
                        adopt(result)
                    } else {
                        await recheckIfUnconfirmed()
                    }
                }
            },
            onRetryPending: { clientId in retryPending(clientId) },
            onEditPending: { clientId in
                replyField.endEditing()
                replies.edit(letterId: letterId, clientId: clientId)
                replyFocused = true
            }
        )
    }

    static let contentId = "letter.content"

    /// The thread's newest reply (recorded or pending), in the order it renders.
    private var newestReplyItem: LetterThreadItem? {
        guard let letter else { return nil }
        return LetterThreadItem.ordered(entries: letter.threadEntries, pending: replies.pendingReplies(for: letterId))
            .last(where: \.isHuman)
    }

    /// Changes whenever the newest reply's status line appears or its words
    /// change: what `LetterFollowsNewestStatus` scrolls into view.
    private var newestStatusKey: String {
        guard let letter, let item = newestReplyItem else { return "" }
        let recipient = recipientName(letter)
        let line: LetterReplyStatus?
        switch item {
        case .pending(let reply): line = pendingStatus(reply, recipient: recipient)
        case .turn(let entry): line = turnStatus(entry, recipient: recipient)
        }
        return "\(item.id)|\(line?.text ?? "")|\(line?.offersRetry == true)|\(line?.isBusy == true)"
    }

    /// The line under a reply the server does not have yet. A reply whose answer
    /// was lost reads as on its way while the letter is re-read to find out
    /// (showing "Not confirmed" for the length of that read was a flash of a
    /// state that is usually not true), and a Retry, being a new send, reads as
    /// on its way like any other.
    private func pendingStatus(_ reply: LetterReplyStore.PendingReply, recipient: String) -> LetterReplyStatus {
        let unsettled = reply.state == .sending || (reply.mayHaveArrived && replies.isRechecking(letterId: letterId))
        if unsettled { return .sending(recipient: recipient) }
        if case .failed(let sentence) = reply.state {
            return reply.mayHaveArrived ? .unconfirmed(recipient: recipient) : .sendFailed(sentence)
        }
        return .sending(recipient: recipient)
    }

    /// The line under one recorded human turn, or nil when there is nothing true
    /// to say (an older server that recorded no delivery, and no response of
    /// this app session that carried one).
    private func turnStatus(_ entry: LetterThreadEntry, recipient: String) -> LetterReplyStatus? {
        guard var line = recordedTurnStatus(entry, recipient: recipient) else { return nil }
        // A Retry on its way, or one whose answer was lost while the letter is
        // re-read: the line it was tapped on stays, busy.
        let retryUnsettled = replies.isRechecking(letterId: letterId)
            && replies.retryError(letterId: letterId, entry: entry)?.mayHaveArrived == true
        if replies.isRetrying(letterId: letterId, entry: entry) || retryUnsettled { line = line.busy(recipient: recipient) }
        // Tappable only into a session this phone can open.
        if let sessionId = line.sessionId, session(for: sessionId) == nil { line = line.withoutSession() }
        return line
    }

    private func recordedTurnStatus(_ entry: LetterThreadEntry, recipient: String) -> LetterReplyStatus? {
        let when = entry.date ?? entry.delivery?.at.map { Date(timeIntervalSince1970: $0 / 1000) }
        if replies.awaitsDelivery(letterId: letterId, entry: entry) {
            return replies.isDeliveryUnconfirmed(letterId: letterId, entry: entry)
                ? .unconfirmed(recipient: recipient, canRetry: entry.clientId != nil)
                : .sending(recipient: recipient)
        }
        guard let delivery = replies.delivery(letterId: letterId, entry: entry) else { return nil }
        if delivery.status == "failed", let failure = replies.retryError(letterId: letterId, entry: entry) {
            return failure.mayHaveArrived
                ? .unconfirmed(recipient: recipient)
                : .retryFailed(recipient: recipient, at: when, sessionId: delivery.sessionId)
        }
        return .recorded(delivery, recipient: recipient, at: when, canRetry: entry.clientId != nil)
    }

    /// Recorded turns still waiting for their delivery outcome and not yet given
    /// up on: what `LetterDeliveryWatch` re-reads the letter for.
    private var turnsAwaitingDelivery: [LetterThreadEntry] {
        guard let letter else { return [] }
        return letter.threadEntries.filter { entry in
            replies.awaitsDelivery(letterId: letterId, entry: entry)
                && !replies.isDeliveryUnconfirmed(letterId: letterId, entry: entry)
        }
    }

    private var deliveryWaitKey: String {
        turnsAwaitingDelivery.map { LetterThreadItem.turn($0).id }.joined(separator: ",")
    }

    /// What is still unknown after the backoff: recorded turns shown as "Not
    /// confirmed", and a reply whose answer was lost. `LetterDeliveryWatch`
    /// re-reads slowly for these, so a late outcome still shows on its own.
    private var deliveryLateKey: String {
        guard let letter else { return "" }
        var parts = letter.threadEntries.filter { entry in
            replies.awaitsDelivery(letterId: letterId, entry: entry)
                && replies.isDeliveryUnconfirmed(letterId: letterId, entry: entry)
        }.map { LetterThreadItem.turn($0).id }
        if replies.needsRecheck(letterId: letterId) { parts.append("lost-answer") }
        return parts.joined(separator: ",")
    }

    /// The session behind a status line, when this phone can open it.
    private func session(for id: String) -> WalnutSession? {
        tasks.sessions.first { $0.id == id } ?? lookedUpSessions[id]
    }

    /// Session ids the thread's status lines name that are neither in the tasks
    /// store nor looked up yet.
    private var sessionsToLookUp: [String] {
        guard let letter else { return [] }
        var ids: [String] = []
        for entry in letter.threadEntries where entry.isHuman {
            guard let id = replies.delivery(letterId: letterId, entry: entry)?.sessionId, !id.isEmpty,
                  !ids.contains(id), !unopenableSessions.contains(id), session(for: id) == nil else { continue }
            ids.append(id)
        }
        return ids
    }

    /// The by-id lookup the board uses, once per session per appearance.
    private func lookUpSessions(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        let task = letter?.sender?.taskId.flatMap { id in tasks.tasks.first { $0.id == id } }
        var found: [String: WalnutSession] = [:]
        var missing: Set<String> = []
        for id in ids {
            if let session = await tasks.resolveSession(id: id, task: task) { found[id] = session } else { missing.insert(id) }
        }
        // One write, so the lookup does not restart itself halfway through.
        lookedUpSessions.merge(found) { _, new in new }
        unopenableSessions.formUnion(missing)
    }

    /// Who a reply goes to, in the words the Tasks tab uses: the origin task's
    /// title from the tasks store, else the title stamped on the letter, else
    /// "the agent".
    private func recipientName(_ letter: Letter) -> String {
        let sessionId = letter.sender?.sessionId
        let session = sessionId.flatMap { sid in tasks.sessions.first { $0.id == sid } }
        let taskId = letter.sender?.taskId ?? session?.taskId
        let storeTitle = taskId.flatMap { id in tasks.tasks.first { $0.id == id }?.title } ?? session?.taskTitle
        return LetterReplyStatus.recipientName(storeTitle: storeTitle, stampedTitle: letter.taskTitle)
    }

    /// Open the session a status line names. A line is only tappable once the
    /// session is in hand (`session(for:)`), so there is no failure to report.
    private func openSession(_ sessionId: String) {
        guard let session = session(for: sessionId) else { return }
        deliveryNote = nil
        openedSession = session
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
                        inbox.mark(id: letter.id, read: false)
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

    /// The reply box: voice notices, then either the recording row or the field
    /// with the mic and send beside it (mic just left of send, as in the chat
    /// composer).
    private var composer: some View {
        VStack(spacing: 0) {
            VoiceNoticeRows(voice: voice, idPrefix: "inbox.letter") { text in insertTranscript(text) }
            if voice.state == .recording {
                VoiceRecordingBar(
                    voice: voice, idPrefix: "inbox.letter",
                    onCancel: { voice.cancel() },
                    onStop: {
                        Task { if let text = await voice.stopAndTranscribe() { insertTranscript(text) } }
                    }
                )
            } else {
                HStack(alignment: .bottom, spacing: 4) {
                    LetterReplyField(
                        text: replyDraft, isFocused: $replyFocused, controller: replyField
                    )
                    // A UIKit view has no width of its own to offer the row: take
                    // what is left beside the mic and send.
                    .frame(maxWidth: .infinity)
                    .overlay(alignment: .topLeading) {
                        // The long placeholder does not fit at the largest
                        // sizes, and an ellipsis in a placeholder reads as a bug.
                        //
                        // Always drawn, hidden by a clear colour. A view that
                        // appears (inserted, or back from opacity 0, which drops
                        // it from what is drawn) starts at its FINAL place, so
                        // when the Send that emptied the field also moved the box
                        // (the keyboard leaving) the placeholder showed at the
                        // bottom while the box was still sliding down to it
                        // (2026-09-29 films, round 4: opacity popped too, a clear
                        // colour slides with the box).
                        Text(dynamicTypeSize.isAccessibilitySize ? "Reply" : "Reply to the agent")
                            .lineLimit(1)
                            .foregroundStyle(
                                replyDraft.wrappedValue.isEmpty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.clear)
                            )
                            .padding(.horizontal, 12)
                            .padding(.vertical, LetterReplyField.verticalInset)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                    .background(
                        Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
                    VoiceMicButton(voice: voice, identifier: "inbox.letter.mic")
                    LetterSendButton(enabled: canSend, action: sendTapped)
                }
                .padding(.leading, 12)
                .padding(.trailing, 6)
                .padding(.vertical, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .background(.bar)
        // A group, so the children keep their own identifiers.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.letter.composer")
    }

    /// This letter's draft, held by the app-wide store.
    private var replyDraft: Binding<String> {
        Binding(
            get: { replies.draft(for: letterId) },
            set: { replies.setDraft($0, for: letterId) }
        )
    }

    private var canSend: Bool {
        !committingSend && !replies.draft(for: letterId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    /// Paint from the row we already have, then read the full letter. Opening
    /// marks THIS letter read (and nothing else), at the open itself, as the
    /// console's reader does: waiting for the body kept the row and the badge
    /// unread for as long as a slow relay took to deliver it.
    private func load() async {
        if letter == nil { letter = inbox.letter(id: letterId) }
        inbox.markReadOnOpen(id: letterId)
        loading = true
        defer { loading = false }
        let started = Date()
        do {
            let loaded = try await inbox.detail(id: letterId)
            // A reply whose response was lost but which the server recorded shows
            // once, as the recorded turn; one it does not hold gets Edit back.
            replies.reconcile(letterId: letterId, with: loaded, readStartedAt: started)
            letter = loaded
            loadError = nil
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            // The letter is gone from the server: so are its saved words.
            if let apiError = error as? APIError, case .server(404, _, _, _, _) = apiError {
                replies.forget(letterId: letterId)
            }
            // A failed re-read must not blank a letter already on screen.
            if letter == nil { loadError = error.localizedDescription }
        }
    }

    private func answer(_ action: LetterAction) async {
        guard busyActionId == nil else { return }
        busyActionId = action.id
        defer { busyActionId = nil }
        // The note field has the same input session hazard as the reply box: end
        // editing first so a composition or dictation is committed before it is read.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        try? await Task.sleep(for: .milliseconds(150))
        let note = decisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
        switch await inbox.answer(id: letterId, actionId: action.id, freeText: note.isEmpty ? nil : note) {
        case .success(let result):
            decisionNote = ""
            deliveryNote = nil
            replies.noteAnswerDelivery(result, letterId: letterId)
            adopt(result)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .failure(let error):
            // 409 = someone answered from another surface. The buttons must not
            // stay armed over a decision that is already made, so re-read instead.
            if let apiError = error as? APIError, apiError.isConflict {
                deliveryNote = "This letter was already answered somewhere else."
                await load()
                return
            }
            deliveryNote = error.localizedDescription
        }
    }

    /// Send what the field shows, then empty it for good.
    ///
    /// The order is the fix for the reply that stayed in the box after it was
    /// sent (see `LetterReplyField`): end the input session FIRST, so marked text
    /// (an IME composition, dictation still publishing) is committed as shown;
    /// read the committed words; hand them to the store, which empties the draft
    /// and shows them as a pending reply in the thread; then clear the view
    /// itself and guard it against the session writing them back.
    ///
    /// All of that happens in the tap's own run-loop turn unless dictation is
    /// running (only dictation can still change the words after Send), so the
    /// field never shows the sent words for a frame after the tap.
    private func sendTapped() {
        guard !committingSend, canSend else { return }
        if let shown = replyField.readNow(fallback: replies.draft(for: letterId)) {
            handOver(shown)
            return
        }
        committingSend = true
        Task { @MainActor in
            let shown = await replyField.commitAndRead(fallback: replies.draft(for: letterId))
            committingSend = false
            handOver(shown)
        }
    }

    private func handOver(_ shown: String) {
        let text = shown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        AppLog.info("inbox", "letter reply sent from the reader", [
            "letterId": letterId, "chars": "\(text.count)",
        ])
        replyField.clear(sent: text)
        // The keyboard stays up for a follow-up, as in the chat composer,
        // except after a committed composition (its input session must end, so
        // it leaves now, after the field is cleared) and at the accessibility
        // sizes, where the keyboard leaves too little room to show the reply and
        // what happened to it. There it leaves once the reply's line says what
        // happened, or after `keyboardOutcomeWait`, and the letter moves once,
        // with the keyboard, to the reply and that line. Leaving at once moved
        // it twice whenever the answer landed while the keyboard went (film,
        // 2026-09-29): down with the reply box, then up to the taller line.
        let leavesWithOutcome = dynamicTypeSize.isAccessibilitySize && !replyField.committedComposition
        if replyField.committedComposition { replyField.endEditing() }
        guard let clientId = replies.beginSend(
            letterId: letterId, text: text, afterTurns: letter?.threadEntries.count
        ) else {
            if leavesWithOutcome { replyField.endEditing() }
            return
        }
        if leavesWithOutcome {
            keyboardLeavesAfterSend = true
            Task { @MainActor in
                try? await Task.sleep(for: Self.keyboardOutcomeWait)
                keyboardLeavesWithTheOutcome()
            }
        }
        // Wherever the reader was, the reply they just sent comes into view.
        followTick += 1
        Task { @MainActor in
            if let result = await replies.deliver(letterId: letterId, clientId: clientId) {
                adopt(result)
                keyboardLeavesWithTheOutcome()
            } else {
                keyboardLeavesWithTheOutcome()
                await recheckIfUnconfirmed()
            }
        }
    }

    /// The longest the keyboard waits for a reply's answer after a Send at the
    /// accessibility sizes. Answers usually take a tenth of that; a slower one
    /// updates the line later, and the letter follows it then.
    static let keyboardOutcomeWait: Duration = .milliseconds(500)

    /// The keyboard held after a Send at the accessibility sizes leaves now,
    /// unless a follow-up is already being typed into the field.
    private func keyboardLeavesWithTheOutcome() {
        guard keyboardLeavesAfterSend else { return }
        keyboardLeavesAfterSend = false
        if !replyField.holdsWords { replyField.endEditing() }
    }

    /// Retry a refused reply. It is a new send (`LetterReplyStore.beginRetry`):
    /// it moves after everything on record, reading "Sending", and the letter
    /// follows it there as it does after a Send, so its line ends on screen. The
    /// move is animated: in one frame it left the finger's view (r4 gate, P1).
    private func retryPending(_ clientId: String) {
        let moved = withAnimation(.easeInOut(duration: LetterThreadView.moveDuration)) {
            replies.beginRetry(letterId: letterId, clientId: clientId, afterTurns: letter?.threadEntries.count)
        }
        guard moved else { return }
        // A reply that may already be on record kept its slot: the letter stays
        // where the finger is unless that slot is the newest.
        if newestReplyItem?.id == "reply-\(clientId)" { followTick += 1 }
        Task { @MainActor in
            if let result = await replies.deliver(letterId: letterId, clientId: clientId) {
                adopt(result)
            } else {
                await recheckIfUnconfirmed()
            }
        }
    }

    /// The answer to a reply was lost, so it may be on record: read the letter
    /// again, which shows it as recorded if the server has it, or gives Edit
    /// back if it does not.
    private func recheckIfUnconfirmed() async {
        guard replies.needsRecheck(letterId: letterId) else { return }
        AppLog.info("inbox", "letter reply unconfirmed, re-reading the letter", ["letterId": letterId])
        replies.beginRecheck(letterId: letterId)
        await load()
        replies.endRecheck(letterId: letterId)
    }

    /// A transcript lands after what is already in the field, editable before
    /// sending (the chat composer's rule), and the keyboard comes back for it.
    private func insertTranscript(_ text: String) {
        replyField.endEditing()
        replies.appendToDraft(text, for: letterId)
        replyFocused = true
    }

    /// Voice wiring, once per appearance. The recorder speaks for THIS letter's
    /// box: an automatic drain only recovers takes spoken here.
    private func attachVoice() {
        voice.surface = "letter:\(letterId)"
        voice.ownsOrphanTakes = false
        voice.onAutoStopText = { text in insertTranscript(text) }
        voice.onDrainedText = { text in insertTranscript(text) }
        voice.refreshPending()
        voice.drainPending(trigger: "letter-appear")
    }

    /// Adopt the server's letter, but never trade a body-inlined document for a
    /// payload that lost it (an older/relayed response), because the reader would
    /// blank the letter the human is reading. Keep what's on screen and re-read.
    private func adopt(_ result: LetterActionResult) {
        inbox.adopt(result)
        guard let updated = result.letter else {
            Task { await load() }
            return
        }
        replies.reconcile(letterId: letterId, with: updated)
        if updated.body != nil || letter?.body == nil {
            letter = updated
        } else {
            Task { await load() }
        }
    }
}

/// The reply box's send button: a round glyph that grows with the text size up
/// to 44pt, inside a 44pt target.
private struct LetterSendButton: View {
    let enabled: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var seat: CGFloat = 32

    var body: some View {
        let size = VoiceGlyphSeat(scaled: seat)
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: size.glyphSize * 1.1, weight: .semibold))
                .frame(width: size.diameter, height: size.diameter)
                // The colours change in the frame the field empties, never on
                // an animation: a Send that also moves the reply box (the
                // keyboard leaving) ran inside that move, and the arrow stayed
                // brown for 3 frames after the field was empty (r4 gate, P2-5).
                // Scoped to these two modifiers, so the button still slides
                // with the box.
                .animation(nil) { glyph in
                    glyph
                        .foregroundStyle(enabled ? Theme.onTint : Color(.tertiaryLabel))
                        .background(enabled ? Theme.tint : Color(.tertiarySystemFill), in: Circle())
                }
                .frame(width: size.target, height: size.target)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("inbox.letter.send")
    }
}
