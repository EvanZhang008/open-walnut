import Foundation
import Observation

/// Independent item receipts and drafts. Whole-letter read/decision state stays in InboxStore.
@Observable @MainActor
final class InboxItemStore: LifecycleSuspendable {
    static let shared = InboxItemStore()
    struct Key: Hashable { let letter: String; let item: String }
    struct Draft: Equatable {
        var input = InboxFrozenInput()
        var query = ""
        var selected: InboxTaskCandidate?
        var listAnchor: String?
    }
    struct State {
        var source: InboxMailSource?
        var receipts: [InboxItemReceipt] = []
        var currentTask: InboxCurrentTaskStatus?
        var readObservation: InboxReadObservation?
        var restrictions: [InboxActionRestriction] = []
        var readLocalOnly = false
        var projects: [InboxItemPrepareResponse.Project] = []
        var existingWork: InboxExistingWork?
        var plan: InboxItemPlan?
        var preparedInput: InboxFrozenInput?
        var preparedPlans: [String: InboxItemPlan] = [:]
        var planInputs: [String: InboxFrozenInput] = [:]
        var busy: Set<String> = []
        var unknown: Set<String> = []
        var unknownRequests: [String: String] = [:]
        var submittedPlans: Set<String> = []
        var error: String?
        var stale = false
        var currentTaskStale = false
        var pollingExhausted = false
        var supported = true
    }
    private let api: InboxItemTransport
    private var active = true
    private var visible: Set<Key> = []
    private var mirrorLetters: Set<String> = []
    private var states: [Key: State] = [:]
    private var drafts: [Key: Draft] = [:]
    private var actionDrafts: [Key: [String: Draft]] = [:]
    private var draftActions: [Key: String] = [:]
    @ObservationIgnored private var preparing: [Key: Int] = [:]
    @ObservationIgnored private var queryJobs: [Key: Task<Void, Never>] = [:]
    @ObservationIgnored private var inFlightQueries: [Key: Task<Void, Never>] = [:]
    @ObservationIgnored private var queryGeneration = 0
    @ObservationIgnored private var resetGeneration = 0
    static let pendingQueryDelays = [1, 2, 5, 10, 12]
    init(transport: InboxItemTransport? = nil) {
        api = transport ?? WalnutAPI()
        LifecycleHub.shared.register(self)
    }
    func state(_ key: Key) -> State { states[key] ?? State() }
    func draft(_ key: Key) -> Draft { drafts[key] ?? Draft() }
    func activateDraft(_ key: Key, action: InboxItemAction) {
        guard !state(key).busy.contains("task"), draftActions[key] != action.id else { return }
        if let current = draftActions[key] { actionDrafts[key, default: [:]][current] = draft(key) }
        var next = actionDrafts[key]?[action.id] ?? Draft()
        if action.intent == "create_task" { next.selected = nil; next.input.selectedTaskId = nil }
        draftActions[key] = action.id
        setDraft(next, key: key)
        preparing[key, default: 0] += 1
        var s = state(key); s.plan = nil; s.preparedInput = nil; s.existingWork = nil; s.error = nil
        s.busy.remove("prepare")
        s.preparedPlans = s.preparedPlans.filter { Self.lane($0.value.intent) != "task" }
        s.planInputs = s.planInputs.filter { s.preparedPlans[$0.key] != nil }
        states[key] = s
    }
    func setTaskQuery(_ value: String, key: Key, actionId: String) {
        guard draftActions[key] == actionId, draft(key).query != value else { return }
        var next = draft(key); next.query = value
        next.selected = nil; next.input.selectedTaskId = nil; next.listAnchor = nil
        setDraft(next, key: key)
    }
    func setDraft(_ draft: Draft, key: Key) {
        guard !state(key).busy.contains("task") else { return }
        if drafts[key]?.input != draft.input {
            preparing[key, default: 0] += 1
            var s = state(key); s.plan = nil; s.preparedInput = nil
            if s.restrictions.contains(where: { $0.code == "goal_required" && $0.message == s.error }) {
                s.error = nil; s.restrictions.removeAll { $0.code == "goal_required" }
            }
            s.preparedPlans = s.preparedPlans.filter { Self.lane($0.value.intent) != "task" }
            s.planInputs = s.planInputs.filter { s.preparedPlans[$0.key] != nil }
            s.busy.remove("prepare"); states[key] = s
        }
        drafts[key] = draft
        if let action = draftActions[key] { actionDrafts[key, default: [:]][action] = draft }
    }
    static func recoveryAction(_ receipt: InboxItemReceipt, item: InboxEmailItem) -> InboxItemAction? {
        let intents = receipt.intent == "create_task" ? ["create_task"] : receipt.intent == "attach_task" ? ["attach_task", "find_task"] : []
        if let exact = item.visibleActions.first(where: { $0.id == receipt.actionId && $0.kind == "op" && intents.contains($0.intent ?? "") }) { return exact }
        for intent in intents {
            if let action = item.visibleActions.first(where: { $0.kind == "op" && $0.intent == intent }) { return action }
        }
        return nil
    }
    func recoveryDraft(_ key: Key, receipt: InboxItemReceipt, item: InboxEmailItem) -> InboxItemAction? {
        guard let action = Self.recoveryAction(receipt, item: item) else { return nil }
        activateDraft(key, action: action)
        var next = draft(key); next.input = receipt.input
        next.input.retryStart = receipt.recovery.contains("retry_start") ? true : nil
        if action.intent == "create_task" { next.selected = nil }
        setDraft(next, key: key)
        return action
    }
    func eraseAll() {
        resetGeneration += 1; queryGeneration += 1
        queryJobs.values.forEach { $0.cancel() }; queryJobs = [:]
        inFlightQueries.values.forEach { $0.cancel() }; inFlightQueries = [:]
        states = [:]; drafts = [:]; actionDrafts = [:]; draftActions = [:]; preparing = [:]
        visible = []; mirrorLetters = []
    }
    func seedLetter(_ letter: Letter) {
        let all = (letter.items ?? []) + letter.threadEntries.flatMap { $0.items ?? [] }
        seed(all, letterId: letter.id)
        let repeatedItems = Set(Dictionary(grouping: all, by: \.id).filter { $0.value.count > 1 }.keys)
        let actionIds = all.flatMap { $0.actions.map(\.id) }
        let repeatedActions = Set(Dictionary(grouping: actionIds, by: { $0 }).filter { $0.value.count > 1 }.keys)
        for item in all where repeatedItems.contains(item.id) || item.actions.contains(where: { repeatedActions.contains($0.id) }) {
            let key = Key(letter: letter.id, item: item.id)
            var s = state(key); s.supported = false; s.error = "Duplicate email item or action ID"; states[key] = s
        }
    }
    func seed(_ items: [InboxEmailItem], letterId: String) {
        for item in items {
            let key = Key(letter: letterId, item: item.id)
            var s = state(key)
            if s.source == nil { s.source = item.source }
            if s.source != item.source { s.supported = false; s.error = "Email source changed" }
            if let observation = item.readObservation,
               Self.isNewer(observation.observedAt, than: s.readObservation?.observedAt) { s.readObservation = observation }
            if item.unavailableReason != nil { s.supported = false; s.error = item.unavailableReason }
            s.receipts = Self.mergeReceipts(s.receipts, item.receipts, source: s.source)
            states[key] = s
        }
    }
    func setAccess(letterId: String, response: LetterResponse?) {
        if response?.servedFrom == "mirror" { mirrorLetters.insert(letterId) }
        else { mirrorLetters.remove(letterId) }
        for key in Array(states.keys) where key.letter == letterId {
            var s = state(key)
            if response?.capabilities?.itemActions == false { s.supported = false }
            if let capability = response?.capabilities?.markRead { s.readLocalOnly = capability == "local_only" }
            states[key] = s
        }
    }
    func isMirror(_ key: Key) -> Bool { mirrorLetters.contains(key.letter) }
    func markReadRestriction(_ key: Key) -> String? {
        if isMirror(key) { return "Last saved status. Connect to the primary Walnut to act." }
        if state(key).readLocalOnly { return "Available on Mac only" }
        return nil
    }
    func latest(_ key: Key, lane: String) -> InboxItemReceipt? {
        state(key).receipts.last { Self.lane($0.intent) == lane }
    }
    func latest(_ key: Key, action: InboxItemAction) -> InboxItemReceipt? {
        action.kind == "reply_ai" ? state(key).receipts.last { $0.intent == "reply_ai" && $0.actionId == action.id }
            : latest(key, lane: Self.lane(action.intent))
    }
    static func lane(_ intent: String?) -> String { intent == "mark_read" ? "read" : intent == "reply_ai" ? "ai" : "task" }
    static func executionLane(intent: String?, actionId: String) -> String { intent == "reply_ai" ? "ai:\(actionId)" : lane(intent) }
    static func executionLane(_ action: InboxItemAction) -> String { executionLane(intent: action.intent ?? action.kind, actionId: action.id) }
    func canBegin(_ key: Key, action: InboxItemAction) -> Bool {
        let s = state(key); let lane = Self.executionLane(action)
        guard active, s.supported, s.source?.isValid == true, action.isSupported, !isMirror(key), !s.busy.contains(lane), !s.unknown.contains(lane) else { return false }
        if lane == "read", markReadRestriction(key) != nil || s.readObservation?.read == true { return false }
        if let r = latest(key, action: action), r.needsQuery && !r.canRetryRead && !(r.canReviewStartRecovery && draft(key).input.retryStart == true) || action.kind == "reply_ai" && r.status == "success" { return false }
        return true
    }
    func beginPrepare(_ key: Key, action: InboxItemAction, input: InboxFrozenInput) async -> InboxItemPlan? {
        guard canBegin(key, action: action) else { return nil }
        let lane = Self.executionLane(action)
        if lane == "task" { preparing[key, default: 0] += 1 }
        let generation = preparing[key, default: 0]; let reset = resetGeneration
        var s = state(key); s.error = nil
        if lane == "task" { s.plan = nil; s.busy.insert("prepare") }
        states[key] = s
        do {
            let result = try await api.prepareInboxItem(letterId: key.letter, itemId: key.item,
                request: InboxItemPrepareRequest(actionId: action.id, input: input))
            guard reset == resetGeneration, lane != "task" || preparing[key] == generation else { return nil }
            s = state(key); s.busy.remove("prepare")
            guard s.source == result.source else { s.error = "Email source changed"; states[key] = s; return nil }
            s.receipts = Self.mergeReceipts(s.receipts, result.receipts, source: s.source, canonicalTask: true)
            s.projects = result.projects; s.existingWork = result.existingWork
            if let current = result.currentTask, Self.isNewer(current.observedAt, than: s.currentTask?.observedAt) {
                s.currentTask = current; s.currentTaskStale = false
            }
            s.restrictions = result.restrictions
            if lane == "read" { s.readLocalOnly = result.restrictions.contains { $0.code == "local_only" } }
            if let plan = result.plan, (!plan.isSafe(for: key, source: s.source, action: action)
                || !plan.matchesHumanInput(input)) {
                s.error = "Could not prepare this action"; s.plan = nil; states[key] = s; return nil
            }
            if let plan = result.plan, result.restrictions.isEmpty { s.preparedPlans[plan.id] = plan; s.planInputs[plan.id] = input }
            if lane == "task" {
                s.plan = result.plan; s.preparedInput = input
                // Unknown restrictions from the server remain visible and cannot enable execute.
                if !result.restrictions.isEmpty { s.plan = nil }
            }
            s.error = result.restrictions.first?.message
            states[key] = s
            return result.restrictions.isEmpty ? result.plan : nil
        } catch {
            guard reset == resetGeneration, lane != "task" || preparing[key] == generation else { return nil }
            s = state(key); s.busy.remove("prepare"); s.error = Self.errorCopy(error); states[key] = s
            return nil
        }
    }
    func expirePlan(_ key: Key, planId: String, at now: Date = Date()) {
        var s = state(key)
        guard let plan = s.plan, plan.id == planId, !s.submittedPlans.contains(planId), plan.isExpired(at: now) else { return }
        s.plan = nil; s.preparedInput = nil; s.preparedPlans.removeValue(forKey: planId); s.planInputs.removeValue(forKey: planId)
        s.error = "This plan expired. Review the action again."; states[key] = s
    }
    /// Set pending in the tap's frame, before the network task gets a turn.
    func beginExecute(_ key: Key, plan: InboxItemPlan, input: InboxFrozenInput) -> InboxItemExecuteRequest? {
        var s = state(key); let lane = Self.executionLane(intent: plan.intent, actionId: plan.actionId)
        if lane == "task", input.goal?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false { return nil }
        guard active, !isMirror(key), s.supported, s.preparedPlans[plan.id] == plan, s.planInputs[plan.id] == input,
              plan.itemId == key.item, plan.letterId == key.letter, plan.source == s.source,
              !s.busy.contains(lane), !s.unknown.contains(lane), !s.submittedPlans.contains(plan.id) else { return nil }
        guard !plan.isExpired() else {
            s.error = "This plan expired. Review the action again."
            s.preparedPlans.removeValue(forKey: plan.id); s.planInputs.removeValue(forKey: plan.id)
            if s.plan?.id == plan.id { s.plan = nil; s.preparedInput = nil }
            states[key] = s
            return nil
        }
        let requestId = "ir-\(UUID().uuidString.lowercased())"
        s.busy.insert(lane); s.error = nil; s.pollingExhausted = false; s.submittedPlans.insert(plan.id)
        s.unknownRequests[lane] = requestId; states[key] = s
        return .init(actionId: plan.actionId, requestId: requestId, confirmed: true, planId: plan.id, planVersion: plan.version)
    }
    func deliver(_ key: Key, request: InboxItemExecuteRequest, lane: String) async {
        let reset = resetGeneration
        guard state(key).unknownRequests[lane] == request.requestId else { return }
        do {
            let response = try await api.executeInboxItem(letterId: key.letter, itemId: key.item, request: request)
            guard reset == resetGeneration else { return }
            merge(response, key: key)
        } catch {
            guard reset == resetGeneration else { return }
            var s = state(key)
            if let apiError = error as? APIError, case .server(_, let code, let message, _, _) = apiError,
               ["plan_changed", "plan_expired", "task_changed", "launch_changed", "origin_changed", "source_changed", "target_deleted", "task_completed", "source_conflict", "local_only", "bad_request", "invalid_action", "primary_unavailable"].contains(code) {
                // These are explicit pre-dispatch refusals. Never infer this from an HTTP status alone.
                s.error = InboxEmailItem.safe(message); s.unknownRequests.removeValue(forKey: lane)
                s.plan = nil; s.preparedPlans.removeValue(forKey: request.planId)
            } else {
                s.unknown.insert(lane); s.stale = true; s.error = "Status unavailable. Check again."
            }
            states[key] = s
        }
        var s = state(key); s.busy.remove(lane); states[key] = s
        scheduleQueries(key)
    }
    func merge(_ response: InboxItemExecutionResponse, key: Key) {
        guard response.itemId == key.item else { return }
        var s = state(key)
        s.receipts = Self.mergeReceipts(s.receipts, response.receipts + (response.receipt.map { [$0] } ?? []), source: s.source, canonicalTask: true)
        if let current = response.currentTask, s.receipts.contains(where: { $0.taskId == current.taskId }),
           Self.isNewer(current.observedAt, than: s.currentTask?.observedAt) {
            s.currentTask = current; s.currentTaskStale = current.status == "unavailable"
        } else if response.currentTask == nil, s.currentTask != nil { s.currentTaskStale = true }
        if let observation = response.readObservation, Self.isNewer(observation.observedAt, than: s.readObservation?.observedAt) {
            s.readObservation = observation
        }
        s.restrictions = response.restrictions
        if response.restrictions.contains(where: { $0.code == "local_only" }) { s.readLocalOnly = true }
        s.stale = false; s.error = nil
        // A receipt does not clear or replace the human's open confirmation plan.
        for r in s.receipts {
            let lane = Self.executionLane(intent: r.intent, actionId: r.actionId)
            if let request = s.unknownRequests[lane], request == r.requestId || r.requestIds?.contains(request) == true {
                s.unknown.remove(lane); s.unknownRequests.removeValue(forKey: lane)
            }
        }
        states[key] = s
    }
    static func mergeReceipts(_ old: [InboxItemReceipt], _ incoming: [InboxItemReceipt], source: InboxMailSource?, canonicalTask: Bool = false) -> [InboxItemReceipt] {
        var result = old
        // Only the source-bound server endpoint may prove a cross-account canonical task.
        // Read receipts always belong to the exact account/message pair.
        for receipt in incoming where receipt.source == source || (canonicalTask && ["create_task", "attach_task"].contains(receipt.intent)) {
            if let i = result.firstIndex(where: { $0.requestId == receipt.requestId }) {
                if receipt.revision > result[i].revision { result[i] = receipt }
            } else { result.append(receipt) }
        }
        return result.sorted {
            let a = InboxItemDate.parse($0.updatedAt) ?? .distantPast
            let b = InboxItemDate.parse($1.updatedAt) ?? .distantPast
            return a == b ? $0.requestId < $1.requestId : a < b
        }
    }
    static func isNewer(_ incoming: String, than saved: String?) -> Bool {
        guard let date = InboxItemDate.parse(incoming) else { return false }
        guard let saved, let previous = InboxItemDate.parse(saved) else { return true }
        return date >= previous
    }
    func query(_ key: Key) async {
        guard active, !isMirror(key), state(key).supported else { return }
        if let running = inFlightQueries[key] { await running.value; return }
        let generation = queryGeneration
        let job = Task { [weak self] in
            guard let self else { return }
            await self.performQuery(key, generation: generation)
        }
        inFlightQueries[key] = job
        await job.value
        if generation == queryGeneration { inFlightQueries[key] = nil }
    }
    private func performQuery(_ key: Key, generation: Int) async {
        do {
            let result = try await api.inboxItemExecution(letterId: key.letter, itemId: key.item)
            guard active, generation == queryGeneration, !Task.isCancelled else { return }
            merge(result, key: key)
        } catch {
            guard active, generation == queryGeneration, !Task.isCancelled else { return }
            var s = state(key); s.stale = true; s.currentTaskStale = true; s.error = Self.errorCopy(error)
            if let e = error as? APIError, case .server(404, _, _, _, _) = e {
                s.supported = false; s.error = "Email actions need a newer server"
            }
            states[key] = s
        }
    }
    func appear(_ key: Key) {
        visible.insert(key)
        var s = state(key); s.pollingExhausted = false; states[key] = s
        Task { await query(key); scheduleQueries(key) }
    }
    func disappear(_ key: Key) {
        visible.remove(key); queryJobs.removeValue(forKey: key)?.cancel()
    }
    func needsQuery(_ key: Key) -> Bool {
        !state(key).unknown.isEmpty || state(key).receipts.contains(where: \.needsQuery)
    }
    private func scheduleQueries(_ key: Key) {
        guard active, visible.contains(key), needsQuery(key), !state(key).pollingExhausted, queryJobs[key] == nil else { return }
        let reset = resetGeneration
        queryJobs[key] = Task { [weak self] in
            let deadline = Date().addingTimeInterval(30)
            for delay in Self.pendingQueryDelays {
                if Date().addingTimeInterval(TimeInterval(delay)) > deadline { break }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard let self, self.active, self.resetGeneration == reset, self.visible.contains(key) else { return }
                await self.query(key)
                guard !Task.isCancelled, self.resetGeneration == reset else { return }
                if !self.needsQuery(key) { break }
            }
            if let self, self.resetGeneration == reset, !Task.isCancelled {
                self.queryJobs[key] = nil
                if self.needsQuery(key) {
                    var s = self.state(key); s.pollingExhausted = true; self.states[key] = s
                }
            }
        }
    }
    func refreshVisible() async {
        for key in Array(visible) {
            var s = state(key); s.pollingExhausted = false; states[key] = s
            await query(key); scheduleQueries(key)
        }
    }
    func suspendForBackground() {
        active = false; queryGeneration += 1
        queryJobs.values.forEach { $0.cancel() }; queryJobs = [:]
        inFlightQueries.values.forEach { $0.cancel() }; inFlightQueries = [:]
    }
    func resumeForForeground() {
        active = true; Task { await refreshVisible() }
    }
    func taskPage(_ key: Key, query: String, offset: Int = 0) async throws -> InboxTaskPage {
        try await api.inboxItemTasks(letterId: key.letter, itemId: key.item, query: query, offset: offset)
    }
    func taskPreview(_ key: Key, taskId: String) async throws -> InboxTaskPreview {
        try await api.inboxItemTask(letterId: key.letter, itemId: key.item, taskId: taskId)
    }
    static func errorCopy(_ error: Error) -> String {
        if let e = error as? APIError, case .server(_, _, let message, _, _) = e { return InboxEmailItem.safe(message) }
        return "Status unavailable. Check again."
    }
}
