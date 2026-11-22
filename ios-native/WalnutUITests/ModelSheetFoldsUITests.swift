import XCTest

/// THE MODEL SHEET'S COST, SPEED AND DETAILS, driven as a finger drives them (design
/// v2, the user, 2026-11-21: model on the left, effort on the right, and under them
/// "Cost $102", "Speed 128 tok/s avg", "Details", each opening its own page; the Speed
/// page's average and turn table as design A draws them).
///
/// The box is `tests/ui/mid-turn-stub-server.mjs` with the chat on the Mac's lane
/// session: its record carries the last turn's speed (137 tokens in 573 ms on
/// GPT-6.1 Sol, 239 tok/s), the session's average on Fable 5.1 (12,800 tokens over
/// 100 s in 42 turns, 128 tok/s) and a context 93% full, and its cost route answers
/// $102.31 with no budget. `POST /__stub/model-sheet?cost=missing` makes the cost
/// route 404, as a server older than it does.
///
/// An extension of `ModelPillHealUITests` for its helpers (launch, sheet open and
/// close, the stub). RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh` and the stub
/// running; a bare `xcodebuild` skips it.
extension ModelPillHealUITests {

    @MainActor
    func testTheSheetShowsCostSpeedAndDetailsUnderTheTwoColumns() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed \(Self.healedLabel)")
        try await openMenu(app, pill)
        XCTAssertTrue(app.navigationBars[Self.sheetTitle].waitForExistence(timeout: 5), "no \(Self.sheetTitle) sheet")

        // The two columns: the models with the current one checked, the levels beside them.
        XCTAssertTrue(app.buttons["Fable 5.1 1M"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Fable 5.1 1M"].isSelected, "the current model is not checked")
        let levelsInReach = try await effortColumnInReach(app)
        XCTAssertTrue(levelsInReach)
        assertTheLevelsAreOneList(app, checked: "High", besideModels: true, tag: "folds")

        // The three rows, with their numbers once the answers land.
        let cost = element(app, "composer.modelSheet.cost")
        let speed = element(app, "composer.modelSheet.speed")
        let details = element(app, "composer.modelSheet.details")
        XCTAssertTrue(cost.waitForExistence(timeout: 5), "no Cost row under the columns")
        revealInList(app, details)
        XCTAssertTrue(waitUntil(timeout: 10) { Self.value(cost) == "$102" }, "the Cost row reads \(Self.value(cost))")
        XCTAssertTrue(waitUntil(timeout: 10) { Self.value(speed) == "128 tok/s avg" }, "the Speed row reads \(Self.value(speed))")
        XCTAssertTrue(waitUntil(timeout: 10) { details.label.contains("Context 93% full") },
                      "the Details row carries no context dot (label \"\(details.label)\")")
        XCTAssertFalse(cost.label.contains("paused"), "a Cost dot with no budget: \(cost.label)")
        try await stub.screenshot(app, "model-sheet-01-columns-and-rows")

        // Each row opens its page, and Back returns to the choices.
        try await openPage(app, cost, "Cost")
        XCTAssertEqual(staticText(app, "composer.modelSheet.costTotal"), "$102")
        XCTAssertTrue(app.staticTexts["1d 17h"].exists, "the Cost page names no span")
        XCTAssertTrue(app.staticTexts["1h 6m"].exists, "the Cost page names no model time")
        XCTAssertTrue(app.staticTexts["Fable 5.1"].exists, "the Cost page names no model")
        XCTAssertTrue(app.staticTexts["1052 requests · $102.31"].exists, "the Cost page's model line")
        XCTAssertEqual(staticText(app, "composer.modelSheet.budget"), "No budget")
        try await stub.screenshot(app, "model-sheet-02-cost-page")
        try await back(app, from: "Cost")

        try await openPage(app, speed, "Speed")
        // Design A: the session's average in its own group, then the turn as a table row.
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedAverage"), "128 tok/s")
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedTurns"), "42 on Fable 5.1 1M")
        // The note is longer than an XCUI query string may be (128 characters): match its start.
        let note = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@",
            "Output tokens per second of model generation, averaged over this session's turns on this model")).firstMatch
        XCTAssertTrue(note.exists, "the Speed page does not say what the average covers")
        XCTAssertTrue(note.label.hasSuffix("(thinking counted; tool waits and time to first token not)."), "the Speed note reads \(note.label)")
        // One label by the row's state (the record's turn is final), the "last call" scope kept.
        let turnRow = app.descendants(matching: .any)["composer.modelSheet.speedRow.0"]
        XCTAssertTrue(turnRow.waitForExistence(timeout: 5), "the Speed page has no turn row")
        XCTAssertEqual(turnRow.label, "Last turn, GPT-6.1 Sol, last call")
        XCTAssertFalse(app.staticTexts["This turn"].exists, "a final turn is named Last turn only")
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedRow.0.0"), "Tokens 137")
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedRow.0.1"), "First token 2.6s")
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedRow.0.2"), "Speed 239 tok/s")
        XCTAssertEqual(staticText(app, "composer.modelSheet.speedRow.0.3"), "Time 53s")
        try await stub.screenshot(app, "model-sheet-03-speed-page")
        try await back(app, from: "Speed")

