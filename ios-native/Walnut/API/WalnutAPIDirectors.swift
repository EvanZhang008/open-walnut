import Foundation
import Observation

/// Directors (additive, 2026-11-20; server `src/core/org/org-directors.ts`): the layer between a
/// VP and the work. A task is a Director when its choice (`Task.director`) is `yes`, not when it
/// is `no`, and otherwise (auto, absent) when it leads an open subtask. The org tree marks each
/// task node with the result (`director: true`); the choice itself rides the task row.
enum DirectorChoice: String, Codable, Equatable {
    case yes, no, auto

    /// Never throws: an unknown word (a newer server) reads as auto, so one odd value cannot make
    /// a whole task list or org tree fail to decode.
    init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = DirectorChoice(rawValue: raw ?? "") ?? .auto
    }
}

enum DirectorRule {
    /// The server's `isDirector`: its choice, else whether it leads any open worker.
    static func isDirector(_ choice: DirectorChoice?, openWorkers: Int) -> Bool {
        switch choice {
        case .yes: return true
        case .no: return false
        case .auto, nil: return openWorkers > 0
        }
    }

    /// Can a task take a Director choice: only work under a project (never the CEO, a VP or a
    /// router, which the server refuses with a 400, and never the Inbox, which has no VP).
    static func canChoose(_ task: WalnutTask) -> Bool {
        task.orgRole == nil && !task.project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !task.isDone
    }

    /// The task's open subtasks in the list (the server's open workers).
    static func openWorkers(of id: String, in tasks: [WalnutTask]) -> Int {
        tasks.filter { $0.parentTaskId == id && $0.id != id && !$0.isDone && $0.phase != "COMPLETE" }.count
    }
}

/// How the Chat drawer shows Directors, the org's own settings (`GET /api/v1/org/settings`), so
/// the phone and the web agree. Absent from an older server: the feature is off.
struct DirectorsSettings: Codable, Equatable {
    enum Layout: String, Codable, CaseIterable, Identifiable {
        /// Under each VP, a folded "N directors" row.
        case fold
        /// After the VPs, one "Directors" section, each a first-level row.
        case sections

        var id: String { rawValue }
        var label: String { self == .fold ? "Fold" : "Sections" }
        var detail: String {
            switch self {
            case .fold: return "Each VP folds its Directors into one row under it; tap it to open them."
            case .sections: return "A Directors section after the VPs, each Director a row of its own."
            }
        }
    }

    var enabled = false
    var layout: Layout = .fold
    var showProjects = true

    init(enabled: Bool = false, layout: Layout = .fold, showProjects: Bool = true) {
        self.enabled = enabled
        self.layout = layout
        self.showProjects = showProjects
    }

    init(_ view: OrgSettingsView) {
        enabled = view.directorsEnabled ?? false
        layout = view.directorsLayout.flatMap(Layout.init(rawValue:)) ?? .fold
        showProjects = view.directorsShowProjects ?? true
    }
}

extension WalnutAPI {
    /// Make a task a Director (`yes`), take it off (`no`), or back to the default (`auto`).
    func setDirector(taskId: String, _ choice: DirectorChoice) async throws -> WalnutTask {
        struct Body: Encodable { let director: String }
        let updated: TaskCreated = try await send("PATCH", "/tasks/\(escape(taskId))", body: Body(director: choice.rawValue))
        return updated.task
    }

    /// A new task in `project`, born a Director and not started: its first message starts it.
    func createDirector(title: String, project: String) async throws -> WalnutTask {
        struct Body: Encodable { let title: String; let project: String; let director: String }
        let created: TaskCreated = try await send("POST", "/tasks", body: Body(title: title, project: project, director: "yes"))
        return created.task
    }

    /// Change how Directors show; answers the org's settings after the change.
    func setDirectorsSettings(layout: DirectorsSettings.Layout? = nil, showProjects: Bool? = nil) async throws -> OrgSettingsView {
        struct Body: Encodable { let directorsLayout: String?; let directorsShowProjects: Bool? }
        return try await send("PUT", "/org/settings", body: Body(directorsLayout: layout?.rawValue, directorsShowProjects: showProjects))
    }
}

/// The Directors settings as last read, shared by the drawer, the task page and Settings. Kept on
/// the phone too, so the drawer opens in the right layout before the server answers.
@Observable
@MainActor
final class DirectorsSettingsStore {
    static let shared = DirectorsSettingsStore()
    static let storageKey = "org.directors.settings"

    private(set) var value: DirectorsSettings
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = AppPrefs.defaults) {
        self.defaults = defaults
        value = defaults.data(forKey: Self.storageKey)
            .flatMap { try? JSONDecoder().decode(DirectorsSettings.self, from: $0) } ?? DirectorsSettings()
    }

    func adopt(_ next: DirectorsSettings) {
        guard next != value else { return }
        value = next
        if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: Self.storageKey) }
    }

    /// Read them again; a failed read keeps what was known.
    func refresh(api: WalnutAPI = WalnutAPI()) async {
        guard let view = try? await api.orgSettings() else { return }
        adopt(DirectorsSettings(view))
    }

    /// Write a change (the Mac only: a companion answers 501). Shown at once, put back on failure.
    func update(layout: DirectorsSettings.Layout? = nil, showProjects: Bool? = nil, api: WalnutAPI = WalnutAPI()) async throws {
        let before = value
        var next = value
        if let layout { next.layout = layout }
        if let showProjects { next.showProjects = showProjects }
        adopt(next)
        do {
            let answer = try await api.setDirectorsSettings(layout: layout, showProjects: showProjects)
            // An older server answers without the fields: keep what was asked for.
            if answer.directorsEnabled != nil { adopt(DirectorsSettings(answer)) }
        } catch {
            adopt(before)
            throw error
        }
    }
}
