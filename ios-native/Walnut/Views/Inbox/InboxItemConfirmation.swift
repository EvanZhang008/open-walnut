import SwiftUI

struct InboxItemPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 44)
            .foregroundStyle(enabled ? Theme.onTint : Color(.secondaryLabel))
            .background(enabled ? Theme.tint : Color(.tertiarySystemFill), in: Capsule())
            .opacity(enabled && configuration.isPressed ? 0.85 : 1)
    }
}

struct InboxItemConfirmation: View {
    let key: InboxItemStore.Key
    let item: InboxEmailItem
    let action: InboxItemAction
    var onOpenTask: (String, String?) -> Void
    private let store = InboxItemStore.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var openedTask: InboxTaskDestination?
    @FocusState private var goalFocused: Bool
    /// The work goal's recorder, held here so the footer can wait for a take:
    /// a plan reviewed or confirmed mid-take would go without the spoken words.
    @State private var goalVoice = VoiceRecorder()
    private let goalAnchor = "work-goal-editor"
    private var retry: Bool { store.draft(key).input.retryStart == true }
    private var needsRecovery: Bool { retry && store.latest(key, lane: "task")?.canReviewStartRecovery == true }
    private var title: String { retry ? "Retry start" : action.intent == "create_task" ? "Create and start task" : "Attach to task" }
    private func footer(_ state: InboxItemStore.State) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let plan = state.plan, !state.submittedPlans.contains(plan.id), !plan.isExpired() {
                let enabled = !state.busy.contains("task") && state.preparedInput == store.draft(key).input && !state.submittedPlans.contains(plan.id) && goalVoice.state == .idle
                Button(state.busy.contains("task") ? (action.intent == "create_task" && !retry ? "Creating…" : "Attaching…") : action.intent == "create_task" || retry ? "Confirm and start" : "Confirm attachment") {
                    confirm(plan)
                }.buttonStyle(InboxItemPrimaryButtonStyle()).frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(!enabled)
                    .accessibilityLabel("Confirm \(title) for \(item.subject)")
                    .accessibilityHint(plan.consequence)
                    .accessibilityIdentifier("inbox.item.confirm.execute")
            } else if state.plan.map({ state.submittedPlans.contains($0.id) }) == true {
                Text(store.latest(key, lane: "task")?.label ?? (retry ? "Starting…" : action.intent == "create_task" ? "Creating…" : "Attaching…")).font(.body)
                Button("Check status") { Task { await store.query(key) } }.frame(minHeight: 44)
            } else {
                if state.plan?.isExpired() == true { Text("This plan expired. Review the action again.").font(.caption).foregroundStyle(Theme.warning) }
                let enabled = !state.busy.contains("prepare") && canReview(state) && goalVoice.state == .idle
                Button("Review action") { Task { await prepare() } }
                    .buttonStyle(InboxItemPrimaryButtonStyle()).frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(!enabled)
                    .accessibilityIdentifier("inbox.item.confirm.prepare")
            }
            Button("Cancel") { dismiss() }.frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityHint("Closes this form. Work already submitted continues.")
                .accessibilityIdentifier("inbox.item.confirm.cancel")
        }.padding(12).background(.bar)
    }
    private func canReview(_ state: InboxItemStore.State) -> Bool {
        guard !field(\.goal).wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if let work = state.existingWork, work.status != "saved" && !retry { return false }
        if !retry, action.intent != "create_task", store.draft(key).selected?.canAttach != true { return false }
        return store.canBegin(key, action: action)
    }
    private func initialize() async {
        store.activateDraft(key, action: action)
        var draft = store.draft(key)
        if draft.input.title == nil { draft.input.title = item.subject }
        if draft.input.project == nil { draft.input.project = "" }
        store.setDraft(draft, key: key)
        // The first prepare is read-only: discovers existing source work and restrictions.
        let discovery = retry ? draft.input : InboxFrozenInput(selectedTaskId: draft.input.selectedTaskId)
        _ = await store.beginPrepare(key, action: action, input: discovery)
    }
    private func prepare() async {
        _ = await store.beginPrepare(key, action: action, input: store.draft(key).input)
    }
    private func confirm(_ plan: InboxItemPlan) {
        guard let request = store.beginExecute(key, plan: plan, input: store.draft(key).input) else { return }
        Task { await store.deliver(key, request: request, lane: InboxItemStore.lane(plan.intent)) }
        // Keep the sheet, work goal and input location stable while the receipt arrives.
    }
    private func field(_ path: WritableKeyPath<InboxFrozenInput, String?>) -> Binding<String> {
        Binding(get: { store.draft(key).input[keyPath: path] ?? "" }, set: { value in
            var draft = store.draft(key); draft.input[keyPath: path] = value; store.setDraft(draft, key: key)
        })
    }
    var body: some View {
        let state = store.state(key)
        NavigationStack {
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Source email").font(.body.weight(.semibold))
                            Text(item.subject).font(.body).textSelection(.enabled)
                            Text(item.senderLabel).font(.caption)
                            Text(item.dateLabel).font(.caption)
                            Text(item.accountLabel).font(.caption)
                            if let selected = action.intent == "create_task" ? state.plan?.task?.candidate : store.draft(key).selected ?? state.plan?.task?.candidate {
                                Text("Selected task").font(.body.weight(.semibold))
                                Text(InboxEmailItem.safe(selected.title)).font(.body)
                                Text("\(selected.projectLabel) · \(selected.phaseLabel)").font(.caption)
                            }
                            if action.intent == "create_task" && !retry && state.existingWork == nil {
                                Text("Task title").font(.caption)
                                TextField("Task title", text: field(\.title)).textFieldStyle(.roundedBorder)
                                    .accessibilityIdentifier("inbox.item.confirm.title")
                                Menu {
                                    Button("Inbox") { field(\.project).wrappedValue = "" }
                                    ForEach(state.projects.filter { !$0.name.isEmpty }, id: \.name) { project in
                                        Button(project.name) { field(\.project).wrappedValue = project.name }
                                    }
                                } label: {
                                    Text("Project: \(field(\.project).wrappedValue.isEmpty ? "Inbox" : field(\.project).wrappedValue)")
                                        .frame(minHeight: 44)
                                }
                            }
                            if let existing = state.existingWork {
                                if existing.status == "deleted" { Text("Target deleted").font(.body) }
                                if existing.status == "unavailable" { Text("Target unavailable").font(.body) }
                                if let description = existing.task?.description, !description.isEmpty {
                                    Text("Saved work goal: \(InboxEmailItem.safe(description, limit: 4000))").font(.body).textSelection(.enabled)
                                }
                                Text(existing.status == "saved" ? "Review and start existing task" : "Existing work").font(.body.weight(.semibold))
                                Text(existing.task?.title ?? "Task saved").font(.body)
                                if let goal = existing.goal { Text("Confirmed work goal: \(goal)").font(.body).textSelection(.enabled) }
                                Button("Open existing task") { openedTask = InboxTaskDestination(id: existing.taskId, title: existing.task?.title) }.frame(minHeight: 44)
                            }
                            Text("Work goal").font(.body.weight(.semibold))
                            if retry {
                                Text(field(\.goal).wrappedValue).font(.body).textSelection(.enabled)
                                    .accessibilityIdentifier("inbox.item.confirm.goal")
                            } else {
                                VoiceDictationField(
                                    text: field(\.goal), surface: "inbox-goal:\(key.letter):\(key.item)",
                                    box: "inbox-goal", placement: .below, recorder: goalVoice,
                                    refocus: { goalFocused = true }
                                ) {
                                    TextEditor(text: field(\.goal))
                                        .frame(height: min(160, max(0, viewport.size.height - 32)))
                                        .focused($goalFocused)
                                        .accessibilityLabel("Work goal for \(item.subject)")
                                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator)) }
                                        .accessibilityIdentifier("inbox.item.confirm.goal")
                                }
                                .id(goalAnchor)
                            }
                            if field(\.goal).wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text("Add a work goal before continuing.").font(.caption)
                            }
                            if needsRecovery { Text("The previous start is unconfirmed. Confirming cancels that pending start on its host before retrying this same task.").font(.body) }
                            if let plan = state.plan {
                                Text(plan.consequence).font(.body)
                                if retry, let launch = plan.launch {
                                    Text("Start on \(launch.host) using \(launch.engine), \(launch.model). Mode: \(launch.mode).")
                                        .font(.caption)
                                }
                                InboxItemOperationDetails(plan: plan)
                            }
                            if state.busy.contains("prepare") { ProgressView("Preparing action…") }
                            if let error = state.error, !state.restrictions.contains(where: { $0.code == "goal_required" && $0.message == error }) {
                                Text(error).font(.caption).foregroundStyle(Theme.warning)
                            }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    }.scrollDismissesKeyboard(.interactively)
                    .onChange(of: goalFocused) { _, focused in
                        if focused { proxy.scrollTo(goalAnchor, anchor: .bottom) }
                    }
                    // The recording row is taller than the mic it replaces (much
                    // taller at large text sizes): keep its Stop above the footer.
                    .onChange(of: goalVoice.state) { _, state in
                        if state == .recording { withAnimation { proxy.scrollTo(goalAnchor, anchor: .bottom) } }
                    }
                    .task(id: viewport.size.height) {
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        if goalFocused { proxy.scrollTo(goalAnchor, anchor: .bottom) }
                    }
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .barPage(Color(uiColor: .systemBackground))
            .toolbarColorScheme(colorScheme, for: .navigationBar)
            .safeAreaInset(edge: .bottom) { footer(state) }
            .task { await initialize() }
            .task(id: state.plan?.id) {
                guard let plan = state.plan, let expires = InboxItemDate.parse(plan.expiresAt) else { return }
                do { try await Task.sleep(for: .seconds(max(0, expires.timeIntervalSinceNow))) } catch { return }
                store.expirePlan(key, planId: plan.id)
            }
            .sheet(item: $openedTask) { destination in
                InboxItemReadOnlyTaskSheet(key: key, destination: destination).presentationDetents([.large])
            }
        }
    }
}
