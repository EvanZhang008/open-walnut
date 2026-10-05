import XCTest

/// THE MODEL PILL HEALS ITSELF, driven as a finger drives it.
///
/// The field report (TestFlight build 82, phone on a cloud replica): the chat
/// composer's model menu showed ONE row, "Opus 5", for 5.5 hours while the Mac
/// offered ten models. The Mac's bridge to the replica had blipped for about 1.3s,
/// the phone's only `GET /api/v1/chat/engine` landed in the gap, and the phone never
/// asked again: the only refresh path was a Retry button that only the unreachable
/// state showed.
///
/// Every assertion here is a SCREEN fact (what the pill and its menu say) or a WIRE
/// fact (what the stub was asked, and when). Nothing reaches into the app, and no
/// test ever taps Retry: healing without a tap is the whole claim.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs`, told what to answer through
/// `POST /__stub/engine?mode=…`: `unreachable` is the 503 `primary_unreachable` a
/// current replica answers while the Mac is away, `degraded` is the one-model
/// answer an OLD replica gave (the reported state), and `lane` is the Mac itself,
/// whose session serves the full ten-row catalog.
///
/// RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh` and the stub running (see
/// `MidTurnQueueUITests` for why a bare `xcodebuild` skips every case here).
final class ModelPillHealUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The pills once they show the Mac's current model (Fable 5.1, High).
    private static let healedLabel = "Model: Fable 5.1"
    private static let healedEffort = "Effort: High"
    private static let healedID = "global.anthropic.claude-fable-5-1[1m]"
    /// The model pill's picker (`ComposerModelPill.sheetTitle`).
    private static let sheetTitle = "Select model"
    /// Rows only the Mac's catalog has; the degraded answer has none of them.
    /// Spelled as the Mac's picker spells them (`catalogRowLabel`), which is the
    /// point: "Haiku 4.5", not the catalog's bare "Haiku".
    private static let catalogOnlyRows = ["Default (Opus 5.5 1M)", "Opus 5.5 1M", "Haiku 4.5", "GPT-6 Astra"]

    /// The Mac's rows, top to bottom: `sortByModelStrength` over the real catalog,
    /// as the web computes it (`ModelStrengthOrderTests` pins the same list).
    private static let macOrder = [
        "Haiku 4.5", "GPT-6 Luna", "Sonnet 5", "GPT-6 Astra", "Fable 5 1M", "Fable 5.1 1M",
        "GPT-5.6 Sol", "GPT-6 Sol", "Default (Opus 5.5 1M)", "Opus 5.5 1M",
    ]

    // MARK: - Scenario 1: unreachable, spaced retries, heals with no tap

    @MainActor
    func testAnUnreachableLookupRetriesOnItsOwnSpacedOutAndHealsWithoutATap() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("unreachable")
        let app = try launchPaired()
        openChatTab(app)
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 45), "the chat composer never appeared")

        // A fresh launch with the Mac away used to show NO pill and no Retry. The
        // pill shows, says the model is unknown, and its sheet offers the retry.
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: unknown", timeout: 20),
                      "no unreachable pill on a fresh launch (reads \(pill.exists ? pill.label : "absent"))")
        try await openMenu(app, pill)
        XCTAssertTrue(element(app, "composer.modelPill.retry").waitForExistence(timeout: 5),
                      "the unreachable pill's sheet offers no Retry")
        try await stub.screenshot(app, "model-pill-00-fresh-launch-unreachable-sheet")
        closeMenu(app)

        // The Mac is away. Let the phone retry on its own for a while.
        try await Task.sleep(for: .seconds(10))
        let whileDown = try await stub.engineGets()
        XCTAssertGreaterThanOrEqual(
            whileDown.count, 3,
            "the phone asked \(whileDown.count) time(s) in 10s of the Mac being away: it is not "
                + "retrying on its own, which is the reported bug"
        )
        XCTAssertLessThanOrEqual(
            whileDown.count, 8,
            "the phone asked \(whileDown.count) times: that is a hot loop, not a backoff"
        )
        let gaps = zip(whileDown.dropFirst(), whileDown).map { $0.at.timeIntervalSince($1.at) }
        XCTAssertTrue(
            gaps.allSatisfy { $0 >= 0.8 },
            "two engine lookups were closer than the first rung (1s): gaps \(Self.fmt(gaps))"
        )
        XCTAssertTrue(
            zip(gaps.dropFirst(), gaps).allSatisfy { $0 >= $1 * 0.8 },
            "the retry gaps are not backing off: \(Self.fmt(gaps))"
        )
        try await stub.screenshot(app, "model-pill-01-mac-unreachable")

        // The Mac comes back. Nobody touches anything.
        let flippedAt = Date()
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 45),
            "the pill did not heal within 45s of the Mac coming back (it reads "
                + "\(pill.exists ? pill.label : "absent")) and no Retry was tapped"
        )
        let healedAfter = Date().timeIntervalSince(flippedAt)
        XCTAssertLessThanOrEqual(healedAfter, 35, "healing took \(Int(healedAfter))s, past the ladder's 30s cap")
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-02-healed-menu")
        try await assertEffortPillOffersTheLevels(app, shot: "model-pill-02-healed-effort")

        let options = try await stub.requests().filter { $0.path.hasSuffix("/model-options") }
        XCTAssertFalse(options.isEmpty, "the healed pill never read the lane session's catalog")
    }

    // MARK: - Scenario 2: an old replica's one-model answer heals by itself

    @MainActor
    func testAOneModelAnswerFromAnOldReplicaHealsWithinSecondsWithoutATap() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)

        // The reported state: one model, and the sheet offers only it.
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")
        try await openMenu(app, pill)
        // Proof the sheet is OPEN, without which "the rows are absent" is vacuous.
        XCTAssertTrue(app.buttons["Opus 5"].waitForExistence(timeout: 5), "the model sheet did not open")
        for row in Self.catalogOnlyRows {
            XCTAssertFalse(app.buttons[row].exists, "the degraded sheet already lists \(row)")
        }
        try await stub.screenshot(app, "model-pill-03-degraded-one-row")
        closeMenu(app)

        // The Mac answers again. Nobody touches anything: the suspect answer is
        // rechecked on the ladder's early rungs, not left to the 60s TTL.
        let flippedAt = Date()
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 30),
            "the one-model answer did not heal on its own (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        let healedAfter = Date().timeIntervalSince(flippedAt)
        XCTAssertLessThan(healedAfter, 20, "the heal took \(Int(healedAfter))s: that is the TTL, not a recheck")
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-04-recheck-healed-menu")
    }

    // MARK: - Scenario 3: a settled answer is re-validated on foreground

    @MainActor
    func testASettledAnswerIsReaskedWhenTheAppComesBackToTheFront() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        // Let the rechecks run out (1 + 2 + 4 + 8 + 15s), so no timer is due for a
        // minute and only the foreground can explain a heal.
        XCTAssertTrue(
            waitUntil(timeout: 60) { ((try? self.syncEngineGets(stub).count) ?? 0) >= 6 },
            "the suspect answer was not rechecked five times"
        )
        try await Task.sleep(for: .seconds(2))
        try await stub.setEngine("lane")
        let beforeHome = try await stub.engineGets().count
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        let asksInBackground = try await stub.engineGets().count - beforeHome
        XCTAssertEqual(asksInBackground, 0, "the pill asked \(asksInBackground) time(s) from the background")
        let activatedAt = Date()
        app.activate()

        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 20),
            "coming back to the app did not re-ask (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        let healedAfter = Date().timeIntervalSince(activatedAt)
        XCTAssertLessThan(healedAfter, 15, "the heal took \(Int(healedAfter))s: that is the TTL, not the foreground")
    }

    // MARK: - Scenario 4 (the gate's P1): nothing changes under an open sheet

    /// The gate's repro: the degraded one-row picker is OPEN, the Mac comes back,
    /// and the answer lands. The old menu rebuilt under the finger, and a tap
    /// where "Opus 5" had been picked GPT-6 Luna (a real `POST …/model`). Now the
    /// rows hold until the sheet closes, the same tap picks the unchanged row
    /// (which writes nothing and closes the sheet), and the new rows arrive after
    /// the close.
    @MainActor
    func testAnAnswerLandingWhileTheMenuIsOpenNeverMovesTheRowsUnderTheFinger() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        try await openMenu(app, pill)
        let oldRow = app.buttons["Opus 5"]
        XCTAssertTrue(oldRow.waitForExistence(timeout: 5), "the model sheet did not open")
        let oldRowCentre = CGPoint(x: oldRow.frame.midX, y: oldRow.frame.midY)
        let asksBefore = try await stub.engineGets().count
        let optionsBefore = try await stub.requests().filter { $0.path.hasSuffix("/model-options") }.count

        // The Mac comes back WHILE the sheet is open.
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitUntil(timeout: 20) {
                let records = (try? self.syncRequests(stub)) ?? []
                return records.filter { $0.path.hasSuffix("/model-options") }.count > optionsBefore
            },
            "no re-ask reached the Mac's catalog while the sheet was open, so this would prove nothing"
        )
        let asksWhileOpen = try await stub.engineGets().count - asksBefore
        XCTAssertGreaterThanOrEqual(asksWhileOpen, 1)
        // Give a rebuild every chance to happen.
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(oldRow.exists, "the row under the finger vanished while the sheet was open")
        XCTAssertEqual(CGPoint(x: oldRow.frame.midX, y: oldRow.frame.midY), oldRowCentre,
                       "the row under the finger moved while the sheet was open")
        for row in Self.catalogOnlyRows {
            XCTAssertFalse(app.buttons[row].exists, "\(row) appeared in the OPEN sheet: it was rebuilt under the finger")
        }
        try await stub.screenshot(app, "model-pill-05-menu-open-answer-waiting")

        // The finger lands where the old row was.
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: oldRowCentre.x, dy: oldRowCentre.y)).tap()
        try await Task.sleep(for: .seconds(2))
        let writes = try await stub.requests().filter { record in
            (record.method == "POST" && (record.path.hasSuffix("/model") || record.path.hasSuffix("/effort")))
                || (record.method == "PUT" && record.path.hasSuffix("/chat/model"))
        }
        XCTAssertTrue(writes.isEmpty, "a tap on the unchanged row WROTE a model: \(writes.map(\.path))")
        XCTAssertFalse(sheetIsUp(app), "a tap on a row did not close the sheet")

        // Closed: the waiting answer lands now.
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 5),
            "the answer that waited for the close never landed (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-06-after-close-menu")
    }

    /// The open and close signals fire on EVERY open, not just the first (the
    /// reason SwiftUI's `Menu` could not be kept: its content `onAppear` fires on
    /// the first open only). Three rounds: each time an answer lands while the
    /// sheet is open, the sheet keeps its row, and the pill takes the answer only
    /// once the sheet has closed.
    @MainActor
    func testEveryOpenHoldsItsRowsAndEveryCloseAppliesTheWaitingAnswer() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        // Each round flips which one model the old replica claims. Its answers
        // stay suspect, so the recheck ladder keeps asking (1, 2, 4, 8, 15s). A
        // trip to the home screen between rounds restarts that ladder (the
        // foreground re-asks and resets it), so every round has a recheck due
        // within seconds of the sheet opening.
        let rounds: [(from: String, to: String, toModel: String)] = [
            ("Opus 5", "Sonnet 5", "global.anthropic.claude-sonnet-5"),
            ("Sonnet 5", "Opus 5", "global.anthropic.claude-opus-5"),
            ("Opus 5", "Sonnet 5", "global.anthropic.claude-sonnet-5"),
        ]
        for (index, round) in rounds.enumerated() {
            if index > 0 {
                let asksBeforeHome = try await stub.engineGets().count
                XCUIDevice.shared.press(.home)
                try await Task.sleep(for: .seconds(1.5))
                app.activate()
                XCTAssertTrue(
                    waitUntil(timeout: 10) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBeforeHome },
                    "round \(index + 1): coming back to the app did not re-ask"
                )
                XCTAssertTrue(waitForLabel(pill, "Model: \(round.from)", timeout: 5))
            }
            try await openMenu(app, pill)
            XCTAssertTrue(app.buttons[round.from].waitForExistence(timeout: 5), "round \(index + 1): the sheet did not open")
            let asksBefore = try await stub.engineGets().count
            try await stub.setEngine("degraded", model: round.toModel)
            XCTAssertTrue(
                waitUntil(timeout: 25) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBefore },
                "round \(index + 1): no re-ask landed while the sheet was open"
            )
            try await Task.sleep(for: .seconds(1))
            XCTAssertTrue(app.buttons[round.from].exists, "round \(index + 1): the open sheet lost its row")
            XCTAssertFalse(app.buttons[round.to].exists, "round \(index + 1): the open sheet was rebuilt")
            try await stub.screenshot(app, "model-pill-07-round\(index + 1)-open")
            closeMenu(app)
            XCTAssertTrue(
                waitForLabel(pill, "Model: \(round.to)", timeout: 5),
                "round \(index + 1): the close did not apply the waiting answer (pill reads \(pill.label))"
            )
        }
    }

    // MARK: - Scenario 6: a pick through the sheet

    /// A tap on a row writes exactly that model and closes the sheet, and while
    /// the write is out the pill is disabled with its spinner, the name in
    /// readable ink; it takes taps again once the Mac has answered.
    ///
    /// "Disabled" is checked as the user meets it, not only as a flag: the first
    /// version of this test caught SwiftUI re-enabling the UIKit button right
    /// after the pill disabled it, so a pill drawn in the quiet ink still opened
    /// its menu. A tap on the pill mid-write must open nothing.
    @MainActor
    func testAPickWritesTheTappedModelAndThePillsWaitForTheWrite() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.call("POST", "__stub/write-delay?ms=7000")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")
        XCTAssertTrue(pill.isEnabled)
        try await stub.screenshot(app, "model-pill-09-enabled-pills")

        try await openMenu(app, pill)
        let sonnet = app.buttons["Sonnet 5"]
        XCTAssertTrue(sonnet.waitForExistence(timeout: 5), "the model sheet did not open")
        sonnet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 3) { !self.sheetIsUp(app) }, "the pick did not close the sheet")
        XCTAssertTrue(waitUntil(timeout: 3) { !pill.isEnabled }, "the pill took taps while its pick was being written")
        XCTAssertEqual(pill.label, "Model: Sonnet 5", "the pick is not shown while it is written")
        try await stub.screenshot(app, "model-pill-09-disabled-pills-while-writing")
        // What the user reads, measured off the screen: the name being written in
        // readable ink (it was 1.69:1, gate r2).
        let writing = Self.textContrast(of: pill)
        print("[evidence] while writing: the model pill's text is \(Self.fmt1(writing)):1")
        XCTAssertGreaterThanOrEqual(writing, 4.5, "the name being written reads \(Self.fmt1(writing)):1")
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertFalse(sheetClose(app).waitForExistence(timeout: 1.5),
                       "a disabled pill opened its sheet mid-write")
        XCTAssertFalse(pill.isEnabled, "the write finished before the disabled tap was checked; lengthen the delay")

        XCTAssertTrue(waitUntil(timeout: 12) { pill.isEnabled }, "the pill never came back after the write landed")
        XCTAssertEqual(pill.label, "Model: Sonnet 5")
        let writes = try await stub.requests().filter { $0.method == "POST" && $0.path.hasSuffix("/model") }
        XCTAssertEqual(writes.map(\.model), ["global.anthropic.claude-sonnet-5"],
                       "the tap wrote something other than the row it landed on")
        try await stub.screenshot(app, "model-pill-09-after-write")
    }

    // MARK: - Scenario 6b: the chat's mode pill (user, 2026-10-04)

    /// On the lane engine the chat runs in a real session, so its composer has the
    /// web's mode pill, before the model pill on the same row: it reads the lane
    /// session's mode control, and a pick writes exactly that mode to it.
    @MainActor
    func testTheChatComposerShowsAndWritesTheLaneSessionsMode() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        let mode = app.buttons["composer.modePill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")
        XCTAssertTrue(waitForLabel(mode, "Permission mode: Bypass", timeout: 15),
                      "no mode pill on the lane chat (reads \(mode.exists ? mode.label : "absent"))")
        XCTAssertLessThanOrEqual(mode.frame.maxX, pill.frame.minX, "the mode pill is not before the model pill")
        try await stub.screenshot(app, "model-pill-13-mode-pill")

        try await openMenu(app, mode)
        let plan = app.buttons["composer.mode.plan"]
        XCTAssertTrue(plan.waitForExistence(timeout: 5), "the mode menu did not open")
        try await stub.screenshot(app, "model-pill-13-mode-menu")
        plan.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitForLabel(mode, "Permission mode: Plan", timeout: 10),
                      "the pick did not land (reads \(mode.label))")
        let writes = try await stub.requests().filter { $0.method == "POST" && $0.path.hasSuffix("/controls") }
        XCTAssertEqual(writes.count, 1, "the pick was not written exactly once: \(writes.map(\.path))")
        XCTAssertEqual(writes.first?.path, "/api/v1/sessions/sess-stub-lane/controls")
        try await stub.screenshot(app, "model-pill-13-mode-picked")
    }

    // MARK: - Scenario 6c: the chat's mode pill keeps its seat (user, 2026-10-04)

    /// The user: "the main chat sometimes has Bypass and sometimes doesn't". The
    /// pill came and went with every gap in the composer's session: none until the
    /// mode had loaded, none from the first send until the new conversation had
    /// its id, none while the Mac was away. It keeps its seat through all of them:
    /// "Mode" until the first answer, the mode through the first send, the last
    /// known mode (read-only) while the Mac is away, and live again when it is back.
    @MainActor
    func testTheChatsModePillNeverComesAndGoes() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        let mode = app.buttons["composer.modePill"]

        // From the first frame the composer shows: never a model pill alone.
        var alone = 0
        var samples = 0
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline {
            samples += 1
            let pillShows = pill.exists
            if pillShows && !mode.exists { alone += 1 }
            if pillShows, pill.label == Self.healedLabel, mode.exists, mode.label == "Permission mode: Bypass" { break }
            usleep(150_000)
        }
        XCTAssertEqual(mode.label, "Permission mode: Bypass", "the mode never loaded (reads \(mode.label))")
        XCTAssertEqual(alone, 0, "the model pill showed \(alone) of \(samples) times without the mode pill")
        XCTAssertTrue(mode.isEnabled)

        // The first send: the new conversation gets its id. The seat never empties.
        let field = element(app, "chat.composer")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the composer took no focus")
        field.typeText("hello")
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no send button")
        var gone = 0
        var watched = 0
        func watch(_ seconds: Double) {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                watched += 1
                if !mode.exists || mode.label != "Permission mode: Bypass" { gone += 1 }
                usleep(150_000)
            }
        }
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        watch(4)
        XCTAssertTrue(waitUntil(timeout: 20) {
            ((try? self.syncRequests(stub)) ?? []).contains { $0.method == "POST" && $0.path.hasSuffix("/messages") }
        }, "the message never went out")
        try await stub.screenshot(app, "model-pill-16-mode-first-send")
        try await stub.call("POST", "__stub/finish-turn")
        watch(4)
        print("[evidence] first send: the mode pill was missing or changed in \(gone) of \(watched) samples")
        XCTAssertEqual(gone, 0, "the mode pill left its seat \(gone) of \(watched) times around the first send")

        // The Mac goes away: the last known mode stays, and takes no pick.
        try await stub.setEngine("unreachable")
        let before = try await stub.engineGets().count
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        XCTAssertTrue(waitUntil(timeout: 20) { ((try? self.syncEngineGets(stub).count) ?? 0) > before },
                      "coming back to the app did not ask, so the Mac being away was never seen")
        XCTAssertTrue(waitForLabel(pill, "\(Self.healedLabel), last known", timeout: 20), "the model pill reads \(pill.label)")
        XCTAssertTrue(mode.exists, "the mode pill left with the Mac")
        XCTAssertEqual(mode.label, "Permission mode: Bypass")
        XCTAssertEqual(mode.value as? String, "last known")
        XCTAssertFalse(mode.isEnabled, "the mode pill offers a pick it cannot write with the Mac away")
        try await stub.screenshot(app, "model-pill-16-mode-mac-away")

        // Back: live again.
        try await stub.setEngine("lane")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill did not heal once the Mac was back")
        XCTAssertTrue(waitUntil(timeout: 10) { mode.isEnabled && ((mode.value as? String) ?? "").isEmpty },
                      "the mode pill is not live again (value \(String(describing: mode.value)))")
        XCTAssertEqual(mode.label, "Permission mode: Bypass")
        app.terminate()

        // A launch with the Mac away: the seat is there, unnamed, before the
        // model pill, and takes no pick; the mode fills it once the Mac answers.
        try await stub.reset()
        try await stub.setEngine("unreachable")
        let away = try launchPaired()
        openChatTab(away)
        let awayPill = away.buttons["composer.modelPill"]
        let awayMode = away.buttons["composer.modePill"]
        XCTAssertTrue(waitForLabel(awayPill, "Model: unknown", timeout: 45), "no unreachable pill")
        XCTAssertTrue(waitForLabel(awayMode, "Permission mode", timeout: 5),
                      "no mode seat with the Mac away from launch (reads \(awayMode.exists ? awayMode.label : "absent"))")
        XCTAssertFalse(awayMode.isEnabled, "the empty mode seat takes taps")
        XCTAssertLessThanOrEqual(awayMode.frame.maxX, awayPill.frame.minX, "the mode seat is not before the model pill")
        try await stub.screenshot(away, "model-pill-16-mode-away-from-launch")
        try await stub.setEngine("lane")
        XCTAssertTrue(waitForLabel(awayMode, "Permission mode: Bypass", timeout: 45),
                      "the mode never filled its seat (reads \(awayMode.label))")
        let writes = try await stub.requests().filter { $0.method == "POST" && $0.path.hasSuffix("/controls") }
        XCTAssertTrue(writes.isEmpty, "showing the mode wrote \(writes.map(\.path))")
    }

    // MARK: - Scenario 5: the sheet and the pills at the default and largest text sizes

    /// The "Select model" sheet (user, 2026-10-04: a drawer, every list vertical,
    /// the Claude app's picker): the models are one vertical list in the Mac's
    /// order with the current one checked, and the levels are their own vertical
    /// list behind one Effort row that names the current level. At the default
    /// size every name is on one line (an Effort submenu once wrapped "Default
    /// (Opus 5.5 1M)"); at XXXL (the largest standard size) and AX5 the list
    /// scrolls, every row is still there in order, and the pill still fits beside
    /// the mic. A model without an effort axis has no Effort row.
    ///
    /// And AX5, the largest ACCESSIBILITY size, with the WIDEST real pill label
    /// (gate r2 D2: side by side there, "GPT-6 Astra" read "GP…" in a 131pt pill).
    /// The pill wraps, and the model name must fit the pill it got, measured
    /// against the real font.
    @MainActor
    func testTheSheetAndPillsAtTheDefaultAndTheLargestTextSizes() async throws {
        let stub = try await stubUnderTest()
        let ax5 = "UICTContentSizeCategoryAccessibilityXXXL"
        let widest = Self.widestPillLabel(at: .accessibilityExtraExtraExtraLarge)
        print("[evidence] widest real pill label at AX5: \(widest.label) (\(Int(widest.width))pt), model \(widest.id)")
        for (size, tag) in [(nil as String?, "default"), ("UICTContentSizeCategoryXXXL", "xxxl"), (ax5, "ax5")] {
            try await stub.reset()
            try await stub.setEngine("lane")
            let expected: String
            // Only some rows of the catalog have an effort axis (and so an effort
            // half on the pill and an Effort row in its sheet).
            var hasEffort = true
            if size == ax5 {
                try await stub.setLane(model: widest.id, effort: "xhigh")
                expected = "Model: \(widest.label)"
                hasEffort = Self.rowsWithEffort.contains(widest.id)
            } else {
                expected = Self.healedLabel
            }
            let extra = size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? []
            let app = try launchPaired(extra)
            openChatTab(app)
            let pill = app.buttons["composer.modelPill"]
            XCTAssertTrue(waitForLabel(pill, expected, timeout: 45),
                          "\(tag): the pill never showed \(expected) (reads \(pill.exists ? pill.label : "absent"))")
            XCTAssertEqual(waitUntil(timeout: 10) { Self.effortValue(pill) != nil }, hasEffort,
                           "\(tag): effort on the pill (value \(Self.effortValue(pill) ?? "none"))")
            let mic = element(app, "chat.mic")
            XCTAssertTrue(mic.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(pill.frame.maxX, mic.frame.minX,
                                     "\(tag): the model pill runs into the mic (\(pill.frame) vs \(mic.frame))")
            if size == ax5 {
                assertTheNameFits(widest.label, in: pill.frame, at: .accessibilityExtraExtraExtraLarge, tag: tag)
            }
            try await stub.screenshot(app, "model-pill-08-\(tag)-pills")

            try await openMenu(app, pill)
            let sheet = app.navigationBars[Self.sheetTitle]
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "\(tag): the pill did not open the \(Self.sheetTitle) sheet")
            let screen = app.windows.firstMatch.frame
            XCTAssertTrue(screen.contains(sheet.frame), "\(tag): the sheet's title is off screen at \(sheet.frame)")
            try await stub.screenshot(app, "model-pill-08-\(tag)-sheet")
            let current = size == ax5 ? widest.id : Self.healedID
            let row = Self.macOrder[Self.pillLabels.firstIndex { $0.id == current }!]
            // Every row, in the Mac's order, in one vertical list. At the big sizes
            // the list is taller than the sheet and scrolls, and a row far out of
            // view is not in the tree at all, so the rows are read before and after
            // scrolling to the end (a slow swipe scrolls; it must never pick a row,
            // which the wire check below holds).
            var seen = Self.rowsInView(app)
            var checked = Set(seen.filter { app.buttons[$0].isSelected })
            var columns = Set(seen.map { Int(app.buttons[$0].frame.minX) })
            var swipes = 0
            while seen.last != Self.macOrder.last, swipes < 6 {
                let reachable = Self.rowsInView(app).filter { app.buttons[$0].isHittable }
                guard !reachable.isEmpty else {
                    XCTFail("\(tag): no row of the open sheet is reachable")
                    break
                }
                app.buttons[reachable[reachable.count / 2]].swipeUp(velocity: .slow)
                swipes += 1
                try await Task.sleep(for: .seconds(1))
                let now = Self.rowsInView(app)
                seen += now.filter { !seen.contains($0) }
                checked.formUnion(now.filter { app.buttons[$0].isSelected })
                columns.formUnion(now.map { Int(app.buttons[$0].frame.minX) })
                XCTAssertTrue(sheetIsUp(app), "\(tag): scrolling the sheet closed it")
            }
            if swipes > 0 {
                print("[evidence] \(tag): the sheet scrolled (\(swipes) swipe(s)) to its last row")
                try await stub.screenshot(app, "model-pill-08-\(tag)-sheet-scrolled")
            }
            XCTAssertEqual(seen, Self.macOrder, "\(tag): the sheet's rows, top to bottom, are not the Mac's order")
            XCTAssertEqual(columns.count, 1, "\(tag): the models are not one vertical list (row x \(columns.sorted()))")
            XCTAssertEqual(checked, [row], "\(tag): the checked rows are \(checked.sorted()), not the current \(row)")
            if size == nil {
                let single = app.buttons["Sonnet 5"].frame.height
                let longest = app.buttons["Default (Opus 5.5 1M)"].frame.height
                print("[evidence] \(tag): row heights Sonnet 5 = \(single)pt, Default (Opus 5.5 1M) = \(longest)pt")
                XCTAssertLessThan(longest, single * 1.25,
                                  "default size: \"Default (Opus 5.5 1M)\" is \(Int(longest))pt against \(Int(single))pt: it wrapped")
            }
            print("[evidence] \(tag): pill \(pill.frame) (effort \(Self.effortValue(pill) ?? "none")), mic \(mic.frame)")
            let effortRow = element(app, "composer.modelSheet.effort")
            let effortInReach = try await scrollSheet(app, to: effortRow, rows: Self.macOrder)
            if hasEffort {
                // The levels are their own vertical list behind one Effort row,
                // which names the current level.
                let level = size == ax5 ? "Extra High" : "High"
                XCTAssertTrue(effortInReach, "\(tag): the sheet has no Effort row in reach")
                XCTAssertTrue(effortRowText(app).hasSuffix(level),
                              "\(tag): the Effort row reads \"\(effortRowText(app))\", not \(level)")
                try await stub.screenshot(app, "model-pill-08-\(tag)-sheet-effort-row")
                if try await openEffortPage(app) {
                    assertTheLevelsAreOneList(app, checked: level, tag: tag)
                    try await stub.screenshot(app, "model-pill-08-\(tag)-effort-page")
                }
            } else {
                XCTAssertFalse(effortInReach, "\(tag): a model without an effort axis has an Effort row")
            }
            closeSheet(app)
            let writes = try await stub.writes()
            XCTAssertTrue(writes.isEmpty, "\(tag): looking at the sheet wrote \(writes.map(\.path))")
            app.terminate()
        }
    }

    // MARK: - Scenario 5b: a long raw model id (gate r3 P2-3)

    /// A model the catalog does not know (a custom proxy id) reaches the pill as
    /// its raw id. At AX5 that wrapped to five lines and the Capsule turned the
    /// pill into a 262x266pt circle. A raw id now takes at most two lines, cut in
    /// the middle, in a rounded rectangle; at the default size it is one line.
    /// Catalog names are not capped (the size test holds that they never truncate).
    @MainActor
    func testALongRawModelIDKeepsThePillASaneSize() async throws {
        let stub = try await stubUnderTest()
        let raw = "custom-proxy-model-extra-long-name-v2"
        let sizes: [(String?, UIContentSizeCategory, String)] = [
            (nil, .large, "default"),
            ("UICTContentSizeCategoryAccessibilityXXXL", .accessibilityExtraExtraExtraLarge, "ax5"),
        ]
        for (size, category, tag) in sizes {
            try await stub.reset()
            try await stub.setEngine("lane")
            try await stub.setLane(model: raw, effort: "xhigh")
            let app = try launchPaired(size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
            openChatTab(app)
            let pill = app.buttons["composer.modelPill"]
            XCTAssertTrue(waitForLabel(pill, "Model: \(raw)", timeout: 45),
                          "\(tag): the pill reads \(pill.exists ? pill.label : "absent")")
            let mic = element(app, "chat.mic")
            XCTAssertTrue(mic.waitForExistence(timeout: 5))
            let frame = pill.frame
            // The button's frame is at least 34pt tall (its hit area), so the drawn
            // chip is read off the screen.
            guard let chip = Self.drawnChip(of: pill) else {
                XCTFail("\(tag): no pill drawn in \(frame)")
                return
            }
            let lineHeight = Self.pillFont(at: category).lineHeight
            let lines = (chip.height - 10) / lineHeight
            print("[evidence] \(tag): raw id pill drawn \(Int(frame.width))x\(String(format: "%.1f", chip.height))pt "
                  + "(button \(frame)) = \(String(format: "%.2f", lines)) line(s) of \(String(format: "%.1f", lineHeight))pt; "
                  + "corner \(chip.corner) vs fill \(chip.fill) vs outside \(chip.outside), mic \(mic.frame)")
            try await stub.screenshot(app, "model-pill-15-\(tag)-raw-id")
            XCTAssertLessThanOrEqual(frame.maxX, mic.frame.minX, "\(tag): the raw id pill runs into the mic")
            if size == nil {
                XCTAssertLessThan(lines, 1.3, "default: the raw id wrapped (\(chip.height)pt)")
            } else {
                XCTAssertLessThan(lines, 2.3, "ax5: the raw id takes more than two lines (\(chip.height)pt)")
                XCTAssertGreaterThan(lines, 1.5, "ax5: the raw id was not given its second line (\(chip.height)pt)")
                XCTAssertGreaterThan(frame.width, chip.height * 1.5, "ax5: the pill is a blob, \(frame)")
                XCTAssertTrue(chip.cornerFilled, "ax5: the wrapped pill is round at its corner (a capsule): "
                              + "\(chip.corner) vs fill \(chip.fill)")
            }
            let writes = try await stub.writes()
            XCTAssertTrue(writes.isEmpty, "\(tag): showing a raw id wrote \(writes.map(\.path))")
            app.terminate()
        }
    }

    /// The pill labels the stub's catalog can put on the pill, keyed by model id:
    /// what the app names each row's model (`currentModelLabel`: the versioned name
    /// from the resolved model, else the row's label).
    private static let pillLabels: [(id: String, label: String)] = [
        ("haiku", "Haiku 4.5"), ("gpt-6-luna", "GPT-6 Luna"), ("global.anthropic.claude-sonnet-5", "Sonnet 5"),
        ("gpt-6-astra", "GPT-6 Astra"), ("global.anthropic.claude-fable-5[1m]", "Fable 5"),
        ("global.anthropic.claude-fable-5-1[1m]", "Fable 5.1"), ("gpt-5.6-sol", "GPT-5.6 Sol"),
        ("gpt-6-sol", "GPT-6 Sol"), ("default", "Opus 5.5"), ("opus", "Opus 5.5"),
    ]

    private static let effortRows = ["Low", "Medium", "High", "Extra High", "Max"]

    /// The model rows the open sheet has in its tree right now, top to bottom.
    @MainActor
    private static func rowsInView(_ app: XCUIApplication) -> [String] {
        macOrder.filter { app.buttons[$0].exists }.sorted { app.buttons[$0].frame.minY < app.buttons[$1].frame.minY }
    }
    /// The stub catalog's rows that declare effort levels (the rest carry none).
    private static let rowsWithEffort: Set<String> = [
        "default", "global.anthropic.claude-fable-5[1m]", "global.anthropic.claude-fable-5-1[1m]",
        "global.anthropic.claude-sonnet-5", "opus", "gpt-6-astra",
    ]

    /// The pill's font at a text size: `.caption.weight(.medium)`.
    private static func pillFont(at size: UIContentSizeCategory) -> UIFont {
        let traits = UITraitCollection(preferredContentSizeCategory: size)
        let caption = UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits)
        return UIFont.systemFont(ofSize: caption.pointSize, weight: .medium)
    }

    private static func width(_ text: String, _ font: UIFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    private static func widestPillLabel(at size: UIContentSizeCategory) -> (id: String, label: String, width: CGFloat) {
        let font = pillFont(at: size)
        return pillLabels.map { ($0.id, $0.label, width($0.label, font)) }.max { $0.2 < $1.2 }!
    }

    /// The name fits the pill it got: every word fits the text column, and the
    /// words wrapped greedily into that column need no more lines than the pill is
    /// tall. This is the check the old side-by-side layout fails (one 89pt line
    /// for a ~230pt name).
    @MainActor
    private func assertTheNameFits(
        _ label: String, in frame: CGRect, at size: UIContentSizeCategory, tag: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let font = Self.pillFont(at: size)
        let traits = UITraitCollection(preferredContentSizeCategory: size)
        let glyphPoints = UIFontMetrics(forTextStyle: .caption1).scaledValue(for: 8, compatibleWith: traits)
        let glyph = UIImage(
            systemName: "chevron.up.chevron.down",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: glyphPoints, weight: .semibold)
        )?.size.width ?? glyphPoints
        // PillChip: 9pt padding each side, 4pt between the name and the glyph.
        let column = frame.width - 18 - 4 - glyph
        // Greedy word wrap, each line measured whole (summing rounded word widths
        // overstates a line by a point or two).
        var lines: [String] = []
        for word in label.split(separator: " ").map(String.init) {
            let w = Self.width(word, font)
            XCTAssertLessThanOrEqual(w, column + 1, "\(tag): \"\(word)\" (\(Int(w))pt) does not fit the pill's "
                                     + "\(Int(column))pt text column: it truncates", file: file, line: line)
            if let last = lines.last, Self.width(last + " " + word, font) <= column + 1 {
                lines[lines.count - 1] = last + " " + word
            } else {
                lines.append(word)
            }
        }
        let fits = Int(((frame.height - 10 + 2) / font.lineHeight).rounded(.down))
        print("[evidence] \(tag): \"\(label)\" is \(Int(Self.width(label, font)))pt, needs \(lines.count) line(s) "
              + "of the \(Int(column))pt column \(lines); the pill \(frame) holds \(fits)")
        XCTAssertLessThanOrEqual(lines.count, fits, "\(tag): \"\(label)\" needs \(lines.count) lines in a pill "
                                 + "\(Int(frame.height))pt tall that holds \(fits): it truncates", file: file, line: line)
    }

    // MARK: - Scenario 7: a second tap on the pill never picks a row (gate r2 D1)

    /// The gate's repro, on the old menu: it grew out of the pill and covered it,
    /// with its strongest rows exactly where the pill was, so a double tap wrote
    /// `default` 380ms after the open. The sheet covers the pill too (it slides up
    /// over the whole composer), and it takes no tap until it has settled
    /// (`PillMenuSheet.settleDelay`, 600ms). So the later taps of a double or a
    /// triple tap land on a sheet that ignores them: it stays up (every pick
    /// closes it, so a sheet still up is a sheet nothing was picked on), nothing
    /// is written, and its X closes it.
    ///
    /// Only a double or triple tap puts a second tap inside the settle window:
    /// XCUI's `tap()` waits for the app to idle, so two separate taps land 1.3s
    /// apart at best (measured), by when the sheet shows its rows and a tap on
    /// one is the user's pick. The old menu's 1.2s and 3s cases were about a
    /// menu growing over a pill still in view; the sheet covers the screen.
    @MainActor
    func testASecondTapOnThePillWhileItsSheetComesUpNeverPicksARow() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "high")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Sonnet 5", timeout: 45), "the pill never showed Sonnet 5")
        XCTAssertTrue(waitForEffort(pill, "Effort: High", timeout: 10), "no effort High on the pill")
        try await secondTaps(app, stub, pill, tag: "model")
        XCTAssertEqual(pill.label, "Model: Sonnet 5")
        XCTAssertEqual(Self.effortValue(pill), "Effort: High")

        // An effort the session does not report (the CLI default): no row is
        // checked, so there is no "current" row a stray tap could safely land on.
        try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "none")
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(1))
        app.activate()
        XCTAssertTrue(waitForEffort(pill, nil, timeout: 20),
                      "the pill still names an effort (\(Self.effortValue(pill) ?? "none")) the session does not report")
        try await secondTaps(app, stub, pill, tag: "effort-unknown")
        // The levels page with no level checked: the row says the CLI's default.
        try await openMenu(app, pill)
        let row = element(app, "composer.modelSheet.effort")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "no Effort row for Sonnet 5")
        XCTAssertTrue(effortRowText(app).hasSuffix("Default"), "the Effort row reads \"\(effortRowText(app))\"")
        if try await openEffortPage(app) {
            assertTheLevelsAreOneList(app, checked: nil, tag: "effort-unknown")
        }
        closeSheet(app)
        let writes = try await stub.writes()
        XCTAssertTrue(writes.isEmpty, "looking at the levels wrote \(writes.map(\.path))")
    }

    /// The Retry sheet under the same rule: a stray Retry writes nothing, but it
    /// would restart the ladder; a sheet still up after the taps is the proof that
    /// Retry was not picked (a pick closes the sheet).
    @MainActor
    func testASecondTapOnTheRetryPillNeverPicksRetry() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("unreachable")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: unknown", timeout: 45), "no unreachable pill")
        try await secondTaps(app, stub, pill, tag: "retry", retryID: "composer.modelPill.retry")
    }

    /// A double and a triple tap at the pill's own spot. Each ends with the sheet
    /// still up (nothing picked), nothing written, and the X closing it.
    @MainActor
    private func secondTaps(
        _ app: XCUIApplication, _ stub: StubControl, _ pill: XCUIElement, tag: String,
        retryID: String? = nil, file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let frame = pill.frame
        let spot = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
        let before = try await stub.writes().count

        func check(_ what: String) async throws {
            try await Task.sleep(for: .milliseconds(1500))
            try await stub.screenshot(app, "model-pill-10-\(tag)-\(what)")
            XCTAssertTrue(sheetIsUp(app), "\(tag) \(what): the sheet is not up, so a tap picked a row "
                          + "or the pill opened nothing", file: file, line: line)
            if let retryID {
                XCTAssertTrue(element(app, retryID).exists, "\(tag) \(what): the sheet offers no Retry",
                              file: file, line: line)
            }
            if sheetIsUp(app) { closeSheet(app, file: file, line: line) }
            let writes = try await stub.writes()
            XCTAssertEqual(writes.count, before, "\(tag) \(what) wrote \(writes.dropFirst(before).map(\.path))",
                           file: file, line: line)
        }

        spot.doubleTap()
        try await check("double-tap")
        pill.tap(withNumberOfTaps: 3, numberOfTouches: 1)
        try await check("triple-tap")
        print("[evidence] \(tag) keyboard down: double and triple tap at \(spot.screenPoint): "
              + "the sheet stayed up each time, \(try await stub.writes().count - before) writes")
    }

    // MARK: - Scenario 10: the same taps with the keyboard up (gate r3 P1-1, P2-1)

    /// The gate, on the old menu: with the keyboard up (how the pill is used while
    /// typing), opening a menu took the text focus, the keyboard dropped its
    /// QuickType row and the composer moved down while the menu opened, so its
    /// bottom row covered the spot where the user had just seen the pill: a double
    /// tap wrote `opus`. The sheet opens on the first tap with the keyboard up (it
    /// needs no room above the pill), and every later tap of a double tap lands on
    /// a sheet that is still settling. When it closes, the focus is back in the
    /// composer and the pill where the user saw it.
    @MainActor
    func testWithTheKeyboardUpNoTapWhereThePillWasPicksARow() async throws {
        let stub = try await stubUnderTest()
        for (size, tag) in [(nil as String?, "default"), ("UICTContentSizeCategoryXXXL", "xxxl")] {
            try await stub.reset()
            try await stub.setEngine("lane")
            try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "high")
            let app = try launchPaired(size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
            openChatTab(app)
            let pill = app.buttons["composer.modelPill"]
            XCTAssertTrue(waitForLabel(pill, "Model: Sonnet 5", timeout: 45), "\(tag): the pill never showed Sonnet 5")
            XCTAssertTrue(waitForEffort(pill, "Effort: High", timeout: 10), "\(tag): no effort High on the pill")
            try await keyboardUpTaps(app, stub, pill, tag: "\(tag)-model")
            XCTAssertEqual(pill.label, "Model: Sonnet 5")
            XCTAssertEqual(Self.effortValue(pill), "Effort: High")
            if size == nil {
                // No level checked (the CLI default): nothing "safe" to land on.
                try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "none")
                XCUIDevice.shared.press(.home)
                try await Task.sleep(for: .seconds(1))
                app.activate()
                XCTAssertTrue(waitForEffort(pill, nil, timeout: 20),
                              "the pill still names an effort (\(Self.effortValue(pill) ?? "none")) the session does not report")
                try await keyboardUpTaps(app, stub, pill, tag: "\(tag)-effort-unknown")
                try await keyboardUpPick(app, stub, pill, level: "Medium", tag: "\(tag)-effort")
            }
            app.terminate()
        }
    }

    /// The Retry sheet with the keyboard up: a tap 3pt above the old menu's pill
    /// fired Retry (gate r3 P2-1). Retry writes nothing, so it is caught on the
    /// wire: it restarts the ladder, which puts two lookups about 1s apart, while
    /// the ladder on its own is past the 15s rung and asks at most every 15s.
    @MainActor
    func testWithTheKeyboardUpNoTapWhereTheRetryPillWasFiresRetry() async throws {
        let stub = try await stubUnderTest()
        for (size, tag) in [(nil as String?, "default"), ("UICTContentSizeCategoryXXXL", "xxxl")] {
            try await stub.reset()
            try await stub.setEngine("unreachable")
            let app = try launchPaired(size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
            openChatTab(app)
            let pill = app.buttons["composer.modelPill"]
            XCTAssertTrue(waitForLabel(pill, "Model: unknown", timeout: 45), "\(tag): no unreachable pill")
            XCTAssertTrue(waitUntil(timeout: 40) { ((try? self.syncEngineGets(stub).count) ?? 0) >= 5 },
                          "\(tag): the ladder never reached its 15s rung")
            let from = Date()
            try await keyboardUpTaps(app, stub, pill, tag: "\(tag)-retry", retryID: "composer.modelPill.retry")
            let gets = try await stub.engineGets().filter { $0.at > from.addingTimeInterval(-1) }
            let gaps = zip(gets.dropFirst(), gets).map { $0.at.timeIntervalSince($1.at) }
            print("[evidence] \(tag)-retry keyboard up: \(gets.count) lookups over \(Int(Date().timeIntervalSince(from)))s, "
                  + "gaps \(Self.fmt(gaps))")
            XCTAssertTrue(gaps.allSatisfy { $0 >= 10 }, "\(tag): Retry fired (lookups \(Self.fmt(gaps)) apart)")
            app.terminate()
        }
    }

    /// With the keyboard up, where the user SAW the pill before touching it: one
    /// tap, a double tap and a triple tap (see `secondTaps` for why there are no
    /// timed second taps). Each opens the sheet with the keyboard away and picks
    /// nothing (the sheet is still up); its X closes it, the keyboard comes back
    /// by itself, and the pill is where the user saw it. Then typing goes on.
    @MainActor
    private func keyboardUpTaps(
        _ app: XCUIApplication, _ stub: StubControl, _ pill: XCUIElement, tag: String,
        retryID: String? = nil, file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let field = element(app, "chat.composer")
        if !app.keyboards.element.exists {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 5), "\(tag): no keyboard", file: file, line: line)
        }
        // The QuickType row settles after the keyboard.
        try await Task.sleep(for: .milliseconds(900))
        let seen = pill.frame
        let spot = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: seen.midX, dy: seen.midY))
        let before = try await stub.writes().count

        func check(_ what: String) async throws {
            try await Task.sleep(for: .milliseconds(1500))
            try await stub.screenshot(app, "model-pill-13-\(tag)-\(what)")
            XCTAssertTrue(sheetIsUp(app), "\(tag) \(what): the sheet is not up, so a tap picked a row "
                          + "or the pill opened nothing", file: file, line: line)
            XCTAssertFalse(app.keyboards.element.exists, "\(tag) \(what): the keyboard stayed up over the sheet",
                           file: file, line: line)
            if let retryID {
                XCTAssertTrue(element(app, retryID).exists, "\(tag) \(what): the sheet offers no Retry",
                              file: file, line: line)
            }
            if sheetIsUp(app) { closeSheet(app, file: file, line: line) }
            XCTAssertTrue(waitUntil(timeout: 4) { app.keyboards.element.exists },
                          "\(tag) \(what): the focus did not come back when the sheet closed", file: file, line: line)
            let writes = try await stub.writes()
            XCTAssertEqual(writes.count, before, "\(tag) \(what) wrote \(writes.dropFirst(before).map(\.path))",
                           file: file, line: line)
            if !app.keyboards.element.exists {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                _ = app.keyboards.element.waitForExistence(timeout: 5)
            }
            try await Task.sleep(for: .milliseconds(900))
            XCTAssertEqual(pill.frame.minY, seen.minY, accuracy: 1,
                           "\(tag) \(what): with the keyboard back the pill is not where the user saw it",
                           file: file, line: line)
        }

        spot.tap()
        try await check("one-tap")
        spot.doubleTap()
        try await check("double-tap")
        pill.tap(withNumberOfTaps: 3, numberOfTouches: 1)
        try await check("triple-tap")
        // Typing goes on in the field the user was typing in.
        field.typeText("ok")
        XCTAssertTrue(waitUntil(timeout: 3) { ((field.value as? String) ?? "").contains("ok") },
                      "\(tag): typing after the sheet did not reach the composer (value \(String(describing: field.value)))",
                      file: file, line: line)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
        print("[evidence] \(tag) keyboard up, pill seen at \(Int(seen.minY))-\(Int(seen.maxY)) (tap at \(spot.screenPoint)): "
              + "one tap, double and triple tap: the sheet opened each time "
              + "with the keyboard away, \(try await stub.writes().count - before) writes, focus back, typing goes on")
    }

    /// With the keyboard up, a PICK: one tap opens the sheet, the Effort row opens
    /// the levels, the tapped level is written once, and the focus comes back.
    @MainActor
    private func keyboardUpPick(
        _ app: XCUIApplication, _ stub: StubControl, _ pill: XCUIElement, level: String, tag: String
    ) async throws {
        let field = element(app, "chat.composer")
        if !app.keyboards.element.exists {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 5), "\(tag): no keyboard")
        }
        try await Task.sleep(for: .milliseconds(900))
        let before = try await stub.writes().count
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: pill.frame.midX, dy: pill.frame.midY)).tap()
        XCTAssertTrue(sheetClose(app).waitForExistence(timeout: 5), "\(tag): one tap did not open the sheet")
        XCTAssertTrue(waitUntil(timeout: 3) { !app.keyboards.element.exists }, "\(tag): the keyboard stayed up")
        try await Task.sleep(for: .milliseconds(900))
        guard try await openEffortPage(app) else { return }
        app.buttons[level].tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !self.sheetIsUp(app) }, "\(tag): the pick did not close the sheet")
        XCTAssertTrue(waitUntil(timeout: 5) { app.keyboards.element.exists },
                      "\(tag): the focus did not come back after a pick")
        XCTAssertTrue(waitUntil(timeout: 10) { ((try? self.syncWrites(stub).count) ?? 0) == before + 1 },
                      "\(tag): the pick was not written once")
        let wrote = try await stub.writes().dropFirst(before).map(\.path)
        XCTAssertEqual(wrote, ["/api/v1/sessions/sess-stub-lane/effort"], "\(tag): the pick wrote \(wrote)")
        XCTAssertTrue(waitForEffort(pill, "Effort: \(level)", timeout: 10),
                      "\(tag): the pill reads \(Self.effortValue(pill) ?? "none") after the pick")
        print("[evidence] \(tag) keyboard up: pick \(level) wrote \(wrote), focus back")
    }

    // MARK: - Scenario 8: a composer on another tab never re-asks (gate r2 D4)

    /// The gate: on Inbox, the hidden Chat composer asked the Mac twice in 130s,
    /// both `trigger=appeared` at a stream reconnect (a retained tab re-runs its
    /// composer's appear), and each armed the 60s TTL. Off screen means no request
    /// at all; coming back asks once.
    @MainActor
    func testTheChatComposerOnAnotherTabNeverAsks() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")

        // A conversation with a live stream, as the gate had: only then is there a
        // stream to reconnect while the tab is hidden.
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no composer to type into")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the composer took no focus")
        field.typeText("hello")
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no send button")
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 30) {
            ((try? self.syncRequests(stub)) ?? []).contains { $0.method == "POST" && $0.path.hasSuffix("/messages") }
        }, "the message never went out")
        try await Task.sleep(for: .seconds(1))
        try await stub.call("POST", "__stub/finish-turn")
        try await Task.sleep(for: .seconds(2))
        // The keyboard covers the tab bar: put it away the way a thumb does.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        if app.keyboards.element.exists {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        }
        XCTAssertTrue(waitUntil(timeout: 5) { !app.keyboards.element.exists }, "the keyboard would not go away")

        let inbox = app.buttons["Inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10), "no Inbox tab")
        inbox.tap()
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(waitUntil(timeout: 5) { inbox.isSelected }, "the Inbox tab did not become selected")
        let leftAt = Date()
        let asksBefore = try await stub.engineGets().count
        // Two reconnects of the chat's stream while it is hidden (the gate saw the
        // re-asks land on those), then on past the 60s TTL.
        try await Task.sleep(for: .seconds(12))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(30))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(30))
        let hidden = try await stub.requests().filter {
            $0.at > leftAt && ($0.path == "/api/v1/chat/engine" || $0.path.hasSuffix("/model-options"))
        }
        let streams = try await stub.requests().filter { $0.at > leftAt && $0.path.hasSuffix("/stream") }
        print("[evidence] on Inbox \(Int(Date().timeIntervalSince(leftAt)))s: \(streams.count) stream (re)connects, "
              + "\(hidden.count) model asks \(hidden.map { "\($0.path)@\($0.at)" })")
        XCTAssertGreaterThanOrEqual(streams.count, 2, "the hidden chat's stream never reconnected: the repro did not happen")
        XCTAssertTrue(hidden.isEmpty, "the hidden Chat composer asked the Mac \(hidden.count) time(s) while on Inbox")
        try await stub.screenshot(app, "model-pill-11-inbox-hidden-composer")

        app.buttons["Chat"].tap()
        XCTAssertTrue(
            waitUntil(timeout: 10) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBefore },
            "coming back to Chat did not re-ask a stale answer"
        )
        try await Task.sleep(for: .seconds(2))
        let back = try await stub.engineGets().count - asksBefore
        XCTAssertEqual(back, 1, "coming back to Chat asked \(back) times, not once")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 10))
    }

    // MARK: - Scenario 11: a SESSION page's composer off screen never re-asks

    /// Gate r3 left the session composer (the `.session(id)` surface) unverified:
    /// the D4 fix was proved on the Chat tab only. A session page pushed on the
    /// Tasks tab stays mounted while the user is on Inbox; its composer must not
    /// ask while hidden (not on a stream reconnect, not on the 60s TTL), must ask
    /// once when the user comes back to it, and must go quiet for good once the
    /// page is popped.
    @MainActor
    func testASessionPagesComposerOffScreenNeverAsks() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.call("POST", "__stub/work-session?on=1")
        let app = try launchPaired()
        let tasksTab = app.buttons["Tasks"]
        XCTAssertTrue(tasksTab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasksTab.tap()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 45), "the board never showed the work task")
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)).tap()
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45),
                      "the session page's pill never showed the session's model (reads \(pill.exists ? pill.label : "absent"))")
        XCTAssertTrue(element(app, "chat.composer").exists, "no composer on the session page")
        try await stub.screenshot(app, "model-pill-14-session-page")
        let sessionAsks = { (records: [StubControl.Record], after: Date) in
            records.filter { $0.at > after && $0.path.hasSuffix("/sessions/sess-stub-lane/model-options") }
        }
        let sessionStreams = { (records: [StubControl.Record], after: Date) in
            records.filter { $0.at > after && $0.path.hasSuffix("/sessions/sess-stub-lane/stream") }
        }

        // Away on Inbox with the page still pushed on Tasks: past the TTL, through
        // two stream drops (the page closes its own stream once hidden, so these
        // find only the Chat tab's), and through a trip to the home screen, the
        // trigger that re-asks a composer on screen.
        let inbox = app.buttons["Inbox"]
        inbox.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { inbox.isSelected }, "the Inbox tab did not become selected")
        let leftAt = Date()
        try await Task.sleep(for: .seconds(12))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(30))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(20))
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        try await Task.sleep(for: .seconds(8))
        var records = try await stub.requests()
        let hidden = sessionAsks(records, leftAt)
        print("[evidence] session page hidden on Inbox \(Int(Date().timeIntervalSince(leftAt)))s, home and back: "
              + "\(sessionStreams(records, leftAt).count) session stream (re)connects, \(hidden.count) model asks")
        XCTAssertTrue(hidden.isEmpty, "the hidden session composer asked \(hidden.count) time(s) while on Inbox")
        try await stub.screenshot(app, "model-pill-14-inbox-over-session-page")

        // Back on Tasks: the page is on screen again, and its stale answer is asked once.
        let backAt = Date()
        tasksTab.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !sessionAsks((try? self.syncRequests(stub)) ?? [], backAt).isEmpty },
                      "coming back to the session page did not re-ask a stale answer")
        try await Task.sleep(for: .seconds(2))
        records = try await stub.requests()
        XCTAssertEqual(sessionAsks(records, backAt).count, 1, "coming back to the session page asked more than once")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 10))

        // Popped: the composer is gone, and nothing it armed may fire.
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no back button on the session page")
        back.tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !app.buttons["composer.modelPill"].exists || !self.element(app, "chat.composer").exists },
                      "the session page did not pop")
        let poppedAt = Date()
        try await Task.sleep(for: .seconds(8))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(48))
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        try await Task.sleep(for: .seconds(8))
        records = try await stub.requests()
        let afterPop = sessionAsks(records, poppedAt)
        print("[evidence] session page popped \(Int(Date().timeIntervalSince(poppedAt)))s, home and back: "
              + "\(afterPop.count) model asks for the session")
        XCTAssertTrue(afterPop.isEmpty, "the popped session page's composer asked \(afterPop.count) time(s)")
    }

    // MARK: - Scenario 9: the Mac goes away after a good answer (gate r2 D3)

    /// The gate: with the Mac away, the pill showed the raw catalog id
    /// ("global.anthropic.claude-fable-5-1[1m]") in place of the name it had a
    /// moment before, because the Retry state dropped the catalog the name came
    /// from. It keeps the name from the last good answer, and says it is last known.
    @MainActor
    func testAMacThatGoesAwayLeavesTheLastKnownNameOnThePill() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")

        try await stub.setEngine("unreachable")
        let before = try await stub.engineGets().count
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        XCTAssertTrue(
            waitUntil(timeout: 20) { ((try? self.syncEngineGets(stub).count) ?? 0) > before },
            "coming back to the app did not ask, so the Mac being away was never seen"
        )
        let lastKnown = "\(Self.healedLabel), last known"
        XCTAssertTrue(waitForLabel(pill, lastKnown, timeout: 20),
                      "the unreachable pill reads \(pill.exists ? pill.label : "absent"), not \(lastKnown)")
        XCTAssertFalse(pill.label.contains("global.anthropic"), "the pill shows a raw catalog id: \(pill.label)")
        // Its effort stays too, as last known (gate r3 UX note); the sheet offers
        // only Retry, so no level can be written while the Mac is away.
        XCTAssertTrue(waitForEffort(pill, "Effort: High, last known", timeout: 5),
                      "the pill's effort reads \(Self.effortValue(pill) ?? "none") with the Mac away")
        let quiet = Self.textContrast(of: pill)
        XCTAssertGreaterThanOrEqual(quiet, 4.5, "the last known name reads \(Self.fmt1(quiet)):1")
        print("[evidence] mac away after a good answer: pill reads \"\(pill.label)\", "
              + "effort \"\(Self.effortValue(pill) ?? "none")\" (text \(Self.fmt1(quiet)):1)")
        try await stub.screenshot(app, "model-pill-12-last-known-name")
        try await openMenu(app, pill)
        XCTAssertTrue(element(app, "composer.modelPill.retry").waitForExistence(timeout: 5),
                      "the unreachable pill's sheet offers no Retry")
        XCTAssertFalse(app.buttons["Haiku 4.5"].exists, "the unreachable sheet lists models it cannot write")
        XCTAssertFalse(element(app, "composer.modelSheet.effort").exists,
                       "the unreachable sheet offers levels it cannot write")
        try await stub.screenshot(app, "model-pill-12-last-known-menu")
        closeMenu(app)

        try await stub.setEngine("lane")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill did not heal once the Mac was back")
        XCTAssertTrue(waitForEffort(pill, Self.healedEffort, timeout: 10), "the effort did not come back live")
        XCTAssertTrue(pill.isEnabled)
        let writes = try await stub.writes()
        XCTAssertTrue(writes.isEmpty, "the Mac being away wrote \(writes.map(\.path))")
    }

    // MARK: - Driving the app

    @MainActor
    private func launchPaired(_ extra: [String] = []) throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner: run this through ios-native/tests/ui/run-ui-tests.sh "
                    + "with WALNUT_UITEST_SERVER pointed at a running tests/ui/mid-turn-stub-server.mjs"
            )
        }
        return (server, token)
    }

    @MainActor
    private func openChatTab(_ app: XCUIApplication) {
        let chat = app.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 60), "the tab bar never appeared")
        chat.tap()
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    /// Every helper that touches XCUI is `@MainActor`: a nonisolated async helper
    /// resumes on the cooperative pool after its first await, and the next XCUI
    /// call then raises `Must be called on the main thread` (measured: the first
    /// run of this file died exactly there, after the heal had already happened).
    ///
    /// A pill is a button, and `tap()` on it waits for hit-testability that a
    /// composer row inside a hosted cell does not always report; a synthesized
    /// touch at its centre is what a thumb is.
    ///
    /// The model pill opens its "Select model" sheet, which takes taps once it
    /// has settled (`PillMenuSheet.settleDelay`, 600ms); the mode pill opens a
    /// UIKit menu.
    @MainActor
    private func openMenu(_ app: XCUIApplication, _ pill: XCUIElement) async throws {
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "no pill to open")
        let isModelPill = pill.identifier == "composer.modelPill"
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        if isModelPill {
            _ = sheetClose(app).waitForExistence(timeout: 5)
            try await Task.sleep(for: .milliseconds(900))
        } else {
            try await Task.sleep(for: .milliseconds(800))
        }
    }

    @MainActor
    private func closeMenu(_ app: XCUIApplication) {
        if sheetIsUp(app) {
            closeSheet(app)
            return
        }
        // A tap beside the menu (its left margin, outside its width) dismisses it.
        // Never above it: the list can reach the top of the screen, and a tap
        // there would PICK a row.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.3)).tap()
        usleep(600_000)
    }

    /// The model sheet's close button (on its first page).
    @MainActor
    private func sheetClose(_ app: XCUIApplication) -> XCUIElement {
        element(app, "composer.modelSheet.close")
    }

    /// The "Select model" sheet is up, on either of its pages.
    @MainActor
    private func sheetIsUp(_ app: XCUIApplication) -> Bool {
        sheetClose(app).exists || app.navigationBars["Effort"].exists
    }

    /// Close the sheet the way a user does: its X (back from the Effort page
    /// first). A tap that lands before the sheet has settled is ignored, so the X
    /// is tapped again until the sheet is gone.
    @MainActor
    private func closeSheet(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let effortBar = app.navigationBars["Effort"]
        if effortBar.exists {
            effortBar.buttons.element(boundBy: 0).tap()
            usleep(700_000)
        }
        let close = sheetClose(app)
        for _ in 0..<3 where close.exists {
            close.tap()
            _ = waitUntil(timeout: 2) { !close.exists }
        }
        XCTAssertFalse(close.exists, "the sheet's X did not close it", file: file, line: line)
        // The sheet's slide down, before the composer takes taps again.
        usleep(500_000)
    }

    /// Scroll the open sheet until `target` is on screen and takes taps: a slow
    /// swipe on a row in the middle of what is in view (a row at an edge can be
    /// clipped to nothing). A swipe scrolls; it never picks a row.
    @MainActor
    private func scrollSheet(_ app: XCUIApplication, to target: XCUIElement, rows: [String]) async throws -> Bool {
        for _ in 0..<6 {
            if target.exists && target.isHittable { return true }
            let reachable = rows.filter { app.buttons[$0].exists && app.buttons[$0].isHittable }
            guard !reachable.isEmpty else { return false }
            app.buttons[reachable[reachable.count / 2]].swipeUp(velocity: .slow)
            try await Task.sleep(for: .seconds(1))
        }
        return target.exists && target.isHittable
    }

    /// From the sheet's first page, open the Effort page (scrolling to its row).
    @MainActor
    private func openEffortPage(
        _ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line
    ) async throws -> Bool {
        let row = element(app, "composer.modelSheet.effort")
        guard try await scrollSheet(app, to: row, rows: Self.macOrder) else {
            XCTFail("the sheet has no Effort row in reach", file: file, line: line)
            return false
        }
        row.tap()
        let opened = app.navigationBars["Effort"].waitForExistence(timeout: 5)
        XCTAssertTrue(opened, "the Effort row did not open the levels", file: file, line: line)
        // The push, before the levels take taps.
        try await Task.sleep(for: .milliseconds(700))
        return opened
    }

    /// What the Effort row on the sheet's first page says ("Effort" and its value).
    @MainActor
    private func effortRowText(_ app: XCUIApplication) -> String {
        let row = element(app, "composer.modelSheet.effort")
        guard row.exists else { return "" }
        return [row.label, (row.value as? String) ?? ""].joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    @MainActor
    private func assertMenuListsTheWholeCatalog(
        _ app: XCUIApplication, _ pill: XCUIElement, shot: String,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        try await openMenu(app, pill)
        XCTAssertTrue(app.navigationBars[Self.sheetTitle].waitForExistence(timeout: 5),
                      "the pill did not open the \"\(Self.sheetTitle)\" sheet", file: file, line: line)
        for row in Self.macOrder {
            XCTAssertTrue(
                app.buttons[row].waitForExistence(timeout: 5),
                "the healed sheet does not list \(row): it is still the one-row answer, or the rows "
                    + "are not spelled the way the Mac's picker spells them",
                file: file, line: line
            )
        }
        // The Mac's order, top to bottom, in one vertical list.
        let frames = Self.macOrder.map { app.buttons[$0].frame }
        let tops = frames.map(\.minY)
        XCTAssertEqual(
            tops, tops.sorted(),
            "the sheet's rows are not in the Mac's order: \(zip(Self.macOrder, tops).map { "\($0) @\(Int($1))" })",
            file: file, line: line
        )
        XCTAssertEqual(Set(frames.map { Int($0.minX) }).count, 1,
                       "the models are not one vertical list: \(frames.map(\.minX))", file: file, line: line)
        // Every name on ONE line at the default text size.
        let single = frames[Self.macOrder.firstIndex(of: "Sonnet 5")!].height
        for (row, frame) in zip(Self.macOrder, frames) {
            XCTAssertLessThan(frame.height, single * 1.25,
                              "\(row) is \(Int(frame.height))pt tall against \(Int(single))pt: it wrapped",
                              file: file, line: line)
        }
        // The current model carries the check (the selected trait), and only it.
        let checked = Self.macOrder.filter { app.buttons[$0].isSelected }
        XCTAssertEqual(checked, ["Fable 5.1 1M"], "the checked rows are \(checked)", file: file, line: line)
        // The levels are not rows of this list: one Effort row names the level.
        XCTAssertFalse(app.buttons["Extra High"].exists, "levels sit in the model list", file: file, line: line)
        XCTAssertTrue(effortRowText(app).contains("High"),
                      "the Effort row reads \"\(effortRowText(app))\"", file: file, line: line)
        try await stubUnderTest().screenshot(app, shot)
        closeMenu(app)
    }

    /// The pill names the effort, and the sheet's Effort row opens every level as
    /// one vertical list, low to high, the current one checked.
    @MainActor
    private func assertEffortPillOffersTheLevels(
        _ app: XCUIApplication, shot: String, file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForEffort(pill, Self.healedEffort, timeout: 5),
                      "the pill names no effort (value \(Self.effortValue(pill) ?? "none"))",
                      file: file, line: line)
        try await openMenu(app, pill)
        guard try await openEffortPage(app, file: file, line: line) else {
            closeMenu(app)
            return
        }
        assertTheLevelsAreOneList(app, checked: "High", tag: "healed", file: file, line: line)
        try await stubUnderTest().screenshot(app, shot)
        closeMenu(app)
    }

    /// On the Effort page: every level, top to bottom, low to high, in one column,
    /// and only `checked` carries the check (nil = none, the CLI's default).
    @MainActor
    private func assertTheLevelsAreOneList(
        _ app: XCUIApplication, checked: String?, tag: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        for level in Self.effortRows {
            XCTAssertTrue(app.buttons[level].waitForExistence(timeout: 5), "\(tag): the Effort page has no \(level)",
                          file: file, line: line)
        }
        let frames = Self.effortRows.map { app.buttons[$0].frame }
        let column = zip(frames, frames.dropFirst()).allSatisfy { a, b in
            b.minY >= a.maxY - 1 && abs(b.minX - a.minX) <= 1
        }
        XCTAssertTrue(column, "\(tag): the levels are not one list, low to high: "
                      + "\(zip(Self.effortRows, frames).map { "\($0) @\(Int($1.minX)),\(Int($1.minY))" })",
                      file: file, line: line)
        let marked = Self.effortRows.filter { app.buttons[$0].isSelected }
        XCTAssertEqual(marked, checked.map { [$0] } ?? [], "\(tag): the checked levels are \(marked)",
                       file: file, line: line)
        print("[evidence] \(tag): the Effort page lists \(Self.effortRows) in one column, checked \(marked)")
    }

    /// The pill's effort half, as VoiceOver reads it after the name. nil = none.
    @MainActor
    private static func effortValue(_ pill: XCUIElement) -> String? {
        guard pill.exists, let value = pill.value as? String, !value.isEmpty else { return nil }
        return value
    }

    @MainActor
    private func waitForEffort(_ pill: XCUIElement, _ value: String?, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { pill.exists && Self.effortValue(pill) == value }
    }

    @MainActor
    private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { element.exists && element.label == label }
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }

    private static func fmt1(_ value: Double) -> String { String(format: "%.2f", value) }

    /// The contrast of a pill's drawn text against its own capsule, off a real
    /// screenshot: the capsule is the commonest colour in the text band, the ink
    /// the pixel furthest from it. The band skips the left of the pill, where the
    /// spinner sits while a pick is written.
    @MainActor
    private static func textContrast(of element: XCUIElement) -> Double {
        guard case let (pixels, width, height)? = bitmap(of: element) else { return 0 }
        func luminance(_ i: Int) -> Double {
            func channel(_ v: UInt8) -> Double {
                let c = Double(v) / 255
                return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(pixels[i]) + 0.7152 * channel(pixels[i + 1]) + 0.0722 * channel(pixels[i + 2])
        }
        var counts: [Int: Int] = [:]
        var band: [Int] = []
        for y in Int(Double(height) * 0.25)..<Int(Double(height) * 0.75) {
            for x in Int(Double(width) * 0.45)..<Int(Double(width) * 0.92) {
                let i = (y * width + x) * 4
                band.append(i)
                let key = (Int(pixels[i]) >> 3) << 10 | (Int(pixels[i + 1]) >> 3) << 5 | Int(pixels[i + 2]) >> 3
                counts[key, default: 0] += 1
            }
        }
        guard let common = counts.max(by: { $0.value < $1.value })?.key,
              let backgroundIndex = band.first(where: { i in
                  ((Int(pixels[i]) >> 3) << 10 | (Int(pixels[i + 1]) >> 3) << 5 | Int(pixels[i + 2]) >> 3) == common
              })
        else { return 0 }
        let background = luminance(backgroundIndex)
        let ink = band.map(luminance).max { abs($0 - background) < abs($1 - background) } ?? background
        return (max(ink, background) + 0.05) / (min(ink, background) + 0.05)
    }

    /// An element's screenshot as RGBA bytes, top row first.
    @MainActor
    private static func bitmap(of element: XCUIElement) -> (pixels: [UInt8], width: Int, height: Int)? {
        guard let image = element.screenshot().image.cgImage else { return nil }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return (pixels, width, height)
    }

    /// The chip a pill draws inside its button: its height, and whether a point
    /// 6pt in from its top left corner is filled (a 14pt rounded rectangle) or
    /// outside it (a capsule taller than about 30pt). Its top and bottom are the
    /// first and last rows of the middle column that differ from the corner of
    /// the button, which is outside the chip either way.
    @MainActor
    private static func drawnChip(of element: XCUIElement)
        -> (height: CGFloat, cornerFilled: Bool, corner: [Int], fill: [Int], outside: [Int])? {
        guard case let (pixels, width, height)? = bitmap(of: element), element.frame.width > 0 else { return nil }
        let scale = Double(width) / element.frame.width
        func rgb(_ x: Int, _ y: Int) -> [Int] {
            let i = (y * width + x) * 4
            return [Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2])]
        }
        func differs(_ a: [Int], _ b: [Int]) -> Bool { zip(a, b).contains { abs($0 - $1) > 6 } }
        let outside = rgb(0, 0)
        let rows = (0..<height).filter { differs(rgb(width / 2, $0), outside) }
        guard let top = rows.first, let bottom = rows.last else { return nil }
        let x = Int(6 * scale)
        let corner = rgb(x, min(bottom, top + Int(6 * scale)))
        let fill = rgb(x, (top + bottom) / 2)
        return (Double(bottom - top + 1) / scale, differs(fill, outside) && !differs(corner, fill), corner, fill, outside)
    }

    private static func fmt(_ gaps: [TimeInterval]) -> String {
        gaps.map { String(format: "%.1fs", $0) }.joined(separator: ", ")
    }

    // MARK: - The stub

    private func stubUnderTest() async throws -> StubControl {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StubControl(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip(
                "\(server) is not the UI stub (no /__stub/state: \(error)). Start "
                    + "ios-native/tests/ui/mid-turn-stub-server.mjs and point WALNUT_UITEST_SERVER at it; "
                    + "this test never runs against a real Walnut."
            )
        }
        return stub
    }

    private func syncEngineGets(_ stub: StubControl) throws -> [StubControl.Record] {
        try syncRequests(stub).filter { $0.method == "GET" && $0.path == "/api/v1/chat/engine" }
    }

    private func syncWrites(_ stub: StubControl) throws -> [StubControl.Record] {
        try syncRequests(stub).filter {
            $0.method == "POST" && $0.path.hasPrefix("/api/v1/sessions/")
                && ($0.path.hasSuffix("/model") || $0.path.hasSuffix("/effort"))
        }
    }

    /// Synchronous read for a polling predicate (the XCUITest wait loop is sync).
    private func syncRequests(_ stub: StubControl) throws -> [StubControl.Record] {
        var result: [StubControl.Record] = []
        var failure: Error?
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do { result = try await stub.requests() } catch { failure = error }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 10)
        if let failure { throw failure }
        return result
    }

    struct StubControl: Sendable {
        let base: URL

        struct Record: Decodable {
            let seq: Int
            let at: Date
            let method: String
            let path: String
            /// The value a model write carried (the stub records it).
            let model: String?
        }

        @discardableResult
        func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL \(path)"])
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            if let body {
                request.httpBody = body
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw NSError(domain: "stub", code: code, userInfo: [
                    NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)",
                ])
            }
            return data
        }

        func reset() async throws { try await call("POST", "__stub/reset") }

        /// The lane session's current model and effort as the Mac reports them
        /// (`effort: "none"` = the session reports no effort).
        func setLane(model: String? = nil, effort: String? = nil) async throws {
            var query: [String] = []
            if let model { query.append("model=\(model.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? model)") }
            if let effort { query.append("effort=\(effort)") }
            try await call("POST", "__stub/lane?\(query.joined(separator: "&"))")
        }

        func dropStreams() async throws { try await call("POST", "__stub/drop-streams") }

        /// The lane session's model and effort writes this generation.
        func writes() async throws -> [Record] {
            try await requests().filter {
                $0.method == "POST" && $0.path.hasPrefix("/api/v1/sessions/")
                    && ($0.path.hasSuffix("/model") || $0.path.hasSuffix("/effort"))
            }
        }

        func setEngine(_ mode: String, model: String? = nil) async throws {
            let suffix = model.map { "&model=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
            try await call("POST", "__stub/engine?mode=\(mode)\(suffix)")
        }

        func requests() async throws -> [Record] {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom { decoder in
                let raw = try decoder.singleValueContainer().decode(String.self)
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let date = parser.date(from: raw) else {
                    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
                }
                return date
            }
            return try decoder.decode([Record].self, from: try await call("GET", "__stub/requests"))
        }

        /// Every `GET /chat/engine` the app made this generation, in order.
        func engineGets() async throws -> [Record] {
            try await requests().filter { $0.method == "GET" && $0.path == "/api/v1/chat/engine" }
        }

        /// On the main actor: every XCUI call (the screenshot included) raises
        /// `must be called on the main thread` from anywhere else, and a
        /// nonisolated async helper resumes on the cooperative pool.
        @MainActor
        func screenshot(_ app: XCUIApplication, _ name: String) async throws {
            let shot = app.screenshot()
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
            try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        }
    }
}
