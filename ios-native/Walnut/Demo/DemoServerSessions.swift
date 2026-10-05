import Foundation

// The demo server's coding-session routes (`/api/v1/sessions/...`).
extension DemoServer {
    func routeSessions(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        if match2(r, "GET", s, "sessions") {
            let list = withState { state in state.visibleSessions.map { state.wireSession($0) } }
            return .encoded(SessionsResponse(sessions: list, syncedAt: nowISO))
        }
        if match2(r, "POST", s, "sessions") { return createSession(r) }
        if match2(r, "GET", s, "sessions", "launch-options") { return .encoded(DemoFixtures.launchOptions) }
        if match2(r, "GET", s, "sessions", "list-dirs") { return listDirs(r) }
        guard s.count >= 2 else { return nil }
        let id = s[1]
        if id == Self.laneSessionID { return routeLaneSession(r, action: s.count > 2 ? s[2] : "") }
        guard withState({ $0.sessionIndex(id) }) != nil else {
            return .error(404, "not_found", "Session not found.")
        }
        let action = s.count > 2 ? s[2] : ""
        switch (r.method, action) {
        case ("GET", ""):
            return .encoded(sessionDetail(id))
        case ("PATCH", ""):
            let record = withState { state -> SessionDetail.Record in
                let i = state.sessionIndex(id)!
                if let title = r.string("title"), !title.isEmpty { state.sessions[i].title = title }
                if let archived = r.bool("archived") { state.sessions[i].archived = archived }
                if let mode = r.string("mode") { state.sessions[i].mode = mode }
                if let note = r.string("human_note") { state.sessions[i].humanNote = note }
                return Self.record(state.sessions[i], state)
            }
            publishSession(id)
            return .encoded(SessionPatched(session: record))
        case ("GET", "transcript"):
            let transcript = withState { state -> SessionTranscript in
                let session = state.sessions[state.sessionIndex(id)!]
                return SessionTranscript(sessionId: id, exportedAt: nowISO, truncated: false, messages: session.transcript)
            }
            return .encoded(transcript)
        case ("GET", "stream"):
            return DemoReply(status: 200, body: .stream(.session(id), lastEventID: r.lastEventID))
        case ("POST", "messages"):
            let text = r.string("text") ?? ""
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .error(400, "bad_request", "A message needs some text.")
            }
            let messageID = r.string("messageId") ?? withState { $0.nextID("qm") }
            sendToSession(id, text: text)
            return .object(["messageId": messageID], status: 202)
        case ("POST", "permission"):
            let requestID = r.string("requestId") ?? ""
            let allow = r.bool("allow") ?? false
            guard resolvePermission(sessionID: id, requestID: requestID, allow: allow) else {
                return .error(404, "not_found", "That permission request is no longer waiting.")
            }
            return .encoded(PermissionResolved(status: "resolved", requestId: requestID, allow: allow))
        case ("POST", "terminate"):
            endSessionTurn(id, status: "stopped")
            return .encoded(SessionTerminated(status: "terminated", sessionId: id, tookMs: 640))
        case ("POST", "restart"):
            endSessionTurn(id, status: "idle")
            return .encoded(SessionRestarted(status: "restarted", sessionId: id, pendingMessages: 0))
        case ("POST", "retry"):
            let taskID = withState { $0.sessions[$0.sessionIndex(id)!].taskId }
            endSessionTurn(id, status: "idle")
            return .encoded(SessionRetried(status: "reconnected", sessionId: id, taskId: taskID, oldSessionId: nil, restoredMessages: 0))
        case ("GET", "model-options"):
            let options = withState { state -> SessionModelOptions in
                let session = state.sessions[state.sessionIndex(id)!]
                return SessionModelOptions(
                    models: DemoFixtures.models, current: session.model,
                    currentEffort: state.sessionEfforts[id] ?? DemoFixtures.defaultEffort
                )
            }
            return .encoded(options)
        case ("POST", "model"):
            let model = r.string("model") ?? DemoFixtures.mainModel
            withState { state in state.sessions[state.sessionIndex(id)!].model = model }
            publishSession(id)
            return .encoded(SessionModelChange(model: model, cliModel: model, appliedLive: true, applied: nil, effectiveModel: model))
        case ("POST", "effort"):
            let effort = r.string("effort") ?? DemoFixtures.defaultEffort
            withState { state in state.sessionEfforts[id] = effort }
            return .encoded(SessionEffortChange(effort: effort, appliedLive: true, effectiveEffort: effort, overridden: false))
        case ("POST", "fork"):
            return forkSession(id, message: r.string("message"))
        case ("GET", "controls"), ("POST", "controls"):
            if r.method == "POST", r.string("id") == "mode", let value = r.string("value") {
                withState { state in state.sessions[state.sessionIndex(id)!].mode = value }
            }
            return .encoded(controls(id))
        case ("GET", "queue"):
            return .encoded(SessionQueueResponse(messages: queued(id)))
        case ("DELETE", "queue"), ("PATCH", "queue"):
            return .ok
        case ("GET", "plan"):
            return .error(404, "not_found", "This session has no plan.")
        case ("GET", "side-questions"):
            return .encoded(SideQuestionsResponse(sideQuestions: withState { $0.sideQuestions[id] ?? [] }))
        case ("POST", "side-question"):
            let question = r.string("question") ?? ""
            let answer = SideQuestion(
                id: withState { $0.nextID("sq") }, question: question,
                answer: "Short answer: yes. The change only touches the album screen and its tests, so nothing else in the app is affected.",
                createdAt: nowISO, promotedTaskId: nil
            )
            withState { state in state.sideQuestions[id, default: []].append(answer) }
            return .encoded(SideQuestionEnvelope(sideQuestion: answer))
        default:
            return nil
        }
    }

    // MARK: - Projections

    static func record(_ s: DemoSession, _ state: DemoState) -> SessionDetail.Record {
        let task = s.taskId.flatMap { id in state.tasks.first { $0.id == id } }
        return SessionDetail.Record(
            claudeSessionId: s.id, processStatus: s.processStatus, title: s.title, mode: s.mode,
            archived: s.archived, taskId: s.taskId,
            project: task.map { $0.project.isEmpty ? nil : $0.project } ?? nil,
            host: s.host, cwd: s.cwd, startedAt: s.startedAt, lastActiveAt: s.lastActiveAt,
            messageCount: s.transcript.filter { $0.kind == nil }.count, model: s.model,
            description: s.description, humanNote: s.humanNote
        )
    }

    private func sessionDetail(_ id: String) -> SessionDetail {
        withState { state in
            let session = state.sessions[state.sessionIndex(id)!]
            return SessionDetail(
                session: Self.record(session, state),
                pendingPermissions: state.pendingPermissions[id].map { [$0] } ?? []
            )
        }
    }

    // MARK: - The chat's lane session

    /// The chat's lane session. Not a listed session (the real server keeps its
    /// lanes out of the session lists too): it answers only what the chat
    /// composer asks of it, the model catalog, model and effort switches, and the
    /// permission mode.
    static let laneSessionID = "demo-lane"

    /// The draft picks a picker alias ("sonnet"); a real launch runs it as a
    /// catalog model, so the session reports that row. Kept as the alias, the
    /// model sheet showed an unlisted, greyed "sonnet" row above "Sonnet 5.5".
    static func launchModel(_ picked: String?) -> String {
        switch picked ?? "" {
        case "", "default", "opus": return DemoFixtures.mainModel
        case "sonnet": return "claude-sonnet-5-5"
        case "haiku": return DemoFixtures.fastModel
        case let id: return id
        }
    }

    private func routeLaneSession(_ r: DemoRequest, action: String) -> DemoReply? {
        switch (r.method, action) {
        case ("GET", "model-options"):
            let options = withState { state in
                SessionModelOptions(models: DemoFixtures.models, current: state.chatModel, currentEffort: state.chatEffort)
            }
            return .encoded(options)
        case ("POST", "model"):
            let model = r.string("model") ?? DemoFixtures.mainModel
            withState { state in state.chatModel = model }
            return .encoded(SessionModelChange(model: model, cliModel: model, appliedLive: true, applied: nil, effectiveModel: model))
        case ("POST", "effort"):
            let effort = r.string("effort") ?? DemoFixtures.defaultEffort
            withState { state in state.chatEffort = effort }
            return .encoded(SessionEffortChange(effort: effort, appliedLive: true, effectiveEffort: effort, overridden: false))
        case ("GET", "controls"), ("POST", "controls"):
            if r.method == "POST", r.string("id") == "mode", let value = r.string("value") {
                withState { state in state.chatMode = value }
            }
            return .encoded(Self.modeControls(current: withState { $0.chatMode }))
        default:
            return .error(404, "not_found", "Session not found.")
        }
    }

    private func controls(_ id: String) -> SessionControlsPayload {
        Self.modeControls(current: withState { $0.sessions[$0.sessionIndex(id)!].mode })
    }

    private static func modeControls(current mode: String) -> SessionControlsPayload {
        SessionControlsPayload(engine: "claude", controls: [
            // The real server's shape (`claudeModeControls`): every mode, by the
            // labels of the one mode registry.
            SessionControlsPayload.Control(
                id: "mode", name: "Mode", type: "select", currentValue: mode,
                options: [
                    .init(value: "plan", name: "Plan"),
                    .init(value: "default", name: "Default"),
                    .init(value: "dontAsk", name: "Don't Ask"),
                    .init(value: "accept", name: "Accept"),
                    .init(value: "auto", name: "Auto"),
                    .init(value: "bypass", name: "Bypass"),
                ]
            ),
        ])
    }

    private func queued(_ id: String) -> [SessionQueuedMessage] {
        withState { state in
            (state.sessionQueue[id] ?? []).enumerated().map { index, text in
                SessionQueuedMessage(id: "q-\(id)-\(index)", message: text, status: "pending", enqueuedAt: nowISO)
            }
        }
    }

    private func listDirs(_ r: DemoRequest) -> DemoReply {
        let prefix = r.query["prefix"] ?? ""
        let host = r.query["host"] ?? ""
        let roots = host == DemoFixtures.buildBoxAlias
            ? ["\(DemoFixtures.buildBoxRoot)/infra", "\(DemoFixtures.buildBoxRoot)/backups", "\(DemoFixtures.buildBoxRoot)/scripts"]
            : ["\(DemoFixtures.macCodeRoot)/pebble", "\(DemoFixtures.macCodeRoot)/acme-site", "\(DemoFixtures.macCodeRoot)/recipes-app",
               "\(DemoFixtures.macCodeRoot)/pebble/Sources", "\(DemoFixtures.macCodeRoot)/pebble/Tests"]
        let parent = prefix.hasSuffix("/") ? String(prefix.dropLast()) : (prefix as NSString).deletingLastPathComponent
        let dirs = roots.filter { $0.hasPrefix(prefix) && ($0 as NSString).deletingLastPathComponent == parent }.sorted()
        return .encoded(DirListing(dirs: dirs, parent: parent, exists: true))
    }

    // MARK: - Create / fork

    private func createSession(_ r: DemoRequest) -> DemoReply {
        let cwd = r.string("cwd") ?? "\(DemoFixtures.macCodeRoot)/pebble"
        let host = r.string("host") ?? ""
        let message = (r.string("message") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let created = withState { state -> SessionCreated in
            let now = nowISO
            let project = Self.project(forCwd: cwd)
            var taskID = r.string("taskId")
            let title = message.isEmpty ? "New session" : Self.titleFrom(message)
            if taskID == nil || state.taskIndex(taskID!) == nil {
                let task = DemoTask(
                    id: state.nextID("t"), title: title, phase: "IN_PROGRESS", priority: "none",
                    project: project, dueDate: nil, startDate: nil, endDate: nil, createdAt: now,
                    updatedAt: now, completedAt: nil, pinned: false, focusTier: nil, tags: nil,
                    summary: nil, description: nil, note: nil, parentId: nil, groupId: nil
                )
                // As the server's launch: the new task is appended and born on
                // the board, at the foot of Satellite.
                state.tasks.append(task)
                state.pin(state.tasks.count - 1)
                taskID = task.id
            }
            let id = state.nextID("s")
            state.sessions.append(DemoSession(
                id: id, title: title, taskId: taskID, host: host, processStatus: "idle",
                model: Self.launchModel(r.string("model")), mode: r.string("mode") ?? "bypass",
                startedAt: now, lastActiveAt: now, cwd: cwd, description: nil, transcript: []
            ))
            if let t = state.taskIndex(taskID!) { state.tasks[t].sessionIds.append(id) }
            return SessionCreated(sessionId: id, taskId: taskID!, title: title)
        }
        publishTask(created.taskId)
        publishSession(created.sessionId)
        if !message.isEmpty {
            // A moment later, as a CLI spawning on a real host would.
            let gen = currentGeneration
            schedule(after: 0.6 * turnScale) { [weak self] in
                guard let self, self.currentGeneration == gen else { return }
                self.sendToSession(created.sessionId, text: message)
            }
        }
        return .encoded(created, status: 201)
    }

    private func forkSession(_ id: String, message: String?) -> DemoReply {
        let forked = withState { state -> SessionForked in
            let original = state.sessions[state.sessionIndex(id)!]
            let now = nowISO
            let parentTask = original.taskId.flatMap { state.taskIndex($0) }.map { state.tasks[$0] }
            // As the server's fork: a new task appended, born pinned at the foot
            // of the board in the source's tier, filed beside the source (its
            // folder), not under it.
            let task = DemoTask(
                id: state.nextID("t"), title: "Fork of \(parentTask?.title ?? original.title)",
                phase: "IN_PROGRESS", priority: "none", project: parentTask?.project ?? "",
                dueDate: nil, startDate: nil, endDate: nil, createdAt: now, updatedAt: now,
                completedAt: nil, pinned: false,
                focusTier: parentTask?.pinned == true ? parentTask?.focusTier : nil,
                tags: nil, summary: nil,
                description: nil, note: nil, parentId: nil, groupId: parentTask?.groupId
            )
            state.tasks.append(task)
            state.pin(state.tasks.count - 1)
            var copy = original
            copy.id = state.nextID("s")
            copy.title = "Fork of \(original.title)"
            copy.taskId = task.id
            copy.processStatus = "idle"
            copy.startedAt = now
            copy.lastActiveAt = now
            state.sessions.append(copy)
            if let t = state.taskIndex(task.id) { state.tasks[t].sessionIds.append(copy.id) }
            return SessionForked(sessionId: copy.id, taskId: task.id, title: copy.title)
        }
        publishTask(forked.taskId)
        publishSession(forked.sessionId)
        if let message, !message.isEmpty { sendToSession(forked.sessionId, text: message) }
        return .encoded(forked, status: 201)
    }

    static func project(forCwd cwd: String) -> String {
        if cwd.contains("pebble") { return "Pebble" }
        if cwd.contains("acme") || cwd.hasPrefix(DemoFixtures.buildBoxRoot) { return "Acme Website" }
        return ""
    }
}
