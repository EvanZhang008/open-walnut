import SwiftUI

/// What the mode pill needs from the server: the session's provider controls,
/// read and applied. `WalnutAPI` is the real one; tests pass a fake.
protocol ComposerModeTransport {
    func sessionControls(id: String) async throws -> SessionControlsPayload
    func applySessionControl(id: String, controlId: String, value: String) async throws -> SessionControlsPayload
}

extension WalnutAPI: ComposerModeTransport {}

/// The permission mode of the session behind a live composer, for its mode pill.
///
/// The mode is the session's `mode` control (`GET /sessions/:id/controls`, which
/// names the options), changed with `POST /sessions/:id/controls`: the channel the
/// Session Controls sheet and the web's mode pill use, so all three agree. A pick
/// shows at once with a spinner and lands on the server's answer; a refused one
/// goes back to the mode the session really has and says why at the top of the
/// next menu.
///
/// One session at a time (`attach`). An answer for a session the composer has
/// since left is dropped, so a slow reply can never paint another session's mode.
@Observable
@MainActor
final class ComposerModeModel {
    @ObservationIgnored private let api: ComposerModeTransport

    private(set) var sessionID: String?
    /// The session's mode control, as the server last described it.
    private(set) var control: SessionControlsPayload.Control?
    /// The value a pick is writing, shown until the server answers.
    private(set) var writing: String?
    /// Why the last pick did not take, shown above the next menu's rows.
    private(set) var failureNote: String?
    /// The session's controls could not be read and nothing is known yet: the
    /// pill says "Mode" with a warning, and its menu is this reason and Retry.
    private(set) var loadFailure: String?

    /// Bumps on every attach and every load, so only the newest answer lands.
    @ObservationIgnored private var loadToken = 0
    @ObservationIgnored private(set) var pickTask: Task<Void, Never>?
    @ObservationIgnored private(set) var loadTask: Task<Void, Never>?

    /// The control ids that mean "permission mode": Claude's `mode`, and the
    /// plan/exec split an ACP adapter (Codex) advertises.
    static let modeControlIDs = ["mode", "collaboration_mode"]

    init(transport: ComposerModeTransport = WalnutAPI()) {
        self.api = transport
    }

    // MARK: - What the pill shows

    /// The current mode's name ("Bypass"), or nil = not known yet.
    var label: String? {
        guard let control else { return nil }
        let value = writing ?? control.currentValue
        return Self.optionLabel(value, in: control)
    }

    /// The pill's seat holder while the mode is not known: the pill stays in
    /// the row (it never comes and goes), quiet until the answer lands.
    static let placeholderLabel = "Mode"

    var pillState: ComposerControlsModel.PillState {
        if writing != nil { return .writing }
        // Still being read (no answer and no failure yet): nothing to pick from.
        if control == nil, loadFailure == nil { return .waiting }
        return .ready
    }

    var menu: PillMenu {
        if control == nil, let loadFailure {
            return PillMenu(
                sections: [.init(title: loadFailure, items: [.init(
                    title: "Retry", choice: .retry, systemImage: "arrow.clockwise",
                    accessibilityID: "composer.modePill.retry"
                )])],
                token: ComposerControlsModel.MenuToken(generation: 0, version: 0)
            )
        }
        let options = control?.options ?? []
        let current = writing ?? control?.currentValue
        let items = options.map { option in
            PillMenu.Item(
                title: option.label, choice: .mode(option.value), checked: option.value == current,
                accessibilityID: "composer.mode.\(option.value)"
            )
        }
        return PillMenu(
            // Headed by the current value, as the model and effort sections are.
            sections: [.init(title: ComposerControlsModel.heading(control?.name ?? "Mode", current: label), items: items)],
            token: ComposerControlsModel.MenuToken(generation: 0, version: 0),
            title: failureNote ?? ""
        )
    }

    static func optionLabel(_ value: String?, in control: SessionControlsPayload.Control) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return control.options?.first { $0.value == value }?.label ?? value
    }

    /// The mode control in a controls answer: the first select whose id means
    /// permission mode and that offers something to pick.
    static func modeControl(in payload: SessionControlsPayload) -> SessionControlsPayload.Control? {
        for id in modeControlIDs {
            if let control = payload.controls.first(where: {
                $0.id == id && $0.type == "select" && !($0.options ?? []).isEmpty
            }) {
                return control
            }
        }
        return nil
    }

    // MARK: - Session

    /// Follow this session (nil = none: the pill goes away). The same session
    /// again is a no-op; use `refresh` to re-ask.
    func attach(_ id: String?) {
        guard id != sessionID else { return }
        sessionID = id
        control = nil
        writing = nil
        failureNote = nil
        loadFailure = nil
        pickTask?.cancel()
        refresh()
    }

    /// Re-ask the server (a reconnect, a return to the app). Never while a pick
    /// is being written: its answer is the newer truth.
    func refresh() {
        loadToken += 1
        loadTask?.cancel()
        guard let id = sessionID, writing == nil else { return }
        let token = loadToken
        loadTask = Task {
            do {
                let payload = try await api.sessionControls(id: id)
                guard token == self.loadToken, id == self.sessionID else { return }
                self.control = Self.modeControl(in: payload)
                self.loadFailure = nil
            } catch {
                // Cancelled by a newer load or an attach, which owns the pill now.
                guard !Task.isCancelled, token == self.loadToken, id == self.sessionID else { return }
                // A re-read that failed keeps the mode it had (the pill goes on
                // naming it); with nothing known the pill says why, with a Retry.
                if self.control == nil {
                    self.loadFailure = "Couldn't read the mode: \(SessionControlsSheet.friendlyControlError(error))"
                }
                AppLog.info("session", "composer mode: controls unavailable", [
                    "sessionId": id, "error": error.localizedDescription,
                ])
            }
        }
    }

    func menuSelect(_ choice: PillMenu.Choice) {
        switch choice {
        case .mode(let value): select(value)
        case .retry: refresh()
        case .model, .effort, .none: return
        }
    }

    func select(_ value: String) {
        guard let id = sessionID, let control, writing == nil, value != control.currentValue else { return }
        writing = value
        failureNote = nil
        loadToken += 1
        loadTask?.cancel()
        pickTask = Task {
            do {
                let payload = try await api.applySessionControl(id: id, controlId: control.id, value: value)
                guard id == self.sessionID else { return }
                self.control = Self.modeControl(in: payload) ?? self.control
                self.writing = nil
                AppLog.info("session", "composer mode: applied", ["sessionId": id, "value": value])
            } catch {
                // Cancelled by `attach`, which already reset the pill.
                guard !Task.isCancelled, id == self.sessionID else { return }
                self.writing = nil
                self.failureNote = "Couldn't change the mode: \(SessionControlsSheet.friendlyControlError(error))"
                AppLog.info("session", "composer mode: apply failed", [
                    "sessionId": id, "value": value, "error": error.localizedDescription,
                ])
            }
        }
    }
}
