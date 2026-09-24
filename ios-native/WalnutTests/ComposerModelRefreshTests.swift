import XCTest
@testable import Walnut

/// The composer model pill must CONVERGE to what the Mac offers, with no tap.
///
/// The field report (TestFlight build 82, phone on a cloud replica): the pill said
/// "Opus 5" with a one-row menu for 5.5 hours while the Mac offered ten models.
/// The Mac's bridge to the replica blipped for about 1.3s, the phone's only
/// `GET /chat/engine` landed in the gap, an old replica answered its own one-model
/// config, and nothing ever asked again: `attach` was a no-op for the same
/// source, and the only other path was a Retry button the unreachable state alone
/// showed.
///
/// Then the independent gate reproduced two more (2026-09-24): an answer that
/// landed while the menu was open rebuilt its rows under the finger (a tap wrote
/// a model the user never chose), and a same-agent conversation switch showed the
/// previous conversation's model. Both are pinned below.
///
/// Two layers here. The POLICY (`ComposerModelRefreshPolicy`) is pure, so its
/// ladder and triggers are plain assertions. The MODEL is then driven for real
/// through a scripted transport, an injected clock, and a sleep that never
/// returns on its own: time moves only when a test moves it, and a scheduled
/// re-ask fires only when a test fires it. So "spaced retries", "no hot loop" and
/// "a stale answer never lands on a new conversation" are facts about request
/// counts, not about how long a test happened to wait.
@MainActor
final class ComposerModelRefreshTests: XCTestCase {

    typealias Policy = ComposerModelRefreshPolicy

    // MARK: - Fixtures

    private static let fable = "global.anthropic.claude-fable-5-1[1m]"
    private static let opus55 = "global.anthropic.claude-opus-5-5[1m]"
    private static let opus5 = "global.anthropic.claude-opus-5"

    /// The ten-row catalog a real Mac answers with (ids shaped like the real ones).
    private static let fullCatalog: [SessionModelOptions.Model] = [
        row(fable, "Fable", ["low", "medium", "high", "xhigh", "max"]),
        row(opus55, "Opus", ["low", "medium", "high", "xhigh", "max"]),
        row("global.anthropic.claude-opus-5[1m]", "Opus", ["high", "max"]),
        row("global.anthropic.claude-sonnet-5-1", "Sonnet", ["high"]),
        row("global.anthropic.claude-sonnet-5", "Sonnet", ["high"]),
        row("global.anthropic.claude-haiku-5", "Haiku", nil),
        row("gpt-6-astra", "GPT-6 Astra", ["high"]),
        row("gpt-6-sol", "GPT-6 Sol", ["high"]),
        row("gpt-5.6-sol", "GPT-5.6 Sol", ["high"]),
        row("gpt-6-luna", "GPT-6 Luna", nil),
    ]

    private static func row(
        _ id: String, _ label: String, _ levels: [String]?
    ) -> SessionModelOptions.Model {
        SessionModelOptions.Model(
            id: id, label: label, supportsEffort: levels != nil, supportedEffortLevels: levels
        )
    }

    private static let unreachable503 = APIError.server(
        status: 503, code: "primary_unreachable",
        message: "The primary box isn't reachable", serverHash: nil, serverContent: nil
    )

    /// A healthy primary: lane engine with a live session.
    private static let laneEngine = ChatEngineInfo(engine: "lane", sessionId: "sess-lane-1", cwd: "/x", host: "")

    /// What an OLD replica answered while the Mac was away: its own in-process
    /// config, one model, no catalog.
    private static let degradedEngine = ChatEngineInfo(engine: "in-process", model: opus5)

    private var clock: ComposerTestClock!
    private var transport: ScriptedComposerTransport!

    override func setUp() {
        super.setUp()
        clock = ComposerTestClock()
        transport = ScriptedComposerTransport()
        let clock = self.clock!
        transport.now = { clock.now }
        transport.options = { _ in
            .success(SessionModelOptions(
                models: Self.fullCatalog, current: Self.fable, currentEffort: "high"
            ))
        }
    }

    override func tearDown() {
        // A held call left suspended would leak its continuation into the next test.
        transport.releaseAll()
        super.tearDown()
    }

    /// The real model, visible and in the foreground, with time under test control.
    private func makeModel() -> ComposerControlsModel {
        let clock = self.clock!
        let model = ComposerControlsModel(
            transport: transport,
            now: { clock.now },
            // Never returns on its own: a wake fires only through the test seam.
            sleep: { _ in try await Task.sleep(for: .seconds(100_000)) }
        )
        model.setVisible(true)
        return model
    }

    private let chat = ComposerControlsModel.Source.chat(agentID: "general", conversationID: "conv-1")

    /// What the composer row says: the model pill, then the effort pill if any
    /// ("Fable 5.1 · High" reads the two pills "Fable 5.1" and "High").
    private func pills(_ model: ComposerControlsModel) -> String? {
        guard let name = model.pillLabel else { return nil }
        guard let effort = model.effortPillLabel else { return name }
        return "\(name) · \(effort)"
    }

    /// The model menu's row titles, top to bottom, as the UIKit menu shows them.
    private func menuRows(_ model: ComposerControlsModel) -> [String] {
        model.modelMenu.sections.flatMap { $0.items.map(\.title) }
    }

    private func open(_ model: ComposerControlsModel, _ source: ComposerControlsModel.Source? = nil) async {
        model.attach(source ?? chat)
        await model.settleForTesting()
    }

    /// Move time to the scheduled wake, fire it, and wait for the load it starts.
    @discardableResult
    private func fireWake(_ model: ComposerControlsModel, file: StaticString = #filePath, line: UInt = #line) async -> Policy.Wake? {
        guard let wake = model.scheduledWake else {
            XCTFail("nothing was scheduled", file: file, line: line)
            return nil
        }
        clock.advance(wake.delay)
        model.fireScheduledWakeForTesting()
        await model.settleForTesting()
        return wake
    }

    // MARK: - Policy: the retry ladder

    func testRetryLadderIsOneTwoFourEightFifteenThenThirtyForever() {
        let delays = (1...9).map { Policy.retryDelay(afterFailures: $0) }
        XCTAssertEqual(delays, [1, 2, 4, 8, 15, 30, 30, 30, 30])
        XCTAssertEqual(Policy.retryDelay(afterFailures: 0), 0, "no failure, no retry delay")
        XCTAssertEqual(Policy.retryDelay(afterFailures: 10_000), Policy.retryCap,
                       "a phone offline for days still asks at the cap, never faster")
        XCTAssertEqual(Policy.retryCap, 30)
    }

    /// Scenario 7, as arithmetic: an hour offline is a bounded number of requests,
    /// and no two are closer than the first rung.
    func testAnHourOfflineIsABoundedNumberOfSpacedRequests() {
        var elapsed: TimeInterval = 0
        var attempts = 1   // the first lookup
        var failures = 1
        var minSpacing = TimeInterval.infinity
        while true {
            let delay = Policy.retryDelay(afterFailures: failures)
            guard elapsed + delay <= 3600 else { break }
            elapsed += delay
            minSpacing = min(minSpacing, delay)
            attempts += 1
            failures += 1
        }
        XCTAssertLessThanOrEqual(attempts, 6 + 3600 / 30 + 1, "an hour offline must stay near 2 requests a minute")
        XCTAssertGreaterThanOrEqual(minSpacing, 1, "no two retries may be closer than 1s (no hot loop)")
    }

    // MARK: - Policy: when a trigger asks

