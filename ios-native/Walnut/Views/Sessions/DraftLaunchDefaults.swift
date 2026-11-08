import Foundation

/// A project's launch defaults on the phone's new-session draft: the engine, model and permission
/// mode a new task of the project starts on when the draft picks none (server
/// `src/core/sessions/project-launch-defaults.ts`, web `utils/launch-source.ts`).
///
///   the draft's own pick  >  the project's default  >  the global default
///
/// The server applies the project's values to a launch that names none, so a pill the user did
/// not touch sends nothing and shows what the server will use; a pick is the task's own and is
/// sent. A project engine that issues its own session ids (Codex, any ACP engine) runs too: the
/// page launches with `WalnutAPI.launchSession` and waits for the task's session (`awaitSession`).
struct DraftLaunchDefaults: Equatable {
    let project: String
    /// nil = the global default engine.
    let engine: String?
    /// A model of `engine`; never without it.
    let model: String?
    let mode: NewSessionSheet.PermissionMode?
    /// The project's engine, given way to Claude Code where the draft launches (`onHost`).
    var yieldedEngine: String? = nil

    init?(project: String, metadata: WalnutProjectSource.LaunchDefaults?) {
        let engine = metadata?.defaultEngine.flatMap { $0.isEmpty ? nil : $0 }
        let mode = metadata?.defaultMode.flatMap(NewSessionSheet.PermissionMode.init(rawValue:))
        guard engine != nil || mode != nil else { return nil }
        self.project = project
        self.engine = engine
        self.model = engine == nil ? nil : metadata?.defaultModel.flatMap { $0.isEmpty || $0 == "default" ? nil : $0 }
        self.mode = mode
    }

    init(project: String, engine: String?, model: String?, mode: NewSessionSheet.PermissionMode?) {
        self.project = project
        self.engine = engine
        self.model = engine == nil ? nil : model
        self.mode = mode
    }

    /// These defaults where a launch on `host` runs: the server runs an engine other than Claude
    /// Code only on the primary machine (agents/default-engine.ts), so on a remote host the
    /// project's engine and its model give way to Claude Code, and the line says so.
    func onHost(_ host: String) -> DraftLaunchDefaults {
        guard let other = otherEngine, !host.isEmpty, host != "__local__" else { return self }
        var out = DraftLaunchDefaults(project: project, engine: nil, model: nil, mode: mode)
        out.yieldedEngine = other
        return out
    }

    /// The project's engine is another than Claude Code (its own model list, its own modes).
    var otherEngine: String? { engine.flatMap { $0 == "claude" ? nil : $0 } }

    /// The model the draft's pill shows before a pick: the project's.
    var shownModel: String? { model }

    /// The engine's name for the draft's line ("Codex").
    static func engineName(_ id: String) -> String {
        switch id {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        case "pi": return "Pi"
        case "gemini": return "Gemini"
        case "goose": return "Goose"
        case "dsh": return "DeepSeek Harness"
        case "custom": return "Custom (ACP)"
        default: return id.prefix(1).uppercased() + id.dropFirst()
        }
    }

    /// The draft's one line about them, or nil when every value they set was picked over.
    /// "New tasks in Walnut start in Accept Edits with Sonnet (project defaults)."
    /// "New tasks in Walnut start on Codex with gpt-5.5 (project defaults)."
    func line(modeTouched: Bool, modelTouched: Bool) -> String? {
        var parts: [String] = []
        if !modelTouched, let other = otherEngine { parts.append("on \(Self.engineName(other))") }
        if !modeTouched, let mode { parts.append("in \(mode.label)") }
        if !modelTouched, let shown = shownModel { parts.append("with \(NewSessionChatView.modelLabel(shown))") }
        let start = parts.isEmpty ? nil : "New tasks in \(project) start \(parts.joined(separator: " ")) (project defaults)."
        guard let yielded = yieldedEngine, !modelTouched else { return start }
        let note = "\(Self.engineName(yielded)), the default engine of \(project), runs only on the main computer, so a session on this host starts Claude Code."
        return start.map { "\($0) \(note)" } ?? note
    }

    /// What the create call sends as `mode`: nil leaves it to the server (the project's mode,
    /// else bypass). An untouched pill sends what it always did when the project sets no mode.
    static func wireMode(picked: NewSessionSheet.PermissionMode, touched: Bool, defaults: DraftLaunchDefaults?) -> String? {
        if !touched {
            if defaults?.mode != nil { return nil }
            return picked == .bypass ? nil : picked.rawValue
        }
        // Bypass over a project's other mode must be named, or the server would apply that one.
        if picked == .bypass && defaults?.mode == nil { return nil }
        return picked.rawValue
    }

    /// What the create call sends for the engine and model pair. Untouched: nothing when the
    /// project sets an engine (the server applies its pair), else the pill's model as always.
    /// Touched: the pick, with Claude Code named when the project sets an engine, or the server
    /// would read the silence (or "Default") as no pick and apply the project's pair.
    static func wirePair(picked: String?, touched: Bool, defaults: DraftLaunchDefaults?) -> (model: String?, namesClaude: Bool) {
        let projectPair = defaults?.engine != nil
        guard touched, !keepsProjectPair(picked: picked, defaults: defaults) else { return (projectPair ? nil : picked, false) }
        return (picked, projectPair)
    }

    /// The pick is the project's own model again (or its engine's default when it sets none):
    /// still the project's pair, on the project's engine, not a pick of Claude Code's.
    static func keepsProjectPair(picked: String?, defaults: DraftLaunchDefaults?) -> Bool {
        guard let defaults, defaults.engine != nil else { return false }
        return picked == defaults.shownModel
    }
}

extension DraftLaunchDefaults {
    /// The session of a launch answered without an id (`WalnutAPI.launchSession`: the project's
    /// engine issues its own ids): the task's newest session the list did not hold before the
    /// launch, once the store sees it. nil when it has not appeared within `timeout`.
    @MainActor
    static func awaitSession(
        taskId: String, excluding known: Set<String>, in tasks: TasksStore,
        timeout: Duration = .seconds(60), every interval: Duration = .milliseconds(1500)
    ) async -> WalnutSession? {
        let deadline = ContinuousClock.now + timeout
        while true {
            await tasks.loadSessions()
            if let found = newSession(of: taskId, excluding: known, in: tasks.sessions) { return found }
            if Task.isCancelled || ContinuousClock.now + interval > deadline { return nil }
            try? await Task.sleep(for: interval)
        }
    }

    /// The pure half of `awaitSession`: the newest session of `taskId` not in `known`.
    static func newSession(of taskId: String, excluding known: Set<String>, in sessions: [WalnutSession]) -> WalnutSession? {
        sessions.filter { $0.taskId == taskId && !known.contains($0.id) }.max { $0.startedAt < $1.startedAt }
    }
}
