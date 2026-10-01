import Foundation

/// A timed list of steps, played on the server's turn queue.
struct DemoScript {
    private(set) var steps: [(at: TimeInterval, run: () -> Void)] = []
    private var elapsed: TimeInterval = 0

    mutating func after(_ delay: TimeInterval, _ run: @escaping () -> Void) {
        elapsed += delay
        steps.append((elapsed, run))
    }
}

// Scripted turns: the Personal AI's streamed reply and a coding session's work,
// sent over the same SSE frames the real server uses.
extension DemoServer {
    /// Play `script` for the turn on `key`. A reset, or a Stop on the same key,
    /// silences every step still waiting.
    func play(_ script: DemoScript, key: String) {
        let gen = currentGeneration
        let token = beginTurnToken(key)
        let scale = turnScale
        for step in script.steps {
            schedule(after: step.at * scale) { [weak self] in
                guard let self, self.isCurrent(generation: gen, key: key, token: token) else { return }
                step.run()
            }
        }
    }

    private func frame(_ channel: DemoStreams.Channel, _ event: String, _ payload: [String: Any],
                       turnStart: Bool = false, turnEnd: Bool = false) {
        streams.publish(channel, event: event, json: Self.text(payload), turnStart: turnStart, turnEnd: turnEnd)
    }

