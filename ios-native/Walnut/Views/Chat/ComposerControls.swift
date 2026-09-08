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
                if controls.unreachable {
                    // We could not establish what this conversation's model is.
                    // That is NOT a locked pill with a config story (which is what
                    // the user hit: a replica describing its OWN config while the
                    // Mac was unreachable). The last known name stays on the pill
                    // and the menu offers the one action that can help.
                    unreachableSection
                } else if controls.readOnly {
                    // Honest dead end: state WHY there is nothing to pick instead
                    // of showing an inert list. (A conversation with no turn yet
                    // has no session; a box that explicitly declares the model
                    // fixed for this conversation.)
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
            if controls.unreachable {
                // The name is the LAST KNOWN one, so say so on the pill itself
                // rather than only inside the menu: a stale value that looks live
                // is the failure this whole state exists to avoid.
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 8, weight: .semibold))
            } else if !controls.readOnly {
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

    /// The retry state's menu: a reason line plus the retry itself. The picker is
    /// also the natural place to retry from, so the affordance sits exactly where
    /// the (unknowable) list would have been rather than being an empty section.
    private var unreachableSection: some View {
        Section(controls.statusNote ?? ComposerControlsModel.unreachableNote) {
            Button {
                controls.refresh()
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            .accessibilityIdentifier("composer.modelPill.retry")
        }
    }

    /// The header carries a just-failed write's reason when there is one, so a
    /// pill that snapped back to its previous model says why on the next open
    /// (the composer row has no toast surface of its own).
    private var modelSection: some View {
        Section(controls.statusNote ?? "Model") {
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

/// Model + effort state for one composer. Used by BOTH composers:
///  - a coding session: the model lives on the session itself.
///  - the main-agent chat: `GET /api/v1/chat/engine` says where it lives. On the
///    LANE engine a chat turn runs in a real CLI, so the ordinary session
///    endpoints apply (minting the lane session if the conversation has none
///    yet). On the IN-PROCESS engine there is no session, and the model is a
///    per-conversation setting written through `PUT /api/v1/chat/model`.
///
/// The pill is selectable on every one of those, which is the point: it used to
/// go read-only on the in-process engine ("the model comes from the server's
/// config"), and a cloud replica that could not reach the Mac reported ITSELF as
/// in-process — so the one situation where the answer was unknown was also the
/// one that looked most authoritative. Unknown is now its own state
/// (`unreachable`): last known name, no invented list, and a retry.
///
/// The decision itself is a pure function (`pillPlan`) so every variant is
/// unit-testable without a network: one engine payload (or one classified
/// failure) in, the whole pill state out.
@Observable
@MainActor
final class ComposerControlsModel {
    private let api = WalnutAPI()

    /// Where the switchable model lives. `.session` is known up front;
    /// `.chat` has to ask the engine first.
    enum Source: Equatable {
        case session(id: String)
        case chat(agentID: String, conversationID: String?)
    }

    /// Where a pick is WRITTEN. Resolved from the engine lookup, never guessed.
    enum WriteTarget: Equatable {
        /// Nothing is writable (unknown engine, or nothing resolved yet).
        case none
        /// `POST /sessions/:id/model` + `/effort` — a real CLI session.
        case session(id: String)
        /// `PUT /chat/model` — the in-process engine's per-conversation model.
        case chat(agentID: String, conversationID: String?)
        /// A lane conversation with no session yet: mint one, then it is
        /// `.session`. Only ever an INTERMEDIATE plan output.
        case mintLaneSession(agentID: String, conversationID: String?)
    }

    /// What one `GET /chat/engine` attempt settled into. The failure cases are
    /// classified (`lookup(afterFailing:)`) so the decision stays pure.
    enum EngineLookup: Equatable {
        case engine(ChatEngineInfo)
        /// 503 `primary_unreachable`, a down bridge, or a request that never
        /// landed. The model is UNKNOWN — not fixed, and never the replica's own.
        case unreachable
        /// The box answered something unusable (bad payload, auth, a 4xx).
        case unusable
    }

    /// What the pill already believes, so a plan can retain it.
    struct LastKnown: Equatable {
        var models: [SessionModelOptions.Model] = []
        var modelID: String?
        var effort: String?
    }

    /// The whole pill state, decided in one place.
    struct PillPlan: Equatable {
        var models: [SessionModelOptions.Model] = []
        var currentModelID: String?
        var currentEffort: String?
        var readOnly = false
        var readOnlyReason: String?
        /// True = we could not establish this conversation's model. Retry state,
        /// NOT a locked pill.
        var unreachable = false
        /// Menu heading for the retry state (and for a just-failed write).
        var statusNote: String?
        var writeTarget: WriteTarget = .none
    }

    private(set) var models: [SessionModelOptions.Model] = []
    private(set) var currentModelID: String?
    private(set) var currentEffort: String?
    private(set) var applying = false
    private(set) var readOnly = false
    private(set) var readOnlyReason: String?
    /// True = the conversation's model is unknown right now (the box or the Mac
    /// behind it can't be reached). The pill keeps its last known name.
    private(set) var unreachable = false
    /// Why the retry state is showing, or why the last write snapped back.
    private(set) var statusNote: String?
    private(set) var writeTarget: WriteTarget = .none
    /// Fallback label when no catalog is reachable (offline, old server): the
    /// model string already on the session row. Better a true name than nothing.
    private(set) var fallbackLabel: String?

    private var source: Source?
    private var loadTask: Task<Void, Never>?

    static let unreachableNote = "Can't reach your Mac right now"
    static let unusableNote = "Couldn't read the model list"

    init() {}

    /// Test seam: construct a settled model without any network.
    init(
        models: [SessionModelOptions.Model],
        currentModelID: String?,
        currentEffort: String?,
        readOnly: Bool = false,
        readOnlyReason: String? = nil,
        fallbackLabel: String? = nil,
        unreachable: Bool = false,
        statusNote: String? = nil,
        writeTarget: WriteTarget = .none
    ) {
        self.models = models
        self.currentModelID = currentModelID
        self.currentEffort = currentEffort
        self.readOnly = readOnly
        self.readOnlyReason = readOnlyReason
        self.fallbackLabel = fallbackLabel
        self.unreachable = unreachable
        self.statusNote = statusNote
        self.writeTarget = writeTarget
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

    // MARK: - The decision (pure)

    /// The whole pill state from ONE engine lookup. No network, no clock, no
    /// stored state beyond what is passed in — so every branch below is a unit
    /// test rather than a thing you have to reproduce on a phone.
    static func pillPlan(
        for lookup: EngineLookup,
        agentID: String,
        conversationID: String?,
        lastKnown: LastKnown
    ) -> PillPlan {
        switch lookup {
        case .unreachable:
            return retryPlan(note: unreachableNote, lastKnown: lastKnown)
        case .unusable:
            return retryPlan(note: unusableNote, lastKnown: lastKnown)
        case .engine(let info):
            // An EXPLICIT `switchable: false` is the box telling us the model is
            // fixed for this conversation; honor it. A MISSING field is an old
            // server that never had it, which is not a "no" (that inference is
            // exactly what locked the in-process pill).
            if info.isLockedByServer {
                return PillPlan(
                    models: [], currentModelID: info.model ?? lastKnown.modelID,
                    currentEffort: info.effort ?? lastKnown.effort,
                    readOnly: true,
                    readOnlyReason: "This box says the model is fixed for this conversation."
                )
            }
            if let id = info.switchableSessionId {
                // Lane with a live session: the ordinary session endpoints own
                // the model. Keep the current list until the catalog read lands
                // so a refresh doesn't blink the picker empty.
                return PillPlan(
                    models: lastKnown.models,
                    currentModelID: lastKnown.modelID,
                    currentEffort: lastKnown.effort,
                    writeTarget: .session(id: id)
                )
            }
            if info.engine == "in-process" {
                // Selectable, always. The catalog comes from the payload; a
                // server too old to send one still gets a one-row picker built
                // from the model it DID report, so the pill is never the locked
                // "comes from the server's config" dead end. (A pick on such a
                // box 404s, which `writeOutcome` reports as "too old".)
                let catalog = info.models?.isEmpty == false
                    ? info.models!
                    : singleRowCatalog(for: info.model ?? lastKnown.modelID)
                return PillPlan(
                    models: catalog,
                    currentModelID: info.model ?? lastKnown.modelID,
                    currentEffort: info.effort,
                    writeTarget: .chat(agentID: agentID, conversationID: conversationID)
                )
            }
            // Lane engine, no session yet: MINT one. This used to be a read-only
            // "Send a message first", which meant the ordinary chat had no working
            // model control until the conversation had been used — while a task's
            // session had one immediately. The web console has always minted
            // eagerly on mount (useLaneSession), so this is parity: the CLI it
            // starts is the one that would answer the next message anyway.
            return PillPlan(
                models: lastKnown.models,
                currentModelID: lastKnown.modelID,
                currentEffort: lastKnown.effort,
                writeTarget: .mintLaneSession(agentID: agentID, conversationID: conversationID)
            )
        }
    }

    /// Unknown, not fixed: keep the last true name, offer NO list we can't honor,
    /// and let the menu carry the retry.
    private static func retryPlan(note: String, lastKnown: LastKnown) -> PillPlan {
        PillPlan(
            models: [],
            currentModelID: lastKnown.modelID,
            currentEffort: lastKnown.effort,
            unreachable: true,
            statusNote: note,
            writeTarget: .none
        )
    }

    /// One catalog row for a model string, so an old server's single known model
    /// is still a pickable (and correctly labelled) list of one.
    private static func singleRowCatalog(for model: String?) -> [SessionModelOptions.Model] {
        guard let model, !model.isEmpty else { return [] }
        return [SessionModelOptions.Model(
            id: model, label: WalnutSession.shortModelName(model),
            supportsEffort: nil, supportedEffortLevels: nil
        )]
    }

    /// Which lookup a failed `GET /chat/engine` is. `primary_unreachable` (a
    /// replica that can't relay to the Mac) and any transport failure are the
    /// same fact: the model is unknown.
    static func lookup(afterFailing error: Error) -> EngineLookup {
        guard let api = error as? APIError else { return .unreachable }
        switch api {
        case .network, .rateLimited:
            return .unreachable
        case .server(let status, let code, _, _, _):
            if code == "primary_unreachable" || code == "bridge_offline" { return .unreachable }
            return status >= 500 ? .unreachable : .unusable
        case .cancelled, .unauthorized, .badResponse, .notConfigured:
            return .unusable
        }
    }

    // MARK: - Load

    /// Point this model at a source and (re)load. Cheap to call on every appear:
    /// an identical source with settled state is a no-op.
    func attach(_ next: Source, fallbackModel: String? = nil) {
        if let fallbackModel, !fallbackModel.isEmpty, fallbackLabel == nil {
            fallbackLabel = fallbackModel
        }
        guard source != next else { return }
        source = next
        models = []
        currentModelID = nil
        currentEffort = nil
        readOnly = false
        readOnlyReason = nil
        unreachable = false
        statusNote = nil
        writeTarget = .none
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    /// Re-ask. This is also the retry out of the unreachable state, so it must
    /// never be gated on the previous outcome.
    func refresh() {
        guard source != nil else { return }
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    private var lastKnown: LastKnown {
        LastKnown(models: models, modelID: currentModelID, effort: currentEffort)
    }

    private func apply(_ plan: PillPlan) {
        models = plan.models
        currentModelID = plan.currentModelID
        currentEffort = plan.currentEffort
        readOnly = plan.readOnly
        readOnlyReason = plan.readOnlyReason
        unreachable = plan.unreachable
        statusNote = plan.statusNote
        writeTarget = plan.writeTarget
    }

    private func load() async {
        guard let source else { return }
        switch source {
        case .session(let id):
            // A session's model always lives on the session — no engine lookup.
            writeTarget = .session(id: id)
            await loadSessionCatalog(id)
        case .chat(let agentID, let conversationID):
            let lookup: EngineLookup
            do {
                lookup = .engine(
                    try await api.chatEngine(agentID: agentID, conversationID: conversationID)
                )
            } catch let error as APIError where error.isCancelled {
                return
            } catch {
                lookup = Self.lookup(afterFailing: error)
                AppLog.info("chat", "composer model: engine lookup failed", [
                    "agentId": agentID,
                    "verdict": lookup == .unreachable ? "unreachable" : "unusable",
                    "error": error.localizedDescription,
                ])
            }
            guard !Task.isCancelled else { return }
            let plan = Self.pillPlan(
                for: lookup, agentID: agentID, conversationID: conversationID,
                lastKnown: lastKnown
            )
            apply(plan)
            switch plan.writeTarget {
            case .session(let id):
                await loadSessionCatalog(id)
            case .mintLaneSession(let agentID, let conversationID):
                guard let minted = await mintLaneSession(agentID: agentID, conversationID: conversationID)
                else { return }
                guard !Task.isCancelled else { return }
                writeTarget = .session(id: minted)
                await loadSessionCatalog(minted)
            case .chat, .none:
                // In-process: the engine payload already IS the catalog.
                break
            }
        }
    }

    private func loadSessionCatalog(_ sessionID: String) async {
        do {
            let options = try await api.sessionModelOptions(id: sessionID)
            guard !Task.isCancelled else { return }
            models = options.models
            currentModelID = options.current ?? currentModelID
            currentEffort = options.currentEffort
            unreachable = false
            statusNote = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            // The catalog is unreachable (offline / old server / cloud relay
            // down). Same verdict as a failed engine lookup: keep the true name
            // we have, offer no list we can't honor, and let the user retry.
            AppLog.info("chat", "composer model: catalog unavailable", [
                "sessionId": sessionID, "error": error.localizedDescription,
            ])
            apply(Self.pillPlan(
                for: Self.lookup(afterFailing: error), agentID: "", conversationID: nil,
                lastKnown: LastKnown(
                    models: [], modelID: currentModelID ?? fallbackLabel, effort: currentEffort
                )
            ))
        }
    }

    /// Mint this conversation's lane session, returning its id.
    ///
    /// Returns nil (and leaves an honest reason) when the box refuses: a 409
    /// means it is not on the lane engine after all — the config changed between
    /// the GET and this POST, which is rare but not impossible.
    private func mintLaneSession(agentID: String, conversationID: String?) async -> String? {
        do {
            let minted = try await api.chatEngineSession(agentID: agentID, conversationID: conversationID)
            guard let id = minted.switchableSessionId else {
                readOnly = true
                readOnlyReason = "This conversation has no session to switch the model on."
                return nil
            }
            return id
        } catch let error as APIError where error.isCancelled {
            return nil
        } catch {
            // Old server without the endpoint, offline, or a 409. Degrade to the
            // previous behaviour rather than losing the pill: the model still
            // becomes switchable after the first message, which is what this box
            // could do before.
            AppLog.info("chat", "composer model: lane mint failed", [
                "agentId": agentID, "error": error.localizedDescription,
            ])
            readOnly = true
            readOnlyReason = "Send a message first — the model can be switched once this conversation has a session."
            return nil
        }
    }

    // MARK: - Apply

    /// Why a write snapped back. Pure + testable: the note is what the picker
    /// shows on its next open (a composer row has no toast surface of its own).
    enum WriteFailure: Equatable {
        /// 404/405/501 — this box predates the endpoint.
        case serverTooOld
        /// 400 `unknown_model` — the box refused the value.
        case rejected
        /// 409 `lane_engine` — the engine changed under us; re-resolve.
        case laneEngine
        /// 503 `primary_unreachable` / transport down.
        case unreachable
        case unknown

        var note: String {
            switch self {
            case .serverTooOld: return "This server is too old to switch the chat model"
            case .rejected: return "The server didn't accept that model"
            case .laneEngine: return "This conversation runs a session now — reloading"
            case .unreachable: return ComposerControlsModel.unreachableNote
            case .unknown: return "That switch didn't go through"
            }
        }
    }

    static func writeOutcome(for error: Error) -> WriteFailure {
        guard let api = error as? APIError else { return .unknown }
        switch api {
        case .network: return .unreachable
        case .server(let status, let code, _, _, _):
            switch code {
            case "primary_unreachable", "bridge_offline": return .unreachable
            case "unknown_model": return .rejected
            case "lane_engine": return .laneEngine
            default: break
            }
            if status == 404 || status == 405 || status == 501 { return .serverTooOld }
            return status >= 500 ? .unreachable : .rejected
        default: return .unknown
        }
    }

    func pick(model id: String) async {
        guard !applying, id != currentModelID else { return }
        let target = writeTarget
        let previous = currentModelID
        let previousEffort = currentEffort
        applying = true
        currentModelID = id                       // optimistic
        statusNote = nil
        defer { applying = false }
        do {
            switch target {
            case .session(let sessionID):
                let result = try await api.setSessionModel(id: sessionID, model: id)
                // Adopt the server's read-back: the CLI may have substituted a
                // value, and showing what we ASKED for would be a quiet lie.
                if let effective = result.effectiveModel, !effective.isEmpty {
                    currentModelID = models.contains(where: { $0.id == effective }) ? effective : id
                }
                // Switching models can change the effort axis; re-read it.
                if effortLevelsForCurrentModel.isEmpty { currentEffort = nil }
            case .chat(let agentID, let conversationID):
                let result = try await api.setChatModel(
                    agentID: agentID, conversationID: conversationID, model: id
                )
                if let effective = result.model, !effective.isEmpty {
                    currentModelID = models.contains(where: { $0.id == effective }) ? effective : id
                }
                // Here the server owns the effort read-back (the model change may
                // have dropped it), so adopt it verbatim.
                currentEffort = result.effort
            case .mintLaneSession, .none:
                // Nothing resolved to write to: undo and say so, rather than
                // leaving a name the box never agreed to.
                currentModelID = previous
                statusNote = Self.unreachableNote
                return
            }
            AppLog.info("chat", "composer model switched", ["model": id])
        } catch let error as APIError where error.isCancelled {
            currentModelID = previous
        } catch {
            currentModelID = previous
            currentEffort = previousEffort
            let failure = Self.writeOutcome(for: error)
            statusNote = failure.note
            AppLog.info("chat", "composer model switch failed", [
                "model": id, "verdict": String(describing: failure),
                "error": error.localizedDescription,
            ])
            if failure == .laneEngine { refresh() }
        }
    }

    func pick(effort: String) async {
        guard !applying, effort != currentEffort else { return }
        let target = writeTarget
        let previous = currentEffort
        applying = true
        currentEffort = effort
        statusNote = nil
        defer { applying = false }
        do {
            switch target {
            case .session(let sessionID):
                let result = try await api.setSessionEffort(id: sessionID, effort: effort)
                // `overridden` means the CLI is really using something else —
                // adopt the truth so the pill matches the run.
                if let effective = result.effectiveEffort, !effective.isEmpty {
                    currentEffort = effective
                }
            case .chat(let agentID, let conversationID):
                let result = try await api.setChatModel(
                    agentID: agentID, conversationID: conversationID, effort: effort
                )
                if let effective = result.effort, !effective.isEmpty {
                    currentEffort = effective
                }
            case .mintLaneSession, .none:
                currentEffort = previous
                statusNote = Self.unreachableNote
                return
            }
            AppLog.info("chat", "composer effort switched", ["effort": effort])
        } catch let error as APIError where error.isCancelled {
            currentEffort = previous
        } catch {
            currentEffort = previous
            let failure = Self.writeOutcome(for: error)
            statusNote = failure.note
            AppLog.info("chat", "composer effort switch failed", [
                "effort": effort, "verdict": String(describing: failure),
                "error": error.localizedDescription,
            ])
            if failure == .laneEngine { refresh() }
        }
    }
}
