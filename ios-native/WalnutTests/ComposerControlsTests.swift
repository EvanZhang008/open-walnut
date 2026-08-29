import XCTest
@testable import Walnut

/// The composer's model pill and the `+` menu's host provenance.
///
/// The bug class these gate is "the phone tells the user something that isn't
/// true": a pill claiming a model the session isn't running, a picker offering an
/// effort level the model rejects, or a cheerful "Cloud" that hides the fact that
/// the Mac is unreachable and nothing the user does will land. Every assertion
/// below is about a claim being either correct or visibly absent.
@MainActor
final class ComposerControlsTests: XCTestCase {

    private func model(
        _ id: String, _ label: String,
        supportsEffort: Bool? = nil, levels: [String]? = nil
    ) -> SessionModelOptions.Model {
        SessionModelOptions.Model(
            id: id, label: label, supportsEffort: supportsEffort, supportedEffortLevels: levels
        )
    }

    // MARK: - Pill label

    /// The catalog's `label` is a bare family ("Opus") while the id carries the
    /// version. The pill must show the VERSION, matching the web's catalogRowLabel
    /// and the reference composer's "Opus 5".
    func testPillPrefersTheVersionedNameOverTheBareFamilyLabel() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["high"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: nil
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5", "the bare 'Opus' label loses the version the id knows")
    }

