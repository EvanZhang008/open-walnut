import XCTest
@testable import Walnut

/// The model sheet's Cost, Speed and Details rows and pages (`ModelSheetFormat`,
/// `ModelSheetFacts`), and the wire shapes they read.
///
/// The bug class: a row whose number means something other than the web picker's
/// (a rate over a window too short to divide, a total that hides unpriced
/// requests, a percentage rounded differently), or a server that does not answer
/// turning into an error instead of "n/a".
@MainActor
final class ModelSheetFormatTests: XCTestCase {
    private typealias F = ModelSheetFormat

    private func cost(
        _ status: String, total: Double? = nil, unpriced: Int = 0,
        pending: SessionCostFacts.Cost.Pending? = nil
    ) -> SessionCostFacts.Cost {
        SessionCostFacts.Cost(status: status, totalUsd: total, unpricedResponses: unpriced, pending: pending)
    }

    // MARK: - Cost

    func testTheCostRowReadsTheTotalByTheWebsRules() {
        XCTAssertEqual(F.costValue(cost("priced", total: 102.31)), "$102")
        XCTAssertEqual(F.costValue(cost("priced", total: 29.194)), "$29.19")
        XCTAssertEqual(F.costValue(cost("priced", total: 0.0031)), "$0.0031")
        XCTAssertEqual(F.costValue(cost("priced", total: 0.003)), "$0.0030")
        XCTAssertEqual(F.costValue(cost("priced", total: 0)), "$0")
        XCTAssertEqual(F.costValue(cost("partial", total: 141.2, unpriced: 3)), "$141+", "unpriced requests are not $0")
        XCTAssertEqual(F.costValue(cost("unpriced", total: nil, unpriced: 2)), "?")
        XCTAssertEqual(F.costValue(cost("unavailable")), "n/a")
        XCTAssertEqual(F.costValue(cost("pending")), "reading…")
        XCTAssertEqual(F.costValue(cost("empty", total: 0)), "$0")
    }

    func testTheCostPageSaysWhatTheTotalLeavesOut() {
        XCTAssertEqual(F.costHeadline(cost("priced", total: 102.31)), "$102")
        XCTAssertEqual(F.costHeadline(cost("partial", total: 5.5, unpriced: 1)), "$5.50 + 1 request without a price")
        XCTAssertEqual(F.costHeadline(cost("unpriced", unpriced: 4)), "Unknown (4 requests without a price)")
        XCTAssertEqual(F.costHeadline(cost("pending", pending: .init(readBytes: 40, totalBytes: 100))),
                       "Reading the transcript (40%)…")
        XCTAssertEqual(F.costHeadline(cost("empty", total: 0)), "$0 so far")
        XCTAssertEqual(F.costHeadline(cost("unavailable")), "Not available")
    }

    func testTheCostPageNamesItsSpanModelTimeAndEachModel() {
        var c = cost("priced", total: 102.31)
        c.firstAt = "2026-11-19T15:00:00.000Z"
        c.lastAt = "2026-11-21T08:00:00.000Z"
        c.apiDurationMs = 3_960_000
        c.models = [
            .init(model: "claude-fable-5-1", speed: "standard", responses: 1052, costUsd: 1234.5),
            .init(model: "gpt-6-1-sol", speed: "fast", responses: 1, costUsd: nil),
        ]
        XCTAssertEqual(F.costTimes(c), [.init(label: "Span", value: "1d 17h"), .init(label: "Model time", value: "1h 6m")])
        XCTAssertEqual(F.costModels(c), [
            .init(label: "Fable 5.1", value: "1052 requests · $1,234.50"),
            .init(label: "GPT-6.1 Sol fast", value: "1 request · no price"),
        ])
    }