        try await openPage(app, details, "Details")
        XCTAssertEqual(staticText(app, "composer.modelSheet.contextValue"), "767.6K / 828.4K (93%)")
        XCTAssertTrue(app.staticTexts["Claude Code"].exists, "the Details page names no engine")
        XCTAssertTrue(app.staticTexts["Bypass"].exists, "the Details page names no mode")
        try await stub.screenshot(app, "model-sheet-04-details-page")
        try await back(app, from: "Details")

        // Looking wrote nothing; one pick of a level writes it and closes the sheet.
        let looked = try await stub.writes()
        XCTAssertTrue(looked.isEmpty, "opening the pages wrote \(looked.map(\.path))")
        let max = app.buttons["Max"]
        XCTAssertTrue(revealInList(app, max), "the Max level is out of reach")
        max.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !self.sheetIsUp(app) }, "a pick did not close the sheet")
        XCTAssertTrue(waitUntil(timeout: 10) { ((try? self.syncWrites(stub)) ?? []).count == 1 },
                      "the pick was not written once")
        let wrote = try await stub.writes().map(\.path)
        XCTAssertEqual(wrote, ["/api/v1/sessions/sess-stub-lane/effort"], "the pick wrote \(wrote)")
        app.terminate()
    }

    /// A server older than the cost route: the Cost row reads "n/a" and its page
    /// says why, with no error alert; the other rows still fill.
    @MainActor
    func testWithNoCostRouteTheCostRowReadsNotAvailable() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.call("POST", "__stub/model-sheet?cost=missing")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45))
        try await openMenu(app, pill)
        let cost = element(app, "composer.modelSheet.cost")
        let speed = element(app, "composer.modelSheet.speed")
        XCTAssertTrue(cost.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil(timeout: 10) { Self.value(cost) == "n/a" }, "the Cost row reads \(Self.value(cost))")
        XCTAssertTrue(waitUntil(timeout: 10) { Self.value(speed) == "128 tok/s avg" }, "the Speed row reads \(Self.value(speed))")
        XCTAssertFalse(app.alerts.firstMatch.exists, "a missing cost route raised an alert")
        try await stub.screenshot(app, "model-sheet-05-no-cost-route")
        try await openPage(app, cost, "Cost")
        XCTAssertEqual(staticText(app, "composer.modelSheet.costTotal"), "Not available")
        try await stub.screenshot(app, "model-sheet-06-no-cost-route-page")
        closeSheet(app)
        app.terminate()
    }

    // MARK: - Helpers

    /// What a fold row says after its name ("$102"), as VoiceOver reads it.
    @MainActor
    static func value(_ row: XCUIElement) -> String {
        guard row.exists else { return "absent" }
        return (row.value as? String) ?? ""
    }

    @MainActor
    private func staticText(_ app: XCUIApplication, _ identifier: String) -> String {
        let text = app.staticTexts[identifier]
        return text.waitForExistence(timeout: 5) ? text.label : "absent"
    }

    @MainActor
    private func openPage(_ app: XCUIApplication, _ row: XCUIElement, _ title: String,
                          file: StaticString = #filePath, line: UInt = #line) async throws {
        XCTAssertTrue(revealInList(app, row), "the \(title) row is out of reach", file: file, line: line)
        row.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), "the \(title) row opened no page",
                      file: file, line: line)
        // The push, before the page's values are read.
        try await Task.sleep(for: .milliseconds(700))
    }

    @MainActor
    private func back(_ app: XCUIApplication, from title: String,
                      file: StaticString = #filePath, line: UInt = #line) async throws {
        app.navigationBars[title].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars[Self.sheetTitle].waitForExistence(timeout: 5),
                      "Back from \(title) did not return to the choices", file: file, line: line)
        try await Task.sleep(for: .milliseconds(700))
    }
}