    /// Effort joins the label only when the current model actually has an effort
    /// axis. This is the "Opus 5 · High" shape.
    func testPillAppendsEffortWhenTheModelSupportsIt() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5 · High")
    }

    /// A model with NO effort axis must not show a stale effort, even when the
    /// record still carries one from a previous model.
    func testPillOmitsEffortForAModelThatHasNoEffortAxis() {
        let controls = ComposerControlsModel(
            models: [model("haiku", "Haiku")],   // no supportsEffort, no levels
            currentModelID: "haiku",
            currentEffort: "high"
        )
        XCTAssertEqual(controls.pillLabel, "Haiku")
        XCTAssertTrue(controls.effortLevelsForCurrentModel.isEmpty)
    }

    /// A model outside the catalog (custom proxy id) still gets a name, not a
    /// blank pill and not the raw id when a family is derivable.
    func testPillNamesAModelThatIsNotInTheCatalog() {
        let controls = ComposerControlsModel(
            models: [model("haiku", "Haiku")],
            currentModelID: "global.anthropic.claude-sonnet-5",
            currentEffort: nil
        )
        XCTAssertEqual(controls.pillLabel, "Sonnet 5")
    }

    /// Nothing known at all = NO pill. An empty or placeholder pill in the
    /// composer would be a control that answers no question.
    func testNoModelMeansNoPill() {
        let controls = ComposerControlsModel(models: [], currentModelID: nil, currentEffort: nil)
        XCTAssertNil(controls.pillLabel)
    }

    /// The row's own model string carries the label while the catalog loads (and
    /// forever, if it never arrives) so an offline composer still says the truth.
    func testFallbackModelLabelsThePillBeforeTheCatalogArrives() {
        let controls = ComposerControlsModel(
            models: [], currentModelID: nil, currentEffort: nil,
            fallbackLabel: "global.anthropic.claude-fable-5[1m]"
        )
        XCTAssertEqual(controls.pillLabel, "Fable 5")
    }

    // MARK: - Effort levels offered

    /// Only the levels the CURRENT model declares are offered, so the server's
    /// 409-on-unsupported-effort is unreachable through the UI.
    func testOnlyTheCurrentModelsDeclaredEffortLevelsAreOffered() {
        let controls = ComposerControlsModel(
            models: [
                model("a", "A", levels: ["low", "medium"]),
                model("b", "B", levels: ["low", "medium", "high", "xhigh", "max"]),
            ],
            currentModelID: "a",
            currentEffort: "low"
        )
        XCTAssertEqual(controls.effortLevelsForCurrentModel, ["low", "medium"],
                       "offering 'max' here would produce a 409 the user can't predict")
    }

    /// `supportsEffort: true` with no explicit list falls back to the full set
    /// (an older server that only sends the boolean).
    func testSupportsEffortWithoutAListFallsBackToTheFullSet() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", supportsEffort: true)],
            currentModelID: "a", currentEffort: "medium"
        )
        XCTAssertEqual(controls.effortLevelsForCurrentModel, ComposerControlsModel.defaultEffortLevels)
    }

    func testEffortLabelsAreHumanReadable() {
        XCTAssertEqual(ComposerControlsModel.effortLabel("xhigh"), "Extra High")
        XCTAssertEqual(ComposerControlsModel.effortLabel("max"), "Max")
        XCTAssertEqual(ComposerControlsModel.effortLabel("low"), "Low")
    }

    // MARK: - Catalog ids vs legacy aliases (measured on a real session)

    /// The picker must send the row's own `id`, which on a live box is a FULL
    /// provider id ("global.anthropic.claude-fable-5[1m]"), never the family
    /// alias ("fable").
    ///
    /// Measured 2026-08-27 against a real session: `POST /model {"model":"sonnet"}`
    /// answered `appliedLive:false` with `effectiveModel` still on the OLD model,
    /// while the same call with the catalog id `global.anthropic.claude-sonnet-5`
    /// answered `appliedLive:true` and the switch stuck. Both are 200s, so an
    /// alias-sending picker fails SILENTLY: the pill would show the new name while
    /// the CLI kept running the old model. Rendering from the catalog row (which
    /// carries the id) is what keeps the label and the wire value the same thing.
    func testTheModelSentIsTheCatalogRowIdNotTheFamilyAlias() {
        let rows = [
            model("global.anthropic.claude-fable-5[1m]", "Fable", levels: ["xhigh"]),
            model("global.anthropic.claude-sonnet-5", "Sonnet", levels: ["high"]),
        ]
        let controls = ComposerControlsModel(
            models: rows, currentModelID: rows[0].id, currentEffort: "xhigh"
        )
        // The label is derived from the id, and the id is what a pick sends.
        XCTAssertEqual(controls.pillLabel, "Fable 5 · Extra High")
        XCTAssertEqual(controls.models[1].id, "global.anthropic.claude-sonnet-5",
                       "the row's id must stay the full provider id — 'sonnet' applies as a no-op")
        XCTAssertFalse(controls.models.contains { $0.id == "sonnet" },
                       "a bare alias in the catalog would be sent verbatim and silently not apply")
    }

    /// Rows whose id carries no derivable family (a GPT row) fall back to the
    /// catalog LABEL rather than showing a raw id in the composer.
    func testNonAnthropicRowFallsBackToItsCatalogLabel() {
        let controls = ComposerControlsModel(
            models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
            currentModelID: "gpt-5.6-sol", currentEffort: nil
        )
        XCTAssertEqual(controls.pillLabel, "GPT-5.6 Sol")
    }

    /// A short alias row that IS in the catalog (an older host's catalog can carry
    /// "haiku") must still render a human name, not an empty pill.
    func testShortAliasRowStillRendersAName() {
        let controls = ComposerControlsModel(
            models: [model("haiku", "Haiku")], currentModelID: "haiku", currentEffort: nil
        )
        XCTAssertEqual(controls.pillLabel, "Haiku")
    }

    // MARK: - Read-only states

    /// A read-only pill still shows the model but offers no list: the two reasons
    /// (no session yet vs in-process engine) have DIFFERENT fixes, so they must
    /// not collapse into one message.
    func testReadOnlyPillKeepsItsLabelAndItsReason() {
        let controls = ComposerControlsModel(
            models: [], currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: nil, readOnly: true,
            readOnlyReason: "Send a message first"
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5")
        XCTAssertTrue(controls.readOnly)
        XCTAssertEqual(controls.readOnlyReason, "Send a message first")
    }

    // MARK: - ChatEngineInfo → switchable session

    /// The lane engine with a session = switchable. This is what puts a live model
    /// pill on the MAIN AGENT's chat.
    func testLaneEngineWithASessionIsSwitchable() {
        let info = ChatEngineInfo(
            engine: "lane", sessionId: "sess-1", cwd: "/x", host: "", model: nil
        )
        XCTAssertEqual(info.switchableSessionId, "sess-1")
    }

    /// A lane with NO session yet is not switchable FROM THIS PAYLOAD: the GET
    /// never mints one, because a poll or a prefetch must not spawn a CLI. The
    /// composer's answer to this state is to ask for a mint explicitly
    /// (`POST /chat/engine/session`) and re-read — not to go read-only, which is
    /// what left the ordinary chat without a model control.
    func testLaneEngineWithoutASessionIsNotSwitchable() {
        let info = ChatEngineInfo(engine: "lane", sessionId: nil, cwd: nil, host: nil, model: nil)
        XCTAssertNil(info.switchableSessionId)
    }

    /// The in-process engine has no per-conversation session at all: its model is
    /// a server-config fact, so nothing is switchable from the phone.
    func testInProcessEngineIsNeverSwitchableEvenWithAModel() {
        let info = ChatEngineInfo(
            engine: "in-process", sessionId: nil, cwd: nil, host: nil,
            model: "global.anthropic.claude-opus-5"
        )
        XCTAssertNil(info.switchableSessionId)
        XCTAssertEqual(info.model, "global.anthropic.claude-opus-5")
    }

    /// An empty-string sessionId is as unusable as a nil one; treating it as a
    /// real id would send model switches to /sessions//model.
    func testEmptySessionIdIsTreatedAsAbsent() {
        let info = ChatEngineInfo(engine: "lane", sessionId: "", cwd: nil, host: nil, model: nil)
        XCTAssertNil(info.switchableSessionId)
    }

    func testChatEngineDecodesTheServerShape() throws {
        let json = #"{"engine":"lane","sessionId":"s1","cwd":"/Users/x/.open-walnut","host":""}"#
        let info = try JSONDecoder().decode(ChatEngineInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.engine, "lane")
        XCTAssertEqual(info.switchableSessionId, "s1")
        XCTAssertEqual(info.host, "", "\"\" means the primary box, not a missing host")
    }

    // MARK: - Host provenance: the main-agent chat

    private func status(_ mode: ServerStatus.Mode, bridges: [String]?) -> ServerStatus {
        ServerStatus(
            mode: mode, cloud: mode == .replica, version: "1.0", serverTime: "",
            lastSyncAt: nil,
            bridgeHosts: bridges?.map { .init(hostAlias: $0, since: nil) }
        )
    }

    /// Talking straight to the Mac.
    func testPrimaryChatSaysThisMac() {
        let p = ComposerHostProvenance.chat(status: status(.live, bridges: nil), online: true)
        XCTAssertEqual(p.label, "This Mac")
        XCTAssertEqual(p.icon, "laptopcomputer")
        XCTAssertFalse(p.degraded)
    }

    /// On the replica with the Mac's daemon dialled in, the useful fact is that
    /// answers relay THROUGH to the Mac.
    func testReplicaWithThePrimaryBridgedSaysMacConnected() {
        let p = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["__local__", "clouddev"]), online: true
        )
        XCTAssertEqual(p.label, "Cloud · Mac connected")
        XCTAssertEqual(p.icon, "cloud")
        XCTAssertFalse(p.degraded)
    }

    /// The state the user has actually been stuck in: the phone is on the cloud
    /// box and the Mac is gone. The label must SAY so and the detail must name the
    /// consequence, because a cheerful "Cloud" hides why nothing works.
    func testReplicaWithThePrimaryMissingSaysMacOfflineAndNamesTheConsequence() {
        let p = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["clouddev"]), online: true
        )
        XCTAssertEqual(p.label, "Cloud · Mac offline")
        XCTAssertTrue(p.degraded)
        let detail = p.detail ?? ""
        XCTAssertTrue(detail.contains("isn't connected"), "detail must state the Mac is not connected: \(detail)")
        XCTAssertTrue(detail.contains("can't be reached"), "detail must state the consequence: \(detail)")
    }

    /// An EMPTY bridge list is a real verdict ("nothing is connected"); an ABSENT
    /// key means the server is too old to say. Conflating them would claim the Mac
    /// is offline on a server that never reports bridges at all.
    func testAbsentBridgeHostsIsUnknownNotOffline() {
        let absent = ComposerHostProvenance.chat(status: status(.replica, bridges: nil), online: true)
        XCTAssertEqual(absent.label, "Cloud", "an old server can't tell us — don't claim the Mac is offline")
        XCTAssertFalse(absent.degraded)

        let empty = ComposerHostProvenance.chat(status: status(.replica, bridges: []), online: true)
        XCTAssertEqual(empty.label, "Cloud · Mac offline", "an empty list IS a verdict")
        XCTAssertTrue(empty.degraded)
    }

    /// Transport down: say that, rather than reporting a mode we can't confirm.
    func testOfflineIsReportedForBothModes() {
        let live = ComposerHostProvenance.chat(status: status(.live, bridges: nil), online: false)
        XCTAssertEqual(live.label, "This Mac · unreachable")
        XCTAssertTrue(live.degraded)

        let replica = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["__local__"]), online: false
        )
        XCTAssertEqual(replica.label, "Cloud · unreachable")
        XCTAssertTrue(replica.degraded)
    }

    func testNoStatusYetSaysConnecting() {
        XCTAssertEqual(
            ComposerHostProvenance.chat(status: nil, online: true).label, "Connecting…"
        )
        XCTAssertEqual(
            ComposerHostProvenance.chat(status: nil, online: false).label, "Offline"
        )
    }

    // MARK: - Host provenance: a coding session

    /// A session's host is a per-session FACT (empty alias = the Mac), which is a
    /// different question from which server is answering. The cwd is the detail.
    func testSessionProvenanceReportsItsExecHostAndCwd() {
        let local = ComposerHostProvenance.session(hostAlias: "", cwd: "/Users/x/walnut")
        XCTAssertEqual(local.label, "This Mac")
        XCTAssertEqual(local.detail, "/Users/x/walnut")
        XCTAssertFalse(local.degraded, "a session's host is a fact, never a degraded state")

        let remote = ComposerHostProvenance.session(hostAlias: "clouddev", cwd: "/workspace")
        XCTAssertEqual(remote.label, "clouddev")
        XCTAssertEqual(remote.detail, "/workspace")
    }

    func testSessionWithoutACwdHasNoDetailLine() {
        XCTAssertNil(ComposerHostProvenance.session(hostAlias: "", cwd: nil).detail)
        XCTAssertNil(ComposerHostProvenance.session(hostAlias: "", cwd: "").detail)
    }

    // MARK: - ServerStatus decoding

    /// The primary omits `bridgeHosts` entirely. Decoding must survive that (and a
    /// malformed value from a mixed-version box) rather than failing the whole
    /// /status probe, which would take the app offline over an additive field.
    func testServerStatusDecodesWithAndWithoutBridgeHosts() throws {
        let primary = #"{"mode":"LIVE","cloud":false,"version":"1.0","serverTime":"t"}"#
        let a = try JSONDecoder().decode(ServerStatus.self, from: Data(primary.utf8))
        XCTAssertNil(a.bridgeHosts)

        let replica = #"{"mode":"REPLICA","cloud":true,"version":"1.0","serverTime":"t","bridgeHosts":[{"hostAlias":"__local__","since":1}]}"#
        let b = try JSONDecoder().decode(ServerStatus.self, from: Data(replica.utf8))
        XCTAssertEqual(b.bridgeHosts?.count, 1)
        XCTAssertEqual(b.bridgeHosts?.first?.hostAlias, "__local__")

        let junk = #"{"mode":"REPLICA","cloud":true,"version":"1.0","serverTime":"t","bridgeHosts":"nope"}"#
        let c = try JSONDecoder().decode(ServerStatus.self, from: Data(junk.utf8))
        XCTAssertNil(c.bridgeHosts, "a malformed additive field must degrade, not throw")
    }
}
