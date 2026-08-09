import SwiftUI

// MARK: - Queued messages (Wave 2 /v1/sessions/:id/queue)

/// Messages you sent that haven't reached the CLI yet — view and withdraw.
/// Pending rows can be deleted; a processing row is already being delivered.
struct SessionQueueSheet: View {
    let sessionId: String

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var messages: [SessionQueuedMessage] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busyIds = Set<String>()

    var body: some View {
        NavigationStack {
            List {
                if let actionError {
                    Section {
                        Label(actionError, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
                if !loaded {
                    Section {
                        HStack { ProgressView(); Text("Loading queue…").foregroundStyle(.secondary) }
                    }
                } else if let loadError {
                    Section {
                        retryBlock(loadError) { Task { await load() } }
                    }
                } else if messages.isEmpty {
                    Section {
                        Text("No queued messages — everything you sent has been delivered.")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 24)
                    }
                } else {
                    Section {
                        ForEach(messages) { message in
                            queueRow(message)
                        }
                    } footer: {
                        Text("Pending messages deliver when the session finishes its current turn. Swipe to withdraw one before it's delivered.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Queued Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .accessibilityIdentifier("session.queue.list")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func queueRow(_ message: SessionQueuedMessage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(message.message)
                .font(.subheadline)
                .lineLimit(4)
            HStack(spacing: 6) {
                Text(message.isPending ? "Pending" : "Delivering…")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(message.isPending ? Theme.warning : Theme.success)
                if let when = message.enqueuedDate {
                    Text(when.formatted(.relative(presentation: .named)))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if busyIds.contains(message.id) { ProgressView().controlSize(.small) }
            }
        }
        .accessibilityIdentifier("session.queue.row.\(message.id)")
        .swipeActions(edge: .trailing) {
            if message.isPending {
                Button(role: .destructive) {
                    Task { await remove(message) }
                } label: {
                    Label("Withdraw", systemImage: "trash")
                }
            }
        }
    }

    private func load() async {
        do {
            messages = try await api.sessionQueue(id: sessionId)
            loadError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            loadError = SessionControlsSheet.friendlyControlError(error)
        }
        loaded = true
    }

    /// Optimistic removal + rollback. A 409 means it already started
    /// delivering — refresh instead of restoring (server truth).
    private func remove(_ message: SessionQueuedMessage) async {
        guard !busyIds.contains(message.id) else { return }
        busyIds.insert(message.id)
        actionError = nil
        let original = messages
        messages.removeAll { $0.id == message.id }
        defer { busyIds.remove(message.id) }
        do {
            try await api.deleteQueuedMessage(sessionId: sessionId, messageId: message.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("session", "queued message withdrawn", [
                "sessionId": sessionId, "messageId": message.id,
            ])
        } catch let error as APIError where error.isConflict {
            actionError = "That message already started delivering."
            await load()
        } catch {
            messages = original
            actionError = SessionControlsSheet.friendlyControlError(error)
        }
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
                    MarkdownView(blocks: MarkdownParser.parse(plan.content))
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
                        Text("No side questions yet. Ask one above — the session answers without derailing its main work.")
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
            .navigationTitle("Side Questions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.disabled(asking) }
            }
            .accessibilityIdentifier("session.sideQuestions")
            .task { await load() }
            .interactiveDismissDisabled(asking)
        }
    }

    private var askSection: some View {
        Section {
            TextField("Ask without interrupting the work…", text: $draft, axis: .vertical)
                .lineLimit(2...4)
                .disabled(asking)
                .accessibilityIdentifier("session.sideQuestion.field")
            Button {
                Task { await ask() }
            } label: {
                HStack {
                    if asking {
                        ProgressView().controlSize(.small)
                        Text("Waiting for the answer… this can take a minute.")
                            .font(.subheadline)
                    } else {
                        Label("Ask", systemImage: "questionmark.bubble")
                    }
                }
            }
            .disabled(asking || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                    Text(when.formatted(.relative(presentation: .named)))
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
            askError = "The session isn't reachable right now — it may be asleep. Wake it and try again."
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
