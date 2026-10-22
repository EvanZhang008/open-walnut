import SwiftUI

struct EmailItemCard: View {
    let letterId: String
    let item: InboxEmailItem
    var duplicateAccount = false
    var onOpenTask: (String, String?) -> Void = { _, _ in }
    private let store = InboxItemStore.shared
    private var key: InboxItemStore.Key { .init(letter: letterId, item: item.id) }
    @State private var expanded = false
    @State private var sourceDetails = false
    @State private var outcomeDetails = false
    @State private var copied = false
    @State private var quickBusy: Set<String> = []
    @State private var readAgainAction: InboxItemAction?
    @State private var selectorAction: InboxItemAction?
    @State private var pendingConfirmationAction: InboxItemAction?
    @State private var confirmationAction: InboxItemAction?
    @ScaledMetric(relativeTo: .caption) private var statusHeight: CGFloat = 22
    @ScaledMetric(relativeTo: .caption) private var targetHeight: CGFloat = 44
    var body: some View {
        let state = store.state(key)
        VStack(alignment: .leading, spacing: 8) {
            Text(item.subject).font(.body.weight(.semibold)).textSelection(.enabled)
                .accessibilityIdentifier("inbox.item.\(item.id).subject")
            Text(item.summary).font(.body).lineLimit(expanded ? nil : 2).textSelection(.enabled)
            Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                .font(.caption).frame(minHeight: 44).accessibilityValue(expanded ? "Expanded" : "Collapsed")
            sourceIdentity
            DisclosureGroup("Source details", isExpanded: $sourceDetails) {
                Text(item.source?.copyText ?? "Email unavailable").font(.caption).textSelection(.enabled)
                Text(InboxEmailItem.safe(item.display?.sentAt ?? "Date unavailable")).font(.caption)
                Button(copied ? "Copied" : "Copy source") {
                    UIPasteboard.general.string = item.source?.copyText; copied = true
                }.frame(minHeight: 44).disabled(item.source == nil)
            }.font(.caption)
            if let reason = item.unavailableReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
            if store.isMirror(key) { Text("Last saved status. Connect to the primary Walnut to act.").font(.caption) }
            if !state.supported { Text(state.error ?? "Email actions need a newer server").font(.caption) }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(item.visibleActions) { action in actionButton(action, state: state) }
            }
            outcomes(state)
            let restriction = store.markReadRestriction(key)
            Text(restriction ?? " ").font(.caption).lineLimit(2)
                .frame(height: statusHeight * 2, alignment: .topLeading).accessibilityHidden(restriction == nil)
            Text(restriction == "Available on Mac only" ? "Marking email read is only available from the console on this Mac." : " ")
                .font(.caption).lineLimit(2).frame(height: statusHeight * 2, alignment: .topLeading)
                .accessibilityHidden(restriction != "Available on Mac only")
            Text(state.stale ? "Status unavailable. Check again." : state.pollingExhausted ? "Still working. Check status." : " ").font(.caption)
                .frame(height: statusHeight).accessibilityHidden(!state.stale && !state.pollingExhausted)
            Button("Check status") { Task { await store.query(key) } }.frame(minHeight: 44)
                .opacity(state.stale || state.pollingExhausted ? 1 : 0)
                .disabled(!state.stale && !state.pollingExhausted).accessibilityHidden(!state.stale && !state.pollingExhausted)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator), lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.item.\(item.id)")
        .modifier(InboxItemExecutionWatch(key: key))
        .onChange(of: state.receipts) { old, new in
            if let receipt = new.last(where: { changed in !old.contains(where: { $0.requestId == changed.requestId && $0.revision == changed.revision }) }) {
                UIAccessibility.post(notification: .announcement, argument: "\(item.subject): \(receipt.label)")
            }
        }
        .sheet(item: $selectorAction, onDismiss: {
            if let action = pendingConfirmationAction {
                pendingConfirmationAction = nil; confirmationAction = action
            }
        }) { action in
            InboxItemTaskSelector(key: key, item: item, actionId: action.id, onOpenTask: onOpenTask) { selected in
                var draft = store.draft(key); draft.selected = selected; draft.input.selectedTaskId = selected.id
                store.setDraft(draft, key: key); pendingConfirmationAction = action; selectorAction = nil
            }.presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(item: $confirmationAction) { action in
            InboxItemConfirmation(key: key, item: item, action: action, onOpenTask: onOpenTask)
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .confirmationDialog("Mark read again", isPresented: Binding(get: { readAgainAction != nil }, set: { if !$0 { readAgainAction = nil } })) {
            if let action = readAgainAction {
                Button("Confirm mark read again") { quickAction(action, again: true); readAgainAction = nil }
            }
            Button("Cancel", role: .cancel) { readAgainAction = nil }
        } message: {
            Text("\(item.subject)\n\(item.source?.copyText ?? "")\nSet this email to read again. The previous receipt is kept.")
        }
    }
    private func actionButton(_ action: InboxItemAction, state: InboxItemStore.State) -> some View {
        let lane = InboxItemStore.executionLane(action)
        let busy = state.busy.contains(lane) || quickBusy.contains(lane)
        let receipt = store.latest(key, action: action)
        let confirmed = receipt?.status == "success"
        let taskBound = lane == "task" && receipt?.hasCreatedTask == true
        let locked = taskBound || (confirmed && (lane != "read" || state.readObservation?.read == true))
        let readAgain = lane == "read" && confirmed && state.readObservation?.read != true
        return Button {
            if lane == "task" { store.activateDraft(key, action: action) }
            if lane == "task", action.intent != "create_task" { pendingConfirmationAction = nil; selectorAction = action }
            else if lane == "task" { confirmationAction = action }
            else if readAgain { readAgainAction = action }
            else { quickAction(action) }
        } label: {
            Text(busy ? (lane == "read" ? "Marking read…" : "Submitting…") : locked ? (lane == "read" ? "Marked read" : taskBound ? "Task linked" : receipt?.label ?? "Delivery unavailable") : readAgain ? "Mark read again" : action.buttonLabel)
                .font(.body).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .tint(Theme.tint)
        .disabled(!store.canBegin(key, action: action) || locked || quickBusy.contains(lane))
        .accessibilityLabel("\(action.buttonLabel) for \(item.subject)")
        .accessibilityHint(lane == "read" ? "Mark only this email as read. It stays in the mailbox." : action.kind == "reply_ai" ? "No email or task operation runs." : "Review the exact task and work goal before confirming.")
        .accessibilityIdentifier("inbox.item.\(item.id).\(action.intent ?? action.kind)")
    }
    private func quickAction(_ action: InboxItemAction, again: Bool = false) {
        let lane = InboxItemStore.executionLane(action)
        guard !quickBusy.contains(lane), store.canBegin(key, action: action) else { return }
        quickBusy.insert(lane)
        Task {
            defer { quickBusy.remove(lane) }
            let input = InboxFrozenInput(markReadAgain: again ? true : nil)
            guard let plan = await store.beginPrepare(key, action: action, input: input),
                  let request = store.beginExecute(key, plan: plan, input: input) else { return }
            await store.deliver(key, request: request, lane: InboxItemStore.executionLane(intent: plan.intent, actionId: plan.actionId))
        }
    }
    @ViewBuilder private func outcomes(_ state: InboxItemStore.State) -> some View {
        // A fixed seat for each status and target prevents asynchronous receipt growth
        // from moving a lower item's buttons. Full text is an explicit disclosure.
        VStack(alignment: .leading, spacing: 4) {
            statusSeat(state.unknown.contains("read") ? "Read status unconfirmed" : store.latest(key, lane: "read")?.label ?? "No read action recorded")
            statusSeat(state.readObservation.map { "Last observed: \($0.read ? "Already read" : "Unread") · \($0.observedAt)" } ?? "Current read status unavailable")
            statusSeat(state.busy.contains("task") ? "Submitting…" : store.latest(key, lane: "task")?.label ?? "No task action recorded")
            statusSeat(currentTaskLabel(state))
            if item.visibleActions.contains(where: { $0.kind == "reply_ai" }) {
                ForEach(item.visibleActions.filter { $0.kind == "reply_ai" }) { action in
                    statusSeat("\(action.buttonLabel): \(state.busy.contains(InboxItemStore.executionLane(action)) ? "Submitting…" : store.latest(key, action: action)?.label ?? "No AI question recorded")")
                }
            } else { statusSeat("No AI question recorded") }
            if let receipt = store.latest(key, lane: "task"), receipt.hasCreatedTask, let taskId = receipt.taskId {
                Button { onOpenTask(taskId, state.existingWork?.task?.title) } label: {
                    Text(state.existingWork?.task?.title ?? "Open task").font(.caption).lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: targetHeight, maxHeight: targetHeight, alignment: .leading)
                }.accessibilityIdentifier("inbox.item.\(item.id).taskLink")
            } else { Color.clear.frame(height: targetHeight).accessibilityHidden(true) }
        }
        DisclosureGroup("Show details", isExpanded: $outcomeDetails) {
            if let error = state.error { Text(error).font(.caption).foregroundStyle(Theme.warning) }
            ForEach(state.receipts, id: \.requestId) { receipt in
                Text(receipt.label).font(.caption)
                if let task = state.currentTask {
                    Text("Current task status: \(task.label) · \(state.currentTaskStale || state.stale ? "Last observed" : "Checked") \(task.observedAt)").font(.caption)
                }
                if let reason = receipt.reason { Text(InboxEmailItem.safe(reason)).font(.caption) }
                if receipt == store.latest(key, lane: "task"), receipt.recovery.contains("retry_start") || receipt.recovery.contains("retry_create"), InboxItemStore.recoveryAction(receipt, item: item) != nil {
                    Button(receipt.recovery.contains("retry_create") ? "Retry create" : "Retry start") {
                        confirmationAction = store.recoveryDraft(key, receipt: receipt, item: item)
                    }.frame(minHeight: 44).disabled(receipt.needsQuery && !receipt.canReviewStartRecovery || state.busy.contains("task"))
                }
                if receipt.needsQuery { Button("Check status") { Task { await store.query(key) } }.frame(minHeight: 44) }
                if receipt == store.latest(key, lane: "read"), receipt.intent == "mark_read", receipt.recovery.contains("retry_mark_read"), let action = item.actions.first(where: { $0.intent == "mark_read" }) {
                    Button("Retry mark read") { quickAction(action) }.frame(minHeight: 44).disabled(store.markReadRestriction(key) != nil)
                }
            }
        }.font(.caption)
    }
    private func currentTaskLabel(_ state: InboxItemStore.State) -> String {
        guard let current = state.currentTask, !state.stale, !state.currentTaskStale, !store.isMirror(key) else {
            return "Current task status unavailable"
        }
        return "Current task status: \(current.label) · Checked \(current.observedAt)"
    }
    private func statusSeat(_ text: String) -> some View {
        Text(text).font(.caption).lineLimit(2).frame(maxWidth: .infinity, minHeight: statusHeight * 2, maxHeight: statusHeight * 2, alignment: .leading)
            .accessibilityLabel("\(item.subject): \(text)")
    }
    private var sourceIdentity: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(item.senderLabel)
            Text(item.dateLabel)
            Text("Mail · \(item.accountLabel)")
            if duplicateAccount { Text("Technical account: \(InboxEmailItem.safe(item.source?.account ?? ""))") }
        }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }
}
