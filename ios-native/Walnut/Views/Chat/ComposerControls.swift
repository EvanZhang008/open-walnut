import SwiftUI

/// The composer's controls row: a MODEL pill (model + effort, one picker) that
/// sits in the input row, next to the message it configures.
///
/// Why the model lives HERE and not in a settings sheet: this mirrors the web
/// console's decision, quoted from `DraftLaunchBar.tsx` ("the model belongs with
/// the message, so the draft renders it inside the composer's controls row,
/// exactly where a real session's model pill sits"). The desktop's session
/// composer and its main-agent composer (`LaneComposerControls.tsx`) both put the
/// model pill in the controls row; the phone now matches.
///
/// What is deliberately NOT in this row (a 44pt row is not a settings screen):
///  - Effort is INSIDE the model picker, not a second pill. Effort is only
///    meaningful relative to a model (each model declares its own
///    `supportedEffortLevels`, and some support none), so a standalone pill would
///    have to grey itself out for reasons the user can't see. The web makes the
///    same call: one picker, provider and effort ride inside it.
///  - Permission mode stays in the session menu (Session Controls). It is a
///    spawn-shaped safety setting, not a per-message choice, and the desktop's
///    mode pill exists because a mouse has hover room the phone's row does not.
///    Mid-conversation it is also rarely touched compared to the model.
///  - Path/host are not in a live session's composer at all: they are facts of a
///    running CLI. They belong to session CREATION, which is why they live in the
///    new-session chat page instead (see NewSessionChatView).
///
/// Keyboard: this is a plain `Menu`, so tapping it does NOT dismiss the keyboard,
/// and the menu is placed by UIKit (it can never overflow the screen no matter how
/// many models the catalog carries). The house rule the web AGENTS.md states as
/// "menus never overflow the viewport" is satisfied by construction here; the
/// equivalent iOS trap is a custom overlay that fights the keyboard, which is
/// exactly what a Menu avoids.
struct ComposerModelPill: View {
    @State var controls: ComposerControlsModel

    var body: some View {
        // Nothing known yet (still loading, or an engine with no switchable
        // session): render nothing rather than a pill that lies or a spinner
        // that draws the eye to a control the user did not ask about.
        if let label = controls.pillLabel {
            Menu {
                if controls.readOnly {
                    // Honest dead end: state WHY there is nothing to pick instead
                    // of showing an inert list. (A conversation with no turn yet
                    // has no session; the in-process engine has no per-chat model.)
                    Section(controls.readOnlyReason ?? "Model can't be changed here") {
                        Text(label)
                    }
                } else {
                    modelSection
                    effortSection
                }
            } label: {
                pillLabel(label)
            }
            .disabled(controls.applying)
            .accessibilityIdentifier("composer.modelPill")
            .accessibilityLabel("Model: \(label)")
        }
    }

