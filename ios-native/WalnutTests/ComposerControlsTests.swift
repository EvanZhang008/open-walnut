import UIKit
import XCTest
@testable import Walnut

/// The composer's model pill and the `+` menu's host provenance.
///
/// The bug class these gate is "the phone tells the user something that isn't
/// true": a pill claiming a model the session isn't running, a picker offering an
/// effort level the model rejects, or a "Cloud" headline while the Mac is the one
/// answering (and the reverse: a "Mac" that hides that it is unreachable). Every assertion
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

    /// The effort half appears only when the current model actually has an effort
    /// axis: "Opus 5" and "High". These are the two halves the one pill joins.
    func testTheEffortPillShowsWhenTheModelSupportsIt() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5")
        XCTAssertEqual(controls.effortPillLabel, "High")
        XCTAssertEqual(controls.effortMenu.sections.flatMap(\.items).map(\.title), ["Low", "High", "Max"])
        XCTAssertEqual(controls.effortMenu.sections.flatMap(\.items).filter(\.checked).map(\.title), ["High"])
    }

    // MARK: - One pill for model and effort

    /// One pill names both, the web's way: "Opus 5 · High". VoiceOver reads the
    /// model as the name and the effort as the value, so "Model: Opus 5" stays the
    /// pill's identity for every test that finds it by label.
    func testOnePillNamesTheModelAndItsEffort() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        XCTAssertEqual(controls.combinedPillLabel, "Opus 5 · High")
        XCTAssertEqual(controls.pillAccessibilityLabel, "Model: Opus 5")
        XCTAssertEqual(controls.pillAccessibilityValue, "Effort: High")
    }

    /// The pill's menu is the levels, then the models, as INLINE sections (never
    /// a submenu, whose chevron column squeezed the model names), each headed by
    /// its current value and each with exactly its own row checked. The levels
    /// lead as compact tiles: always in view, however long the model list.
    func testTheOnePillsMenuHoldsTheLevelsThenTheModels() {
        let controls = ComposerControlsModel(
            models: [
                model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"]),
                model("global.anthropic.claude-haiku-4-5", "Haiku"),
            ],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "max"
        )
        let sections = controls.combinedMenu().sections
        XCTAssertEqual(sections.map(\.title), ["Effort: Max", "Model: Opus 5 1M"])
        XCTAssertEqual(sections.map(\.compact), [true, false])
        XCTAssertEqual(sections[0].items.map(\.choice), [.effort("low"), .effort("high"), .effort("max")])
        XCTAssertEqual(sections[0].items.filter(\.checked).map(\.title), ["Max"])
        XCTAssertEqual(sections[1].items.filter(\.checked).count, 1)
        XCTAssertEqual(controls.combinedMenu().token, controls.menuToken)

        // At the accessibility sizes a tile is a whole row: the models lead, the
        // levels follow as an ordinary section.
        let large = controls.combinedMenu(compactLevels: false).sections
        XCTAssertEqual(large.map(\.title), ["Model: Opus 5 1M", "Effort: Max"])
        XCTAssertEqual(large.map(\.compact), [false, false])
    }

    /// A compact section becomes rows of at most three medium tiles (UIKit spills
    /// a fourth tile into a plain row), the first row carrying the heading; a
    /// plain section stays one inline group.
    func testACompactSectionIsRowsOfThreeTilesUnderItsHeading() {
        let levels = ["Low", "Medium", "High", "Extra High", "Max"]
        let menu = PillMenu(sections: [
            .init(title: "Effort: High", items: levels.map { .init(title: $0, choice: .effort($0)) }, compact: true),
            .init(title: "Model: Opus 5", items: [.init(title: "Opus 5", choice: .model("opus"))]),
        ], token: .init(generation: 0, version: 0))
        let built = PillMenuUIButton.build(menu) { _, _ in }
        let tiles = built.children[0] as? UIMenu
        let rows = tiles?.children.compactMap { $0 as? UIMenu } ?? []
        XCTAssertEqual(rows.map { $0.children.map(\.title) }, [["Low", "Medium", "High"], ["Extra High", "Max"]])
        XCTAssertEqual(rows.map(\.preferredElementSize), [.medium, .medium])
        XCTAssertEqual(rows.map(\.title), ["Effort: High", ""])
        let plain = built.children[1] as? UIMenu
        XCTAssertEqual(plain?.title, "Model: Opus 5")
        XCTAssertEqual(plain?.children.map(\.title), ["Opus 5"])
    }

    /// A model with no effort axis: the model alone, and a menu of models only.
    func testAModelWithoutEffortIsTheModelAlone() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-haiku-4-5", "Haiku")],
            currentModelID: "global.anthropic.claude-haiku-4-5",
            currentEffort: nil
        )
        XCTAssertEqual(controls.combinedPillLabel, controls.pillLabel)
        XCTAssertNil(controls.pillAccessibilityValue)
        XCTAssertEqual(controls.combinedMenu().sections.count, 1)
    }

    /// An effort axis with no reported level: "Effort" is a placeholder, not a
    /// fact, so the pill names the model alone, and the menu still offers the
    /// levels with none checked.
    func testAnUnreportedEffortAddsNothingToThePill() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: nil
        )
        XCTAssertEqual(controls.combinedPillLabel, "Opus 5")
        XCTAssertNil(controls.pillAccessibilityValue)
        let levels = controls.combinedMenu().sections.first?.items ?? []
        XCTAssertEqual(levels.map(\.title), ["Low", "High"])
        XCTAssertTrue(levels.allSatisfy { !$0.checked })
    }

    /// With the Mac away the pill keeps both last known halves and says so, and
    /// its menu is the Retry, never levels it cannot write.
    func testUnreachableKeepsBothHalvesAndOffersOnlyRetry() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high", unreachable: true, statusNote: ComposerControlsModel.unreachableNote
        )
        XCTAssertEqual(controls.combinedPillLabel, "Opus 5 · High")
        XCTAssertEqual(controls.pillAccessibilityValue, "Effort: High, last known")
        XCTAssertEqual(controls.combinedMenu().sections.flatMap(\.items).map(\.choice), [.retry])
    }

    /// The mode pill follows the session a pick is written to; the in-process
    /// chat (no session) has none.
    func testTheModeSessionIsTheWriteTargetSession() {
        let session = ComposerControlsModel(
            models: [], currentModelID: "x", currentEffort: nil, writeTarget: .session(id: "sess-1")
        )
        XCTAssertEqual(session.switchableSessionID, "sess-1")
        let inProcess = ComposerControlsModel(
            models: [], currentModelID: "x", currentEffort: nil,
            writeTarget: .chat(agentID: "general", conversationID: "c1")
        )
        XCTAssertNil(inProcess.switchableSessionID)
    }

    /// Both menus are headed by the current value, which at the accessibility
    /// sizes can open scrolled out of view (gate r3 P2-4: "Extra High" cut off at
    /// the bottom of the AX5 effort menu). A just-failed write's reason goes
    /// above, as the menu's own title.
    func testTheMenusNameTheCurrentValueInTheirHeading() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "xhigh"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "xhigh",
            writeTarget: .session(id: "s")
        )
        XCTAssertEqual(controls.effortMenu.sections.map(\.title), ["Effort: Extra High"])
        XCTAssertEqual(controls.modelMenu.sections.map(\.title), ["Model: Opus 5 1M"])
        XCTAssertEqual(controls.modelMenu.title, "")
        let unset = ComposerControlsModel(models: [model("a", "A", levels: ["low"])], currentModelID: "a", currentEffort: nil)
        XCTAssertEqual(unset.effortMenu.sections.map(\.title), ["Effort"], "no level known, no level named")
        let failed = ComposerControlsModel(
            models: [model("a", "A", levels: ["low"])], currentModelID: "a", currentEffort: "low",
            statusNote: "That switch didn't go through"
        )
        XCTAssertEqual(failed.effortMenu.title, "That switch didn't go through")
        XCTAssertEqual(failed.effortMenu.sections.map(\.title), ["Effort: Low"])
        XCTAssertEqual(PillMenuUIButton.build(failed.effortMenu) { _, _ in }.title, "That switch didn't go through",
                       "the reason is not on the UIKit menu")
    }

    /// A model the catalog does not list is named by its raw id, which the pill
    /// shortens (two lines at most, in the middle) instead of growing into a
    /// circle at AX5 (gate r3 P2-3). A catalog name is never shortened.
    func testARawModelIDIsCappedAndACatalogNameIsNot() {
        let raw = ComposerControlsModel(
            models: [model("haiku", "Haiku")], currentModelID: "custom-proxy-model-extra-long-name-v2", currentEffort: nil
        )
        XCTAssertEqual(raw.pillLabel, "custom-proxy-model-extra-long-name-v2")
        XCTAssertTrue(raw.pillLabelIsRawID)
        let listed = ComposerControlsModel(models: [model("haiku", "Haiku")], currentModelID: "haiku", currentEffort: nil)
        XCTAssertFalse(listed.pillLabelIsRawID)
        XCTAssertEqual(PillChipText.lineLimit(wraps: true, rawID: true), 2)
        XCTAssertNil(PillChipText.lineLimit(wraps: true, rawID: false), "a catalog name must never be cut")
        XCTAssertEqual(PillChipText.lineLimit(wraps: false, rawID: false), 1)
        XCTAssertEqual(PillChipText.lineLimit(wraps: false, rawID: true), 1)
    }

    /// One line: a capsule. Wrapped: a fixed 14pt radius, not a circle.
    func testAWrappedPillIsARoundedRectangleNotACircle() {
        let shape = PillChipShape(oneLineHeight: 61)
        let oneLine = shape.path(in: CGRect(x: 0, y: 0, width: 283, height: 61))
        XCTAssertFalse(oneLine.contains(CGPoint(x: 6, y: 6)), "one line is a capsule")
        XCTAssertTrue(oneLine.contains(CGPoint(x: 30, y: 30)))
        let twoLines = shape.path(in: CGRect(x: 0, y: 0, width: 262, height: 118))
        XCTAssertTrue(twoLines.contains(CGPoint(x: 6, y: 6)), "a wrapped pill keeps its corners")
        XCTAssertFalse(twoLines.contains(CGPoint(x: 1, y: 1)))
        XCTAssertTrue(twoLines.contains(CGPoint(x: 6, y: 112)))
        XCTAssertGreaterThan(PillChipText.oneLineHeight(.accessibility5), PillChipText.oneLineHeight(.large) * 2)
    }

    /// A model with an effort axis but no level reported yet still offers the
    /// pill (to set one), named for what it is.
    func testTheEffortPillWithNoReportedLevelSaysEffort() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", levels: ["low", "high"])], currentModelID: "a", currentEffort: nil
        )
        XCTAssertEqual(controls.effortPillLabel, "Effort")
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
        XCTAssertNil(controls.effortPillLabel, "no effort axis, no effort pill (absent, not greyed)")
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
        XCTAssertEqual(controls.pillLabel, "Fable 5")
        XCTAssertEqual(controls.effortPillLabel, "Extra High")
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

    private func status(
        _ mode: ServerStatus.Mode, bridges: [String]?, cloudChat: ServerStatus.CloudChat? = nil
    ) -> ServerStatus {
        ServerStatus(
            mode: mode, cloud: mode == .replica, version: "1.0", serverTime: "",
            lastSyncAt: nil,
            bridgeHosts: bridges?.map { .init(hostAlias: $0, since: nil) },
            cloudChat: cloudChat
        )
    }

    /// Talking straight to the Mac: the headline is the machine, plainly "Mac".
    func testPrimaryChatSaysMac() {
        let p = ComposerHostProvenance.chat(status: status(.live, bridges: nil), online: true)
        XCTAssertEqual(p.label, "Mac")
        XCTAssertNil(p.detail, "a healthy row is the machine's name and nothing else")
        XCTAssertEqual(p.icon, "laptopcomputer")
        XCTAssertFalse(p.degraded)
    }

    /// The reported bug: build 82 said "Cloud · Mac connected" / "Answers relay to
    /// your Mac." while the Mac was computing the reply. The headline names where
    /// the reply is computed (the Mac); the relay is only the path, in the detail.
    func testReplicaWithThePrimaryBridgedSaysMacNotCloud() {
        for cloudChat in [nil, ServerStatus.CloudChat.available, .unavailable] {
            let p = ComposerHostProvenance.chat(
                status: status(.replica, bridges: ["__local__", "clouddev"], cloudChat: cloudChat),
                online: true
            )
            XCTAssertEqual(p.label, "Mac", "the Mac answers whatever the cloud could do on its own")
            XCTAssertNil(p.detail, "the relay path is not the user's business")
            XCTAssertEqual(p.icon, "laptopcomputer")
            XCTAssertFalse(p.degraded)
            XCTAssertFalse(p.label.contains("Cloud"), "never headline the network path")
        }
    }

    /// The Mac is gone and the cloud box SAYS it can answer: now the cloud really
    /// computes the reply, so "Cloud" is the honest headline, and the detail says
    /// what that costs (text only, no Mac sessions).
    func testMacOfflineWithCloudChatAvailableSaysCloudAndTheConsequence() {
        let p = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["clouddev"], cloudChat: .available), online: true
        )
        XCTAssertEqual(p.label, "Cloud")
        XCTAssertEqual(p.icon, "cloud")
        XCTAssertTrue(p.degraded)
        XCTAssertEqual(
            p.detail,
            "Your Mac is offline, so the cloud server answers text messages for now. Mac sessions can't be reached."
        )
    }

    /// The Mac is gone and the cloud box says it CANNOT answer: claiming "Cloud"
    /// would promise replies that never come. Say the Mac is offline and that new
    /// messages fail (the server ends the turn with its "primary is unreachable" error).
    func testMacOfflineWithCloudChatUnavailableDoesNotClaimCloud() {
        let p = ComposerHostProvenance.chat(
            status: status(.replica, bridges: [], cloudChat: .unavailable), online: true
        )
        XCTAssertEqual(p.label, "Mac offline")
        XCTAssertEqual(p.icon, "laptopcomputer.slash")
        XCTAssertTrue(p.degraded)
        XCTAssertEqual(
            p.detail,
            "The cloud server can't answer without your Mac, so new messages get an error until it's back."
        )
    }

    /// The Mac is gone and the box is too old to say whether it can answer. The
    /// deployed older replica answers on its own; a later one fails the turn. The
    /// copy must not promise either, so it says "may".
    func testMacOfflineOnAServerThatDoesNotReportCloudChatSaysMay() {
        let p = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["clouddev"], cloudChat: nil), online: true
        )
        XCTAssertEqual(p.label, "Mac offline")
        XCTAssertEqual(p.icon, "laptopcomputer.slash")
        XCTAssertTrue(p.degraded)
        XCTAssertEqual(
            p.detail,
            "Your Mac isn't connected. The cloud server may answer on its own, without your Mac's sessions."
        )
    }

    /// An EMPTY bridge list is a real verdict ("nothing is connected"); an ABSENT
    /// key means the server is too old to say. Conflating them would claim the Mac
    /// is offline on a server that never reports bridges at all. An unknown relay
    /// still sends every turn to the Mac first, so the headline is the Mac.
    func testAbsentBridgeHostsIsUnknownNotOffline() {
        let absent = ComposerHostProvenance.chat(status: status(.replica, bridges: nil), online: true)
        XCTAssertEqual(absent.label, "Mac", "an old server can't tell us: don't claim offline")
        XCTAssertNil(absent.detail)
        XCTAssertEqual(absent.icon, "laptopcomputer")
        XCTAssertFalse(absent.degraded)

        let empty = ComposerHostProvenance.chat(status: status(.replica, bridges: []), online: true)
        XCTAssertEqual(empty.label, "Mac offline", "an empty list IS a verdict")
        XCTAssertTrue(empty.degraded)
    }

    /// Transport down: say that, rather than reporting a mode we can't confirm.
    func testOfflineIsReportedForBothModes() {
        let live = ComposerHostProvenance.chat(status: status(.live, bridges: nil), online: false)
        XCTAssertEqual(live.label, "Offline")
        XCTAssertEqual(live.detail, "Your Mac isn't responding right now.")
        XCTAssertEqual(live.icon, "laptopcomputer.slash")
        XCTAssertTrue(live.degraded)

        let replica = ComposerHostProvenance.chat(
            status: status(.replica, bridges: ["__local__"], cloudChat: .available), online: false
        )
        XCTAssertEqual(replica.label, "Offline", "a stale 'Mac connected' must not survive the phone going offline")
        XCTAssertEqual(replica.detail, "The cloud relay to your Mac isn't responding right now.")
        XCTAssertEqual(replica.icon, "wifi.slash")
        XCTAssertTrue(replica.degraded)
    }

    func testNoStatusYetSaysConnectingOrOffline() {
        let connecting = ComposerHostProvenance.chat(status: nil, online: true)
        XCTAssertEqual(connecting.label, "Connecting…")
        XCTAssertNil(connecting.detail)
        XCTAssertFalse(connecting.degraded)

        let offline = ComposerHostProvenance.chat(status: nil, online: false)
        XCTAssertEqual(offline.label, "Offline")
        XCTAssertEqual(offline.detail, "Can't reach Walnut right now. Reconnecting.")
        XCTAssertTrue(offline.degraded)
    }

    /// Every state the row can be in, with the rules that hold across all of
    /// them: "This Mac" never appears, "Cloud" is a headline only where the
    /// cloud answers, and every icon is a real SF Symbol (a typo renders blank).
    func testEveryProvenanceStateKeepsTheHeadlineRule() {
        var states: [(String, ComposerHostProvenance)] = [
            ("connecting", .chat(status: nil, online: true)),
            ("offline, no status", .chat(status: nil, online: false)),
            ("session on the Mac", .session(hostAlias: "", cwd: "/x")),
            ("session remote", .session(hostAlias: "clouddev", cwd: nil)),
        ]
        for online in [true, false] {
            states.append(("live online=\(online)", .chat(status: status(.live, bridges: nil), online: online)))
            for bridges in [nil, [], ["clouddev"], ["__local__"]] as [[String]?] {
                for cloudChat in [nil, ServerStatus.CloudChat.available, .unavailable] {
                    states.append((
                        "replica online=\(online) bridges=\(String(describing: bridges)) cloudChat=\(String(describing: cloudChat))",
                        .chat(status: status(.replica, bridges: bridges, cloudChat: cloudChat), online: online)
                    ))
                }
            }
        }
        for (name, p) in states {
            XCTAssertFalse(p.label.contains("This Mac"), "\(name): \(p.label)")
            XCTAssertFalse((p.label + (p.detail ?? "")).contains("\u{2014}"), "\(name): no em dashes in UI copy")
            XCTAssertNotNil(UIImage(systemName: p.icon), "\(name): \(p.icon) is not an SF Symbol")
            if p.label == "Cloud" {
                guard case .chat(let s?, true) = p else {
                    return XCTFail("\(name): only a reachable replica can headline Cloud")
                }
                XCTAssertEqual(s.cloudChat, .available, name)
                XCTAssertEqual(ComposerHostProvenance.primaryReachability(s), .offline, name)
            }
        }
    }

    // MARK: - Host provenance: a coding session

    /// A session's host is a per-session FACT (empty alias = the Mac), which is a
    /// different question from which server is answering. The cwd is the detail.
    func testSessionProvenanceReportsItsExecHostAndCwd() {
        let local = ComposerHostProvenance.session(hostAlias: "", cwd: "/Users/x/walnut")
        XCTAssertEqual(local.label, "Mac")
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

    /// `cloudChat` is additive and replica-only: absent on the primary and on a
    /// replica older than the field; an unknown value from a newer server reads
    /// as "does not say", never as a failed probe.
    func testServerStatusDecodesCloudChatPresentAbsentAndUnknown() throws {
        func decode(_ json: String) throws -> ServerStatus {
            try JSONDecoder().decode(ServerStatus.self, from: Data(json.utf8))
        }
        XCTAssertNil(try decode(#"{"mode":"REPLICA","cloud":true,"version":"0.4.5","serverTime":"t","bridgeHosts":[]}"#).cloudChat)
        XCTAssertEqual(
            try decode(#"{"mode":"REPLICA","cloud":true,"version":"1","serverTime":"t","bridgeHosts":[],"cloudChat":"available"}"#).cloudChat,
            .available
        )
        XCTAssertEqual(
            try decode(#"{"mode":"REPLICA","cloud":true,"version":"1","serverTime":"t","bridgeHosts":[],"cloudChat":"unavailable"}"#).cloudChat,
            .unavailable
        )
        let newer = try decode(#"{"mode":"REPLICA","cloud":true,"version":"9","serverTime":"t","bridgeHosts":[],"cloudChat":"sometimes"}"#)
        XCTAssertNil(newer.cloudChat)
        XCTAssertEqual(newer.bridgeHosts?.count, 0, "one odd field must not cost the rest")
    }
}