    private func snap(
        active: Bool = true, applying: Bool = false, inFlightSince: TimeInterval? = nil,
        successAgo: TimeInterval? = nil, failureAgo: TimeInterval? = nil, failures: Int = 0,
        suspect: Int = 0, now: Date
    ) -> Policy.Snapshot {
        Policy.Snapshot(
            active: active, applying: applying,
            loadStartedAt: inFlightSince.map { now.addingTimeInterval(-$0) },
            lastSuccessAt: successAgo.map { now.addingTimeInterval(-$0) },
            lastFailureAt: failureAgo.map { now.addingTimeInterval(-$0) },
            consecutiveFailures: failures,
            suspectAnswers: suspect
        )
    }

    func testTriggersAskWhenSomethingMayHaveChanged() {
        let now = Date(timeIntervalSince1970: 5_000)
        let fresh = snap(successAgo: 2, now: now)
        XCTAssertEqual(Policy.decide(.foreground, fresh, now: now), .loadNow,
                       "coming back to the app always re-asks, however fresh the answer")
        XCTAssertEqual(Policy.decide(.streamConnected, fresh, now: now), .loadNow,
                       "a reconnect ends a gap, and the answer may be from inside it")
        XCTAssertEqual(Policy.decide(.ttl, fresh, now: now), .loadNow)
        XCTAssertEqual(Policy.decide(.manual, fresh, now: now), .loadNow)

        XCTAssertEqual(Policy.decide(.recheck, fresh, now: now), .loadNow)

        // A re-appearance re-asks only a stale answer.
        XCTAssertEqual(Policy.decide(.appeared, snap(successAgo: 9, now: now), now: now), .skip)
        XCTAssertEqual(Policy.decide(.appeared, snap(successAgo: 10, now: now), now: now), .loadNow)
        XCTAssertEqual(Policy.decide(.appeared, snap(failureAgo: 1.5, failures: 3, now: now), now: now),
                       .loadNow, "coming back to the pill in the retry state is a good moment to try")
        XCTAssertEqual(Policy.decide(.appeared, snap(failureAgo: 0.2, failures: 3, now: now), now: now),
                       .skip, "but never sooner than 1s after the last attempt")
    }

    func testNothingAsksOffScreenOrInTheBackground() {
        let now = Date(timeIntervalSince1970: 5_000)
        let away = snap(active: false, successAgo: 300, now: now)
        for trigger: Policy.Trigger in [.foreground, .streamConnected, .ttl, .retry, .recheck, .appeared, .followUp] {
            XCTAssertEqual(Policy.decide(trigger, away, now: now), .skip, "\(trigger) asked while inactive")
        }
        XCTAssertNil(Policy.nextWake(snap(active: false, failureAgo: 0, failures: 2, now: now), now: now),
                     "a backgrounded composer must arm no retry timer")
        XCTAssertNil(Policy.nextWake(snap(active: false, successAgo: 0, now: now), now: now))
    }

    /// A trigger that lands right after a load STARTED is answered by it; one that
    /// lands later is owed a second ask (the load may have been sent into the gap).
    func testTriggersDuringAnInFlightLoadCoalesceOrAreOwed() {
        let now = Date(timeIntervalSince1970: 5_000)
        XCTAssertEqual(Policy.decide(.foreground, snap(inFlightSince: 0.1, now: now), now: now), .skip)
        XCTAssertEqual(Policy.decide(.streamConnected, snap(inFlightSince: 3, now: now), now: now), .afterCurrent)
        XCTAssertEqual(Policy.decide(.appeared, snap(inFlightSince: 3, now: now), now: now), .skip,
                       "the in-flight load already answers a re-appearance")
        XCTAssertEqual(Policy.decide(.recheck, snap(inFlightSince: 3, now: now), now: now), .skip)
        XCTAssertEqual(Policy.decide(.ttl, snap(inFlightSince: 3, now: now), now: now), .skip)
        XCTAssertEqual(Policy.decide(.manual, snap(inFlightSince: 3, now: now), now: now), .loadNow,
                       "Retry always asks")
    }

    /// Measured on launch: the attach load's 503 came back in under 0.1s and the
    /// scene's first `.active` edge asked again right behind it (two GETs 0.1s
    /// apart in the stub's log). An answer that just landed IS the answer.
    func testAForegroundOrReconnectRightAfterAnAnswerLandedIsAnsweredByIt() {
        let now = Date(timeIntervalSince1970: 5_000)
        XCTAssertEqual(Policy.decide(.foreground, snap(failureAgo: 0.1, failures: 1, now: now), now: now), .skip,
                       "a failure 0.1s old keeps its own 1s retry rung; no second request on top")
        XCTAssertEqual(Policy.decide(.streamConnected, snap(successAgo: 0.3, now: now), now: now), .skip)
        XCTAssertEqual(Policy.decide(.foreground, snap(successAgo: 1.5, now: now), now: now), .loadNow)
        XCTAssertEqual(Policy.decide(.followUp, snap(successAgo: 0.1, now: now), now: now), .loadNow,
                       "an owed re-ask is owed precisely because the answer that just landed may be stale")
        XCTAssertEqual(Policy.decide(.manual, snap(failureAgo: 0.1, failures: 1, now: now), now: now), .loadNow)
    }

    /// Scenario 5, policy half: while a pick is being written, nothing starts.
    func testNothingStartsUnderAPickButTheAskIsOwed() {
        let now = Date(timeIntervalSince1970: 5_000)
        for trigger: Policy.Trigger in [.foreground, .streamConnected, .ttl, .recheck, .manual] {
            XCTAssertEqual(Policy.decide(trigger, snap(applying: true, successAgo: 100, now: now), now: now),
                           .afterCurrent, "\(trigger) must wait for the pick, then ask")
        }
        XCTAssertNil(Policy.nextWake(snap(applying: true, successAgo: 100, now: now), now: now))
    }

    func testNextWakeIsTheRetryRungOrTheTTL() {
        let now = Date(timeIntervalSince1970: 5_000)
        XCTAssertEqual(Policy.nextWake(snap(failureAgo: 0, failures: 3, now: now), now: now),
                       Policy.Wake(trigger: .retry, delay: 4))
        XCTAssertEqual(Policy.nextWake(snap(failureAgo: 1, failures: 3, now: now), now: now),
                       Policy.Wake(trigger: .retry, delay: 3), "the rung is measured from the failure")
        XCTAssertEqual(Policy.nextWake(snap(failureAgo: 99, failures: 3, now: now), now: now),
                       Policy.Wake(trigger: .retry, delay: 0), "an overdue retry fires at once")
        XCTAssertEqual(Policy.nextWake(snap(successAgo: 15, now: now), now: now),
                       Policy.Wake(trigger: .ttl, delay: 45))
        XCTAssertNil(Policy.nextWake(snap(now: now), now: now), "never loaded: attach owns the first ask")
        XCTAssertNil(Policy.nextWake(snap(inFlightSince: 1, successAgo: 15, now: now), now: now),
                     "no timer while a load is out; its end re-arms")
        XCTAssertTrue(Policy.resetsBackoff(.foreground))
        XCTAssertTrue(Policy.resetsBackoff(.manual))
        XCTAssertFalse(Policy.resetsBackoff(.retry))
    }