    func testTheBudgetLine() {
        typealias B = SessionCostFacts.Budget
        XCTAssertEqual(F.budgetSummary(nil), "No budget")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: nil, spentUsd: 3, state: "unlimited")), "No budget")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: 200, spentUsd: 102.31, state: "active")), "$102.31 of $200.00")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: 200, spentUsd: nil, state: "checking")), "$200.00 · checking")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: 1500, spentUsd: 1, state: "active", checkError: "x")),
                       "$1,500.00 · usage could not be read")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: 100, spentUsd: 100.4, state: "paused", reason: "limit")),
                       "Paused at budget: $100.40 of $100.00")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: 100, spentUsd: 1, state: "paused", reason: "unpriced", unpricedModel: "m-x")),
                       "Paused: a request on m-x has no price")
        XCTAssertEqual(F.budgetSummary(B(limitUsd: nil, spentUsd: nil, state: "paused", reason: "unreadable")),
                       "Paused: its usage could not be read")
        XCTAssertEqual(F.usageUsd(0.004), "<$0.01")
    }

    // MARK: - Durations and counts

    func testDurationsAndSecondsSpellLikeTheWeb() {
        XCTAssertEqual(F.duration(45_000), "45s")
        XCTAssertEqual(F.duration(12 * 60_000), "12m")
        XCTAssertEqual(F.duration(3 * 3_600_000), "3h")
        XCTAssertEqual(F.duration((3 * 60 + 4) * 60_000), "3h 4m")
        XCTAssertEqual(F.duration((5 * 24 + 11) * 3_600_000), "5d 11h")
        XCTAssertEqual(F.seconds(573), "0.6s")
        XCTAssertEqual(F.seconds(2563), "2.6s")
        XCTAssertEqual(F.seconds(52_910), "53s", "ten seconds and over round to the second")
        XCTAssertEqual(F.seconds(65_000), "1m 05s")
        XCTAssertEqual(F.tokenCount(767_600), "767.6K")
        XCTAssertEqual(F.tokenCount(828_400), "828.4K")
        XCTAssertEqual(F.tokenCount(1_000_000), "1M")
        XCTAssertEqual(F.tokenCount(950), "950")
    }

    // MARK: - Speed

    private let sol = SessionTurnSpeed(
        outputTokens: 137, generationMs: 573, ttftMs: 2563, durationMs: 52_910,
        model: "openai.gpt-6.1-sol[xhigh]", tokenScope: "last-call"
    )

    func testTheRateIsRealTokensOverTheGenerationWindow() {
        XCTAssertEqual(F.tokensPerSecond(sol), "239 tok/s")
        XCTAssertEqual(F.speedValue(sol), "239 tok/s")
    }

    func testAWindowUnderHalfASecondHasNoRate() {
        let short = SessionTurnSpeed(outputTokens: 4, generationMs: 499)
        XCTAssertNil(F.tokensPerSecond(short))
        XCTAssertEqual(F.speedValue(short), "—", "a finished turn too short to divide")
        XCTAssertNil(F.tokensPerSecond(SessionTurnSpeed(outputTokens: 0, generationMs: 4000)))
    }

    func testNoMeasuredTurnReadsADashAndALiveOneWithNoCountAnEllipsis() {
        XCTAssertEqual(F.speedValue(nil), "—")
        XCTAssertEqual(F.speedValue(SessionTurnSpeed(isFinal: false)), "…")
    }

    /// The Speed page's table: one row for the turn, labelled once by its state, with the
    /// "last call" scope kept; numbers as the web's Speed fold writes them.
    func testTheSpeedTableRowsSayWhatTheCountCovers() {
        let name: (String?) -> String? = { $0 == nil ? nil : "GPT-6.1 Sol" }
        XCTAssertEqual(F.speedRows(sol, now: 0, name: name), [
            .init(label: "Last turn", model: "GPT-6.1 Sol", states: ["last call"], running: false,
                  tokens: "137", first: "2.6s", speed: "239 tok/s", time: "53s"),
        ])
        var whole = SessionTurnSpeed(outputTokens: 840, generationMs: 12_000, durationMs: 30_000)
        whole.turnOutputTokens = 1210
        whole.partial = true
        XCTAssertEqual(F.speedRows(whole, now: 0, name: { _ in nil }), [
            .init(label: "Last turn", model: nil, states: ["partial"], running: false,
                  tokens: "1,210", first: "", speed: "70 tok/s", time: "30s"),
        ])
        // A turn still running reads "This turn" (never both labels), its clocks from `now`.
        var live = SessionTurnSpeed(isFinal: false)
        live.startedAt = 1_000
        let row = F.speedRows(live, now: 5_000, name: { _ in nil })[0]
        XCTAssertEqual(row.label, "This turn")
        XCTAssertTrue(row.running)
        XCTAssertEqual(row.first, "4.0s…")
        XCTAssertEqual(row.time, "4.0s")
        var stopped = sol
        stopped.interrupted = true
        stopped.partial = true
        XCTAssertEqual(F.speedRows(stopped, now: 0, name: name)[0].states, ["stopped", "last call"])
    }

    /// One row per model the turn's agents ran on, in the order each first ran; tokens are
    /// always an estimate; the state word only while it is not done.
    func testTheSpeedTableHasOneRowPerAgentModel() {
        var turn = sol
        turn.lanes = [
            SessionTurnSpeedLane(model: "claude-haiku-5-5", startedAt: 0, firstReplyMs: 1_200, generationMs: 8_000,
                                 estimatedTokens: 900, status: "done", endedAt: 30_000),
            SessionTurnSpeedLane(model: "claude-sonnet-5-5", startedAt: 1_000, firstReplyMs: nil, generationMs: 0,
                                 estimatedTokens: 0, status: "running"),
            SessionTurnSpeedLane(model: "claude-haiku-5-5", startedAt: 2_000, firstReplyMs: 900, generationMs: 4_000,
                                 estimatedTokens: 300, status: "failed", endedAt: 12_000),
        ]
        let rows = F.speedRows(turn, now: 11_000, name: { $0 })
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[1], .init(label: "Agents ×2", model: "claude-haiku-5-5", states: ["failed"], running: false,
                                      tokens: "~1,200", first: "0.9s", speed: "~100 tok/s", time: "30s"))
        XCTAssertEqual(rows[2], .init(label: "Agent", model: "claude-sonnet-5-5", states: ["running"], running: true,
                                      tokens: "~0", first: "10s…", speed: "", time: "10s"))
        XCTAssertEqual(F.speedRowTitle(rows[2]), "Agent, claude-sonnet-5-5, running")
    }

    func testAModelIsNamedByTheMenuElseReadFromItsID() {
        let menu = PillMenu(sections: [.init(title: "Model", items: [
            .init(title: "Fable 5.1 1M", choice: .model("global.anthropic.claude-fable-5-1[1m]")),
        ])], token: ComposerControlsModel(models: [], currentModelID: nil, currentEffort: nil).menuToken)
        XCTAssertEqual(F.modelName("global.anthropic.claude-fable-5-1[1m]", menu: menu), "Fable 5.1 1M")
        XCTAssertEqual(F.modelName("openai.gpt-6.1-sol[xhigh]", menu: menu), "GPT-6.1 Sol")
        XCTAssertEqual(F.modelName("global.anthropic.claude-opus-5-5[1m]", menu: menu), "Opus 5.5 1M")
        XCTAssertNil(F.modelName(nil, menu: menu))
    }

    // MARK: - Average speed

    private func record(model: String? = nil, acpModel: String? = nil, totals: [String: SessionSpeedTotals.Total]? = nil) -> SessionDetail.Record {
        var r = SessionDetail.Record(claudeSessionId: "s", processStatus: nil, title: nil, mode: nil, archived: nil)
        r.model = model
        r.acpModel = acpModel
        r.lastTurnSpeed = sol
        r.speedTotals = totals.map(SessionSpeedTotals.init)
        return r
    }

    func testTheSpeedRowReadsTheSessionsAverageOnItsModel() {
        XCTAssertEqual(F.speedValue(record()), "239 tok/s", "no average yet: the last turn")
        let fable = record(model: "global.anthropic.claude-fable-5-1[1m]",
                           totals: ["claude-fable-5-1": .init(outputTokens: 12_800, generationMs: 100_000, turns: 42)])
        XCTAssertEqual(F.speedValue(fable), "128 tok/s avg", "the 1M window and the provider prefix name the same model")
        XCTAssertEqual(F.speedAverage(fable), .init(tps: "128 tok/s", turns: 42))
        XCTAssertEqual(F.averageLines(.init(tps: "128 tok/s", turns: 42), modelName: "Fable 5.1 1M"),
                       [.init(label: "Average", value: "128 tok/s"), .init(label: "Turns", value: "42 on Fable 5.1 1M")])
        XCTAssertEqual(F.averageLines(.init(tps: "90 tok/s", turns: 1_200), modelName: nil),
                       [.init(label: "Average", value: "90 tok/s"), .init(label: "Turns", value: "1,200")])
        let other = record(model: "global.anthropic.claude-opus-5-5",
                           totals: ["claude-fable-5-1": .init(outputTokens: 12_800, generationMs: 100_000, turns: 42)])
        XCTAssertEqual(F.speedValue(other), "239 tok/s", "another model's average is not this one's")
        var none = fable
        none.lastTurnSpeed = nil
        XCTAssertEqual(F.speedValue(none), "—", "no measured turn")
    }

    func testAnAcpSessionsAverageIsKeyedWithoutItsEffort() {
        let acp = record(acpModel: "openai.gpt-6.2-sol[max]",
                         totals: ["openai.gpt-6.2-sol": .init(outputTokens: 1_000, generationMs: 10_000, turns: 3)])
        XCTAssertEqual(F.currentModel(acp), "openai.gpt-6.2-sol")
        XCTAssertEqual(F.speedValue(acp), "100 tok/s avg")
        let short = record(acpModel: "openai.gpt-6.2-sol[max]",
                           totals: ["openai.gpt-6.2-sol": .init(outputTokens: 10, generationMs: 100, turns: 1)])
        XCTAssertEqual(F.speedValue(short), "239 tok/s", "a window under half a second is no rate")
    }

    func testSpeedTotalsDecodeLenientlyAndOlderServersSendNone() throws {
        let json = #"{"session":{"claudeSessionId":"s1","acpModel":"openai.gpt-6.2-sol[max]","speedTotals":{"openai.gpt-6.2-sol":{"outputTokens":12800,"generationMs":100000,"turns":42,"lastAt":1},"odd":{"outputTokens":"many"}}},"pendingPermissions":[]}"#
        let r = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8)).session
        XCTAssertEqual(r.speedTotals, SessionSpeedTotals(["openai.gpt-6.2-sol": .init(outputTokens: 12_800, generationMs: 100_000, turns: 42)]))
        XCTAssertEqual(r.acpModel, "openai.gpt-6.2-sol[max]")
        let wrong = #"{"session":{"claudeSessionId":"s1","speedTotals":"x"},"pendingPermissions":[]}"#
        XCTAssertEqual(try JSONDecoder().decode(SessionDetail.self, from: Data(wrong.utf8)).session.speedTotals?.models, [:])
        let bare = #"{"session":{"claudeSessionId":"s1"},"pendingPermissions":[]}"#
        XCTAssertNil(try JSONDecoder().decode(SessionDetail.self, from: Data(bare.utf8)).session.speedTotals)
    }

    // MARK: - Details

    func testContextPercentAndTheNinetyPercentDot() {
        let full = F.Context(used: 767_600, window: 828_400)
        XCTAssertEqual(full.text, "767.6K / 828.4K (93%)")
        XCTAssertEqual(full.warning, "Context 93% full")
        XCTAssertEqual(F.Context(used: 89_400, window: 100_000).warning, nil, "89% has no dot")
        XCTAssertEqual(F.Context(used: 89_500, window: 100_000).warning, "Context 90% full", "rounded as the web rounds")
        XCTAssertEqual(F.Context(used: 50_000, window: nil).text, "50K")
        XCTAssertNil(F.Context(used: 50_000, window: nil).warning)
    }

    func testTheContextIsTheEnginesCountElseThePromptSize() {
        var record = SessionDetail.Record(claudeSessionId: "s", processStatus: nil, title: nil, mode: nil, archived: nil)
        XCTAssertNil(F.context(record))
        record.promptCache = SessionPromptCache(tokens: 120_000)
        record.modelMaxWindow = 1_000_000
        XCTAssertEqual(F.context(record)?.text, "120K / 1M (12%)")
        record.contextTokens = 767_600
        XCTAssertEqual(F.context(record)?.used, 767_600)
        XCTAssertEqual(F.engineName(nil), "Claude Code")
        XCTAssertEqual(F.engineName("codex"), "Codex")
        XCTAssertEqual(F.modeName("bypass"), "Bypass")
    }

    // MARK: - Wire shapes

    func testARecordWithTheNewFieldsDecodesThem() throws {
        let json = """
        {"session":{"claudeSessionId":"s1","process_status":"idle","engine":"codex",
          "lastTurnSpeed":{"outputTokens":137,"generationMs":573,"ttftMs":2563,"durationMs":52910,
            "tokenScope":"last-call","final":true,"model":"openai.gpt-6.1-sol[xhigh]","messages":1,
            "inFlight":false,"inFlightChars":0,"inFlightMs":0,"inFlightVisibleMs":0,"lanes":[]},
          "contextTokens":767600,"modelMaxWindow":828400,"promptCache":{"tokens":5,"requestAt":"x"}},
         "pendingPermissions":[]}
        """
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.session.lastTurnSpeed, sol)
        XCTAssertEqual(detail.session.contextTokens, 767_600)
        XCTAssertEqual(detail.session.modelMaxWindow, 828_400)
        XCTAssertEqual(detail.session.promptCache?.tokens, 5)
        XCTAssertEqual(detail.session.engine, "codex")
    }

    func testATurnsStateAndItsAgentsDecode() throws {
        let json = #"{"session":{"claudeSessionId":"s1","lastTurnSpeed":{"outputTokens":10,"generationMs":900,"final":true,"partial":true,"interrupted":false,"lanes":[{"id":"a","model":"claude-haiku-5-5","startedAt":5,"firstReplyMs":null,"generationMs":800,"messages":2,"estimatedTokens":40,"status":"running"},{"id":"b","label":"Explore","startedAt":"odd","generationMs":0,"messages":0,"estimatedTokens":0,"status":7}]}},"pendingPermissions":[]}"#
        let speed = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8)).session.lastTurnSpeed
        XCTAssertEqual(speed?.partial, true)
        XCTAssertEqual(speed?.interrupted, false)
        XCTAssertEqual(speed?.lanes, [
            SessionTurnSpeedLane(model: "claude-haiku-5-5", startedAt: 5, generationMs: 800, estimatedTokens: 40, status: "running"),
            // An odd field drops that field only, never the lane.
            SessionTurnSpeedLane(label: "Explore"),
        ])
    }

    func testARecordWithoutThemOrWithOddOnesStillDecodes() throws {
        let bare = #"{"session":{"claudeSessionId":"s1","process_status":"idle"},"pendingPermissions":[]}"#
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(bare.utf8))
        XCTAssertNil(detail.session.lastTurnSpeed)
        XCTAssertNil(detail.session.contextTokens)
        XCTAssertNil(detail.session.engine)
        // A speed field of a type this build does not expect drops that field only.
        let odd = #"{"session":{"claudeSessionId":"s1","lastTurnSpeed":{"outputTokens":"many","generationMs":900,"ttftMs":null}},"pendingPermissions":[]}"#
        let speed = try JSONDecoder().decode(SessionDetail.self, from: Data(odd.utf8)).session.lastTurnSpeed
        XCTAssertEqual(speed?.outputTokens, 0)
        XCTAssertEqual(speed?.generationMs, 900)
        XCTAssertNil(speed?.ttftMs)
    }

    func testTheCostRoutesAnswerDecodes() throws {
        let json = """
        {"cost":{"sessionId":"s1","engine":"claude","source":"claude-transcript","status":"priced","totalUsd":102.31,
          "responses":1052,"unpricedResponses":0,"prices":{"source":"litellm"},
          "models":[{"model":"claude-fable-5-1","speed":"standard","responses":1052,"costUsd":102.31,
            "tokens":{"input":1},"unpricedResponses":0,"longResponses":0,"webSearches":0,"usRegionResponses":0,
            "firstAt":"a","lastAt":"b"}]},
         "budget":{"limitUsd":null,"spentUsd":null,"state":"unlimited","reason":null,"revision":0,"responses":0,
           "unpricedResponses":0,"updatedAt":null,"pausedAt":null,"pauseId":null,"stopError":null,"engine":null}}
        """
        let facts = try JSONDecoder().decode(SessionCostFacts.self, from: Data(json.utf8))
        XCTAssertEqual(F.costValue(facts.cost), "$102")
        XCTAssertEqual(facts.cost.models?.first?.responses, 1052)
        XCTAssertEqual(F.budgetSummary(facts.budget), "No budget")
        let none = try JSONDecoder().decode(SessionCostFacts.self, from: Data(#"{"cost":{"status":"empty","totalUsd":0},"budget":null}"#.utf8))
        XCTAssertNil(none.budget)
    }

    // MARK: - The facts model

    private struct Transport: ModelSheetTransport {
        var detail: Result<SessionDetail, Error>
        var cost: Result<SessionCostFacts, Error>
        func sessionDetail(id: String) async throws -> SessionDetail { try detail.get() }
        func sessionCostFacts(id: String) async throws -> SessionCostFacts { try cost.get() }
    }

    private struct Missing: Error {}

    func testEveryRowReadsAnEllipsisUntilAsked() {
        let facts = ModelSheetFacts(sessionID: "s1", transport: Transport(detail: .failure(Missing()), cost: .failure(Missing())))
        XCTAssertEqual(facts.costValue, "…")
        XCTAssertEqual(facts.speedValue, "…")
        XCTAssertNil(facts.detailsWarning)
    }

    func testAnOlderServerLeavesNAndNoError() async {
        let notFound = APIError.server(status: 404, code: "not_found", message: "stub does not serve", serverHash: nil, serverContent: nil)
        let record = SessionDetail.Record(claudeSessionId: "s1", processStatus: nil, title: nil, mode: nil, archived: nil)
        let facts = ModelSheetFacts(sessionID: "s1", transport: Transport(
            detail: .success(SessionDetail(session: record, pendingPermissions: [])), cost: .failure(notFound)
        ))
        await facts.load()
        XCTAssertEqual(facts.costValue, "n/a")
        XCTAssertFalse(facts.budgetPaused)
        XCTAssertEqual(facts.speedValue, "—", "a record with no turn measured")
    }

    func testAnsweredFactsFillTheRowsAndTheDots() async {
        var record = SessionDetail.Record(claudeSessionId: "s1", processStatus: nil, title: nil, mode: nil, archived: nil)
        record.lastTurnSpeed = sol
        record.contextTokens = 767_600
        record.modelMaxWindow = 828_400
        let paid = SessionCostFacts(
            cost: cost("priced", total: 102.31),
            budget: .init(limitUsd: 100, spentUsd: 102.31, state: "paused", reason: "limit")
        )
        let facts = ModelSheetFacts(sessionID: "s1", transport: Transport(
            detail: .success(SessionDetail(session: record, pendingPermissions: [])), cost: .success(paid)
        ))
        await facts.load()
        XCTAssertEqual(facts.costValue, "$102")
        XCTAssertTrue(facts.budgetPaused)
        XCTAssertEqual(facts.speedValue, "239 tok/s")
        XCTAssertEqual(facts.detailsWarning, "Context 93% full")
    }

    /// A server that never answers: the deadline is the only way out of `load()`
    /// (each call waits an hour), so this test finishing at all is the check.
    func testAServerThatNeverAnswersIsGivenUpOnAtTheDeadline() async {
        struct Hanging: ModelSheetTransport {
            func sessionDetail(id: String) async throws -> SessionDetail {
                try await Task.sleep(for: .seconds(3600))
                throw CancellationError()
            }
            func sessionCostFacts(id: String) async throws -> SessionCostFacts {
                try await Task.sleep(for: .seconds(3600))
                throw CancellationError()
            }
        }
        let facts = ModelSheetFacts(sessionID: "s1", transport: Hanging(), deadline: .milliseconds(100))
        await facts.load()
        XCTAssertEqual(facts.costValue, "n/a")
        XCTAssertEqual(facts.speedValue, "n/a")
    }
}
