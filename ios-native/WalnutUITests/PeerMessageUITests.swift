import XCTest

final class PeerMessageUITests: XCTestCase {
    private struct State: Decodable {
        struct Request: Decodable { let method: String; let path: String; let scenario: String; let status: Int?; let at: Double }
        let sessionId: String
        let taskId: String
        struct Sent: Decodable { let text: String; let messageId: String }
        let requests: [Request]
        let sent: [Sent]
    }
    private var server = ""
    private var token = ""
    private var state: State!
    private var currentApp: XCUIApplication?

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        server = UITestLaunch.pairedServer(try XCTUnwrap(env["WALNUT_UITEST_SERVER"]))
        token = try XCTUnwrap(env["WALNUT_UITEST_TOKEN"])
        let url = try XCTUnwrap(URL(string: server))
        guard url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let port = url.port, ![3456, 3457].contains(port) else {
            throw NSError(domain: "PeerMessageUITests", code: 1)
        }
        state = try JSONDecoder().decode(State.self, from: request("state"))
        _ = try request("fault?on=0", method: "POST")
        _ = try request("missing?on=0", method: "POST")
        _ = try request("send-fault?on=0", method: "POST")
        _ = try request("legacy?on=0", method: "POST")
    }

    override func tearDown() {
        if let app = currentApp {
            let attachment = XCTAttachment(string: app.debugDescription)
            attachment.name = "final-hierarchy"; attachment.lifetime = .keepAlways; add(attachment)
        }
        _ = try? request("fault?on=0", method: "POST")
        _ = try? request("missing?on=0", method: "POST")
        _ = try? request("send-fault?on=0", method: "POST")
        _ = try? request("legacy?on=0", method: "POST")
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor private func open(_ scenario: String, accessible: Bool = false) throws -> XCUIApplication {
        _ = try request("scenario?name=" + scenario, method: "POST")
        var arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token]
        if accessible { arguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        let app = UITestLaunch.app(arguments)
        app.launch()
        currentApp = app
        try enterSession(app)
        return app
    }

    @MainActor private func enterSession(_ app: XCUIApplication) throws {
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30)); tasks.tap()
        let scrim = element(app, "tasks.drawer.scrim")
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 15)); menu.tap()
        }
        let row = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH 'board.row.' AND identifier CONTAINS %@", state.taskId)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 25))
        XCTAssertTrue(row.isHittable); row.tap()
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 25))
    }

    /// Shows what Walnut added to one person's message: a long press on the bubble's
    /// padding (the text view takes a press on the words for selection), then its item.
    @MainActor private func revealWalnutAdded(_ app: XCUIApplication, bubble words: String, count: Int) throws {
        let text = app.textViews.matching(NSPredicate(format: "value CONTAINS %@", words)).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 10), words)
        text.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: -6))
            .press(forDuration: 1)
        let item = app.buttons["Show what Walnut added (\(count))"]
        XCTAssertTrue(item.waitForExistence(timeout: 10)); item.tap()
    }

    @MainActor private func descriptions(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: "chat.peerMessage")
    }

    @MainActor private func checkPrivateTextIsAbsent(_ app: XCUIApplication) {
        let tree = app.debugDescription
        XCTAssertFalse(tree.contains("INTERNAL_BODY"))
        XCTAssertFalse(tree.contains("PRIVATE_REQUEST"))
        XCTAssertFalse(tree.contains("<walnut-message"))
        XCTAssertFalse(tree.contains("Reply when done:"))
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) throws {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        _ = try request("shot?name=" + name, method: "POST", body: shot.pngRepresentation)
    }

    @MainActor func testLongReplyHasNoTapExpansionAcrossReentryAndRefresh() throws {
        let app = try open("long")
        let description = descriptions(app).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 20))
        XCTAssertEqual(description.label, "Build checks: Checks passed; release pending")
        XCTAssertFalse(app.buttons.matching(identifier: "chat.peerMessage").firstMatch.exists)
        checkPrivateTextIsAbsent(app)
        let frame = description.frame
        for _ in 0..<3 {
            description.tap()
            XCTAssertEqual(description.frame.height, frame.height, accuracy: 1)
            checkPrivateTextIsAbsent(app)
        }
        description.press(forDuration: 1.2)
        XCTAssertFalse(app.menuItems.firstMatch.exists)
        XCTAssertEqual(description.frame.height, frame.height, accuracy: 1)
        checkPrivateTextIsAbsent(app)
        try capture(app, "long-after-taps")
        _ = try request("scenario?name=updated", method: "POST")
        try pullToRefresh(app)
        XCTAssertTrue(descriptions(app).matching(NSPredicate(format: "label CONTAINS 'Updated after refresh'")).firstMatch.waitForExistence(timeout: 20))
        checkPrivateTextIsAbsent(app)
        try capture(app, "long-refreshed")
        app.terminate(); app.launch()
        try enterSession(app)
        XCTAssertTrue(description.waitForExistence(timeout: 20))
        checkPrivateTextIsAbsent(app)
        try capture(app, "long-reentered")
    }

    @MainActor func testMixedHumanSummaryAndAllKindsRemainSeparate() throws {
        let app = try open("mixed")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Human summary before'")).firstMatch.exists)
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Human summary after'")).firstMatch.exists)
        checkPrivateTextIsAbsent(app); try capture(app, "mixed-human")
        app.terminate()
        let kindsApp = try open("kinds")
        XCTAssertTrue(descriptions(kindsApp).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(descriptions(kindsApp).count, 5)
        checkPrivateTextIsAbsent(kindsApp); try capture(kindsApp, "all-kinds")
    }

    @MainActor func testMissingTitleAndIncompletePayloadStayShortAtAccessibleSize() throws {
        let app = try open("fallback", accessible: true)
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(descriptions(app).firstMatch.label, "A task: Task reply")
        checkPrivateTextIsAbsent(app); try capture(app, "fallback-accessible")
        app.terminate()
        let partial = try open("partial")
        XCTAssertTrue(descriptions(partial).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(descriptions(partial).firstMatch.label, "Build checks: Still arriving")
        checkPrivateTextIsAbsent(partial); try capture(partial, "partial")
    }

    @MainActor func testNormalUserAssistantAndToolDetailStillWork() throws {
        let app = try open("regression")
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Normal user message.'")).firstMatch
            .waitForExistence(timeout: 20))
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Normal assistant response.'")).firstMatch.exists)
        // The delivery came in mid-work, after the call: it merges with that step, as on the web.
        let merged = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Received 1 message' AND label CONTAINS 'Ran 1 tool'")).firstMatch
        XCTAssertTrue(merged.waitForExistence(timeout: 10)); merged.tap()
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(descriptions(app).firstMatch.label, "Build checks: Final update")
        checkPrivateTextIsAbsent(app)
        let run = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ran a command'")).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 10)); run.tap()
        let tool = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Bash'")).firstMatch
        XCTAssertTrue(tool.waitForExistence(timeout: 10)); tool.tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForExistence(timeout: 10))
        try capture(app, "tool-detail-regression")
    }

    @MainActor func testDenseTranscriptAndRepeatedArrivalsNeverExposePayload() throws {
        let app = try open("dense")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        let timeline = app.collectionViews.firstMatch
        XCTAssertTrue(timeline.exists)
        for _ in 0..<8 {
            timeline.swipeDown()
            checkPrivateTextIsAbsent(app)
        }
        try capture(app, "dense-top")
        for _ in 0..<8 {
            timeline.swipeUp()
            checkPrivateTextIsAbsent(app)
        }
        try capture(app, "dense-bottom")
        for _ in 0..<3 {
            _ = try request("arrive", method: "POST")
            XCTAssertTrue(descriptions(app).matching(NSPredicate(format: "label CONTAINS 'Updated after refresh'")).firstMatch.waitForExistence(timeout: 20))
            checkPrivateTextIsAbsent(app)
        }
        try capture(app, "repeated-arrivals")
    }

    @MainActor func testTranscriptFailureAndMissingObjectRecoverThroughRefresh() throws {
        let app = try open("long")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        for fault in ["fault", "missing"] {
            _ = try request(fault + "?on=1", method: "POST")
            try pullToRefresh(app)
            let state = try JSONDecoder().decode(State.self, from: request("state"))
            XCTAssertTrue(state.requests.contains { $0.path.hasSuffix("/transcript") && $0.status == (fault == "fault" ? 503 : 404) })
            checkPrivateTextIsAbsent(app)
            try capture(app, fault + "-active")
            _ = try request(fault + "?on=0", method: "POST")
            _ = try request("scenario?name=updated", method: "POST")
            try pullToRefresh(app)
            XCTAssertTrue(descriptions(app).matching(NSPredicate(format: "label CONTAINS 'Updated after refresh'")).firstMatch.waitForExistence(timeout: 20))
            checkPrivateTextIsAbsent(app)
            try capture(app, fault + "-recovered")
        }
    }

    @MainActor func testLongTitleRemainsReadableAtAccessibleSize() throws {
        let app = try open("longtitle", accessible: true)
        let description = descriptions(app).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 20))
        XCTAssertTrue(description.label.contains("A longer description"))
        XCTAssertFalse(app.buttons.matching(identifier: "chat.peerMessage").firstMatch.exists)
        checkPrivateTextIsAbsent(app)
        try capture(app, "long-title-accessible-bottom")
        app.collectionViews.firstMatch.swipeDown()
        app.collectionViews.firstMatch.swipeDown()
        checkPrivateTextIsAbsent(app)
        try capture(app, "long-title-accessible-top")
    }

    @MainActor func testNormalSendFailureAndRetryRemainAvailableBesideDescriptions() throws {
        let app = try open("long")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        _ = try request("send-fault?on=1", method: "POST")
        let composer = element(app, "chat.composer")
        composer.tap(); composer.typeText("Normal retry message.")
        app.buttons["chat.send"].tap()
        let failed = app.textViews.matching(NSPredicate(format: "value CONTAINS 'Normal retry message.'")).firstMatch
        XCTAssertTrue(failed.waitForExistence(timeout: 20))
        failed.press(forDuration: 1.2)
        let retry = app.buttons["Retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        _ = try request("send-fault?on=0", method: "POST")
        retry.tap()
        let accepted = NSPredicate { _, _ in
            guard let data = try? self.request("state"), let state = try? JSONDecoder().decode(State.self, from: data) else { return false }
            return state.sent.filter { $0.text == "Normal retry message." }.count == 1
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: accepted, object: nil)], timeout: 20), .completed)
        checkPrivateTextIsAbsent(app)
        try capture(app, "normal-send-retried")
    }

    @MainActor func testImageCaptionAfterDescriptionKeepsItsImageRow() throws {
        let app = try open("image")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Normal image caption'")).firstMatch.waitForExistence(timeout: 20))
        let loaded = NSPredicate { _, _ in
            guard let data = try? self.request("state"), let state = try? JSONDecoder().decode(State.self, from: data) else { return false }
            return state.requests.contains { $0.path == "/api/v1/media" }
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: loaded, object: nil)], timeout: 20), .completed)
        checkPrivateTextIsAbsent(app)
        try capture(app, "image-caption-regression")
    }

    // An older server says nothing about who sent a row: the same descriptions, the old way.
    @MainActor func testAnOlderServerWithoutSendersShowsTheSameDescriptions() throws {
        _ = try request("legacy?on=1", method: "POST")
        let app = try open("kinds")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(descriptions(app).count, 5)
        checkPrivateTextIsAbsent(app); try capture(app, "legacy-all-kinds")
    }

    // The received reply that started work reads above the fold of that work, with
    // nothing to open; the fold opens to its steps, never to the message's body.
    @MainActor func testAReceivedMessageThatStartedWorkMergesWithItsSteps() throws {
        let app = try open("turn")
        // One row for the message and the call it led to, as on the web; the answer below it.
        let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Received 1 message'")).firstMatch
        XCTAssertTrue(fold.waitForExistence(timeout: 20))
        XCTAssertTrue(fold.label.contains("Ran 1 tool"), fold.label)
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'The release is ready.'")).firstMatch.exists)
        XCTAssertEqual(descriptions(app).count, 0)
        checkPrivateTextIsAbsent(app); try capture(app, "turn-closed")
        fold.tap()
        // Opened: the message's one line, then the call; the line itself opens nothing.
        let description = descriptions(app).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 10))
        XCTAssertEqual(description.label, "Build checks: Checks passed; release pending")
        XCTAssertEqual(descriptions(app).count, 1)
        // The call is its own folded run inside, as on the web; it opens to the chip.
        let run = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ran a command'")).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 10))
        XCTAssertLessThan(description.frame.maxY, run.frame.minY + 0.5)
        run.tap()
        let call = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Bash'")).firstMatch
        XCTAssertTrue(call.waitForExistence(timeout: 10))
        checkPrivateTextIsAbsent(app); try capture(app, "turn-opened")
        description.tap()
        XCTAssertEqual(descriptions(app).count, 1)
        checkPrivateTextIsAbsent(app)
    }

    /// Rows as Walnut really writes them: a note in front of a person's words, a hidden turn that
    /// merges with the next quiet message (a shape this build cannot read), an untitled notice and
    /// routine, and a message merged with a send.
    @MainActor func testShapesWithoutATitleOrAFoldOfTheirOwnReadAsOneLine() throws {
        let app = try open("shapes")
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        // The list may not fit one screen: each line is looked for, scrolling down as needed.
        let timeline = app.collectionViews.firstMatch
        for _ in 0..<3 { timeline.swipeDown() }
        // Walnut's note in front of the person's words is hidden until the bubble asks for it.
        XCTAssertFalse(descriptions(app).matching(NSPredicate(format: "label == 'Walnut: Task moved'")).firstMatch.exists)
        try revealWalnutAdded(app, bubble: "Please draft the notes.", count: 1)
        for label in ["Walnut: Task moved", "Docs lead: Completed",
                      "Walnut: wait until: the time this task was waiting for has passed"] {
            let line = descriptions(app).matching(NSPredicate(format: "label == %@", label)).firstMatch
            for _ in 0..<3 where !line.exists { timeline.swipeUp() }
            XCTAssertTrue(line.waitForExistence(timeout: 5), label)
        }
        for _ in 0..<3 { timeline.swipeUp() }
        XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS 'Please draft the notes.'")).firstMatch.exists)
        // A received message with nothing beside it is never a fold of its own.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Received 1 message,'")).firstMatch.exists)
        checkPrivateTextIsAbsent(app); try capture(app, "shapes-closed")
        // The hidden turn and the unreadable shape after it are one quiet row.
        let hidden = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Received 2 messages'")).firstMatch
        for _ in 0..<3 where !hidden.waitForExistence(timeout: 3) { timeline.swipeDown() }
        XCTAssertTrue(hidden.waitForExistence(timeout: 10)); hidden.tap()
        let ping = descriptions(app).matching(NSPredicate(format: "label == 'Build checks: Hidden ping'")).firstMatch
        XCTAssertTrue(ping.waitForExistence(timeout: 10))
        let odd = descriptions(app).matching(NSPredicate(format: "label == 'Walnut: Message received'")).firstMatch
        for _ in 0..<3 where !odd.waitForExistence(timeout: 3) { timeline.swipeUp() }
        XCTAssertTrue(odd.waitForExistence(timeout: 10))
        let merged = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Received 1 message' AND label CONTAINS 'Sent 1'")).firstMatch
        for _ in 0..<4 where !merged.waitForExistence(timeout: 3) { timeline.swipeUp() }
        XCTAssertTrue(merged.waitForExistence(timeout: 10)); merged.tap()
        // The opened hidden turn pushed the merged row to the bottom: its line may sit below the screen.
        let confirm = descriptions(app).matching(NSPredicate(format: "label == 'Build checks: Please confirm the date'")).firstMatch
        for _ in 0..<4 where !confirm.waitForExistence(timeout: 5) { timeline.swipeUp() }
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'mcp__'")).firstMatch.exists)
        checkPrivateTextIsAbsent(app); try capture(app, "shapes-opened")
        // The line opens nothing: it stays itself and no body appears.
        confirm.tap()
        XCTAssertTrue(confirm.exists)
        XCTAssertEqual(confirm.label, "Build checks: Please confirm the date")
        checkPrivateTextIsAbsent(app)
    }

    @MainActor func testShapesStayOneLineEachAtAccessibleSize() throws {
        let app = try open("shapes", accessible: true)
        // At this size the last screen holds only the merged row and the answer, no description.
        let answer = app.textViews.matching(NSPredicate(format: "value CONTAINS 'Confirmed the date.'")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 20))
        checkPrivateTextIsAbsent(app); try capture(app, "shapes-accessible-bottom")
        let list = app.collectionViews.firstMatch
        let words = app.textViews.matching(NSPredicate(format: "value CONTAINS 'Please draft the notes.'")).firstMatch
        for _ in 0..<12 where !words.waitForExistence(timeout: 3) { list.swipeDown() }
        try revealWalnutAdded(app, bubble: "Please draft the notes.", count: 1)
        let rider = descriptions(app).matching(NSPredicate(format: "label == 'Walnut: Task moved'")).firstMatch
        for _ in 0..<4 where !rider.waitForExistence(timeout: 3) { list.swipeDown() }
        XCTAssertTrue(rider.waitForExistence(timeout: 10))
        checkPrivateTextIsAbsent(app); try capture(app, "shapes-accessible-top")
    }

    @MainActor func testDenseLastRowIsFullyVisibleAtAccessibleSize() throws {
        let app = try open("dense", accessible: true)
        let last = descriptions(app).matching(NSPredicate(format: "label == 'Build checks: Round 79 update'")).firstMatch
        XCTAssertTrue(descriptions(app).firstMatch.waitForExistence(timeout: 20))
        let timeline = app.collectionViews.firstMatch
        let composer = element(app, "chat.composer")
        let settled = NSPredicate { _, _ in
            last.exists && last.isHittable && last.frame.minY >= timeline.frame.minY
                && last.frame.maxY <= min(timeline.frame.maxY, composer.frame.minY) + 0.5
        }
        for _ in 0..<16 where !settled.evaluate(with: nil) { timeline.swipeUp() }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 15), .completed,
                       "Last row \(last.frame) outside timeline \(timeline.frame) above composer \(composer.frame)")
        checkPrivateTextIsAbsent(app)
        try capture(app, "dense-accessible-last-row")
    }

    // The production stream pings every 25 s and the client's watchdog reconnects after 50 s of silence,
    // so an arrival is only proven on a stream that has really been idle past that boundary.
    @MainActor func testArrivalAfterStreamIdlePastWatchdogUpdatesDescription() throws {
        let app = try open("long")
        let description = descriptions(app).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 20))
        let streamPath = "/api/v1/sessions/\(state.sessionId)/stream"
        let attached = try XCTUnwrap(try JSONDecoder().decode(State.self, from: request("state")).requests
            .filter { $0.path == streamPath && $0.scenario == "long" }.map(\.at).max())
        let idle = 55 - (Date().timeIntervalSince1970 - attached / 1000)
        if idle > 0 { _ = XCTWaiter.wait(for: [XCTestExpectation(description: "idle stream")], timeout: idle) }
        _ = try request("arrive", method: "POST")
        let arrivedAt = Date().timeIntervalSince1970 * 1000
        XCTAssertTrue(descriptions(app).matching(NSPredicate(format: "label CONTAINS 'Updated after refresh'")).firstMatch.waitForExistence(timeout: 20))
        let requests = try JSONDecoder().decode(State.self, from: request("state")).requests
        XCTAssertGreaterThanOrEqual(arrivedAt - attached, 55_000)
        XCTAssertFalse(requests.contains { $0.path == streamPath && $0.at > attached && $0.at < arrivedAt },
                       "The stream reconnected before the arrival")
        XCTAssertTrue(requests.contains { $0.path.hasSuffix("/transcript") && $0.scenario == "updated" && $0.status == 200 && $0.at >= arrivedAt })
        let updated = descriptions(app).matching(NSPredicate(format: "label CONTAINS 'Updated after refresh'")).firstMatch
        let frame = updated.frame
        updated.tap(); updated.press(forDuration: 1.2)
        XCTAssertFalse(app.menuItems.firstMatch.exists)
        XCTAssertEqual(updated.frame.height, frame.height, accuracy: 1)
        checkPrivateTextIsAbsent(app)
        try capture(app, "arrival-after-idle-stream")
    }

    @MainActor private func pullToRefresh(_ app: XCUIApplication) throws {
        let before = try JSONDecoder().decode(State.self, from: request("state")).requests.filter { $0.path.hasSuffix("/transcript") }.count
        let timeline = app.collectionViews.firstMatch
        XCTAssertTrue(timeline.exists)
        let start = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        let end = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end)
        let readOccurred = NSPredicate { _, _ in
            guard let data = try? self.request("state"), let state = try? JSONDecoder().decode(State.self, from: data) else { return false }
            return state.requests.filter { $0.path.hasSuffix("/transcript") }.count > before
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: readOccurred, object: nil)], timeout: 20), .completed)
    }

    @MainActor private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @discardableResult private func request(_ route: String, method: String = "GET", body: Data? = nil) throws -> Data {
        let url = try XCTUnwrap(URL(string: server + "/__peer/" + route))
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 15; request.httpBody = body
        let done = DispatchSemaphore(value: 0)
        let result = ResultBox()
        URLSession.shared.dataTask(with: request) { data, response, error in
            result.data = data; result.response = response as? HTTPURLResponse; result.error = error; done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 20) == .success else { throw NSError(domain: "PeerMessageUITests", code: 2) }
        if let error = result.error { throw error }
        XCTAssertEqual(result.response?.statusCode, 200)
        return try XCTUnwrap(result.data)
    }

    private final class ResultBox: @unchecked Sendable {
        var data: Data?
        var response: HTTPURLResponse?
        var error: Error?
    }
}