    /// Split a reply into a few words per frame, keeping every character.
    static func chunks(_ text: String, words: Int = 3) -> [String] {
        var out: [String] = []
        var current = ""
        var spaces = 0
        for character in text {
            current.append(character)
            if character == " " || character == "\n" {
                spaces += 1
                if spaces >= words {
                    out.append(current)
                    current = ""
                    spaces = 0
                }
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    // MARK: - Personal AI chat

    func startChatTurn(conversationID id: String, turnID: String, userText: String) {
        let key = "c:\(id)"
        let channel = DemoStreams.Channel.conversation(id)
        let reply = DemoReplies.chat(for: userText)
        withState { state in state.liveTurnIDs[key] = turnID }
        var script = DemoScript()
        script.after(0.35) { self.frame(channel, "message-start", ["turnId": turnID], turnStart: true) }
        script.after(0.3) { self.frame(channel, "thinking", ["delta": reply.thinking]) }
        script.after(0.5) {}
        for chunk in Self.chunks(reply.text) {
            script.after(0.04) {
                self.withState { state in state.liveTurns[key, default: ""] += chunk }
                self.frame(channel, "text-delta", ["delta": chunk])
            }
        }
        script.after(0.1) {
            self.finishChatTurn(conversationID: id, turnID: turnID, thinking: reply.thinking, text: reply.text)
        }
        play(script, key: key)
    }

    /// Land the reply in history BEFORE the end frame, so the refetch the app
    /// makes on `message-end` already sees it.
    private func finishChatTurn(conversationID id: String, turnID: String, thinking: String?, text: String) {
        let key = "c:\(id)"
        withState { state in
            state.liveTurns[key] = nil
            state.liveTurnIDs[key] = nil
            guard let i = state.conversationIndex(id) else { return }
            if let thinking {
                state.conversations[i].messages.append(ChatMessage(
                    id: state.nextID("m"), role: "assistant", text: thinking, createdAt: nowISO,
                    kind: .thinking, thinkingText: thinking
                ))
            }
            state.conversations[i].messages.append(ChatMessage(
                id: state.nextID("m"), role: "assistant", text: text, createdAt: nowISO, kind: nil
            ))
            state.conversations[i].updatedAt = nowISO
        }
        frame(.conversation(id), "message-end", ["turnId": turnID, "fullText": text], turnEnd: true)
    }

    /// Stop a chat reply mid-stream: keep what was written, end the turn.
    func stopChatTurn(conversationID id: String) -> Bool {
        let key = "c:\(id)"
        let stopped = withState { state -> (turnID: String, partial: String)? in
            guard let partial = state.liveTurns[key] else { return nil }
            let turnID = state.liveTurnIDs[key] ?? ""
            state.liveTurns[key] = nil
            state.liveTurnIDs[key] = nil
            if !partial.isEmpty, let i = state.conversationIndex(id) {
                state.conversations[i].messages.append(ChatMessage(
                    id: state.nextID("m"), role: "assistant", text: partial, createdAt: nowISO, kind: nil
                ))
            }
            return (turnID, partial)
        }
        guard let stopped else { return false }
        cancelTurnToken(key)
        frame(.conversation(id), "message-end", ["turnId": stopped.turnID, "fullText": stopped.partial], turnEnd: true)
        return true
    }

    // MARK: - Coding sessions

    /// A message into a session: runs now, or after the turn in flight.
    func sendToSession(_ id: String, text: String) {
        let key = "s:\(id)"
        let startNow = withState { state -> Bool in
            guard let i = state.sessionIndex(id) else { return false }
            if state.liveTurns[key] != nil || state.pendingPermissions[id] != nil {
                state.sessionQueue[id, default: []].append(text)
                return false
            }
            state.sessions[i].transcript.append(
                SessionTranscript.Message(role: "user", text: text, timestamp: nowISO, kind: nil)
            )
            state.sessions[i].processStatus = "running"
            state.sessions[i].lastActiveAt = nowISO
            state.liveTurns[key] = ""
            return true
        }
        guard startNow else { return }
        publishSession(id)
        let reply = withState { state in
            DemoReplies.session(for: text, cwd: state.sessions[state.sessionIndex(id)!].cwd)
        }
        let channel = DemoStreams.Channel.session(id)
        let toolUseID = withState { $0.nextID("tu") }
        var script = DemoScript()
        script.after(0.3) {
            self.frame(channel, "turn-start", [:], turnStart: true)
            self.frame(channel, "status", ["processStatus": "running"])
        }
        script.after(0.4) { self.frame(channel, "thinking", ["delta": reply.thinking]) }
        script.after(0.6) {
            self.frame(channel, "tool", [
                "name": reply.tool.name, "detail": reply.tool.detail,
                "toolUseId": toolUseID, "inputPreview": reply.tool.input,
            ])
        }
        script.after(0.9) {
            self.frame(channel, "tool-result", ["toolUseId": toolUseID, "resultPreview": reply.tool.result])
        }
        for chunk in Self.chunks(reply.text) {
            script.after(0.04) {
                self.withState { state in state.liveTurns[key, default: ""] += chunk }
                self.frame(channel, "text-delta", ["delta": chunk])
            }
        }
        script.after(0.1) {
            let at = self.nowISO
            self.finishSessionTurn(id, rows: [
                SessionTranscript.Message(role: "assistant", text: reply.thinking, timestamp: at,
                                          kind: "thinking", thinkingText: reply.thinking),
                SessionTranscript.Message(role: "assistant", text: reply.tool.name, timestamp: at, kind: "tool",
                                          detail: reply.tool.detail, resultPreview: reply.tool.result,
                                          inputPreview: reply.tool.input),
                SessionTranscript.Message(role: "assistant", text: reply.text, timestamp: at, kind: nil),
            ])
        }
        play(script, key: key)
    }

    /// Write a finished turn into the transcript, then end it on the stream and
    /// start whatever was queued behind it.
    private func finishSessionTurn(_ id: String, rows: [SessionTranscript.Message], summary: String? = nil) {
        let key = "s:\(id)"
        let next = withState { state -> String? in
            state.liveTurns[key] = nil
            guard let i = state.sessionIndex(id) else { return nil }
            state.sessions[i].transcript.append(contentsOf: rows)
            state.sessions[i].processStatus = "idle"
            state.sessions[i].lastActiveAt = nowISO
            if let summary, let taskID = state.sessions[i].taskId, let t = state.taskIndex(taskID) {
                state.tasks[t].summary = summary
                state.tasks[t].updatedAt = nowISO
            }
            guard var queue = state.sessionQueue[id], !queue.isEmpty else { return nil }
            let first = queue.removeFirst()
            state.sessionQueue[id] = queue
            return first
        }
        let channel = DemoStreams.Channel.session(id)
        frame(channel, "turn-end", [:], turnEnd: true)
        frame(channel, "status", ["processStatus": "idle"])
        publishSession(id)
        if summary != nil, let taskID = withState({ $0.sessions.first { $0.id == id }?.taskId }) {
            publishTask(taskID)
        }
        if let next { sendToSession(id, text: next) }
    }

    /// Allow or Deny on the waiting permission card.
    func resolvePermission(sessionID id: String, requestID: String, allow: Bool) -> Bool {
        let key = "s:\(id)"
        let resolved = withState { state -> Bool in
            guard state.pendingPermissions[id]?.requestId == requestID else { return false }
            state.pendingPermissions[id] = nil
            return true
        }
        guard resolved else { return false }
        let channel = DemoStreams.Channel.session(id)
        let pending = withState { $0.liveTurns[key] ?? "" }
        let reply = allow ? DemoReplies.uptimeAllowed : DemoReplies.uptimeDenied
        var script = DemoScript()
        if allow {
            script.after(0.2) { self.frame(channel, "tool", ["name": "Bash", "detail": "Restart the alert agent", "toolUseId": "tu-perm-uptime"]) }
            script.after(1.0) {
                self.frame(channel, "tool-result", ["toolUseId": "tu-perm-uptime", "resultPreview": DemoReplies.uptimeRestartOutput])
            }
        }
        script.after(0.3) { self.frame(channel, "text-delta", ["delta": "\n\n"]) }
        for chunk in Self.chunks(reply) {
            script.after(0.04) { self.frame(channel, "text-delta", ["delta": chunk]) }
        }
        script.after(0.1) {
            let at = self.nowISO
            var rows = [SessionTranscript.Message(role: "assistant", text: pending, timestamp: at, kind: nil)]
            if allow {
                rows.append(SessionTranscript.Message(
                    role: "assistant", text: "Bash", timestamp: at, kind: "tool",
                    detail: "Restart the alert agent", resultPreview: DemoReplies.uptimeRestartOutput,
                    inputPreview: "command: sudo systemctl restart alert-agent"
                ))
            }
            rows.append(SessionTranscript.Message(role: "assistant", text: reply, timestamp: at, kind: nil))
            self.finishSessionTurn(id, rows: rows, summary: allow
                ? "Both alerts are live and a test page reached your phone."
                : "Rules are written. They load the next time the alert agent restarts.")
        }
        play(script, key: key)
        return true
    }

    /// Terminate / restart / retry: end any turn, settle the status.
    func endSessionTurn(_ id: String, status: String) {
        let key = "s:\(id)"
        cancelTurnToken(key)
        let wasLive = withState { state -> Bool in
            let live = state.liveTurns[key] != nil
            state.liveTurns[key] = nil
            state.pendingPermissions[id] = nil
            state.sessionQueue[id] = nil
            if let i = state.sessionIndex(id) {
                state.sessions[i].processStatus = status
                state.sessions[i].lastActiveAt = nowISO
            }
            return live
        }
        let channel = DemoStreams.Channel.session(id)
        if wasLive { frame(channel, "turn-end", [:], turnEnd: true) }
        frame(channel, "status", ["processStatus": status])
        publishSession(id)
    }
}