    private func pillLabel(_ label: String) -> some View {
        HStack(spacing: 4) {
            if controls.applying {
                ProgressView().controlSize(.mini)
            }
            Text(label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
            if !controls.readOnly {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Color(.tertiarySystemFill), in: Capsule())
        // 44pt-equivalent tap target without a 44pt-tall pill: the visual chip
        // stays small (it sits in a text row) while the hit area is padded out.
        .contentShape(Capsule())
    }

    private var modelSection: some View {
        Section("Model") {
            ForEach(controls.models) { model in
                Button {
                    Task { await controls.pick(model: model.id) }
                } label: {
                    if model.id == controls.currentModelID {
                        Label(model.label, systemImage: "checkmark")
                    } else {
                        Text(model.label)
                    }
                }
            }
        }
    }

    /// Effort rides INSIDE the model picker (see the type comment). Only the
    /// levels the CURRENT model declares are offered, so a 409 from the server is
    /// unreachable through the UI rather than something the user has to discover.
    @ViewBuilder
    private var effortSection: some View {
        let levels = controls.effortLevelsForCurrentModel
        if !levels.isEmpty {
            Section("Effort") {
                ForEach(levels, id: \.self) { level in
                    Button {
                        Task { await controls.pick(effort: level) }
                    } label: {
                        if level == controls.currentEffort {
                            Label(ComposerControlsModel.effortLabel(level), systemImage: "checkmark")
                        } else {
                            Text(ComposerControlsModel.effortLabel(level))
                        }
                    }
                }
            }
        }
    }
}

/// Model + effort state for one composer, over the additive session-control
/// endpoints. Used by BOTH composers:
///  - a coding session: `sessionId` is the session itself.
///  - the main-agent chat: `sessionId` is the conversation's LANE session, which
///    `GET /api/v1/chat/engine` reports. On the lane engine a chat turn runs in a
///    real CLI, so the same endpoints apply; when the conversation has no turn yet
///    (or the box runs the in-process engine) there is nothing to switch and the
///    pill goes read-only with a reason.
@Observable
@MainActor
final class ComposerControlsModel {
    private let api = WalnutAPI()

    /// Where the switchable model lives. `.session` is known up front;
    /// `.chat` has to resolve its lane session first.
    enum Source: Equatable {
        case session(id: String)
        case chat(agentID: String, conversationID: String?)
    }

    private(set) var models: [SessionModelOptions.Model] = []
    private(set) var currentModelID: String?
    private(set) var currentEffort: String?
    private(set) var applying = false
    private(set) var readOnly = false
    private(set) var readOnlyReason: String?
    /// Fallback label when no catalog is reachable (offline, old server): the
    /// model string already on the session row. Better a true name than nothing.
    private(set) var fallbackLabel: String?

    private var source: Source?
    private var resolvedSessionID: String?
    private var loadTask: Task<Void, Never>?

    init() {}

    /// Test seam: construct a settled model without any network.
    init(
        models: [SessionModelOptions.Model],
        currentModelID: String?,
        currentEffort: String?,
        readOnly: Bool = false,
        readOnlyReason: String? = nil,
        fallbackLabel: String? = nil
    ) {
        self.models = models
        self.currentModelID = currentModelID
        self.currentEffort = currentEffort
        self.readOnly = readOnly
        self.readOnlyReason = readOnlyReason
        self.fallbackLabel = fallbackLabel
    }

    // MARK: - Label

    /// What the pill shows: the current model's SHORT name ("Opus 5"), plus the
    /// effort when the model has one ("Opus 5 · High") — the same two-part shape
    /// the reference composer uses. nil = show no pill at all.
    var pillLabel: String? {
        guard let base = currentModelLabel else { return nil }
        guard let currentEffort, !currentEffort.isEmpty,
              !effortLevelsForCurrentModel.isEmpty else { return base }
        return "\(base) · \(Self.effortLabel(currentEffort))"
    }

    private var currentModelLabel: String? {
        if let currentModelID, let row = models.first(where: { $0.id == currentModelID }) {
            // The catalog's label is a bare family ("Opus"); the id carries the
            // version. Prefer the versioned name, exactly like the web's
            // catalogRowLabel, so the pill says "Opus 5" not "Opus".
            let versioned = WalnutSession.shortModelName(row.id)
            return versioned == row.id ? row.label : versioned
        }
        // Not in the catalog (a custom proxy model, or no catalog at all).
        if let currentModelID, !currentModelID.isEmpty {
            return WalnutSession.shortModelName(currentModelID)
        }
        if let fallbackLabel, !fallbackLabel.isEmpty {
            return WalnutSession.shortModelName(fallbackLabel)
        }
        return nil
    }

    /// Effort levels the CURRENT model supports. Empty = the model has no effort
    /// axis, so no effort section and no effort in the pill label.
    var effortLevelsForCurrentModel: [String] {
        guard let currentModelID,
              let row = models.first(where: { $0.id == currentModelID })
        else { return [] }
        if let levels = row.supportedEffortLevels, !levels.isEmpty { return levels }
        return row.supportsEffort == true ? Self.defaultEffortLevels : []
    }

    static let defaultEffortLevels = ["low", "medium", "high", "xhigh", "max"]

    static func effortLabel(_ raw: String) -> String {
        switch raw {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra High"
        case "max": return "Max"
        default: return raw.capitalized
        }
    }

    // MARK: - Load

    /// Point this model at a source and (re)load its catalog. Cheap to call on
    /// every appear: an identical source with a settled catalog is a no-op.
    func attach(_ next: Source, fallbackModel: String? = nil) {
        if let fallbackModel, !fallbackModel.isEmpty, fallbackLabel == nil {
            fallbackLabel = fallbackModel
        }
        guard source != next else { return }
        source = next
        resolvedSessionID = nil
        models = []
        currentModelID = nil
        currentEffort = nil
        readOnly = false
        readOnlyReason = nil
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    func refresh() {
        guard source != nil else { return }
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    private func load() async {
        guard let source else { return }
        // Resolve WHICH session id carries the model.
        let sessionID: String
        switch source {
        case .session(let id):
            sessionID = id
        case .chat(let agentID, let conversationID):
            do {
                let info = try await api.chatEngine(agentID: agentID, conversationID: conversationID)
                guard !Task.isCancelled else { return }
                if let id = info.switchableSessionId {
                    sessionID = id
                } else {
                    // Honest read-only states, distinguished because the fixes
                    // differ: send a message vs change the server's config.
                    if info.engine == "in-process" {
                        currentModelID = info.model
                        readOnly = true
                        readOnlyReason = "This box answers chat in-process — the model comes from the server's config."
                    } else {
                        readOnly = true
                        readOnlyReason = "Send a message first — the model can be switched once this conversation has a session."
                    }
                    return
                }
            } catch let error as APIError where error.isCancelled {
                return
            } catch {
                // Degrade, never block: no engine info means no pill (unless a
                // fallback label came from the row), and the composer is untouched.
                AppLog.info("chat", "composer model: engine lookup failed", [
                    "error": error.localizedDescription,
                ])
                return
            }
        }
        resolvedSessionID = sessionID
        do {
            let options = try await api.sessionModelOptions(id: sessionID)
            guard !Task.isCancelled else { return }
            models = options.models
            currentModelID = options.current ?? currentModelID
            currentEffort = options.currentEffort
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            // The catalog is unreachable (offline / old server / cloud relay
            // down). Keep whatever label we have and make the pill read-only
            // rather than offering a list we can't honor.
            AppLog.info("chat", "composer model: catalog unavailable", [
                "sessionId": sessionID, "error": error.localizedDescription,
            ])
            if currentModelID == nil, fallbackLabel != nil { currentModelID = fallbackLabel }
            readOnly = true
            readOnlyReason = "Model options aren't reachable right now."
        }
    }

    // MARK: - Apply

    func pick(model id: String) async {
        guard let sessionID = resolvedSessionID, !applying, id != currentModelID else { return }
        let previous = currentModelID
        applying = true
        currentModelID = id                       // optimistic
        defer { applying = false }
        do {
            let result = try await api.setSessionModel(id: sessionID, model: id)
            // Adopt the server's read-back: the CLI may have substituted a value,
            // and showing what we ASKED for would be a quiet lie.
            if let effective = result.effectiveModel, !effective.isEmpty {
                currentModelID = models.contains(where: { $0.id == effective }) ? effective : id
            }
            // Switching models can change the effort axis; re-read it.
            if effortLevelsForCurrentModel.isEmpty { currentEffort = nil }
            AppLog.info("chat", "composer model switched", ["sessionId": sessionID, "model": id])
        } catch {
            currentModelID = previous
            AppLog.info("chat", "composer model switch failed", [
                "sessionId": sessionID, "model": id, "error": error.localizedDescription,
            ])
        }
    }

    func pick(effort: String) async {
        guard let sessionID = resolvedSessionID, !applying, effort != currentEffort else { return }
        let previous = currentEffort
        applying = true
        currentEffort = effort
        defer { applying = false }
        do {
            let result = try await api.setSessionEffort(id: sessionID, effort: effort)
            // `overridden` means the CLI is really using something else — adopt
            // the truth so the pill matches the run.
            if let effective = result.effectiveEffort, !effective.isEmpty {
                currentEffort = effective
            }
            AppLog.info("chat", "composer effort switched", ["sessionId": sessionID, "effort": effort])
        } catch {
            currentEffort = previous
            AppLog.info("chat", "composer effort switch failed", [
                "sessionId": sessionID, "effort": effort, "error": error.localizedDescription,
            ])
        }
    }
}