    /// A suspect answer (an old replica's one-model in-process catalog) is
    /// rechecked on the ladder's early rungs, then left to the TTL.
    func testASuspectAnswerIsRecheckedOnTheEarlyRungsThenLeftToTheTTL() {
        let now = Date(timeIntervalSince1970: 5_000)
        XCTAssertEqual(Policy.recheckDelays, [1, 2, 4, 8, 15])
        let wakes = (1...6).map { Policy.nextWake(snap(successAgo: 0, suspect: $0, now: now), now: now) }
        XCTAssertEqual(wakes, [
            Policy.Wake(trigger: .recheck, delay: 1), Policy.Wake(trigger: .recheck, delay: 2),
            Policy.Wake(trigger: .recheck, delay: 4), Policy.Wake(trigger: .recheck, delay: 8),
            Policy.Wake(trigger: .recheck, delay: 15), Policy.Wake(trigger: .ttl, delay: Policy.ttl),
        ], "five rechecks within 30s of a suspect answer, then the TTL: bounded, never a loop")
        XCTAssertNil(Policy.nextWake(snap(active: false, successAgo: 0, suspect: 1, now: now), now: now),
                     "no recheck off screen or in the background")
    }

    // MARK: - Scenario 1: healthy open

    func testHealthyOpenShowsThePrimarysModelAndTheWholeCatalog() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)

        XCTAssertEqual(pills(model), "Fable 5.1 · High")
        XCTAssertEqual(model.models.count, 10, "the menu must list the Mac's whole catalog")
        XCTAssertEqual(model.writeTarget, .session(id: "sess-lane-1"))
        XCTAssertFalse(model.unreachable)
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl),
                       "a settled answer is re-validated on the TTL, never final")
        XCTAssertEqual(transport.engineCalls, 1)
        XCTAssertEqual(transport.optionsCalls, 1)
    }

    // MARK: - Scenario 2 + 7: unreachable, auto-retry, converge

    /// The reported shape end to end: a healthy pill, a re-validation that lands
    /// in a bridge gap, then the ladder, then the Mac comes back. No Retry tap.
    func testAnUnreachableLookupRetriesOnTheLadderAndConvergesWithoutATap() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        XCTAssertEqual(pills(model), "Fable 5.1 · High")

        // The bridge drops. The TTL re-validation hits the gap.
        transport.engine = { _ in .failure(Self.unreachable503) }
        await fireWake(model)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.currentModelID, Self.fable, "the last known name stays on the pill")
        XCTAssertEqual(pills(model), "Fable 5.1", "no effort pill without a catalog, but the name stays")
        XCTAssertEqual(menuRows(model), ["Retry"], "no list we can't honor: the menu is the Retry")

        // The ladder: every rung is one request, spaced, then capped.
        var rungs: [TimeInterval] = []
        for _ in 0..<8 {
            guard let wake = model.scheduledWake else { return XCTFail("the retry state armed no retry") }
            XCTAssertEqual(wake.trigger, .retry)
            rungs.append(wake.delay)
            await fireWake(model)
        }
        XCTAssertEqual(rungs, [1, 2, 4, 8, 15, 30, 30, 30])
        XCTAssertEqual(transport.engineCalls, 1 + 1 + 8, "exactly one request per rung, no hot loop")

        // The Mac is back. The next rung heals it, with no user action.
        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertFalse(model.unreachable)
        XCTAssertEqual(model.models.count, 10)
        XCTAssertEqual(pills(model), "Fable 5.1 · High")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl))

        // The ladder reset on success: the next failure starts at 1s again.
        transport.engine = { _ in .failure(Self.unreachable503) }
        await fireWake(model)
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .retry, delay: 1),
                       "backoff must reset after a success")
    }

    /// Unusable (a 4xx, a bad payload) is also "unknown": same ladder.
    func testAnUnusableAnswerAlsoRetries() async {
        transport.engine = { _ in .failure(APIError.badResponse) }
        let model = makeModel()
        await open(model)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.statusNote, ComposerControlsModel.unusableNote)
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .retry, delay: 1))
    }

    /// Backgrounded: no retry timer. Foreground: one immediate ask, and the ladder
    /// restarts at its first rung (a person is looking now).
    func testBackgroundStopsRetriesAndForegroundResumesThem() async {
        transport.engine = { _ in .failure(Self.unreachable503) }
        let model = makeModel()
        await open(model)
        await fireWake(model)
        await fireWake(model)
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .retry, delay: 4))
        let callsBefore = transport.engineCalls

        model.setSceneActive(false)
        XCTAssertNil(model.scheduledWake, "a backgrounded composer must not keep a retry armed")
        model.fireScheduledWakeForTesting()
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, callsBefore, "nothing may ask from the background")

        clock.advance(3600)   // an hour in the pocket
        model.setSceneActive(true)
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, callsBefore + 1, "coming back asks once, at once")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .retry, delay: 1),
                       "the foreground restarts the ladder at 1s")

        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertFalse(model.unreachable)
        XCTAssertEqual(model.models.count, 10)
    }

    /// Off screen (a retained tab) is the same as the background: no timers.
    func testAnOffScreenComposerArmsNothingAndReasksAStaleAnswerOnReturn() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        model.setVisible(false)
        XCTAssertNil(model.scheduledWake)

        clock.advance(3)
        model.setVisible(true)
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 1, "a 3s-old answer is still the answer")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl - 3))

        model.setVisible(false)
        clock.advance(120)
        model.setVisible(true)
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 2, "a two-minute-old answer is re-asked on return")
    }

    // MARK: - Scenario 3: a successful but stale answer

    /// The exact reported state: an old replica's one-row answer. Becoming active
    /// re-asks, and while the re-ask is out the pill and its one row STAY (no
    /// blanking); the full catalog replaces them in place when it lands.
    func testADegradedOneRowAnswerIsReplacedInPlaceOnForeground() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        XCTAssertEqual(pills(model), "Opus 5")
        XCTAssertEqual(model.models.count, 1, "the reported one-row menu")

        transport.engine = { _ in .success(Self.laneEngine) }
        let held = transport.holdNext(.engine)
        model.setSceneActive(false)
        clock.advance(30)   // a while in the pocket
        model.setSceneActive(true)
        await held.reached()
        XCTAssertEqual(pills(model), "Opus 5", "a re-validation in flight must not blank the pill")
        XCTAssertEqual(model.models.count, 1, "…or empty the menu")
        XCTAssertFalse(model.unreachable)

        held.release()
        await model.settleForTesting()
        XCTAssertEqual(pills(model), "Fable 5.1 · High")
        XCTAssertEqual(model.models.count, 10)
        XCTAssertEqual(model.writeTarget, .session(id: "sess-lane-1"))
    }

    func testTheTTLReasksASettledAnswer() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        transport.options = { _ in
            .success(SessionModelOptions(models: Self.fullCatalog, current: Self.opus55, currentEffort: "max"))
        }
        let wake = await fireWake(model)
        XCTAssertEqual(wake, Policy.Wake(trigger: .ttl, delay: 60))
        XCTAssertEqual(pills(model), "Opus 5.5 · Max", "the TTL alone picks up a change made on the Mac")
        XCTAssertEqual(transport.engineCalls, 2)
    }

    /// The P1 follow-up: an old replica's one-model answer heals within seconds
    /// with nobody touching the pill (it used to wait for the 60s TTL, or for a
    /// menu open that then rebuilt the rows under the finger).
    func testASuspectOneModelAnswerHealsOnTheEarlyRungsWithoutATap() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        XCTAssertEqual(model.models.count, 1)
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .recheck, delay: 1),
                       "a one-model in-process answer must be rechecked within a second")

        let first = await fireWake(model)
        XCTAssertEqual(first, Policy.Wake(trigger: .recheck, delay: 1))
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .recheck, delay: 2),
                       "still suspect: the next rung")

        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertEqual(model.models.count, 10, "healed at +3s with no tap")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl),
                       "a real answer is not suspect: back to the TTL")
        XCTAssertEqual(transport.engineCalls, 3)
    }

    /// A box that really IS an old in-process server keeps answering one model:
    /// five rechecks, then the ordinary TTL. Bounded, never a loop.
    func testAGenuinelyOneModelServerIsRecheckedFiveTimesThenLeftToTheTTL() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        var wakes: [Policy.Wake] = []
        for _ in 0..<6 {
            guard let wake = await fireWake(model) else { return }
            wakes.append(wake)
        }
        XCTAssertEqual(wakes.map(\.delay), [1, 2, 4, 8, 15, 60])
        XCTAssertEqual(wakes.map(\.trigger), [.recheck, .recheck, .recheck, .recheck, .recheck, .ttl])
        XCTAssertEqual(transport.engineCalls, 7)
    }

    /// Opening the menu is not a trigger any more (the gate: it only fired on the
    /// FIRST open, re-fired on every content change in the retry state, and its
    /// answer rebuilt the open menu).
    func testOpeningTheMenuAsksNothing() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        clock.advance(120)
        for _ in 0..<3 {
            model.setMenuPresented(true)
            await model.settleForTesting()
            model.setMenuPresented(false)
        }
        XCTAssertEqual(transport.engineCalls, 1, "a menu open asked the box")
    }

    /// A stream reconnect re-asks. One landing right as a load starts is answered
    /// by it; one landing seconds into a load is owed a second ask, because that
    /// load may have been sent into the gap the reconnect just ended.
    func testAStreamReconnectReasksAndIsOwedAcrossAnOldInFlightLoad() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        clock.advance(2)
        model.revalidate(.streamConnected)
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 2)

        // A reconnect in the same breath as a load: answered by that load.
        let first = transport.holdNext(.engine)
        clock.advance(2)
        model.revalidate(.foreground)   // a fresh load starts at t
        model.setSceneActive(false); model.setSceneActive(true)
        await first.reached()
        model.revalidate(.streamConnected)
        first.release()
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 3, "a trigger inside the coalesce window must not double the request")

        // A reconnect 3s into a slow load: owed, asked once when it settles.
        let slow = transport.holdNext(.engine)
        clock.advance(2)
        model.setSceneActive(false); model.setSceneActive(true)
        await slow.reached()
        clock.advance(3)
        model.revalidate(.streamConnected)
        model.revalidate(.streamConnected)
        slow.release()
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 5, "one owed re-ask, however many triggers landed")
    }

    // MARK: - Scenario 4: switching source mid-load

    /// Conversation A's answer arrives AFTER the user switched to B. It must never
    /// be written into B's state.
    func testAnOldSourcesLateAnswerNeverWritesIntoTheNewSource() async {
        transport.engine = { conversation in
            conversation == "conv-a"
                ? .success(ChatEngineInfo(engine: "lane", sessionId: "sess-a"))
                : .success(ChatEngineInfo(
                    engine: "in-process", model: "gpt-6-astra",
                    models: [Self.row("gpt-6-astra", "GPT-6 Astra", nil)]
                ))
        }
        let model = makeModel()
        let heldA = transport.holdNext(.engine)
        model.attach(.chat(agentID: "general", conversationID: "conv-a"))
        await heldA.reached()

        model.attach(.chat(agentID: "general", conversationID: "conv-b"))
        await model.settleForTesting()
        XCTAssertEqual(model.currentModelID, "gpt-6-astra")
        XCTAssertEqual(model.writeTarget, .chat(agentID: "general", conversationID: "conv-b"))

        heldA.release()
        for _ in 0..<20 { await Task.yield() }
        await model.settleForTesting()
        XCTAssertEqual(model.currentModelID, "gpt-6-astra", "A's late answer overwrote B's model")
        XCTAssertEqual(model.writeTarget, .chat(agentID: "general", conversationID: "conv-b"),
                       "A's late answer re-pointed B's writes at A's session")
        XCTAssertEqual(transport.optionsCalls, 0, "A's late answer went on to fetch A's catalog")
    }

    /// A retry scheduled for A must not fire for A once the source is B.
    func testAnOldSourcesScheduledRetryIsCancelledBySwitching() async {
        transport.engine = { conversation in
            conversation == "conv-a" ? .failure(Self.unreachable503) : .success(Self.laneEngine)
        }
        let model = makeModel()
        await open(model, .chat(agentID: "general", conversationID: "conv-a"))
        XCTAssertEqual(model.scheduledWake?.trigger, .retry)

        await open(model, .chat(agentID: "general", conversationID: "conv-b"))
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl),
                       "B's schedule is B's own; A's retry is gone")
        XCTAssertFalse(model.unreachable, "A's failure must not leave B in the retry state")
        let aCalls = transport.engineCallsByConversation["conv-a"] ?? 0
        await fireWake(model)
        XCTAssertEqual(transport.engineCallsByConversation["conv-a"] ?? 0, aCalls,
                       "a wake after the switch asked about the OLD conversation")
    }

    /// A new chat getting its id on the first send is the SAME conversation: the
    /// pill keeps its label while the id's answer loads (no blink), but nothing is
    /// writable until that answer lands.
    func testANewChatGettingItsIDKeepsThePillButBlocksPicksUntilResolved() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model, .chat(agentID: "general", conversationID: nil))
        XCTAssertEqual(pills(model), "Fable 5.1 · High")

        let held = transport.holdNext(.engine)
        model.attach(.chat(agentID: "general", conversationID: "conv-new"))
        await held.reached()
        XCTAssertEqual(pills(model), "Fable 5.1 · High", "the pill blinked away on a conversation id change")
        XCTAssertFalse(model.pillEnabled, "nothing is writable until the id's answer lands")
        XCTAssertTrue(model.resolving)
        XCTAssertEqual(model.writeTarget, .none, "the old conversation's session must not stay writable")
        await model.pick(model: Self.opus55)
        XCTAssertEqual(transport.writeCalls, 0, "a pick went out before the new conversation resolved")

        held.release()
        await model.settleForTesting()
        XCTAssertFalse(model.resolving)
        XCTAssertEqual(model.writeTarget, .session(id: "sess-lane-1"))
    }

    // MARK: - Scenario 5: a pick wins over a refresh in flight

    func testAPickWinsOverARefreshThatStartedBeforeIt() async {
        var serverCurrent = Self.fable
        transport.engine = { _ in .success(Self.laneEngine) }
        transport.options = { _ in
            .success(SessionModelOptions(models: Self.fullCatalog, current: serverCurrent, currentEffort: "high"))
        }
        transport.setModel = { _, model in
            serverCurrent = model
            return .success(SessionModelChange(
                model: model, cliModel: nil, appliedLive: true, applied: nil, effectiveModel: model
            ))
        }
        let model = makeModel()
        await open(model)

        // A refresh reads the catalog while the server still says Fable…
        let stale = transport.holdNext(.options)
        clock.advance(20)
        model.revalidate(.streamConnected)
        await stale.reached()

        // …and the user picks Opus 5.5 while it is out.
        await model.pick(model: Self.opus55)
        XCTAssertEqual(model.currentModelID, Self.opus55)

        // The stale read lands LAST. It must not undo the pick.
        stale.release()
        for _ in 0..<20 { await Task.yield() }
        await model.settleForTesting()
        XCTAssertEqual(model.currentModelID, Self.opus55,
                       "a refresh that started before the pick overwrote the model the user just chose")
        XCTAssertEqual(pills(model), "Opus 5.5 · High")
        XCTAssertEqual(transport.optionsCalls, 3,
                       "the superseded refresh is re-asked once after the pick (open, stale, follow-up)")
    }

    // MARK: - Scenario 6: the coding-session composer

    func testTheSessionComposerGetsTheSameRevalidationAndRetries() async {
        let model = makeModel()
        await open(model, .session(id: "s1"))
        XCTAssertEqual(model.models.count, 10)
        XCTAssertEqual(transport.optionsCalls, 1)
        XCTAssertEqual(transport.engineCalls, 0, "a session's model lives on the session, no engine lookup")

        model.setSceneActive(false)
        clock.advance(5)
        model.setSceneActive(true)
        await model.settleForTesting()
        XCTAssertEqual(transport.optionsCalls, 2, "foreground re-asks the session's catalog too")

        transport.options = { _ in .failure(Self.unreachable503) }
        clock.advance(2)
        model.revalidate(.streamConnected)
        await model.settleForTesting()
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(pills(model), "Fable 5.1", "last known name, warning state")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .retry, delay: 1))

        transport.options = { _ in
            .success(SessionModelOptions(models: Self.fullCatalog, current: Self.opus55, currentEffort: "max"))
        }
        await fireWake(model)
        XCTAssertFalse(model.unreachable)
        XCTAssertEqual(pills(model), "Opus 5.5 · Max")
    }

    // MARK: - The mint is retried on a blip, not locked

    func testAnUnreachableMintRetriesInsteadOfGoingReadOnlyForGood() async {
        transport.engine = { _ in .success(ChatEngineInfo(engine: "lane")) }
        transport.mint = { _ in .failure(Self.unreachable503) }
        let model = makeModel()
        await open(model)
        XCTAssertFalse(model.readOnly, "a bridge blip during the mint locked the pill for good")
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.scheduledWake?.trigger, .retry)

        transport.mint = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertFalse(model.unreachable)
        XCTAssertEqual(model.writeTarget, .session(id: "sess-lane-1"))
        XCTAssertEqual(model.models.count, 10)
    }

    func testAMintTheServerRefusesIsAnHonestReadOnlyThatIsStillRevalidated() async {
        transport.engine = { _ in .success(ChatEngineInfo(engine: "lane")) }
        transport.mint = { _ in
            .failure(APIError.server(status: 404, code: "not_found", message: "x", serverHash: nil, serverContent: nil))
        }
        let model = makeModel()
        await open(model)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.unreachable)
        XCTAssertFalse((model.readOnlyReason ?? "").contains("\u{2014}"), "no em dash in UI copy")
        XCTAssertEqual(model.scheduledWake, Policy.Wake(trigger: .ttl, delay: Policy.ttl),
                       "a read-only answer is still an answer that can go stale")
    }

    // MARK: - P1: nothing changes under an open menu

    /// The gate's repro, model half: degraded one-row menu open, the Mac comes
    /// back, and the recheck's answer lands while the menu is up. The rows (and the
    /// token a tap carries) must not move until the menu has closed.
    func testAnAnswerThatLandsWhileTheMenuIsOpenWaitsForItToClose() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        XCTAssertEqual(menuRows(model), ["Opus 5"])
        let opened = model.modelMenu

        model.setMenuPresented(true)
        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertEqual(transport.optionsCalls, 1, "the recheck ran while the menu was open")
        XCTAssertEqual(model.modelMenu, opened, "the open menu changed under the finger")
        XCTAssertEqual(model.models.count, 1)
        XCTAssertNotNil(model.stagedPlan, "the answer waits for the close")

        model.setMenuPresented(false)
        XCTAssertNil(model.stagedPlan)
        XCTAssertEqual(model.models.count, 10, "the waiting answer lands the moment the menu closes")
        XCTAssertNotEqual(model.menuToken, opened.token)
    }

    /// Retry <-> rows is a section change too: it waits the same way, both ways.
    func testTheRetryStateSwapWaitsForTheMenuToClose() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        await open(model)
        let rows = model.modelMenu

        model.setMenuPresented(true)
        transport.engine = { _ in .failure(Self.unreachable503) }
        await fireWake(model)
        XCTAssertEqual(model.modelMenu, rows, "the list turned into Retry under the finger")
        XCTAssertFalse(model.unreachable)
        model.setMenuPresented(false)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.modelMenu.sections.first?.items.first?.choice, .retry)

        let retry = model.modelMenu
        model.setMenuPresented(true)
        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        XCTAssertEqual(model.modelMenu, retry, "Retry turned into the list under the finger")
        model.setMenuPresented(false)
        XCTAssertEqual(model.models.count, 10)
    }

    /// The gate's repro, tap half: a tap that reaches the model AFTER the waiting
    /// answer was applied carries the old menu's token, and writes nothing.
    func testATapOnAMenuThatWasReplacedAsItClosedWritesNothing() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        let opened = model.modelMenu

        model.setMenuPresented(true)
        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        model.setMenuPresented(false)

        // The row the finger was on in the OLD menu, and a row of the new one.
        model.menuSelect(.model(Self.opus5), token: opened.token)
        model.menuSelect(.model("gpt-6-luna"), token: opened.token)
        await model.settleForTesting()
        XCTAssertEqual(transport.writeCalls, 0, "a tap on rows the user no longer sees wrote a model")
        XCTAssertEqual(model.currentModelID, Self.fable)
    }

    /// A tap delivered BEFORE the close wins over the waiting answer (a pick beats
    /// anything learned before it), and the pick is followed by a fresh ask.
    func testATapBeforeTheCloseWinsOverTheWaitingAnswer() async {
        var serverCurrent = Self.fable
        transport.engine = { _ in .success(Self.laneEngine) }
        transport.options = { _ in
            .success(SessionModelOptions(models: Self.fullCatalog, current: serverCurrent, currentEffort: "high"))
        }
        transport.setModel = { _, model in
            serverCurrent = model
            return .success(SessionModelChange(model: model, cliModel: nil, appliedLive: true, applied: nil, effectiveModel: model))
        }
        let model = makeModel()
        await open(model)

        model.setMenuPresented(true)
        serverCurrent = "global.anthropic.claude-sonnet-5"
        await fireWake(model)
        XCTAssertNotNil(model.stagedPlan)

        model.menuSelect(.model(Self.opus55), token: model.menuToken)
        XCTAssertNil(model.stagedPlan, "an answer from before the pick must not land after it")
        model.setMenuPresented(false)
        await model.settleForTesting()
        XCTAssertEqual(transport.writeCalls, 1)
        XCTAssertEqual(model.currentModelID, Self.opus55, "the waiting answer undid the pick")
        XCTAssertEqual(pills(model), "Opus 5.5 · High")
    }

    /// A composer that goes off screen with a menu marked open must not hold
    /// its answers forever.
    func testGoingOffScreenReleasesAWaitingAnswer() async {
        transport.engine = { _ in .success(Self.degradedEngine) }
        let model = makeModel()
        await open(model)
        model.setMenuPresented(true)
        transport.engine = { _ in .success(Self.laneEngine) }
        await fireWake(model)
        model.setVisible(false)
        XCTAssertFalse(model.menuPresented)
        XCTAssertEqual(model.models.count, 10)
    }

    // MARK: - Fresh launch while the Mac is unreachable

    /// The gate: a fresh launch with the Mac away showed NO pill and no Retry.
    /// The pill shows, says "unknown" with the warning glyph, and offers Retry.
    func testAFreshLaunchWhileUnreachableShowsThePillWithRetry() async {
        transport.engine = { _ in .failure(Self.unreachable503) }
        let model = makeModel()
        await open(model)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.pillLabel, ComposerControlsModel.placeholderLabel)
        XCTAssertNil(model.effortPillLabel)
        XCTAssertTrue(model.pillEnabled, "Retry must be reachable")
        XCTAssertTrue(ComposerBar.showsModelPill(modelSource: chat, pillLabel: model.pillLabel))
        XCTAssertEqual(model.modelMenu.sections.first?.items.map(\.choice), [.retry])
        XCTAssertEqual(model.modelMenu.sections.first?.title, ComposerControlsModel.unreachableNote)

        transport.engine = { _ in .success(Self.laneEngine) }
        model.menuSelect(.retry, token: model.menuToken)
        await model.settleForTesting()
        XCTAssertEqual(pills(model), "Fable 5.1 · High")
    }

    /// A healthy fresh launch still shows no placeholder while it loads.
    func testAHealthyFreshLaunchShowsNoPlaceholderWhileLoading() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let model = makeModel()
        let held = transport.holdNext(.engine)
        model.attach(chat)
        await held.reached()
        XCTAssertNil(model.pillLabel, "a placeholder flashed on a healthy launch")
        held.release()
        await model.settleForTesting()
        XCTAssertEqual(pills(model), "Fable 5.1 · High")
    }

    // MARK: - Gate r2 D3: the last known model keeps its name

    /// The Mac goes away after the pill knew the model. The pill keeps the NAME
    /// the last good answer gave it (a row's label, an alias row's resolved
    /// model), never the raw id: it read "gpt-6-astra, last known" (gate r2 D3).
    func testALastKnownModelKeepsItsDisplayNameWhileTheMacIsAway() async {
        let alias = SessionModelOptions.Model(
            id: "default", label: "Default", supportsEffort: true, supportedEffortLevels: ["high"],
            resolvedModel: Self.opus55
        )
        for (current, name) in [("gpt-6-astra", "GPT-6 Astra"), ("default", "Opus 5.5"), (Self.fable, "Fable 5.1")] {
            transport.engine = { _ in .success(Self.laneEngine) }
            transport.options = { _ in
                .success(SessionModelOptions(models: Self.fullCatalog + [alias], current: current, currentEffort: "high"))
            }
            let model = makeModel()
            await open(model)
            XCTAssertEqual(model.pillLabel, name)

            transport.engine = { _ in .failure(Self.unreachable503) }
            await fireWake(model)
            XCTAssertTrue(model.unreachable)
            XCTAssertEqual(model.pillLabel, name, "\(current): the unreachable pill lost its name")
            XCTAssertEqual(model.pillAccessibilityLabel, "Model: \(name), last known")
            XCTAssertEqual(menuRows(model), ["Retry"], "the kept catalog names the model; it is never offered")
            XCTAssertNil(model.effortPillLabel)
        }
    }

    /// Same for a coding session, whose catalog read is the call that fails.
    func testASessionsLastKnownModelKeepsItsNameWhenItsCatalogIsUnreachable() async {
        transport.options = { _ in
            .success(SessionModelOptions(models: Self.fullCatalog, current: "gpt-6-astra", currentEffort: "high"))
        }
        let model = makeModel()
        await open(model, .session(id: "sess-1"))
        XCTAssertEqual(model.pillLabel, "GPT-6 Astra")
        transport.options = { _ in .failure(Self.unreachable503) }
        await fireWake(model)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.pillAccessibilityLabel, "Model: GPT-6 Astra, last known")
    }

    /// Per source: back on a conversation while the Mac is away, the pill names
    /// THAT conversation's model by its own last answer.
    func testSwitchingBackWhileTheMacIsAwayNamesThatConversationsOwnModel() async {
        transport.engine = { conversation in
            .success(ChatEngineInfo(engine: "lane", sessionId: conversation == "conv-b" ? "sess-b" : "sess-a"))
        }
        transport.options = { session in
            .success(SessionModelOptions(
                models: Self.fullCatalog,
                current: session == "sess-b" ? "global.anthropic.claude-sonnet-5" : "gpt-6-astra",
                currentEffort: "high"
            ))
        }
        let model = makeModel()
        await open(model, convA)
        XCTAssertEqual(model.pillLabel, "GPT-6 Astra")
        await open(model, convB)
        XCTAssertEqual(model.pillLabel, "Sonnet 5")

        transport.engine = { _ in .failure(Self.unreachable503) }
        await open(model, convA)
        XCTAssertTrue(model.unreachable)
        XCTAssertEqual(model.pillAccessibilityLabel, "Model: GPT-6 Astra, last known")
        await open(model, convB)
        XCTAssertEqual(model.pillAccessibilityLabel, "Model: Sonnet 5, last known")
    }

    // MARK: - Gate r2 D4: one on-screen rule

    private typealias Surface = ComposerSurfaceID

    /// Mounted AND, for a declared surface, that surface in front.
    func testOnScreenMeansMountedAndItsSurfaceInFront() {
        let session = Surface.session("s1")
        XCTAssertTrue(Policy.composerOnScreen(appeared: true, surface: .chatTab, activeSurface: .chatTab))
        // The retained Chat tab while the user is on Inbox (no disappear came).
        XCTAssertFalse(Policy.composerOnScreen(appeared: true, surface: .chatTab, activeSurface: .tab("inbox")),
                       "a composer on a tab the user is not on counted as on screen")
        // A session page pushed over the chat tab.
        XCTAssertFalse(Policy.composerOnScreen(appeared: true, surface: .chatTab, activeSurface: session))
        XCTAssertTrue(Policy.composerOnScreen(appeared: true, surface: session, activeSurface: session))
        // A view that is really gone stops, even with its surface in front.
        XCTAssertFalse(Policy.composerOnScreen(appeared: false, surface: .chatTab, activeSurface: .chatTab))
        // No declared surface, or nothing published yet: mounted is enough.
        XCTAssertTrue(Policy.composerOnScreen(appeared: true, surface: .unattached, activeSurface: .tab("inbox")))
        XCTAssertTrue(Policy.composerOnScreen(appeared: true, surface: .chatTab, activeSurface: nil))
        XCTAssertTrue(Policy.composerOnScreen(appeared: true, surface: .chatTab, activeSurface: .unattached))
        XCTAssertFalse(Policy.composerOnScreen(appeared: false, surface: .unattached, activeSurface: nil))
    }

    /// Let the dock's change notification reach the model (it hops to the main actor).
    private func settleSurface(_ model: ComposerControlsModel) async {
        for _ in 0..<10 { await Task.yield() }
        await model.settleForTesting()
    }

    /// The real sequence the gate hit: the user switches to Inbox and the Chat
    /// composer's view hears nothing. The MODEL follows the dock: no timer, no
    /// re-ask on a stream reconnect or a re-run appear. Back on Chat: one re-ask.
    func testAComposerOnAnotherTabNeverAsksAndNeverArmsTheTTL() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        let model = makeModel()
        model.follow(surface: .chatTab, dock: dock)
        await open(model)
        let asked = transport.engineCalls
        XCTAssertTrue(model.isOnScreen)
        XCTAssertNotNil(model.scheduledWake)

        dock.setComposerSurfaceBase(.tab("inbox"))
        await settleSurface(model)
        XCTAssertFalse(model.isOnScreen)
        XCTAssertNil(model.scheduledWake, "a composer on a hidden tab kept its TTL armed")

        clock.advance(55)
        model.revalidate(.streamConnected)
        model.setVisible(true)
        model.revalidate(.ttl)
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, asked, "the hidden composer asked the Mac")
        XCTAssertNil(model.scheduledWake, "the hidden composer armed a timer")

        dock.setComposerSurfaceBase(.chatTab)
        await settleSurface(model)
        XCTAssertTrue(model.isOnScreen)
        XCTAssertEqual(transport.engineCalls, asked + 1, "back on Chat, a 55s old answer is re-asked once")
        XCTAssertEqual(model.scheduledWake?.trigger, .ttl)
    }

    /// A page pushed over the tab takes the surface; popping it gives it back.
    func testAPagePushedOverTheComposerHidesIt() async {
        transport.engine = { _ in .success(Self.laneEngine) }
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        let model = makeModel()
        model.follow(surface: .chatTab, dock: dock)
        await open(model)
        let claim = dock.claimComposerSurface(.session("pushed"))
        await settleSurface(model)
        XCTAssertFalse(model.isOnScreen)
        XCTAssertNil(model.scheduledWake)
        _ = dock.releaseComposerSurface(claim)
        await settleSurface(model)
        XCTAssertTrue(model.isOnScreen)
        XCTAssertNotNil(model.scheduledWake)
    }

    // MARK: - P2: each conversation has its own model

    private func twoConversationTransport(bCurrent: String = "global.anthropic.claude-sonnet-5") {
        transport.engine = { conversation in
            .success(ChatEngineInfo(engine: "lane", sessionId: conversation == "conv-b" ? "sess-b" : "sess-a"))
        }
        transport.options = { session in
            .success(SessionModelOptions(
                models: Self.fullCatalog, current: session == "sess-b" ? bCurrent : Self.fable,
                currentEffort: "high"
            ))
        }
    }

    private let convA = ComposerControlsModel.Source.chat(agentID: "general", conversationID: "conv-a")
    private let convB = ComposerControlsModel.Source.chat(agentID: "general", conversationID: "conv-b")

    /// Adopted from the gate (it failed there): B's first answer fails, and the
    /// pill must not present A's model as B's last known one.
    func testAFailedFirstAnswerForBDoesNotShowAsModelAsBsLastKnown() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)
        XCTAssertEqual(pills(model), "Fable 5.1 · High")

        transport.engine = { conversation in
            conversation == "conv-b"
                ? .failure(Self.unreachable503)
                : .success(ChatEngineInfo(engine: "lane", sessionId: "sess-a"))
        }
        await open(model, convB)
        XCTAssertTrue(model.unreachable)
        XCTAssertNotEqual(model.currentModelID, Self.fable,
                          "conversation B's pill shows conversation A's model (\(model.pillLabel ?? "nil")) as its last known")
        XCTAssertEqual(model.pillLabel, ComposerControlsModel.placeholderLabel)
    }

    /// While B's first answer is out, the pill shows a neutral placeholder (it
    /// keeps its seat) and is disabled; it never shows A's model.
    func testSwitchingToANewConversationShowsAPlaceholderNotThePreviousModel() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)

        let held = transport.holdNext(.engine)
        model.attach(convB)
        await held.reached()
        XCTAssertEqual(model.pillLabel, ComposerControlsModel.placeholderLabel,
                       "B's pill showed \(model.pillLabel ?? "nothing") before B answered")
        XCTAssertNil(model.effortPillLabel)
        XCTAssertFalse(model.pillEnabled)
        XCTAssertNil(model.currentModelID)
        held.release()
        await model.settleForTesting()
        XCTAssertEqual(pills(model), "Sonnet 5 · High")
    }

    /// Switching back shows each conversation's OWN last known model at once,
    /// even while its fresh answer is still out.
    func testSwitchingBackShowsEachConversationsOwnLastKnownModel() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)
        await open(model, convB)
        XCTAssertEqual(pills(model), "Sonnet 5 · High")

        let heldA = transport.holdNext(.engine)
        model.attach(convA)
        await heldA.reached()
        XCTAssertEqual(pills(model), "Fable 5.1 · High", "A's own last known model, not B's and not a blank")
        XCTAssertFalse(model.pillEnabled, "shown, but not writable until A answers")
        heldA.release()
        await model.settleForTesting()

        let heldB = transport.holdNext(.engine)
        model.attach(convB)
        await heldB.reached()
        XCTAssertEqual(pills(model), "Sonnet 5 · High")
        heldB.release()
        await model.settleForTesting()
    }

    /// A NEW chat is a different conversation every time: it inherits nothing.
    func testANewChatNeverInheritsTheConversationItLeft() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)
        let held = transport.holdNext(.engine)
        model.attach(.chat(agentID: "general", conversationID: nil))
        await held.reached()
        XCTAssertEqual(model.pillLabel, ComposerControlsModel.placeholderLabel)
        held.release()
        await model.settleForTesting()
    }

    /// A picked model is remembered as that conversation's last known one.
    func testAPickIsRememberedForTheSwitchBack() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)
        await model.pick(model: Self.opus55)
        await open(model, convB)
        let held = transport.holdNext(.engine)
        model.attach(convA)
        await held.reached()
        XCTAssertEqual(model.pillLabel, "Opus 5.5", "A's pick, not A's pre-pick model")
        held.release()
        await model.settleForTesting()
    }

    // MARK: - P2: the generation guard

    /// Adopted from the gate: a pick on A whose write lands AFTER the switch to B
    /// (and after B's own answer) must not paint A's pick onto B's pill.
    func testAPickOnAWhoseWriteLandsAfterSwitchingToBDoesNotRelabelB() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)
        XCTAssertEqual(model.currentModelID, Self.fable)

        let write = transport.holdNext(.write)
        let pick = Task { await model.pick(model: Self.opus55) }
        await write.reached()

        await open(model, convB)
        XCTAssertEqual(model.currentModelID, "global.anthropic.claude-sonnet-5", "B's own answer")
        XCTAssertFalse(model.applying, "A's write in flight held B's pill")

        write.release()
        await pick.value
        await model.settleForTesting()
        XCTAssertEqual(model.currentModelID, "global.anthropic.claude-sonnet-5",
                       "A's late write result relabelled B's pill")
        XCTAssertEqual(model.writeTarget, .session(id: "sess-b"))
    }

    /// The same race with a FAILING write: A's rollback must not land on B.
    func testAFailedPickOnAWhoseErrorLandsAfterTheSwitchLeavesBAlone() async {
        twoConversationTransport()
        transport.setModel = { _, _ in
            .failure(APIError.server(status: 400, code: "unknown_model", message: "x", serverHash: nil, serverContent: nil))
        }
        let model = makeModel()
        await open(model, convA)

        let write = transport.holdNext(.write)
        let pick = Task { await model.pick(model: Self.opus55) }
        await write.reached()
        await open(model, convB)

        write.release()
        await pick.value
        await model.settleForTesting()
        XCTAssertEqual(model.currentModelID, "global.anthropic.claude-sonnet-5",
                       "A's rollback wrote A's previous model onto B")
        XCTAssertNil(model.statusNote, "A's failure note landed on B's menu")
    }

    /// And for effort: A's late effort read-back must not become B's effort.
    func testAnEffortPickOnAWhoseWriteLandsAfterTheSwitchLeavesBAlone() async {
        twoConversationTransport()
        let model = makeModel()
        await open(model, convA)

        let write = transport.holdNext(.write)
        let pick = Task { await model.pick(effort: "max") }
        await write.reached()
        await open(model, convB)
        XCTAssertEqual(model.currentEffort, "high")

        write.release()
        await pick.value
        await model.settleForTesting()
        XCTAssertEqual(model.currentEffort, "high", "A's effort read-back landed on B")
        XCTAssertEqual(pills(model), "Sonnet 5 · High")
    }

    // MARK: - P2: automatic attempts stay at least 1s apart

    /// Whatever mix of automatic triggers lands (reconnects, re-appearances,
    /// foreground edges, all every 100ms), no two requests start less than 1s
    /// apart while the box is failing. Only the Retry button may go faster.
    func testAutomaticAttemptsAreNeverLessThanOneSecondApart() async {
        transport.engine = { _ in .failure(Self.unreachable503) }
        let model = makeModel()
        await open(model)
        for tick in 0..<200 {
            clock.advance(0.1)
            switch tick % 3 {
            case 0: model.revalidate(.streamConnected)
            case 1: model.setVisible(false); model.setVisible(true)
            default: model.setSceneActive(false); model.setSceneActive(true)
            }
            await model.settleForTesting()
        }
        let starts = transport.engineCallTimes
        XCTAssertGreaterThan(starts.count, 5, "the retry state kept asking")
        let gaps = zip(starts.dropFirst(), starts).map { $0.timeIntervalSince($1) }
        XCTAssertGreaterThanOrEqual(gaps.min() ?? 1, 1 - 1e-9,
                                    "two automatic requests \(gaps.min() ?? 0)s apart (a hot loop)")
        XCTAssertLessThanOrEqual(starts.count, 21, "20s of triggers must stay near one request a second")
    }

    // MARK: - Write failure copy

    /// The gate: a 404 on a SESSION write said "too old to switch the chat model".
    /// The session routes are as old as API v1, so their 404 is the session's.
    func testASessionWrite404SaysTheSessionIsGoneNotTheChatModel() {
        let notFound = APIError.server(
            status: 404, code: "not_found", message: "session not found", serverHash: nil, serverContent: nil
        )
        XCTAssertEqual(ComposerControlsModel.writeOutcome(for: notFound, target: .session(id: "s")), .sessionNotFound)
        XCTAssertEqual(
            ComposerControlsModel.writeOutcome(for: notFound, target: .chat(agentID: "general", conversationID: "c")),
            .serverTooOld, "a missing PUT /chat/model IS an old server"
        )
        let all: [ComposerControlsModel.WriteFailure] = [
            .serverTooOld, .sessionNotFound, .rejected, .laneEngine, .unreachable, .unknown,
        ]
        for failure in all {
            XCTAssertFalse(failure.note.contains("chat model"), failure.note)
            XCTAssertFalse(failure.note.contains("\u{2014}") || failure.note.contains("\u{2013}"),
                           "a dash in UI copy: \(failure.note)")
        }
    }

    // MARK: - The production timer shell

    /// Everything above fires wakes by hand. This proves the real timer path fires
    /// them by itself, on the ladder's delays, and stops when told to.
    func testTheRealTimerFiresTheLadderByItself() async throws {
        let recorder = SleepRecorder(firesBeforeBlocking: 3)
        transport.engine = { _ in .failure(Self.unreachable503) }
        let clock = self.clock!
        let model = ComposerControlsModel(
            transport: transport, now: { clock.now },
            sleep: { delay in try await recorder.sleep(delay) }
        )
        model.setVisible(true)
        model.attach(chat)

        // Real (if instant) timers, so this is the one test that polls.
        let deadline = Date().addingTimeInterval(5)
        while await recorder.requested.count < 4, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        await model.settleForTesting()
        XCTAssertEqual(transport.engineCalls, 4, "the first lookup plus three timer-fired retries")
        let asked = await recorder.requested
        XCTAssertEqual(Array(asked.prefix(4)), [1, 2, 4, 8], "the timer slept the ladder's delays")

        model.setSceneActive(false)
        XCTAssertNil(model.scheduledWake)
    }
}

