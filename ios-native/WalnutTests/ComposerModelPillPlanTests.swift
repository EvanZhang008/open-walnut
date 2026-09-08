import XCTest
@testable import Walnut

/// The composer model pill's STATE MACHINE: one `GET /v1/chat/engine` outcome in,
/// the whole pill state out (`ComposerControlsModel.pillPlan`).
///
/// The bug class this gates is the one the user reported: the pill said "This box
/// answers chat in-process — the model comes from the server's config" and offered
/// no choices. Two different situations produced that single dead end, and neither
/// deserved it. A cloud replica that could not reach the Mac answered "in-process"
/// from ITS OWN config (so the pill named a model the user was not talking to, and
/// looked authoritative doing it), and the genuine in-process engine now has a
/// per-conversation model that `PUT /v1/chat/model` writes. So the rules pinned
/// here are: in-process is ALWAYS selectable, unknown is its own state that keeps
/// the last true name and offers a retry, and the only read-only left is a box
/// explicitly declaring the model fixed.
@MainActor
final class ComposerModelPillPlanTests: XCTestCase {

    private let agent = "general"
    private let conversation = "conv-1"

    private func catalogRow(
        _ id: String, _ label: String, levels: [String]? = nil
    ) -> SessionModelOptions.Model {
        SessionModelOptions.Model(
            id: id, label: label, supportsEffort: levels != nil, supportedEffortLevels: levels
        )
    }

    private func plan(
        _ lookup: ComposerControlsModel.EngineLookup,
        lastKnown: ComposerControlsModel.LastKnown = .init()
    ) -> ComposerControlsModel.PillPlan {
        ComposerControlsModel.pillPlan(
            for: lookup, agentID: agent, conversationID: conversation, lastKnown: lastKnown
        )
    }

    // MARK: - In-process: selectable, always

