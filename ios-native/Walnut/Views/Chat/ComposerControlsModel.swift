import SwiftUI

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
/// in-process, so the one situation where the answer was unknown was also the
/// one that looked most authoritative. Unknown is now its own state
/// (`unreachable`): last known name, no invented list, and a retry.
///
/// The decision itself is a pure function (`pillPlan`) so every variant is
/// unit-testable without a network: one engine payload (or one classified
/// failure) in, the whole pill state out.
///
/// An answer is never final: `ComposerModelRefreshPolicy` decides when to ask
/// again (a retry ladder after a failure, a recheck of a suspect answer,
/// re-validation of a settled one), and this class only carries out what it
/// decides. Two rules sit on top of that:
///  - Nothing a load learns is shown while a menu is open (`setMenuPresented`):
///    it waits, and lands when the menu has closed.
///  - Each source (conversation or session) has its own model. A switch shows the
///    new source's own last known model, its fallback, or a neutral placeholder,
///    and never the previous source's.
@Observable
@MainActor
final class ComposerControlsModel {
    @ObservationIgnored private let api: ComposerModelTransport
    /// Injected so tests move time instead of sleeping.
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void

    /// Where the switchable model lives. `.session` is known up front;
    /// `.chat` has to ask the engine first.
    enum Source: Hashable {
        case session(id: String)
        case chat(agentID: String, conversationID: String?)
    }

    /// Where a pick is WRITTEN. Resolved from the engine lookup, never guessed.
    enum WriteTarget: Equatable {
        /// Nothing is writable (unknown engine, or nothing resolved yet).
        case none
        /// `POST /sessions/:id/model` + `/effort`: a real CLI session.
        case session(id: String)
        /// `PUT /chat/model`: the in-process engine's per-conversation model.
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
        /// landed. The model is UNKNOWN: not fixed, and never the replica's own.
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
        /// A one-model in-process catalog: what an OLD replica says about itself
        /// while the Mac is away (a current server never answers in-process through
        /// a replica). Usable, but rechecked within seconds.
        var suspect = false
    }

    /// Which pick is being written, so the spinner sits on the pill that asked.
    enum PickKind: Equatable { case model, effort }

    /// What a pill takes and how it reads, decided here for both pills so the
    /// view has one value to draw from (`ComposerPillInk.ink(for:)`), not flags
    /// it could combine its own way. The gate's mutation of the view's ink
    /// choice (`enabled ? .enabled : .disabled`) made the name being written
    /// 1.69:1 and survived every test; `testAPickWritesTheTappedModelAndThePillsWaitForTheWrite`
    /// now measures the drawn text.
    enum PillState: Equatable {
        /// Takes taps.
        case ready
        /// Its own pick is being written: readable, a spinner, no taps.
        case writing
        /// Waiting on something else (the other pill's write, a switch): quiet,
        /// no taps.
        case waiting
        /// The last known value while the Mac is away: readable, no taps.
        case lastKnown

        var takesTaps: Bool { self == .ready }
        var spins: Bool { self == .writing }
    }

    /// Identifies the state a menu was built from (see `PillMenu.token`).
    struct MenuToken: Equatable {
        let generation: Int
        let version: Int
    }

    private(set) var models: [SessionModelOptions.Model] = []
    private(set) var currentModelID: String?
    private(set) var currentEffort: String?
    private(set) var applyingWhat: PickKind?
    var applying: Bool { applyingWhat != nil }
    /// True from a source change until that source's first answer: the pill shows
    /// what it can (last known, fallback, placeholder) but nothing is writable yet.
    private(set) var resolving = false
    /// A pill was showing when the source changed, so it keeps its seat in the row
    /// with the neutral placeholder rather than vanishing mid-switch.
    private(set) var holdsSeat = false
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
    /// Bumps whenever a load or a source change replaces what the menus show.
    private(set) var displayVersion = 0

    @ObservationIgnored private var source: Source?
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    // Refresh bookkeeping. None of it is observed: no view reads it, and a
    // re-validation must not invalidate the composer's body just by starting.
    /// Bumps on every source change. A load, a timer or a pick from an older
    /// generation never writes (switching conversations mid-load or mid-pick).
    @ObservationIgnored private var generation = 0
    /// Identifies the ONE current load; a superseded load's answer is dropped.
    @ObservationIgnored private var loadToken = 0
    @ObservationIgnored private var loadStartedAt: Date?
    @ObservationIgnored private var lastSuccessAt: Date?
    @ObservationIgnored private var lastFailureAt: Date?
    @ObservationIgnored private var consecutiveFailures = 0
    @ObservationIgnored private var suspectAnswers = 0
    /// A re-ask owed once whatever is in flight settles.
    @ObservationIgnored private var followUpOwed = false
    /// The composer's view is mounted (between its appear and its disappear, and
    /// re-asserted when the app returns). One input of `isOnScreen`, never the
    /// whole answer.
    @ObservationIgnored private var appeared = false
    /// Where the composer sits, and the dock that says which surface is in front.
    @ObservationIgnored private var surface: ComposerSurfaceID = .unattached
    @ObservationIgnored private weak var dock: FilePreviewDock?
    /// `isOnScreen` as last acted on, so each edge is acted on once.
    @ObservationIgnored private var wasOnScreen = false
    @ObservationIgnored private var sceneActive = true
    @ObservationIgnored private var wakeTask: Task<Void, Never>?
    /// The scheduled re-ask, readable so tests can assert the cadence without
    /// waiting for it.
    @ObservationIgnored private(set) var scheduledWake: ComposerModelRefreshPolicy.Wake?
    /// Which of this composer's menus are on screen (the model pill's, the effort
    /// pill's). UIKit shows one at a time; a set keeps a fast hand-over honest.
    @ObservationIgnored private var presentedMenus: Set<String> = []
    /// An answer that landed while a menu was open, applied when it closes.
    @ObservationIgnored private(set) var stagedPlan: PillPlan?
    /// Each source's own last known model, so a switch never shows another's.
    @ObservationIgnored private var lastKnownBySource: [Source: LastKnown] = [:]
    @ObservationIgnored private var pickSerial = 0
    /// The write a menu tap started, so a test can wait for it.
    @ObservationIgnored private var pickTask: Task<Void, Never>?

