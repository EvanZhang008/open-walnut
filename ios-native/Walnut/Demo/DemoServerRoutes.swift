import Foundation

// The demo server's routes for tasks, chat, the inbox, notes, routines and
// files. Sessions live in DemoServerSessions.swift, scripted turns in
// DemoServerTurns.swift.
extension DemoServer {
    // MARK: - Conversations (Personal AI chat)

    func routeConversations(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        let agent = r.query["agentId"] ?? r.string("agentId") ?? "general"
        if match2(r, "GET", s, "conversations") {
            let list = withState { state in
                state.conversations
                    .filter { $0.agentID == agent }
                    .sorted { $0.updatedAt > $1.updatedAt }
                    .map { ConversationSummary(id: $0.id, title: $0.title, updatedAt: $0.updatedAt, messageCount: $0.messages.count) }
            }
            return .encoded(list)
        }
        if match2(r, "POST", s, "conversations") {
            let id = withState { state -> String in
                let id = state.nextID("c")
                state.conversations.append(DemoConversation(
                    id: id, agentID: agent, title: r.string("title"), updatedAt: nowISO, messages: []
                ))
                return id
            }
            return .object(["id": id], status: 201)
        }
        guard s.count >= 2 else { return nil }
        let id = s[1]
        guard withState({ $0.conversationIndex(id) }) != nil else {
            return .error(404, "not_found", "Conversation not found.")
        }
        switch (r.method, s.count > 2 ? s[2] : "") {
        case ("GET", "messages"):
            let limit = Int(r.query["limit"] ?? "") ?? 50
            let before = r.query["before"]
            let page = withState { state -> [ChatMessage] in
                guard let i = state.conversationIndex(id) else { return [] }
                var all = state.conversations[i].messages
                if let before, let cut = all.firstIndex(where: { $0.id == before }) {
                    all = Array(all[..<cut])
                }
                return Array(all.suffix(limit))
            }
            return .encoded(page)
        case ("POST", "messages"):
            let text = r.string("text") ?? ""
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .error(400, "bad_request", "A message needs some text.")
            }
            if withState({ $0.liveTurns["c:\(id)"] != nil }) {
                return .error(409, "turn_active", "A reply is still being written.")
            }
            let turnID = withState { state -> String in
                guard let i = state.conversationIndex(id) else { return "" }
                let messageID = state.nextID("u")
                state.conversations[i].messages.append(ChatMessage(
                    id: messageID, role: "user", text: text, createdAt: nowISO, kind: nil
                ))
                state.conversations[i].updatedAt = nowISO
                if state.conversations[i].title == nil {
                    state.conversations[i].title = Self.titleFrom(text)
                }
                state.liveTurns["c:\(id)"] = ""
                return state.nextID("turn")
            }
            startChatTurn(conversationID: id, turnID: turnID, userText: text)
            return .object(["turnId": turnID], status: 202)
        case ("GET", "stream"):
            return DemoReply(status: 200, body: .stream(.conversation(id), lastEventID: r.lastEventID))
        case ("PATCH", ""):
            let meta = withState { state -> ConversationPatched.Meta in
                let i = state.conversationIndex(id)!
                if let title = r.string("title") { state.conversations[i].title = title }
                if let pinned = r.bool("pinned") { state.conversations[i].pinned = pinned }
                let c = state.conversations[i]
                return ConversationPatched.Meta(id: c.id, title: c.title, pinned: c.pinned)
            }
            return .encoded(ConversationPatched(conversation: meta))
        case ("DELETE", ""):
            cancelTurnToken("c:\(id)")
            withState { state in
                state.conversations.removeAll { $0.id == id }
                state.liveTurns["c:\(id)"] = nil
            }
            return .noContent
        case ("POST", "stop"):
            let stopped = stopChatTurn(conversationID: id)
            return .encoded(ConversationStopped(stopped: stopped ? 1 : 0, questionCancelled: false))
        case ("POST", "answer"):
            return .ok
        default:
            return nil
        }
    }

    // MARK: - Chat engine + stats

    func routeChat(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        let agent = r.query["agentId"] ?? "general"
        if match2(r, "GET", s, "chat", "stats") {
            let count = withState { state in
                state.conversations.filter { $0.agentID == agent }.reduce(0) { $0 + $1.messages.count }
            }
            return .encoded(ChatStats(
                apiMessageCount: count, estimatedTotalTokens: 18_400 + count * 350,
                contextWindow: 1_000_000, compacted: false
            ))
        }
        if match2(r, "GET", s, "chat", "engine") || match2(r, "POST", s, "chat", "engine", "session") {
            return .encoded(chatEngine())
        }
        if match2(r, "PUT", s, "chat", "model") {
            let change = withState { state -> ChatModelChange in
                if let model = r.string("model") { state.chatModel = model }
                if let effort = r.string("effort") { state.chatEffort = effort }
                return ChatModelChange(model: state.chatModel, effort: state.chatEffort)
            }
            return .encoded(change)
        }
        return nil
    }

    /// The lane engine, as the real server (lanes are its only chat engine): the
    /// chat has a session, so its composer carries the same mode and model pills
    /// a real one does. The demo keeps one lane session for the chat.
    private func chatEngine() -> ChatEngineInfo {
        withState { state in
            ChatEngineInfo(
                engine: "lane", sessionId: Self.laneSessionID, host: "",
                model: state.chatModel, effort: state.chatEffort, switchable: true
            )
        }
    }

    // MARK: - Tasks

    func routeTasks(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "tasks") {
            let tasks = withState { $0.tasks.map(\.wire) }
            return .encoded(TasksResponse(tasks: tasks, syncedAt: nowISO))
        }
        if match2(r, "POST", s, "tasks") { return createTask(r) }
        if match2(r, "GET", s, "tasks", "groups") {
            return .encoded(["groups": withState { $0.wireFolders }])
        }
        // Walnut's own rules only (no plugin runs in the demo): labels read as their word.
        if match2(r, "GET", s, "tasks", "meta", "tag-display") {
            return .encoded(TagDisplayState.walnutOnly)
        }
        if match2(r, "POST", s, "tasks", "quick-parse") {
            return .encoded(Self.quickParse(r.string("text") ?? "", clock: clockNow))
        }
        if match2(r, "POST", s, "tasks", "batch", "phase") {
            let ids = r.json["task_ids"] as? [String] ?? []
            let phase = r.string("phase") ?? ""
            guard Self.phases.contains(phase) else {
                return .error(400, "bad_request", "Unknown phase \(phase).")
            }
            let changed = withState { state -> [BatchTaskRow] in
                ids.compactMap { id in
                    guard let i = state.taskIndex(id) else { return nil }
                    Self.setPhase(&state.tasks[i], phase, now: nowISO)
                    return BatchTaskRow(id: id, title: state.tasks[i].title)
                }
            }
            changed.forEach { publishTask($0.id) }
            return .encoded(BatchPhaseResult(changed: changed, failed: [], syncFailed: nil))
        }
        if match2(r, "POST", s, "tasks", "batch", "delete") {
            let ids = r.json["task_ids"] as? [String] ?? []
            let deleted = withState { state -> [BatchTaskRow] in
                let rows = state.tasks.filter { ids.contains($0.id) }.map { BatchTaskRow(id: $0.id, title: $0.title) }
                state.tasks.removeAll { ids.contains($0.id) }
                return rows
            }
            deleted.forEach { publishTaskDeleted($0.id) }
            return .encoded(BatchDeleteResult(deleted: deleted, failed: []))
        }
        guard s.count >= 2 else { return nil }
        let id = s[1]
        guard withState({ $0.taskIndex(id) }) != nil else {
            return .error(404, "not_found", "Task not found.")
        }
        if s.count == 2 {
            switch r.method {
            case "GET":
                let detail = withState { state in state.taskDetail(state.tasks[state.taskIndex(id)!]) }
                return .encoded(TaskDetailEnvelope(task: detail))
            case "PATCH":
                return updateTask(id, r)
            case "DELETE":
                withState { state in state.tasks.removeAll { $0.id == id } }
                publishTaskDeleted(id)
                return .noContent
            default:
                return nil
            }
        }
        if s.count == 3, r.method == "POST", s[2] == "star" {
            let starred = withState { state -> Bool in
                let i = state.taskIndex(id)!
                state.tasks[i].starred.toggle()
                return state.tasks[i].starred
            }
            publishTask(id)
            return .encoded(TaskStarred(starred: starred))
        }
        if s.count == 3, r.method == "PUT" {
            let content = r.string("content") ?? ""
            withState { state in
                let i = state.taskIndex(id)!
                switch s[2] {
                case "description": state.tasks[i].description = content
                case "summary": state.tasks[i].summary = content
                case "note": state.tasks[i].note = content
                default: break
                }
                state.tasks[i].updatedAt = nowISO
            }
            publishTask(id)
            return .object([String: String]())
        }
        return nil
    }

    private func createTask(_ r: DemoRequest) -> DemoReply {
        let title = (r.string("title") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return .error(400, "bad_request", "A task needs a title.") }
        let tier = r.string("focus_tier")
        // As the real server: a person's new task lands on the board in
        // Satellite unless the client said otherwise.
        let pinned = r.bool("pinned") ?? true
        let task = withState { state -> DemoTask in
            let task = DemoTask(
                id: state.nextID("t"), title: title, phase: "TODO",
                priority: r.string("priority") ?? "none",
                project: r.string("project") ?? "",
                dueDate: r.string("due_date"), startDate: r.string("start_date"),
                endDate: r.string("end_date"), createdAt: nowISO, updatedAt: nowISO,
                completedAt: nil, pinned: false,
                focusTier: tier == "satellite" ? nil : tier,
                tags: nil, summary: nil, description: r.string("description"), note: nil,
                parentId: nil, groupId: nil
            )
            // Appended, and a pin goes to the foot of the board, as the server's
            // `addTask` does. Inserting at the head made a refetch move the new
            // row from the foot of Satellite (where the app had put it) to the
            // top, under the reader's next tap.
            state.tasks.append(task)
            if pinned { state.pin(state.tasks.count - 1) }
            return state.tasks[state.tasks.count - 1]
        }
        publishTask(task.id)
        return .encoded(TaskCreated(task: task.wire), status: 201)
    }

    private func updateTask(_ id: String, _ r: DemoRequest) -> DemoReply {
        let body = r.json
        if body["status"] != nil, body["phase"] != nil {
            return .error(400, "bad_request", "provide status or phase, not both")
        }
        if let phase = body["phase"] as? String, !Self.phases.contains(phase) {
            return .error(400, "bad_request", "Unknown phase \(phase).")
        }
        let wire = withState { state -> WalnutTask in
            let i = state.taskIndex(id)!
            func optional(_ key: String) -> String?? {
                guard let value = body[key] as? String else { return nil }
                return .some(value.isEmpty ? nil : value)
            }
            if let status = body["status"] as? String {
                let phase = status == "done" ? "COMPLETE" : status == "in_progress" ? "IN_PROGRESS" : "TODO"
                Self.setPhase(&state.tasks[i], phase, now: nowISO)
            } else if let phase = body["phase"] as? String {
                Self.setPhase(&state.tasks[i], phase, now: nowISO)
            }
            if let priority = body["priority"] as? String { state.tasks[i].priority = priority }
            if let title = body["title"] as? String, !title.isEmpty { state.tasks[i].title = title }
            if let project = body["project"] as? String { state.tasks[i].project = project }
            if let description = body["description"] as? String { state.tasks[i].description = description }
            if let due = optional("due_date") { state.tasks[i].dueDate = due }
            if let start = optional("start_date") {
                state.tasks[i].startDate = start
                if start == nil { state.tasks[i].endDate = nil }
            }
            if let end = optional("end_date") { state.tasks[i].endDate = end }
            state.tasks[i].updatedAt = nowISO
            return state.tasks[i].wire
        }
        publishTask(id)
        return .encoded(TaskCreated(task: wire))
    }

    /// The phases the server's PATCH accepts (`VALID_PHASES`).
    static let phases = ["TODO", "WAITING", "IN_PROGRESS", "NEED_ACTION", "COMPLETE"]

    /// As the server's `applyPhase`: a task completed twice keeps the moment it
    /// was first completed, and leaving COMPLETE clears it. Completing never
    /// unpins: the row stays where it was on the board, struck through.
    static func setPhase(_ task: inout DemoTask, _ phase: String, now: String) {
        task.phase = phase
        task.updatedAt = now
        if phase == "COMPLETE" {
            if task.completedAt == nil { task.completedAt = now }
        } else {
            task.completedAt = nil
        }
    }

    // MARK: - Focus tiers (the pinned board)

    func routeFocus(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "focus", "tiers") {
            return .encoded(["tiers": [FocusTierInfo]()])
        }
        if match2(r, "GET", s, "focus", "tasks") {
            return .encoded(withState { $0.tierSplit })
        }
        guard s.count >= 3, s[1] == "tasks" else { return nil }
        let id = s[2]
        guard withState({ $0.taskIndex(id) }) != nil else {
            return .error(404, "not_found", "Task not found.")
        }
        if s.count == 3, r.method == "POST" || r.method == "DELETE" {
            let pin = r.method == "POST"
            enum Outcome { case unchanged([String]), changed([String]), completed }
            let outcome = withState { state -> Outcome in
                let i = state.taskIndex(id)!
                // Idempotent both ways, as the server's routes.
                guard state.tasks[i].pinned != pin else { return .unchanged(state.tierSplit.pinnedTasks) }
                if pin, state.tasks[i].phase == "COMPLETE" { return .completed }
                if pin { state.pin(i) } else { state.unpin(i) }
                state.tasks[i].updatedAt = nowISO
                return .changed(state.tierSplit.pinnedTasks)
            }
            switch outcome {
            case .unchanged(let pinned):
                return .encoded(FocusPinResult(pinnedTasks: pinned))
            case .changed(let pinned):
                publishTask(id)
                return .encoded(FocusPinResult(pinnedTasks: pinned))
            case .completed:
                return .error(409, "conflict", "Cannot pin a completed task.")
            }
        }
        if s.count == 4, s[3] == "tier", r.method == "PUT" {
            let tier = r.string("tier") ?? "satellite"
            guard ["focus", "satellite", "backlog", "wait"].contains(tier) else {
                return .error(400, "bad_request", "Unknown tier \(tier).")
            }
            // As the server: only a pinned task has a tier, and a move keeps its
            // place in the pin order.
            let split = withState { state -> FocusTierResult? in
                let i = state.taskIndex(id)!
                guard state.tasks[i].pinned else { return nil }
                state.tasks[i].focusTier = tier == "satellite" ? nil : tier
                state.tasks[i].updatedAt = nowISO
                return state.tierSplit
            }
            guard let split else { return .error(400, "bad_request", "Task is not pinned.") }
            publishTask(id)
            return .encoded(split)
        }
        return nil
    }

    // MARK: - Search

    func globalSearch(_ r: DemoRequest) -> DemoReply {
        let q = (r.query["q"] ?? "").lowercased().trimmingCharacters(in: .whitespaces)
        let limit = Int(r.query["limit"] ?? "") ?? 30
        let wantsTasks = r.query["tasks"] == "1"
        let (results, named) = withState { state -> ([GlobalSearchResult], [WalnutTask]) in
            guard !q.isEmpty else { return ([], []) }
            let tasks = state.tasks
                .filter { $0.title.lowercased().contains(q) || ($0.summary ?? "").lowercased().contains(q) }
                .map { GlobalSearchResult(type: "task", resultId: $0.id, title: $0.title, snippet: $0.summary, score: 1) }
            // A session row carries the task it belongs to, as the real server's does.
            let sessions = state.visibleSessions
                .filter { $0.title.lowercased().contains(q) }
                .map {
                    GlobalSearchResult(
                        type: "session", resultId: $0.taskId ?? $0.id, title: $0.title,
                        snippet: $0.description, score: 0.8, taskId: $0.taskId
                    )
                }
            let rows = Array((tasks + sessions).prefix(limit))
            let ids = Set(rows.compactMap(\.ownerTaskId))
            return (rows, state.tasks.filter { ids.contains($0.id) }.map(\.wire))
        }
        return .encoded(GlobalSearchResponse(results: results, tasks: wantsTasks ? named : nil))
    }

    func asks(_ r: DemoRequest) -> DemoReply {
        .encoded(AskList(
            agentId: r.query["agentId"] ?? "general", project: "Ask Walnut",
            total: 0, launch: false, asks: []
        ))
    }

    // MARK: - Inbox (letters)

    func routeInbox(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "human-inbox") {
            let archived = r.query["archived"] == "1"
            let (letters, unread) = withState { state -> ([Letter], Int) in
                let list = state.letters
                    .filter { $0.isArchived == archived }
                    .sorted { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }
                let unread = state.letters.filter { !$0.isArchived && !$0.isRead }.count
                return (list, unread)
            }
            return .encoded(LetterListResponse(letters: letters, unreadCount: unread))
        }
        guard s.count >= 2 else { return nil }
        let id = s[1]
        guard withState({ $0.letterIndex(id) }) != nil else {
            return .error(404, "not_found", "Letter not found.")
        }
        let action = s.count > 2 ? s[2] : ""
        switch (r.method, action) {
        case ("GET", ""):
            return .encoded(LetterResponse(letter: withState { $0.letters[$0.letterIndex(id)!] }))
        case ("POST", "read"), ("POST", "pin"), ("POST", "archive"):
            let letter = withState { state -> Letter in
                let i = state.letterIndex(id)!
                switch action {
                case "read":
                    let read = r.bool("read") ?? true
                    state.letters[i].read = read
                    state.letters[i].readAt = read ? nowMs : nil
                case "pin":
                    state.letters[i].pinned = r.bool("pinned") ?? true
                default:
                    state.letters[i].archived = r.bool("archived") ?? true
                }
                return state.letters[i]
            }
            return .encoded(LetterResponse(letter: letter))
        case ("POST", "answer"):
            return answerLetter(id, r)
        case ("POST", "human-reply"):
            return replyToLetter(id, r)
        default:
            return nil
        }
    }

    private func answerLetter(_ id: String, _ r: DemoRequest) -> DemoReply {
        let actionID = r.string("actionId") ?? ""
        let freeText = r.string("freeText")
        let result = withState { state -> (Letter, String?)? in
            let i = state.letterIndex(id)!
            let old = state.letters[i]
            guard let action = old.actions?.first(where: { $0.id == actionID }) else { return nil }
            let answer = LetterAnswer(actionId: actionID, label: action.label, freeText: freeText, at: nowMs)
            let updated = Self.letter(old, answered: answer, thread: old.thread, read: true, readAt: nowMs)
            state.letters[i] = updated
            // The decision moves the work it was about, as an agent would.
            var touched: String?
            if id == "l-headline", let t = state.taskIndex("t-copy") {
                state.tasks[t].phase = "IN_PROGRESS"
                state.tasks[t].summary = "Shipping \"\(action.description ?? action.label)\". Updating the welcome screen now."
                state.tasks[t].updatedAt = nowISO
                touched = "t-copy"
            } else if id == "l-merge", actionID == "merge", let t = state.taskIndex("t-offline") {
                Self.setPhase(&state.tasks[t], "COMPLETE", now: nowISO)
                state.tasks[t].summary = "Merged into the 2.4 branch."
                touched = "t-offline"
            }
            return (updated, touched)
        }
        guard let result else {
            return .error(400, "bad_request", "That letter has no action \(actionID).")
        }
        let (letter, touched) = result
        if let touched { publishTask(touched) }
        let delivery = LetterDelivery(status: "delivered", reason: nil, sessionId: letter.sender?.sessionId, messageId: nil)
        return .encoded(LetterActionResult(letter: letter, delivery: delivery))
    }

    private func replyToLetter(_ id: String, _ r: DemoRequest) -> DemoReply {
        let text = (r.string("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .error(400, "bad_request", "A reply needs some text.") }
        let letter = withState { state -> Letter in
            let i = state.letterIndex(id)!
            let old = state.letters[i]
            let entry = LetterThreadEntry(
                from: "human", text: text, bodyFormat: nil, bodyFile: nil, at: nowMs,
                body: nil, bodyBytes: nil, bodyDeferred: nil, bodyUrl: nil, clientId: nil,
                delivery: LetterTurnDelivery(status: "delivered", reason: nil, sessionId: old.sender?.sessionId, at: nowMs)
            )
            let updated = Self.letter(old, answered: old.answered, thread: (old.thread ?? []) + [entry], read: true, readAt: nowMs)
            state.letters[i] = updated
            return updated
        }
        // The agent writes back a moment later, the way a live session would.
        let gen = currentGeneration
        schedule(after: 2.5 * turnScale) { [weak self] in
            guard let self, self.currentGeneration == gen else { return }
            self.withState { state in
                guard let i = state.letterIndex(id) else { return }
                let old = state.letters[i]
                let entry = LetterThreadEntry(
                    from: "agent", text: "Thanks, got it. I will take that into account and update this letter when it is done.",
                    bodyFormat: "markdown", bodyFile: nil, at: self.nowMs, body: nil, bodyBytes: nil,
                    bodyDeferred: nil, bodyUrl: nil, clientId: nil, delivery: nil
                )
                state.letters[i] = Self.letter(old, answered: old.answered, thread: (old.thread ?? []) + [entry], read: old.read, readAt: old.readAt)
            }
        }
        let delivery = LetterDelivery(status: "delivered", reason: nil, sessionId: letter.sender?.sessionId, messageId: nil)
        return .encoded(LetterActionResult(letter: letter, delivery: delivery))
    }

    /// A copy of `old` with a new answer, thread and read state (the letter's
    /// other fields are constants).
    static func letter(_ old: Letter, answered: LetterAnswer?, thread: [LetterThreadEntry]?, read: Bool?, readAt: Double?) -> Letter {
        Letter(
            id: old.id, subject: old.subject, type: old.type, bodyFormat: old.bodyFormat,
            textPreview: old.textPreview, sender: old.sender, createdAt: old.createdAt,
            read: read, readAt: readAt, pinned: old.pinned, archived: old.archived,
            actions: old.actions, answered: answered, thread: thread, taskRefs: old.taskRefs,
            body: old.body, bodyMissing: old.bodyMissing, bodyBytes: old.bodyBytes,
            bodyDeferred: old.bodyDeferred, bodyUrl: old.bodyUrl
        )
    }

    // MARK: - Routines

    func routeRoutines(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "routines") {
            let includeDisabled = r.query["includeDisabled"] == "true"
            let jobs = withState { $0.routines.filter { includeDisabled || $0.enabled } }
            return .encoded(RoutinesResponse(jobs: jobs))
        }
        guard s.count >= 2 else { return nil }
        let id = s[1]
        guard withState({ state in state.routines.contains { $0.id == id } }) else {
            return .error(404, "not_found", "Routine not found.")
        }
        switch (r.method, s.count > 2 ? s[2] : "") {
        case ("POST", "toggle"):
            let job = withState { state -> RoutineJob in
                let i = state.routines.firstIndex { $0.id == id }!
                let old = state.routines[i]
                let job = RoutineJob(
                    id: old.id, name: old.name, description: old.description, enabled: !old.enabled,
                    schedule: old.schedule, executor: old.executor, state: old.state
                )
                state.routines[i] = job
                return job
            }
            return .encoded(RoutineEnvelope(job: job))
        case ("POST", "run"):
            withState { state in
                let i = state.routines.firstIndex { $0.id == id }!
                let old = state.routines[i]
                state.routines[i] = RoutineJob(
                    id: old.id, name: old.name, description: old.description, enabled: old.enabled,
                    schedule: old.schedule, executor: old.executor,
                    state: RoutineJob.State(
                        nextRunAtMs: old.state?.nextRunAtMs, lastRunAtMs: nowMs,
                        lastStatus: "ok", lastError: nil, lastDurationMs: 38_000
                    )
                )
            }
            return .object(["ok": true])
        case ("DELETE", ""):
            withState { state in state.routines.removeAll { $0.id == id } }
            return .noContent
        default:
            return nil
        }
    }

    // MARK: - Notes

    func routeNotes(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "notes") { return .encoded(["tree": withState { $0.noteTree }]) }
        if match2(r, "POST", s, "notes") { return createNote(r) }
        if match2(r, "GET", s, "notes", "search") { return searchNotes(r) }
        if match2(r, "GET", s, "notes", "attachment") {
            return DemoReply(status: 200, body: .bytes(DemoImage.png, contentType: "image/png"))
        }
        if match2(r, "POST", s, "notes", "attachment") {
            let name = "Pasted image \(Int(nowMs) % 100_000).png"
            return .encoded(AttachmentUploadResult(ok: true, path: "_attachment/\(name)", name: name))
        }
        if s.count >= 3, s[1] == "content" {
            let path = s[2...].joined(separator: "/")
            switch r.method {
            case "GET": return noteContent(path)
            case "PUT": return saveNote(path, r)
            default: return nil
            }
        }
        if s.count >= 2, r.method == "DELETE" {
            let path = s[1...].joined(separator: "/")
            let removed = withState { state -> Bool in
                guard let i = Self.noteIndex(state, path) else { return false }
                let gone = state.notes.remove(at: i).path
                state.favorites.removeAll { $0 == gone }
                return true
            }
            return removed ? .ok : .error(404, "not_found", "Note not found.")
        }
        return nil
    }

    static func noteIndex(_ state: DemoState, _ path: String) -> Int? {
        state.noteIndex(path) ?? state.noteIndex(path + ".md")
    }

    private func noteContent(_ path: String) -> DemoReply {
        let note = withState { state in Self.noteIndex(state, path).map { state.notes[$0] } }
        guard let note else { return .error(404, "not_found", "Note not found.") }
        return .encoded(NoteContent(content: note.content, contentHash: note.contentHash, updatedAt: note.updatedAt))
    }

    private func saveNote(_ path: String, _ r: DemoRequest) -> DemoReply {
        let content = r.string("content") ?? ""
        let expected = r.string("expectedHash")
        let outcome = withState { state -> Result<NoteWriteResult, DemoNoteConflict> in
            guard let i = Self.noteIndex(state, path) else {
                let note = DemoNote(path: path.hasSuffix(".md") ? path : path + ".md", content: content, updatedAt: nowISO)
                state.notes.append(note)
                return .success(NoteWriteResult(contentHash: note.contentHash, updatedAt: note.updatedAt))
            }
            let current = state.notes[i]
            if let expected, expected != current.contentHash {
                return .failure(DemoNoteConflict(hash: current.contentHash, content: current.content))
            }
            state.notes[i].content = content
            state.notes[i].updatedAt = nowISO
            return .success(NoteWriteResult(contentHash: state.notes[i].contentHash, updatedAt: nowISO))
        }
        switch outcome {
        case .success(let result):
            return .encoded(result)
        case .failure(let conflict):
            return .error(409, "conflict", "This note changed since you opened it.",
                          extras: ["serverHash": conflict.hash, "serverContent": conflict.content])
        }
    }

    private func createNote(_ r: DemoRequest) -> DemoReply {
        let raw = (r.string("path") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return .error(400, "bad_request", "A note needs a name.") }
        let path = raw.hasSuffix(".md") ? raw : raw + ".md"
        let result = withState { state -> NoteWriteResult? in
            guard state.noteIndex(path) == nil else { return nil }
            let note = DemoNote(path: path, content: r.string("content") ?? "", updatedAt: nowISO)
            state.notes.append(note)
            return NoteWriteResult(contentHash: note.contentHash, updatedAt: note.updatedAt)
        }
        guard let result else { return .error(409, "exists", "A note with that name already exists.") }
        return .encoded(result, status: 201)
    }

    private func searchNotes(_ r: DemoRequest) -> DemoReply {
        let q = (r.query["q"] ?? "").trimmingCharacters(in: .whitespaces)
        let limit = Int(r.query["limit"] ?? "") ?? 30
        let results = withState { state -> [NoteSearchResult] in
            guard !q.isEmpty else { return [] }
            return state.notes.compactMap { note -> NoteSearchResult? in
                let title = ((note.path as NSString).lastPathComponent as NSString).deletingPathExtension
                let haystack = title + "\n" + note.content
                guard let range = haystack.range(of: q, options: .caseInsensitive) else { return nil }
                let start = haystack.index(range.lowerBound, offsetBy: -40, limitedBy: haystack.startIndex) ?? haystack.startIndex
                let end = haystack.index(range.upperBound, offsetBy: 60, limitedBy: haystack.endIndex) ?? haystack.endIndex
                let before = String(haystack[start..<range.lowerBound])
                let hit = String(haystack[range])
                let after = String(haystack[range.upperBound..<end])
                let snippet = "\(before)<mark>\(hit)</mark>\(after)".replacingOccurrences(of: "\n", with: " ")
                return NoteSearchResult(
                    id: note.path, path: note.path, title: title, snippet: snippet,
                    matchType: title.range(of: q, options: .caseInsensitive) != nil ? "title" : "content"
                )
            }
            .prefix(limit)
            .map { $0 }
        }
        return .encoded(NoteSearchResponse(results: results, degraded: nil))
    }

    func favorite(_ r: DemoRequest) -> DemoReply? {
        guard let path = r.string("path") else { return .error(400, "bad_request", "Which note?") }
        let notes = withState { state -> [String]? in
            switch r.method {
            case "POST": if !state.favorites.contains(path) { state.favorites.append(path) }
            case "DELETE": state.favorites.removeAll { $0 == path }
            default: return nil
            }
            return state.favorites
        }
        return notes.map { .encoded(FavoritesResponse(notes: $0)) }
    }

    // MARK: - Files (a session's working directory)

    func routeFiles(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        guard r.method == "GET" else { return nil }
        let path = r.query["path"] ?? ""
        if s == ["file-content"] {
            let content = DemoFixtures.fileContent(at: path) ?? ""
            if r.query["raw"] == "1" {
                let isHTML = path.lowercased().hasSuffix(".html") || path.lowercased().hasSuffix(".htm")
                let page = isHTML ? DemoFixtures.htmlPreview(for: r.url) : content
                return DemoReply(status: 200, body: .bytes(Data(page.utf8), contentType: isHTML ? "text/html; charset=utf-8" : "text/plain; charset=utf-8"))
            }
            return .encoded(SessionFileContent(content: content, size: content.utf8.count, truncated: false, binary: false, error: nil))
        }
        if s == ["files", "list"] {
            let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
            return .encoded(SessionFileListResponse(
                path: trimmed, selectedFile: nil, entries: DemoFixtures.files(in: trimmed) ?? []
            ))
        }
        if s == ["files", "resolve-path"] {
            let rel = r.query["rel"] ?? ""
            let cwd = r.query["cwd"] ?? DemoFixtures.macCodeRoot
            let resolved = rel.hasPrefix("/") ? rel : (cwd as NSString).appendingPathComponent(rel)
            return .encoded(PathResolution(path: resolved, resolved: true, via: "cwd", line: nil, column: nil, endLine: nil))
        }
        return nil
    }

    // MARK: - Matching shorthand

    func match2(_ r: DemoRequest, _ method: String, _ s: [String], _ pattern: String...) -> Bool {
        r.method == method && s == pattern
    }

    /// A short conversation title from its first message.
    static func titleFrom(_ text: String) -> String {
        let oneLine = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        guard oneLine.count > 40 else { return oneLine }
        let cut = oneLine.prefix(40)
        if let space = cut.lastIndex(of: " ") { return String(cut[..<space]) }
        return String(cut)
    }

    /// The natural-language quick add, in the small: dates, urgency and the
    /// demo's own project names.
    static func quickParse(_ text: String, clock: DemoClock) -> QuickParsedTask {
        var title = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = title.lowercased()
        var due: String?
        let days: [(String, Int)] = [
            ("sunday", 1), ("monday", 2), ("tuesday", 3), ("wednesday", 4),
            ("thursday", 5), ("friday", 6), ("saturday", 7),
        ]
        func strip(_ phrase: String) {
            if let range = title.range(of: phrase, options: .caseInsensitive) {
                title.removeSubrange(range)
            }
        }
        if lower.contains("tomorrow") {
            due = clock.day(1)
            strip(" tomorrow")
            strip("tomorrow")
        } else if lower.contains("today") {
            due = clock.day(0)
            strip(" today")
        } else if let day = days.first(where: { lower.contains($0.0) }) {
            due = clock.day(clock.nextWeekday(day.1))
            strip(" on \(day.0)")
            strip(" \(day.0)")
        }
        let urgent = lower.contains("urgent") || lower.contains("asap")
        if urgent { strip(" asap"); strip(" urgent") }
        let projects = ["Pebble", "Acme Website", "Home", "Travel", "Learning"]
        let project = projects.first { lower.contains($0.lowercased()) }
        title = title.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if let first = title.first, first.isLowercase { title = first.uppercased() + title.dropFirst() }
        return QuickParsedTask(
            title: title.isEmpty ? text : title, dueDate: due, startDate: nil, endDate: nil,
            priority: urgent ? "immediate" : nil, project: project, projectIsNew: false,
            pinTier: nil, starred: nil
        )
    }
}

struct DemoNoteConflict: Error {
    let hash: String
    let content: String
}