    /// The headline rule. A modern box on the in-process engine ships its own
    /// catalog, and picks write through `PUT /chat/model` — NOT through any
    /// session endpoint, because there is no session.
    func testInProcessWithACatalogIsSelectableAndWritesThroughTheChatEndpoint() {
        let rows = [
            catalogRow("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["high", "max"]),
            catalogRow("global.anthropic.claude-sonnet-5", "Sonnet", levels: ["high"]),
        ]
        let p = plan(.engine(ChatEngineInfo(
            engine: "in-process", model: rows[0].id, effort: "high",
            switchable: true, models: rows
        )))

        XCTAssertFalse(p.readOnly, "the in-process pill must never be a locked dead end again")
        XCTAssertNil(p.readOnlyReason)
        XCTAssertFalse(p.unreachable)
        XCTAssertEqual(p.models, rows)
        XCTAssertEqual(p.currentModelID, rows[0].id)
        XCTAssertEqual(p.currentEffort, "high")
        XCTAssertEqual(
            p.writeTarget, .chat(agentID: agent, conversationID: conversation),
            "a session write target here would 404 — in-process has no session"
        )
    }

    /// A server that predates the per-conversation model sends `model` and nothing
    /// else. It must STILL be selectable: a one-row picker built from the model it
    /// did report, never the old locked text. (A pick then 404s, which
    /// `writeOutcome` reports as "too old" — see below.)
    func testInProcessWithoutACatalogIsStillSelectableWithOneRow() {
        let p = plan(.engine(ChatEngineInfo(
            engine: "in-process", model: "global.anthropic.claude-opus-5[1m]"
        )))

        XCTAssertFalse(p.readOnly, "an absent `models` is an OLD SERVER, not a 'no'")
        XCTAssertEqual(p.models.count, 1)
        XCTAssertEqual(p.models.first?.id, "global.anthropic.claude-opus-5[1m]")
        XCTAssertEqual(p.models.first?.label, "Opus 5", "the row must carry a human name, not a raw id")
        XCTAssertEqual(p.currentModelID, "global.anthropic.claude-opus-5[1m]")
        XCTAssertEqual(p.writeTarget, .chat(agentID: agent, conversationID: conversation))
    }

    /// An empty `models: []` is as uninformative as an absent one, and must not
    /// leave the user with a pill that opens onto nothing.
    func testInProcessWithAnEmptyCatalogFallsBackToTheOneRow() {
        let p = plan(.engine(ChatEngineInfo(
            engine: "in-process", model: "haiku", models: []
        )))
        XCTAssertEqual(p.models.count, 1)
        XCTAssertFalse(p.readOnly)
    }

    /// The old server reported the model but not the effort. Reporting a made-up
    /// effort would be the same class of lie the read-only text was.
    func testInProcessCarriesNoEffortWhenTheServerSendsNone() {
        let p = plan(.engine(ChatEngineInfo(engine: "in-process", model: "haiku")))
        XCTAssertNil(p.currentEffort)
    }

    // MARK: - Lane: unchanged

    /// A lane conversation with a live session keeps writing through the SESSION
    /// endpoints (that CLI owns the model), and keeps the list it already had so a
    /// refresh doesn't blink the picker empty before the catalog read lands.
    func testLaneWithASessionWritesThroughTheSessionEndpoint() {
        let known = ComposerControlsModel.LastKnown(
            models: [catalogRow("a", "A", levels: ["low"])], modelID: "a", effort: "low"
        )
        let p = plan(.engine(ChatEngineInfo(engine: "lane", sessionId: "sess-1", cwd: "/x", host: "")),
                     lastKnown: known)

        XCTAssertEqual(p.writeTarget, .session(id: "sess-1"))
        XCTAssertFalse(p.readOnly)
        XCTAssertFalse(p.unreachable)
        XCTAssertEqual(p.models, known.models, "a refresh must not empty a good catalog")
        XCTAssertEqual(p.currentModelID, "a")
        XCTAssertEqual(p.currentEffort, "low")
    }

    /// A lane conversation with no turn yet MINTS its session (web parity), rather
    /// than the old read-only "Send a message first".
    func testLaneWithoutASessionAsksForAMint() {
        let p = plan(.engine(ChatEngineInfo(engine: "lane")))
        XCTAssertEqual(p.writeTarget, .mintLaneSession(agentID: agent, conversationID: conversation))
        XCTAssertFalse(p.readOnly)
        XCTAssertFalse(p.unreachable)
    }

    /// An empty-string sessionId is as unusable as a nil one — treating it as real
    /// would write to `/sessions//model`.
    func testLaneWithAnEmptySessionIdStillMints() {
        let p = plan(.engine(ChatEngineInfo(engine: "lane", sessionId: "")))
        XCTAssertEqual(p.writeTarget, .mintLaneSession(agentID: agent, conversationID: conversation))
    }

    // MARK: - Unknown is its own state

    /// 503 `primary_unreachable`: the replica cannot reach the Mac. The honest
    /// answer keeps the LAST KNOWN name, offers no list, and is retryable — the
    /// one thing it must never do is present the replica's own config as the
    /// answer, which is what the reported screenshot did.
    func testPrimaryUnreachableKeepsTheLastKnownModelAndGoesToTheRetryState() {
        let known = ComposerControlsModel.LastKnown(
            models: [catalogRow("a", "A", levels: ["low"])], modelID: "a", effort: "low"
        )
        let error = APIError.server(
            status: 503, code: "primary_unreachable",
            message: "The primary box isn't reachable", serverHash: nil, serverContent: nil
        )
        let lookup = ComposerControlsModel.lookup(afterFailing: error)
        XCTAssertEqual(lookup, .unreachable)

        let p = plan(lookup, lastKnown: known)
        XCTAssertTrue(p.unreachable)
        XCTAssertFalse(p.readOnly, "unknown is a retry state, not a locked pill")
        XCTAssertNil(p.readOnlyReason)
        XCTAssertEqual(p.currentModelID, "a", "the last known model must stay visible")
        XCTAssertEqual(p.currentEffort, "low")
        XCTAssertTrue(p.models.isEmpty, "no list we can't honor — the menu carries the retry instead")
        XCTAssertEqual(p.writeTarget, .none)
        XCTAssertEqual(p.statusNote, ComposerControlsModel.unreachableNote)
        XCTAssertTrue(
            (p.statusNote ?? "").lowercased().contains("reach"),
            "the note must say the Mac can't be reached: \(p.statusNote ?? "nil")"
        )
    }

    /// A request that never landed is the same fact, so it gets the same state.
    func testANetworkErrorIsTheSameUnreachableState() {
        let known = ComposerControlsModel.LastKnown(modelID: "global.anthropic.claude-opus-5[1m]")
        let lookup = ComposerControlsModel.lookup(
            afterFailing: APIError.network(underlying: URLError(.notConnectedToInternet))
        )
        XCTAssertEqual(lookup, .unreachable)

        let p = plan(lookup, lastKnown: known)
        XCTAssertEqual(p, plan(
            ComposerControlsModel.lookup(afterFailing: APIError.server(
                status: 503, code: "primary_unreachable", message: "x",
                serverHash: nil, serverContent: nil
            )),
            lastKnown: known
        ), "a dead network and a 503 primary_unreachable are one state, not two")
        XCTAssertTrue(p.unreachable)
        XCTAssertEqual(p.currentModelID, "global.anthropic.claude-opus-5[1m]")
    }

    /// A down bridge and any 5xx are also "we don't know", while a 4xx that isn't
    /// primary_unreachable is a payload we can't use — both retryable, neither
    /// read-only.
    func testFailureClassification() {
        func lookup(_ status: Int, _ code: String) -> ComposerControlsModel.EngineLookup {
            ComposerControlsModel.lookup(afterFailing: APIError.server(
                status: status, code: code, message: "x", serverHash: nil, serverContent: nil
            ))
        }
        XCTAssertEqual(lookup(503, "bridge_offline"), .unreachable)
        XCTAssertEqual(lookup(500, "internal"), .unreachable)
        XCTAssertEqual(lookup(502, "http_error"), .unreachable)
        XCTAssertEqual(lookup(400, "bad_request"), .unusable)
        XCTAssertEqual(ComposerControlsModel.lookup(afterFailing: APIError.badResponse), .unusable)

        let p = plan(.unusable, lastKnown: .init(modelID: "a"))
        XCTAssertTrue(p.unreachable, "an unusable answer is still 'unknown', never a locked pill")
        XCTAssertFalse(p.readOnly)
        XCTAssertEqual(p.statusNote, ComposerControlsModel.unusableNote)
        XCTAssertEqual(p.currentModelID, "a")
    }

    /// The retry state still SHOWS the model, so the composer keeps a truthful
    /// label while the box is away.
    func testTheRetryStatePillStillCarriesItsLabel() {
        let controls = ComposerControlsModel(
            models: [], currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: nil, unreachable: true,
            statusNote: ComposerControlsModel.unreachableNote
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5")
        XCTAssertTrue(controls.unreachable)
        XCTAssertFalse(controls.readOnly, "the retry state must not render as read-only")
    }

    // MARK: - The only read-only left

    /// A box that EXPLICITLY says `switchable: false` is telling us the model is
    /// fixed; honoring that is honest. An ABSENT field is an old server and must
    /// never be read as a "no" — that inference is what locked the pill.
    func testOnlyAnExplicitSwitchableFalseLocksThePill() {
        let locked = plan(.engine(ChatEngineInfo(
            engine: "in-process", model: "haiku", switchable: false
        )))
        XCTAssertTrue(locked.readOnly)
        XCTAssertEqual(locked.currentModelID, "haiku")
        XCTAssertFalse((locked.readOnlyReason ?? "").contains("config"),
                       "the server-config story is exactly the message the user rejected")

        let silent = plan(.engine(ChatEngineInfo(engine: "in-process", model: "haiku")))
        XCTAssertFalse(silent.readOnly)
    }

    // MARK: - Write failures

    /// Picking on a server too old for `PUT /chat/model` must be reported as
    /// "too old" (and the pill reverts), not as a mystery.
    func testWriteFailureClassification() {
        func outcome(_ status: Int, _ code: String) -> ComposerControlsModel.WriteFailure {
            ComposerControlsModel.writeOutcome(for: APIError.server(
                status: status, code: code, message: "x", serverHash: nil, serverContent: nil
            ))
        }
        XCTAssertEqual(outcome(404, "http_error"), .serverTooOld)
        XCTAssertEqual(outcome(501, "not_implemented"), .serverTooOld)
        XCTAssertEqual(outcome(400, "unknown_model"), .rejected)
        XCTAssertEqual(outcome(409, "lane_engine"), .laneEngine)
        XCTAssertEqual(outcome(503, "primary_unreachable"), .unreachable)
        XCTAssertEqual(
            ComposerControlsModel.writeOutcome(
                for: APIError.network(underlying: URLError(.timedOut))
            ), .unreachable
        )
        XCTAssertTrue(
            ComposerControlsModel.WriteFailure.serverTooOld.note.lowercased().contains("too old"),
            "the note is what the picker shows on its next open"
        )
    }

    // MARK: - Decoding (additive)

    /// The new in-process shape, decoded whole.
    func testEngineDecodesTheInProcessContract() throws {
        let json = """
        {"engine":"in-process","sessionId":null,"switchable":true,
         "model":"global.anthropic.claude-opus-5[1m]","effort":"high",
         "models":[{"id":"global.anthropic.claude-opus-5[1m]","label":"Opus",
                    "supportsEffort":true,"supportedEffortLevels":["high","max"]}]}
        """
        let info = try JSONDecoder().decode(ChatEngineInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.engine, "in-process")
        XCTAssertNil(info.switchableSessionId, "in-process has no session to switch ON")
        XCTAssertEqual(info.switchable, true)
        XCTAssertFalse(info.isLockedByServer)
        XCTAssertEqual(info.effort, "high")
        XCTAssertEqual(info.models?.count, 1)
        XCTAssertEqual(info.models?.first?.supportedEffortLevels, ["high", "max"])

        let p = plan(.engine(info))
        XCTAssertFalse(p.readOnly)
        XCTAssertEqual(p.writeTarget, .chat(agentID: agent, conversationID: conversation))
    }

    /// A server predating the change: no `switchable`, no `effort`, no `models`.
    /// It must decode, and it must NOT lock.
    func testEngineDecodesAnOlderServerAndStaysSelectable() throws {
        let json = #"{"engine":"in-process","sessionId":null,"model":"global.anthropic.claude-opus-5"}"#
        let info = try JSONDecoder().decode(ChatEngineInfo.self, from: Data(json.utf8))
        XCTAssertNil(info.switchable)
        XCTAssertNil(info.models)
        XCTAssertFalse(info.isLockedByServer)
        XCTAssertFalse(plan(.engine(info)).readOnly)
    }

    /// A malformed additive value must degrade, not throw: a failed decode would
    /// read as "the box is unreachable" and hide a perfectly good engine answer.
    func testMalformedAdditiveFieldsDegradeInsteadOfFailingTheLookup() throws {
        let json = #"{"engine":"lane","sessionId":"s1","switchable":"yes","models":"nope","effort":7}"#
        let info = try JSONDecoder().decode(ChatEngineInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.switchableSessionId, "s1")
        XCTAssertNil(info.switchable)
        XCTAssertNil(info.models)
        XCTAssertNil(info.effort)
        XCTAssertEqual(plan(.engine(info)).writeTarget, .session(id: "s1"))
    }

    /// The lane shape keeps decoding exactly as before this change.
    func testEngineStillDecodesTheLaneShape() throws {
        let json = #"{"engine":"lane","sessionId":"s1","cwd":"/Users/x/.open-walnut","host":""}"#
        let info = try JSONDecoder().decode(ChatEngineInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.switchableSessionId, "s1")
        XCTAssertEqual(info.host, "", "\"\" means the primary box, not a missing host")
    }

    /// `PUT /chat/model` answers with the read-back, and a null effort is a real
    /// value ("this model has no effort axis"), not a missing field.
    func testChatModelChangeDecodesItsReadBack() throws {
        let a = try JSONDecoder().decode(
            ChatModelChange.self,
            data: #"{"model":"global.anthropic.claude-sonnet-5","effort":"high"}"#
        )
        XCTAssertEqual(a.model, "global.anthropic.claude-sonnet-5")
        XCTAssertEqual(a.effort, "high")

        let b = try JSONDecoder().decode(
            ChatModelChange.self, data: #"{"model":"haiku","effort":null}"#
        )
        XCTAssertEqual(b.model, "haiku")
        XCTAssertNil(b.effort)
    }
}

private extension JSONDecoder {
    func decode<T: Decodable>(_ type: T.Type, data json: String) throws -> T {
        try decode(type, from: Data(json.utf8))
    }
}