// MARK: - Test doubles

/// Time that moves only when a test moves it.
@MainActor
private final class ComposerTestClock {
    var now = Date(timeIntervalSince1970: 1_000_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

/// Records every requested sleep; returns at once for the first N, then blocks
/// until cancelled (so a failing lookup cannot spin the test in a loop).
private actor SleepRecorder {
    private(set) var requested: [TimeInterval] = []
    private let firesBeforeBlocking: Int

    init(firesBeforeBlocking: Int) { self.firesBeforeBlocking = firesBeforeBlocking }

    func sleep(_ delay: TimeInterval) async throws {
        requested.append(delay)
        if requested.count > firesBeforeBlocking {
            try await Task.sleep(for: .seconds(100_000))
        }
    }
}

/// One held call: the test learns when the call was REACHED, and decides when
/// it returns. The answer is computed when the call starts, so a held read
/// carries the world as it was then (which is what a real in-flight read does).
@MainActor
private final class HeldCall {
    private var reachedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var isReached = false
    private(set) var isReleased = false

    func reached() async {
        if isReached { return }
        await withCheckedContinuation { reachedWaiters.append($0) }
    }

    func release() {
        isReleased = true
        let waiters = releaseWaiters
        releaseWaiters = []
        waiters.forEach { $0.resume() }
    }

    fileprivate func arrive() async {
        isReached = true
        let waiters = reachedWaiters
        reachedWaiters = []
        waiters.forEach { $0.resume() }
        if isReleased { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }
}

/// The composer's six calls, scripted. Answers are closures so a test can change
/// what "the server" says between asks.
@MainActor
private final class ScriptedComposerTransport: ComposerModelTransport {
    enum Kind { case engine, options, write }

    /// The test clock, so request start times are comparable to the policy's.
    var now: () -> Date = Date.init

    var engine: (String?) -> Result<ChatEngineInfo, Error> = { _ in .success(ChatEngineInfo(engine: "lane")) }
    var mint: (String?) -> Result<ChatEngineInfo, Error> = { _ in .failure(APIError.badResponse) }
    var options: (String) -> Result<SessionModelOptions, Error> = { _ in .failure(APIError.badResponse) }
    var setModel: (String, String) -> Result<SessionModelChange, Error> = { _, model in
        .success(SessionModelChange(model: model, cliModel: nil, appliedLive: true, applied: nil, effectiveModel: model))
    }

    private(set) var engineCalls = 0
    private(set) var engineCallTimes: [Date] = []
    private(set) var engineCallsByConversation: [String: Int] = [:]
    private(set) var optionsCalls = 0
    private(set) var writeCalls = 0
    private var holds: [Kind: HeldCall] = [:]
    private var allHolds: [HeldCall] = []

    /// Hold the NEXT call of this kind until the test releases it.
    func holdNext(_ kind: Kind) -> HeldCall {
        let held = HeldCall()
        holds[kind] = held
        allHolds.append(held)
        return held
    }

    func releaseAll() { allHolds.forEach { $0.release() } }

    private func passThroughHold(_ kind: Kind) async {
        guard let held = holds.removeValue(forKey: kind) else { return }
        await held.arrive()
    }

    func chatEngine(agentID: String, conversationID: String?) async throws -> ChatEngineInfo {
        engineCalls += 1
        engineCallTimes.append(now())
        engineCallsByConversation[conversationID ?? "", default: 0] += 1
        let answer = engine(conversationID)
        await passThroughHold(.engine)
        return try answer.get()
    }

    func chatEngineSession(agentID: String, conversationID: String?) async throws -> ChatEngineInfo {
        try mint(conversationID).get()
    }

    func sessionModelOptions(id: String) async throws -> SessionModelOptions {
        optionsCalls += 1
        let answer = options(id)
        await passThroughHold(.options)
        return try answer.get()
    }

    func setSessionModel(id: String, model: String) async throws -> SessionModelChange {
        writeCalls += 1
        let answer = setModel(id, model)
        await passThroughHold(.write)
        return try answer.get()
    }

    func setSessionEffort(id: String, effort: String) async throws -> SessionEffortChange {
        writeCalls += 1
        await passThroughHold(.write)
        return SessionEffortChange(effort: effort, appliedLive: true, effectiveEffort: effort, overridden: nil)
    }

    func setChatModel(
        agentID: String, conversationID: String?, model: String?, effort: String?
    ) async throws -> ChatModelChange {
        writeCalls += 1
        return ChatModelChange(model: model, effort: effort)
    }
}
