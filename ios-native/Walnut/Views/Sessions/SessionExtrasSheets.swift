import SwiftUI

// MARK: - Queued messages (Wave 2 /v1/sessions/:id/queue)

/// Messages you sent that haven't reached the CLI yet: the full list behind the strip
/// above the composer. Tap one to edit it, send it now or withdraw it; swipe to withdraw.
/// A message being delivered can be neither changed nor withdrawn.
struct SessionQueueSheet: View {
    let queue: SessionQueueModel
    /// A turn runs: the rows wait for its end.
    let turnRunning: Bool
    /// Put a message the person just withdrew back where it was.
    let onUndo: (WithdrawnQueuedMessage) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var managing: QueueRowRef?

    var body: some View {
        NavigationStack {
            List {
                if let notice = queue.notice {
                    Section {
                        Label(notice, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
                if !queue.loaded {
                    Section {
                        HStack { ProgressView(); Text("Loading queue…").foregroundStyle(.secondary) }
                    }
                } else if queue.rows.isEmpty {
                    Section {
                        Text("Nothing is waiting in line.")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 24)
                    }
                } else {
                    Section {
                        ForEach(queue.rows) { message in
                            queueRow(message)
                        }
                    } footer: {
                        if queue.rows.contains(where: { $0.status == "parked" }) {
                            Text("Messages marked Not sent were held back when you stopped the agent. Tap one to send it; withdraw with the cross or a swipe.")
                        } else {
                            Text(turnRunning
                                 ? "Waiting messages go in as soon as the session can take them. Tap one to edit it or send it now; withdraw with the cross or a swipe."
                                 : "Pending messages are about to go out. Tap one to edit it or send it now; withdraw with the cross or a swipe.")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .presentationBackground(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .bottom) {
                if let gone = queue.withdrawn {
                    QueueUndoLine(queue: queue, gone: gone, onUndo: onUndo, identifier: "session.queue.list.undo")
                        .padding(.vertical, 4)
                        .background(.bar)
                }
            }
            .navigationTitle("Queued Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .accessibilityIdentifier("session.queue.list")
            .refreshable { await queue.refresh() }
            .task { await queue.refresh() }
            .sheet(item: $managing) { ref in
                SessionQueuedMessageSheet(queue: queue, rowID: ref.id, turnRunning: turnRunning)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func queueRow(_ message: SessionQueuedMessage) -> some View {
        HStack(spacing: 4) {
            openButton(message)
            if message.canWithdraw, !queue.busyIds.contains(message.id) {
                Button {
                    guard queue.takeRowTap() else { return }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await queue.withdraw(message) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Withdraw")
                .accessibilityIdentifier("session.queue.list.withdraw.\(message.id)")
            }
        }
        .swipeActions(edge: .trailing) {
            if message.canWithdraw {
                Button(role: .destructive) {
                    Task { await queue.withdraw(message) }
                } label: {
                    Label("Withdraw", systemImage: "trash")
                }
                .tint(Theme.danger)
            }
        }
    }

    @ViewBuilder
    private func openButton(_ message: SessionQueuedMessage) -> some View {
        Button {
            managing = QueueRowRef(id: message.id)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                QueuedRowThumbnails(paths: message.shownImagePaths)
                Text(message.shownText)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(message.statusNote ?? "Queued")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(message.status == "processing" || message.queueStage == .written ? Theme.doneText
                                         : message.statusNote == nil ? Color.secondary : Theme.needsText)
                    if let when = message.enqueuedDate {
                        // Re-read every half minute, so "2 minutes ago" does not stand still.
                        TimelineView(.periodic(from: .now, by: 30)) { _ in
                            Text(AppClock.relativeNamed(when))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if queue.busyIds.contains(message.id) { ProgressView().controlSize(.small) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.queue.row.\(message.id)")
    }
}

// MARK: - Plan viewer (Wave 2 /v1/sessions/:id/plan)

/// Rendered plan markdown for a plan session (or the plan its exec session
/// came from). 404 = the session has no plan → friendly empty state.
struct SessionPlanSheet: View {
    let sessionId: String

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var plan: SessionPlanPayload?
    @State private var loaded = false
    @State private var emptyText: String?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if !loaded {
                    HStack { ProgressView(); Text("Loading plan…").foregroundStyle(.secondary) }
                        .padding(.top, 40)
                } else if let plan {
                    MarkdownView(blocks: MarkdownParser.parse(plan.content), lazy: true)
                        .padding(16)
                } else if let emptyText {
                    ContentUnavailableView {
                        Label("No plan", systemImage: "list.bullet.clipboard")
                    } description: {
                        Text(emptyText)
                    }
                    .padding(.top, 40)
                } else if let loadError {
                    retryBlock(loadError) { Task { await load() } }
                        .padding(.top, 40)
                }
            }
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .accessibilityIdentifier("session.plan")
            .task { await load() }
        }
    }

    private func load() async {
        do {
            plan = try await api.sessionPlan(id: sessionId)
        } catch let error as APIError where error.isCancelled {
            return
        } catch let error as APIError where error.code == "not_found" {
            emptyText = "This session hasn't produced a plan."
        } catch {
            loadError = SessionControlsSheet.friendlyControlError(error)
        }
        loaded = true
    }
}

// MARK: - Side questions (Wave 2 /v1/sessions/:id/side-questions)

/// Ask the live CLI something WITHOUT injecting into its main conversation,
/// plus the Q&A history. The ask is synchronous (tens of seconds) — the
/// composer shows a working state until the answer lands.
struct SideQuestionsSheet: View {
    let sessionId: String

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var questions: [SideQuestion] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var draft = ""
    @State private var asking = false
    @State private var askError: String?
    /// The question box's recorder, held here so the sheet can wait for a take
    /// still being transcribed: closed under it, the words had no box to land
    /// in and were never offered back (v6 gate).
    @State private var draftVoice = VoiceRecorder()
    /// Ask waits for words still being spoken or transcribed (`DictationSendGate`).
    @State private var sendGate = DictationSendGate()

    /// Asking, or a take's words still on their way into the box.
    private var holdsOpen: Bool { asking || draftVoice.state == .transcribing || sendGate.isWaiting }

    var body: some View {
        NavigationStack {
            List {
                askSection
                if !loaded {
                    Section {
                        HStack { ProgressView(); Text("Loading history…").foregroundStyle(.secondary) }
                    }
                } else if let loadError {
                    Section { retryBlock(loadError) { Task { await load() } } }
                } else if questions.isEmpty {
                    Section {
                        Text("No side questions yet. Ask one above: the session answers without derailing its main work.")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    }
                } else {
                    // Newest first — the answer you just got sits on top.
                    Section("History") {
                        ForEach(questions.reversed()) { question in
                            questionRow(question)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .dictationSendGate(sendGate)
            .navigationTitle("Side Questions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.disabled(holdsOpen) }
            }
            .accessibilityIdentifier("session.sideQuestions")
            .task { await load() }
            // A question he is writing is not kept anywhere else: a push waits for it too.
            .holdsNavigation(holdsOpen || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var askSection: some View {
        Section {
            VoiceDictationField(
                text: $draft, surface: "side-question:\(sessionId)", box: "side-question", blocked: asking,
                recorder: draftVoice
            ) {
                TextField("Ask without interrupting the work…", text: $draft, axis: .vertical)
                    .lineLimit(2...4)
                    .disabled(asking)
                    .accessibilityIdentifier("session.sideQuestion.field")
            }
            Button {
                sendGate.send { _ in Task { await ask() } }
            } label: {
                HStack {
                    if asking {
                        ProgressView().controlSize(.small)
                        Text("Waiting for the answer… this can take a minute.")
                            .font(.subheadline)
                    } else {
                        DictationSendLabel(gate: sendGate, title: "Ask", systemImage: "questionmark.bubble")
                    }
                }
            }
            .disabled(asking || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sendGate.isDictating && !sendGate.isWaiting))
            .accessibilityIdentifier("session.sideQuestion.ask")
            if let askError {
                Label(askError, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Theme.danger)
            }
        } footer: {
            Text("Side questions go to the live session but never enter its main conversation.")
        }
    }

    private func questionRow(_ question: SideQuestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question.question)
                .font(.subheadline.weight(.semibold))
            Text(question.answer)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(12)
            HStack(spacing: 6) {
                if let when = question.createdDate {
                    Text(AppClock.relativeNamed(when))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if question.promotedTaskId != nil {
                    Label("Task created", systemImage: "checkmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.success)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        do {
            questions = try await api.sessionSideQuestions(id: sessionId)
            loadError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            loadError = SessionControlsSheet.friendlyControlError(error)
        }
        loaded = true
    }

    private func ask() async {
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !asking else { return }
        asking = true
        askError = nil
        defer { asking = false }
        do {
            let answered = try await api.askSideQuestion(sessionId: sessionId, question: question)
            questions.append(answered)
            draft = ""
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("session", "side question answered", [
                "sessionId": sessionId, "questionId": answered.id,
            ])
        } catch let error as APIError where error.code == "bad_gateway" || (error.code == "http_error") {
            askError = "The session isn't reachable right now. It may be asleep. Wake it and try again."
        } catch {
            askError = SessionControlsSheet.friendlyControlError(error)
        }
    }
}

// MARK: - Shared bits

/// Error text + Retry button used by all three sheets.
@ViewBuilder
fileprivate func retryBlock(_ message: String, retry: @escaping () -> Void) -> some View {
    VStack(spacing: 8) {
        Text(message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        Button("Retry", action: retry)
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
}