    nonisolated static let unreachableNote = "Can't reach your Mac right now"
    nonisolated static let unusableNote = "Couldn't read the model list"
    /// The pill's name when nothing true is known: the retry state before any
    /// answer, or a switch to a source with no memory yet.
    static let placeholderLabel = "Model"

    init(
        transport: ComposerModelTransport = WalnutAPI(),
        now: @escaping () -> Date = Date.init,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(for: .seconds(seconds))
        }
    ) {
        self.api = transport
        self.now = now
        self.sleep = sleep
    }

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
        self.api = WalnutAPI()
        self.now = Date.init
        self.sleep = { seconds in try await Task.sleep(for: .seconds(seconds)) }
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

    // MARK: - Labels

    /// What the model pill shows: the current model's SHORT name ("Opus 5").
    /// nil = show no pill at all.
    var pillLabel: String? {
        if let name = currentModelLabel { return name }
        // Nothing true to name, but the pill has something to offer: the retry
        // state, or a switch in progress. A neutral word, never another
        // conversation's model.
        if unreachable || (resolving && holdsSeat) { return Self.placeholderLabel }
        return nil
    }

    /// What VoiceOver (and a UI test) reads for the model pill: the name, whether
    /// it is only the LAST KNOWN one, or that nothing is known.
    var pillAccessibilityLabel: String {
        guard let label = pillLabel else { return "Model" }
        guard currentModelLabel != nil else { return "Model: unknown" }
        return unreachable ? "Model: \(label), last known" : "Model: \(label)"
    }

    /// The effort pill: the current level ("High"), or nil when there is nothing
    /// to set (the model has no effort axis, or it isn't established).
    ///
    /// With the Mac away it keeps the LAST KNOWN level of this source, like the
    /// model pill keeps its name (it used to vanish, and "High" with it). It then
    /// takes no taps (`effortPillState`): there is nothing to write to.
    var effortPillLabel: String? {
        guard pillLabel != nil, !readOnly else { return nil }
        guard !effortLevelsForCurrentModel.isEmpty else { return nil }
        if let currentEffort, !currentEffort.isEmpty { return Self.effortLabel(currentEffort) }
        return unreachable ? nil : "Effort"
    }

    var effortPillAccessibilityLabel: String {
        guard let label = effortPillLabel else { return "Effort" }
        return unreachable ? "Effort: \(label), last known" : "Effort: \(label)"
    }

    /// Both pills take a tap only when a pick has somewhere true to go.
    var pillEnabled: Bool { !applying && !resolving }

    var modelPillState: PillState {
        if applyingWhat == .model { return .writing }
        return pillEnabled ? .ready : .waiting
    }

    var effortPillState: PillState {
        if applyingWhat == .effort { return .writing }
        if unreachable { return .lastKnown }
        return pillEnabled ? .ready : .waiting
    }

    /// The pill names a model the catalog does not list: its raw id (a custom
    /// proxy model), which can be as long as a sentence. The pill shortens it
    /// in the middle instead of growing without end (gate r3 P2-3: a 5-line
    /// circle at AX5). Catalog names are never shortened.
    var pillLabelIsRawID: Bool {
        currentModelLabel != nil && ModelCatalogRowLabel.activeRow(in: models, for: currentModelID) == nil
    }

    private var currentModelLabel: String? {
        if let row = ModelCatalogRowLabel.activeRow(in: models, for: currentModelID) {
            // The catalog's label is a bare family ("Opus"); the id carries the
            // version. Prefer the versioned name, exactly like the web's
            // catalogRowLabel, so the pill says "Opus 5" not "Opus". An alias row
            // ("opus", "default") names its version only in `resolvedModel`, so
            // read that first: the pill then agrees with the checked row.
            let source = row.resolvedModel ?? row.id
            let versioned = WalnutSession.shortModelName(source)
            return versioned == source ? row.label : versioned
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
    /// axis, so no effort pill.
    var effortLevelsForCurrentModel: [String] {
        guard let row = ModelCatalogRowLabel.activeRow(in: models, for: currentModelID) else { return [] }
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

    // MARK: - Menus (pure over the state)

    var menuToken: MenuToken { MenuToken(generation: generation, version: displayVersion) }

    /// The model pill's menu. In the retry state: the reason and a Retry, exactly
    /// where the (unknowable) list would be. Read-only: WHY there is nothing to
    /// pick. Otherwise the catalog in the Mac's order (`ModelCatalogRowLabel.menuRows`).
    /// The heading carries a just-failed write's reason, so a pill that snapped
    /// back says why on the next open (the composer row has no toast surface).
    var modelMenu: PillMenu {
        if unreachable {
            return PillMenu(sections: [.init(
                title: statusNote ?? Self.unreachableNote,
                items: [.init(
                    title: "Retry", choice: .retry, systemImage: "arrow.clockwise",
                    accessibilityID: "composer.modelPill.retry"
                )]
            )], token: menuToken)
        }
        if readOnly {
            return PillMenu(sections: [.init(
                title: readOnlyReason ?? "Model can't be changed here",
                items: [.init(title: pillLabel ?? Self.placeholderLabel, choice: .none, enabled: false)]
            )], token: menuToken)
        }
        let rows = ModelCatalogRowLabel.menuRows(models: models, currentModelID: currentModelID)
        let current = rows.first(where: \.checked)?.title ?? pillLabel
        return PillMenu(sections: [.init(
            title: Self.heading("Model", current: current),
            items: rows.map { row in
                .init(
                    title: row.title,
                    choice: row.kind == .catalog ? .model(row.id) : .none,
                    checked: row.checked,
                    enabled: row.kind == .catalog
                )
            }
        )], token: menuToken, title: statusNote ?? "")
    }

    /// The effort pill's menu: only the levels the CURRENT model declares, so a
    /// 409 from the server is unreachable through the UI.
    var effortMenu: PillMenu {
        let current = currentEffort.flatMap { $0.isEmpty ? nil : Self.effortLabel($0) }
        return PillMenu(sections: [.init(
            title: Self.heading("Effort", current: current),
            items: effortLevelsForCurrentModel.map { level in
                .init(title: Self.effortLabel(level), choice: .effort(level), checked: level == currentEffort)
            }
        )], token: menuToken, title: statusNote ?? "")
    }

    /// A menu's heading names the current value ("Effort: Extra High"): at the
    /// accessibility sizes the list scrolls, and the checked row can open out of
    /// view (gate r3 P2-4: "Extra High" cut off at the bottom of the AX5 menu).
    /// A just-failed write's reason goes above it, as the menu's own title.
    static func heading(_ axis: String, current: String?) -> String {
        guard let current, !current.isEmpty else { return axis }
        return "\(axis): \(current)"
    }

    /// A row was tapped. A tap on a menu built from a state that has since been
    /// replaced (an answer that waited for the menu to close, applied before
    /// UIKit delivered the tap) is dropped: its row may not exist any more, and
    /// the fresh list is one tap away.
    func menuSelect(_ choice: PillMenu.Choice, token: MenuToken) {
        // Records the order of UIKit's two callbacks (the tap and the close):
        // `menuOpen` says whether the close had already landed.
        AppLog.info("chat", "composer model: menu tap", [
            "choice": String(describing: choice), "menuOpen": menuPresented ? "yes" : "no",
            "staged": stagedPlan == nil ? "no" : "yes", "current": token == menuToken ? "yes" : "no",
        ])
        switch choice {
        case .none:
            return
        case .retry:
            refresh()
        case .model(let id):
            guard token == menuToken else { return dropStaleTap(choice) }
            guard let request = beginModelPick(id) else { return }
            pickTask = Task { await self.writeModelPick(request) }
        case .effort(let level):
            guard token == menuToken else { return dropStaleTap(choice) }
            guard let request = beginEffortPick(level) else { return }
            pickTask = Task { await self.writeEffortPick(request) }
        }
    }

    private func dropStaleTap(_ choice: PillMenu.Choice) {
        AppLog.info("chat", "composer model: dropped a tap on a replaced menu", [
            "choice": String(describing: choice),
        ])
    }

    /// A menu of this composer opened or closed. While one is open, a landed
    /// answer waits (`stagedPlan`); on close it is applied. The rule is absolute
    /// because the gate reproduced the alternative: an answer that changed the
    /// row set while the menu was up rebuilt it under the finger, and the tap
    /// picked a model the user never chose.
    func setMenuPresented(_ presented: Bool, menu id: String = "model") {
        let wasPresented = menuPresented
        if presented { presentedMenus.insert(id) } else { presentedMenus.remove(id) }
        guard wasPresented != menuPresented else { return }
        AppLog.info("chat", presented ? "composer model: menu opened" : "composer model: menu closed", [
            "menu": id, "staged": stagedPlan == nil ? "no" : "yes",
        ])
        if !menuPresented, let staged = stagedPlan {
            stagedPlan = nil
            applyNow(staged)
        }
    }

    var menuPresented: Bool { !presentedMenus.isEmpty }

    // MARK: - The decision (pure)

    /// The whole pill state from ONE engine lookup. No network, no clock, no
    /// stored state beyond what is passed in, so every branch below is a unit
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
                let sent = info.models ?? []
                let catalog = sent.isEmpty ? singleRowCatalog(for: info.model ?? lastKnown.modelID) : sent
                return PillPlan(
                    models: catalog,
                    currentModelID: info.model ?? lastKnown.modelID,
                    currentEffort: info.effort,
                    writeTarget: .chat(agentID: agentID, conversationID: conversationID),
                    suspect: sent.isEmpty && catalog.count <= 1
                )
            }
            // Lane engine, no session yet: MINT one. This used to be a read-only
            // "Send a message first", which meant the ordinary chat had no working
            // model control until the conversation had been used, while a task's
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

    /// Unknown, not fixed: keep the last true name, offer NO list we can't honor
    /// (the menu is only the reason and a Retry), and let the menu carry the retry.
    ///
    /// The last known CATALOG is kept all the same, because the name comes from it:
    /// a row's label ("GPT-6 Astra") or its resolved model ("Opus 5.5" for
    /// `default`). Dropped, the pill fell back to the raw id and read
    /// "gpt-6-astra, last known" (gate r2 D3). It is this source's own catalog:
    /// `lastKnown` is what this conversation showed, never another's.
    private static func retryPlan(note: String, lastKnown: LastKnown) -> PillPlan {
        PillPlan(
            models: lastKnown.models,
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

    /// The new chat got its id on its first send: the SAME conversation, so its
    /// pill stays exactly as it is. Every other change is another conversation.
    static func isSameConversationGettingItsID(_ previous: Source?, _ next: Source) -> Bool {
        guard case .chat(let before, nil) = previous, case .chat(let after, let id?) = next else { return false }
        return before == after && !id.isEmpty
    }

    // MARK: - Source

    /// Point this model at a source and load it. Cheap to call on every appear:
    /// an identical source is a no-op (re-asking is `revalidate`'s job).
    ///
    /// A DIFFERENT source starts a new generation: whatever the old source had in
    /// flight, scheduled or being written is dropped, and nothing it answers can
    /// land here. The pill shows the new source's own last known model (or its
    /// fallback, or the placeholder) until its first answer.
    func attach(_ next: Source, fallbackModel: String? = nil) {
        let fallback = fallbackModel.flatMap { $0.isEmpty ? nil : $0 }
        guard source != next else {
            if let fallback, fallbackLabel != fallback { fallbackLabel = fallback }
            return
        }
        let previous = source
        let hadPill = pillLabel != nil
        source = next
        generation += 1
        // A pick still being written belongs to the previous source. Its answer is
        // dropped by the generation check, and it must not hold this source's pill.
        applyingWhat = nil
        stagedPlan = nil
        fallbackLabel = fallback
        var display: PillPlan
        if Self.isSameConversationGettingItsID(previous, next) {
            display = displayedPlan
            display.writeTarget = .none
        } else if let known = lastKnownBySource[next] {
            display = PillPlan(models: known.models, currentModelID: known.modelID, currentEffort: known.effort)
        } else {
            display = PillPlan()
        }
        resolving = true
        holdsSeat = hadPill
        displayVersion &+= 1
        present(display)
        lastSuccessAt = nil
        lastFailureAt = nil
        consecutiveFailures = 0
        suspectAnswers = 0
        followUpOwed = false
        cancelWake()
        startLoad()
    }

    /// Re-ask now. This is the Retry button, so it is never gated on the previous
    /// outcome, and it restarts the retry ladder at its first rung.
    func refresh() {
        revalidate(.manual)
    }

    /// Something happened that may have changed the answer. The policy decides
    /// whether that is worth a request; this only carries the decision out.
    func revalidate(_ trigger: ComposerModelRefreshPolicy.Trigger) {
        guard source != nil else { return }
        let decision = ComposerModelRefreshPolicy.decide(trigger, snapshot, now: now())
        switch decision {
        case .loadNow:
            if ComposerModelRefreshPolicy.resetsBackoff(trigger) {
                consecutiveFailures = 0
                suspectAnswers = 0
            }
            AppLog.info("chat", "composer model: re-asking", ["trigger": trigger.rawValue])
            startLoad()
        case .afterCurrent:
            followUpOwed = true
        case .skip:
            reschedule()
        }
    }

    /// The composer's view appeared (or the app returned with it still mounted),
    /// or it disappeared. Whether that puts the pill on screen is `isOnScreen`.
    func setVisible(_ isVisible: Bool) {
        appeared = isVisible
        onScreenMayHaveChanged()
    }

    /// Which surface this composer is on, and the dock that knows which surface is
    /// in front. The pill then follows the surface ITSELF: a retained tab's
    /// composer gets no disappear, and no view update, when the user switches
    /// tabs, so a SwiftUI callback could not carry this (gate r2 D4).
    func follow(surface: ComposerSurfaceID, dock: FilePreviewDock?) {
        self.surface = surface
        if self.dock !== dock {
            self.dock = dock
            observeSurfaceInFront()
        }
        onScreenMayHaveChanged()
    }

    /// The pill's one on-screen rule (`ComposerModelRefreshPolicy.composerOnScreen`),
    /// read live wherever a decision is made.
    var isOnScreen: Bool {
        ComposerModelRefreshPolicy.composerOnScreen(
            appeared: appeared, surface: surface, activeSurface: dock?.activeComposerSurface
        )
    }

    private func observeSurfaceInFront() {
        guard let dock else { return }
        // Fires once, on the next change; re-armed each time. A replaced dock's
        // tracking ends at its next change instead of re-arming.
        withObservationTracking {
            _ = dock.activeComposerSurface
        } onChange: { [weak self, weak dock] in
            Task { @MainActor [weak self] in
                guard let self, let dock, self.dock === dock else { return }
                self.onScreenMayHaveChanged()
                self.observeSurfaceInFront()
            }
        }
    }

    /// Act on an on-screen edge once. Coming on screen may re-ask a stale answer.
    /// Going off means no timers at all, and no menu: one left marked open would
    /// hold every answer.
    private func onScreenMayHaveChanged() {
        let onScreen = isOnScreen
        guard onScreen != wasOnScreen else { return }
        wasOnScreen = onScreen
        if onScreen {
            revalidate(.appeared)
        } else {
            cancelWake()
            if menuPresented {
                presentedMenus.removeAll()
                if let staged = stagedPlan {
                    stagedPlan = nil
                    applyNow(staged)
                }
            }
        }
    }

    /// The app's scene phase. Background stops every timer (no background loop);
    /// becoming active is itself a re-ask, since the world changed while away.
    /// Edge-triggered, so the composer may report the phase on every appear.
    func setSceneActive(_ isActive: Bool) {
        guard sceneActive != isActive else { return }
        sceneActive = isActive
        if isActive { revalidate(.foreground) } else { cancelWake() }
    }

    private var snapshot: ComposerModelRefreshPolicy.Snapshot {
        .init(
            active: isOnScreen && sceneActive,
            applying: applying,
            loadStartedAt: loadStartedAt,
            lastSuccessAt: lastSuccessAt,
            lastFailureAt: lastFailureAt,
            consecutiveFailures: consecutiveFailures,
            suspectAnswers: suspectAnswers
        )
    }

    // MARK: - Display

    /// What a new plan builds on: the staged answer when one is waiting (it is
    /// the newest thing known), else what is shown.
    private var knowledge: LastKnown {
        if let stagedPlan {
            return LastKnown(models: stagedPlan.models, modelID: stagedPlan.currentModelID, effort: stagedPlan.currentEffort)
        }
        return LastKnown(models: models, modelID: currentModelID, effort: currentEffort)
    }

    private var displayedPlan: PillPlan {
        PillPlan(
            models: models, currentModelID: currentModelID, currentEffort: currentEffort,
            readOnly: readOnly, readOnlyReason: readOnlyReason, unreachable: unreachable,
            statusNote: statusNote, writeTarget: writeTarget
        )
    }

    /// Show a plan, or hold it while a menu is open.
    private func present(_ plan: PillPlan) {
        if menuPresented {
            stagedPlan = plan
            return
        }
        applyNow(plan)
    }

    private func applyNow(_ incoming: PillPlan) {
        var plan = incoming
        plan.suspect = false
        // Name the current model by its catalog row, the way the server names
        // `current`, so the checkmark, the pill and a pick all agree on one id.
        if let row = ModelCatalogRowLabel.activeRow(in: plan.models, for: plan.currentModelID) {
            plan.currentModelID = row.id
        }
        if plan != displayedPlan { displayVersion &+= 1 }
        models = plan.models
        currentModelID = plan.currentModelID
        currentEffort = plan.currentEffort
        readOnly = plan.readOnly
        readOnlyReason = plan.readOnlyReason
        unreachable = plan.unreachable
        statusNote = plan.statusNote
        writeTarget = plan.writeTarget
        remember()
    }

    /// Keep this source's last known model for the next switch back to it. A new
    /// chat is a different conversation every time, so it keeps nothing.
    private func remember() {
        guard let source, !resolving, !unreachable, let currentModelID, !currentModelID.isEmpty else { return }
        if case .chat(_, nil) = source { return }
        lastKnownBySource[source] = LastKnown(models: models, modelID: currentModelID, effort: currentEffort)
    }

    // MARK: - Load

    /// Which load, of which source, is allowed to write.
    private struct LoadTicket {
        let generation: Int
        let token: Int
    }

    private enum LoadOutcome {
        /// A usable answer landed (including an honest read-only one).
        case settled(PillPlan)
        /// Unreachable or unusable: the retry ladder takes over.
        case failed(PillPlan)
        /// Replaced by a newer load, a source change, or a pick. Touches nothing.
        case superseded
    }

    /// The one current load may write; anything older may not. Checked after
    /// EVERY await, because a source switch or a pick can land at any of them.
    private func isCurrent(_ ticket: LoadTicket) -> Bool {
        ticket.generation == generation && ticket.token == loadToken && !Task.isCancelled
    }

    /// Start a load, replacing any in flight. The current list and pill stay
    /// exactly as they are until the new answer lands (no blanking on refresh).
    private func startLoad() {
        guard source != nil else { return }
        cancelWake()
        loadTask?.cancel()
        loadToken += 1
        loadStartedAt = now()
        let ticket = LoadTicket(generation: generation, token: loadToken)
        loadTask = Task { [weak self] in
            guard let self else { return }
            let outcome = await self.load(ticket)
            self.finish(ticket, outcome)
        }
    }

    private func finish(_ ticket: LoadTicket, _ outcome: LoadOutcome) {
        // A superseded load's bookkeeping belongs to whoever replaced it.
        guard ticket.generation == generation, ticket.token == loadToken else { return }
        loadStartedAt = nil
        switch outcome {
        case .settled(let plan):
            consecutiveFailures = 0
            suspectAnswers = plan.suspect ? suspectAnswers + 1 : 0
            lastSuccessAt = now()
            lastFailureAt = nil
            resolving = false
            present(plan)
            if plan.suspect {
                let rechecking = suspectAnswers <= ComposerModelRefreshPolicy.recheckDelays.count
                AppLog.info("chat", rechecking
                    ? "composer model: suspect one-model answer, rechecking"
                    : "composer model: suspect one-model answer, rechecks used up, TTL from here", [
                    "suspectAnswers": String(suspectAnswers),
                ])
            }
        case .failed(let plan):
            consecutiveFailures += 1
            suspectAnswers = 0
            lastFailureAt = now()
            resolving = false
            present(plan)
        case .superseded:
            break
        }
        settleFollowUp()
    }

    /// Pay a re-ask owed from while something was in flight, or arm the timer.
    private func settleFollowUp() {
        if followUpOwed {
            followUpOwed = false
            revalidate(.followUp)
        } else {
            reschedule()
        }
    }

    /// Drop the in-flight load (if any) and owe a re-ask in its place. Used by a
    /// pick: an answer from before the pick can only carry the old model.
    private func supersedeInFlightLoad() {
        guard loadStartedAt != nil else { return }
        loadTask?.cancel()
        loadToken += 1
        loadStartedAt = nil
        followUpOwed = true
    }

    private func load(_ ticket: LoadTicket) async -> LoadOutcome {
        guard let source else { return .superseded }
        switch source {
        case .session(let id):
            // A session's model always lives on the session: no engine lookup.
            var base = PillPlan(
                models: knowledge.models, currentModelID: knowledge.modelID,
                currentEffort: knowledge.effort
            )
            base.writeTarget = .session(id: id)
            return await loadSessionCatalog(id, base: base, ticket)
        case .chat(let agentID, let conversationID):
            let lookup: EngineLookup
            do {
                lookup = .engine(
                    try await api.chatEngine(agentID: agentID, conversationID: conversationID)
                )
            } catch let error as APIError where error.isCancelled {
                return .superseded
            } catch {
                lookup = Self.lookup(afterFailing: error)
                AppLog.info("chat", "composer model: engine lookup failed", [
                    "agentId": agentID,
                    "verdict": lookup == .unreachable ? "unreachable" : "unusable",
                    "failures": String(consecutiveFailures + 1),
                    "error": error.localizedDescription,
                ])
            }
            guard isCurrent(ticket) else { return .superseded }
            var plan = Self.pillPlan(
                for: lookup, agentID: agentID, conversationID: conversationID,
                lastKnown: knowledge
            )
            if plan.unreachable { return .failed(plan) }
            switch plan.writeTarget {
            case .session(let id):
                return await loadSessionCatalog(id, base: plan, ticket)
            case .mintLaneSession(let agentID, let conversationID):
                switch await mintLaneSession(agentID: agentID, conversationID: conversationID) {
                case .minted(let minted):
                    guard isCurrent(ticket) else { return .superseded }
                    plan.writeTarget = .session(id: minted)
                    return await loadSessionCatalog(minted, base: plan, ticket)
                case .refused(let reason):
                    guard isCurrent(ticket) else { return .superseded }
                    plan.readOnly = true
                    plan.readOnlyReason = reason
                    plan.writeTarget = .none
                    return .settled(plan)
                case .unreachable(let lookup):
                    guard isCurrent(ticket) else { return .superseded }
                    // A blip, not a verdict: the retry ladder owns it. This used to
                    // go read-only for good, the same "never asks again" trap.
                    return .failed(Self.pillPlan(
                        for: lookup, agentID: agentID, conversationID: conversationID,
                        lastKnown: knowledge
                    ))
                case .cancelled:
                    return .superseded
                }
            case .chat, .none:
                // In-process (or locked): the engine payload already IS the answer.
                return .settled(plan)
            }
        }
    }

    private func loadSessionCatalog(_ sessionID: String, base: PillPlan, _ ticket: LoadTicket) async -> LoadOutcome {
        do {
            let options = try await api.sessionModelOptions(id: sessionID)
            guard isCurrent(ticket) else { return .superseded }
            var plan = base
            plan.models = options.models
            plan.currentModelID = options.current ?? base.currentModelID
            plan.currentEffort = options.currentEffort
            plan.readOnly = false
            plan.readOnlyReason = nil
            plan.unreachable = false
            plan.statusNote = nil
            plan.writeTarget = .session(id: sessionID)
            return .settled(plan)
        } catch let error as APIError where error.isCancelled {
            return .superseded
        } catch {
            guard isCurrent(ticket) else { return .superseded }
            // The catalog is unreachable (offline / old server / cloud relay
            // down). Same verdict as a failed engine lookup: keep the true name
            // we have (named by the catalog we last had, see `retryPlan`), offer
            // no list we can't honor, and retry on the ladder.
            AppLog.info("chat", "composer model: catalog unavailable", [
                "sessionId": sessionID, "failures": String(consecutiveFailures + 1),
                "error": error.localizedDescription,
            ])
            return .failed(Self.pillPlan(
                for: Self.lookup(afterFailing: error), agentID: "", conversationID: nil,
                lastKnown: LastKnown(
                    models: base.models, modelID: base.currentModelID ?? fallbackLabel, effort: base.currentEffort
                )
            ))
        }
    }

    private enum MintOutcome {
        case minted(String)
        /// The box answered, and the answer is "no session here": honest read-only.
        case refused(String)
        /// The box could not be reached: retry, never a read-only verdict.
        case unreachable(EngineLookup)
        case cancelled
    }

    /// Mint this conversation's lane session.
    ///
    /// A 409 means the box is not on the lane engine after all (the config
    /// changed between the GET and this POST), and a 404 is a server without the
    /// endpoint: both are answers, so the pill goes read-only with the reason. A
    /// transport failure or a 5xx is NOT an answer, and gets the retry ladder.
    private func mintLaneSession(agentID: String, conversationID: String?) async -> MintOutcome {
        do {
            let minted = try await api.chatEngineSession(agentID: agentID, conversationID: conversationID)
            guard let id = minted.switchableSessionId else {
                return .refused("This conversation has no session to switch the model on.")
            }
            return .minted(id)
        } catch let error as APIError where error.isCancelled {
            return .cancelled
        } catch {
            AppLog.info("chat", "composer model: lane mint failed", [
                "agentId": agentID, "error": error.localizedDescription,
            ])
            let lookup = Self.lookup(afterFailing: error)
            if lookup == .unreachable { return .unreachable(lookup) }
            // Old server without the endpoint, or a 409. Degrade to the previous
            // behaviour rather than losing the pill: the model still becomes
            // switchable after the first message, which is what this box could do.
            return .refused(
                "Send a message first: the model can be switched once this conversation has a session."
            )
        }
    }

    // MARK: - Timer

    private func cancelWake() {
        wakeTask?.cancel()
        wakeTask = nil
        scheduledWake = nil
    }

    /// Arm the ONE scheduled re-ask the policy asks for (a retry, a recheck or a
    /// TTL), or none. Every state change comes through here, so there is never a
    /// second.
    private func reschedule() {
        cancelWake()
        guard let wake = ComposerModelRefreshPolicy.nextWake(snapshot, now: now()) else { return }
        scheduledWake = wake
        let expected = generation
        let sleep = self.sleep
        wakeTask = Task { [weak self] in
            do { try await sleep(wake.delay) } catch { return }
            guard !Task.isCancelled else { return }
            self?.fireWake(generation: expected)
        }
    }

    private func fireWake(generation expected: Int) {
        guard expected == generation, let wake = scheduledWake else { return }
        wakeTask = nil
        scheduledWake = nil
        revalidate(wake.trigger)
    }

    /// Test seam: fire the scheduled re-ask now instead of waiting for it.
    func fireScheduledWakeForTesting() {
        wakeTask?.cancel()
        fireWake(generation: generation)
    }

    /// Test seam: wait for a menu-started write, then until no load is running
    /// (following any follow-up chain).
    func settleForTesting() async {
        if let pickTask {
            await pickTask.value
            self.pickTask = nil
        }
        var seen = -1
        while seen != loadToken, let task = loadTask {
            seen = loadToken
            await task.value
        }
    }

    // MARK: - Picks

    /// Why a write snapped back. Pure + testable: the note is what the picker
    /// shows on its next open (a composer row has no toast surface of its own).
    enum WriteFailure: Equatable {
        /// 404/405/501 from a route this box predates.
        case serverTooOld
        /// 404 `not_found` from a session write: the box no longer has the session.
        case sessionNotFound
        /// 400 `unknown_model`: the box refused the value.
        case rejected
        /// 409 `lane_engine`: the engine changed under us; re-resolve.
        case laneEngine
        /// 503 `primary_unreachable` / transport down.
        case unreachable
        case unknown

        var note: String {
            switch self {
            case .serverTooOld: return "This server is too old to switch the model here"
            case .sessionNotFound: return "The server no longer has this session"
            case .rejected: return "The server didn't accept that model"
            case .laneEngine: return "This conversation runs a session now, reloading"
            case .unreachable: return ComposerControlsModel.unreachableNote
            case .unknown: return "That switch didn't go through"
            }
        }
    }

    static func writeOutcome(for error: Error, target: WriteTarget = .none) -> WriteFailure {
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
            // The session routes are as old as API v1, so their 404 is the
            // session's, not a missing route's.
            if status == 404, code == "not_found", case .session = target { return .sessionNotFound }
            if status == 404 || status == 405 || status == 501 { return .serverTooOld }
            return status >= 500 ? .unreachable : .rejected
        default: return .unknown
        }
    }

    /// Which pick, of which source, is allowed to write back.
    private struct PickTicket {
        let generation: Int
        let serial: Int
    }

    private struct ModelPick {
        let id: String
        let target: WriteTarget
        let previous: String?
        let previousEffort: String?
        let ticket: PickTicket
    }

    private struct EffortPick {
        let level: String
        let target: WriteTarget
        let previous: String?
        let ticket: PickTicket
    }

    /// The source is still the one the pick was made on. A write that returns
    /// after a switch describes ANOTHER conversation, so it touches nothing.
    private func isCurrentPick(_ ticket: PickTicket) -> Bool {
        ticket.generation == generation
    }

    /// A pick WINS over any refresh: one that started before it can only carry
    /// the previous model, so it is dropped (and re-asked after the pick lands),
    /// an answer waiting for the menu to close is dropped for the same reason,
    /// and nothing new may start while the write is out.
    private func beginPick(_ kind: PickKind) -> PickTicket {
        supersedeInFlightLoad()
        if stagedPlan != nil {
            stagedPlan = nil
            followUpOwed = true
        }
        cancelWake()
        applyingWhat = kind
        pickSerial += 1
        return PickTicket(generation: generation, serial: pickSerial)
    }

    private func endPick(_ ticket: PickTicket) {
        // A newer source (or a newer pick) owns the pill now.
        guard isCurrentPick(ticket), ticket.serial == pickSerial else { return }
        applyingWhat = nil
        remember()
        settleFollowUp()
    }

    func pick(model id: String) async {
        guard let request = beginModelPick(id) else { return }
        await writeModelPick(request)
    }

    func pick(effort: String) async {
        guard let request = beginEffortPick(effort) else { return }
        await writeEffortPick(request)
    }

    /// The synchronous half: validate and show the pick optimistically, so a menu
    /// tap claims the pill before anything else can run.
    private func beginModelPick(_ id: String) -> ModelPick? {
        guard !applying, !resolving, id != currentModelID else { return nil }
        let request = ModelPick(
            id: id, target: writeTarget, previous: currentModelID,
            previousEffort: currentEffort, ticket: beginPick(.model)
        )
        currentModelID = id
        statusNote = nil
        return request
    }

    private func writeModelPick(_ request: ModelPick) async {
        defer { endPick(request.ticket) }
        do {
            switch request.target {
            case .session(let sessionID):
                let result = try await api.setSessionModel(id: sessionID, model: request.id)
                guard isCurrentPick(request.ticket) else { return }
                // Adopt the server's read-back: the CLI may have substituted a
                // value, and showing what we ASKED for would be a quiet lie.
                if let effective = result.effectiveModel, !effective.isEmpty {
                    currentModelID = ModelCatalogRowLabel.activeRow(in: models, for: effective)?.id ?? request.id
                }
                // Switching models can change the effort axis; re-read it.
                if effortLevelsForCurrentModel.isEmpty { currentEffort = nil }
            case .chat(let agentID, let conversationID):
                let result = try await api.setChatModel(
                    agentID: agentID, conversationID: conversationID, model: request.id, effort: nil
                )
                guard isCurrentPick(request.ticket) else { return }
                if let effective = result.model, !effective.isEmpty {
                    currentModelID = ModelCatalogRowLabel.activeRow(in: models, for: effective)?.id ?? request.id
                }
                // Here the server owns the effort read-back (the model change may
                // have dropped it), so adopt it verbatim.
                currentEffort = result.effort
            case .mintLaneSession, .none:
                // Nothing resolved to write to: undo and say so, rather than
                // leaving a name the box never agreed to.
                currentModelID = request.previous
                statusNote = Self.unreachableNote
                return
            }
            AppLog.info("chat", "composer model switched", ["model": request.id])
        } catch let error as APIError where error.isCancelled {
            guard isCurrentPick(request.ticket) else { return }
            currentModelID = request.previous
        } catch {
            guard isCurrentPick(request.ticket) else { return }
            currentModelID = request.previous
            currentEffort = request.previousEffort
            let failure = Self.writeOutcome(for: error, target: request.target)
            statusNote = failure.note
            AppLog.info("chat", "composer model switch failed", [
                "model": request.id, "verdict": String(describing: failure),
                "error": error.localizedDescription,
            ])
            // Owed, not immediate: the pick is still out, so this re-asks the
            // moment it settles.
            if failure == .laneEngine { refresh() }
        }
    }

    private func beginEffortPick(_ level: String) -> EffortPick? {
        guard !applying, !resolving, level != currentEffort else { return nil }
        let request = EffortPick(
            level: level, target: writeTarget, previous: currentEffort, ticket: beginPick(.effort)
        )
        currentEffort = level
        statusNote = nil
        return request
    }

    private func writeEffortPick(_ request: EffortPick) async {
        defer { endPick(request.ticket) }
        do {
            switch request.target {
            case .session(let sessionID):
                let result = try await api.setSessionEffort(id: sessionID, effort: request.level)
                guard isCurrentPick(request.ticket) else { return }
                // `overridden` means the CLI is really using something else:
                // adopt the truth so the pill matches the run.
                if let effective = result.effectiveEffort, !effective.isEmpty {
                    currentEffort = effective
                }
            case .chat(let agentID, let conversationID):
                let result = try await api.setChatModel(
                    agentID: agentID, conversationID: conversationID, model: nil, effort: request.level
                )
                guard isCurrentPick(request.ticket) else { return }
                if let effective = result.effort, !effective.isEmpty {
                    currentEffort = effective
                }
            case .mintLaneSession, .none:
                currentEffort = request.previous
                statusNote = Self.unreachableNote
                return
            }
            AppLog.info("chat", "composer effort switched", ["effort": request.level])
        } catch let error as APIError where error.isCancelled {
            guard isCurrentPick(request.ticket) else { return }
            currentEffort = request.previous
        } catch {
            guard isCurrentPick(request.ticket) else { return }
            currentEffort = request.previous
            let failure = Self.writeOutcome(for: error, target: request.target)
            statusNote = failure.note
            AppLog.info("chat", "composer effort switch failed", [
                "effort": request.level, "verdict": String(describing: failure),
                "error": error.localizedDescription,
            ])
            if failure == .laneEngine { refresh() }
        }
    }
}
