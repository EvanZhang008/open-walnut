import XCTest

final class MediaFileUITests: XCTestCase {
    private struct Fixture: Decodable {
        let sessionId: String
        let taskId: String
        let clip: String
        let large: String
        let missing: String
    }
    private var server = ""
    private var token = ""
    private var fixture: Fixture!
    private var appUnderTest: XCUIApplication?

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["WALNUT_UITEST_SERVER"], let bearer = env["WALNUT_UITEST_TOKEN"] else {
            throw XCTSkip("Run with the isolated media fixture")
        }
        server = UITestLaunch.pairedServer(url)
        token = bearer
        let root = try XCTUnwrap(URL(string: server))
        guard root.scheme == "http", ["127.0.0.1", "localhost"].contains(root.host ?? ""),
              let port = root.port, ![3456, 3457].contains(port) else {
            throw NSError(domain: "MediaUITests", code: 1)
        }
        fixture = try JSONDecoder().decode(Fixture.self, from: request("state"))
        _ = try request("fault?mode=off", method: "POST")
        _ = try request("remove", method: "POST")
    }

    override func tearDown() {
        if let appUnderTest {
            let attachment = XCTAttachment(string: appUnderTest.debugDescription)
            attachment.name = "final-screen-hierarchy"; attachment.lifetime = .keepAlways; add(attachment)
            let shot = XCTAttachment(screenshot: appUnderTest.screenshot())
            shot.name = "final-screen"; shot.lifetime = .keepAlways; add(shot)
        }
        appUnderTest = nil
        try? request("fault?mode=off", method: "POST")
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor private func openSession(accessibilitySize: Bool = false) throws -> XCUIApplication {
        var arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token]
        if accessibilitySize {
            arguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        }
        let app = UITestLaunch.launch(arguments)
        appUnderTest = app
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 40)); tasks.tap()
        let board = app.buttons["tasks.empty.openBoard"].firstMatch
        let menu = app.buttons["tasks.menu"].firstMatch
        let row = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'board.row.' AND identifier CONTAINS %@", fixture.taskId)).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 15) || board.waitForExistence(timeout: 10))
        if !row.exists || !row.isHittable {
            if board.exists && board.isHittable { board.tap() }
            else if menu.isHittable { menu.tap() }
        }
        XCTAssertTrue(row.waitForExistence(timeout: 25))
        for _ in 0..<3 where !row.isHittable {
            let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: row)
            if XCTWaiter.wait(for: [settled], timeout: 3) == .completed { break }
            if board.exists && board.isHittable { board.tap() }
            else if menu.exists && menu.isHittable { menu.tap() }
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 30))
        return app
    }

    @MainActor private func openFiles(_ app: XCUIApplication) {
        let menu = element(app, "session.menu")
        XCTAssertTrue(menu.waitForExistence(timeout: 10)); menu.tap()
        let files = element(app, "session.files")
        XCTAssertTrue(files.waitForExistence(timeout: 10)); files.tap()
        XCTAssertTrue(element(app, "session.files.list").waitForExistence(timeout: 20))
    }

    @MainActor private func openFile(_ app: XCUIApplication, _ name: String) {
        let file = element(app, "session.files.file." + name)
        XCTAssertTrue(file.waitForExistence(timeout: 15)); file.tap()
    }

    // The viewer's Done, not one on a sheet underneath it: wait for a Done that can
    // actually be tapped.
    @MainActor private func hittableDone(_ app: XCUIApplication) -> XCUIElement {
        let buttons = app.buttons.matching(NSPredicate(format: "label == 'Done'"))
        var found: XCUIElement?
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            found = buttons.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
            return found != nil
        }, object: nil)
        _ = XCTWaiter.wait(for: [ready], timeout: 20)
        return found ?? buttons.firstMatch
    }

    @MainActor private func dismissViewer(_ app: XCUIApplication) {
        let done = hittableDone(app)
        XCTAssertTrue(done.isHittable); done.tap()
    }

    // A tap on the player toggles its controls, so tap only while the control is
    // hidden: a tap while they are still showing would hide them instead.
    @MainActor private func revealControls(_ app: XCUIApplication, _ control: XCUIElement) {
        let player = element(app, "session.media.player")
        for _ in 0..<3 {
            if control.exists && control.isHittable { return }
            player.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
            if control.waitForExistence(timeout: 3) && control.isHittable { return }
        }
        XCTFail("Player controls did not appear")
    }

    @MainActor private func expectPlayer(_ app: XCUIApplication) {
        XCTAssertTrue(element(app, "session.media.player").waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Preparing media…"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        XCTAssertFalse(app.staticTexts["Can't show this file"].exists)
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) throws {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        _ = try request("shot?name=" + name, method: "POST", body: shot.pngRepresentation)
    }

    @MainActor func testMP4FromFilesPlaysAndReopensWithRealBytes() throws {
        let beforeState = try JSONSerialization.jsonObject(with: request("state")) as? [String: Any]
        let before = (beforeState?["requests"] as? [[String: Any]])?.count ?? 0
        let app = try openSession(); openFiles(app)
        for round in 0..<3 {
            openFile(app, "walkthrough.mp4"); expectPlayer(app)
            if round == 0 {
                let play = app.buttons["Play/Pause"].firstMatch
                revealControls(app, play)
                if play.label == "Play" { play.tap() }
                let playing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: play)
                XCTAssertEqual(XCTWaiter.wait(for: [playing], timeout: 10), .completed)
                try capture(app, "video-playing")
                revealControls(app, play)
                if play.label == "Pause" { play.tap() }
            }
            try capture(app, "files-video-\(round)")
            dismissViewer(app)
        }
        let state = try JSONSerialization.jsonObject(with: request("state")) as? [String: Any]
        let requests = try XCTUnwrap(state?["requests"] as? [[String: Any]])
        let raw = requests.dropFirst(before).filter { ($0["path"] as? String) == fixture.clip && ($0["raw"] as? Bool) == true }
        XCTAssertGreaterThanOrEqual(raw.count, 3)
        XCTAssertTrue(raw.allSatisfy { ($0["status"] as? Int) == 200 && ($0["bytes"] as? Int ?? 0) > 1000 })
    }

    @MainActor func testBackgroundAndShareKeepPositionWithoutDownloadingAgain() throws {
        try verifyBackgroundAndShare(accessibilitySize: false)
    }

    @MainActor func testAccessiblePlayerKeepsPositionAcrossForegroundRecreation() throws {
        try verifyBackgroundAndShare(accessibilitySize: true)
    }

    @MainActor private func verifyBackgroundAndShare(accessibilitySize: Bool) throws {
        let app = try openSession(accessibilitySize: accessibilitySize)
        let before = try rawReadCount()
        if accessibilitySize {
            let clip = app.links.matching(NSPredicate(format: "label CONTAINS 'walkthrough.mp4'")).firstMatch
            XCTAssertTrue(clip.waitForExistence(timeout: 15)); clip.tap()
        } else {
            openFiles(app)
            openFile(app, "walkthrough.mp4")
        }
        expectPlayer(app)
        let player = element(app, "session.media.player")
        let forward = app.buttons["Skip Forward"].firstMatch
        revealControls(app, forward); forward.tap()
        let position = app.sliders["Current position"].firstMatch
        let advanced = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.elapsedSeconds(position) >= 9
        }, object: position)
        XCTAssertEqual(XCTWaiter.wait(for: [advanced], timeout: 10), .completed)
        let backward = app.buttons["Skip Backward"].firstMatch
        revealControls(app, backward); backward.tap()
        let rewound = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let elapsed = self.elapsedSeconds(position)
            return position.exists && elapsed >= 0 && elapsed <= 1
        }, object: position)
        XCTAssertEqual(XCTWaiter.wait(for: [rewound], timeout: 10), .completed)
        let play = app.buttons["Play/Pause"].firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 10)); play.tap()
        let progressed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            if !position.exists {
                player.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
            }
            return position.exists && self.elapsedSeconds(position) >= 3
        }, object: position)
        XCTAssertEqual(XCTWaiter.wait(for: [progressed], timeout: 10), .completed)
        revealControls(app, play)
        if play.label == "Pause" { play.tap() }
        let paused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Play'"), object: play)
        XCTAssertEqual(XCTWaiter.wait(for: [paused], timeout: 10), .completed)
        XCTAssertGreaterThan(elapsedSeconds(position), 1)
        XCTAssertLessThan(elapsedSeconds(position), 9)
        let pausedPosition = elapsedSeconds(position)
        let changedWhilePaused = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.elapsedSeconds(position) != pausedPosition
        }, object: position)
        changedWhilePaused.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [changedWhilePaused], timeout: 2), .completed)
        let elapsed = elapsedSeconds(position)
        let caption = accessibilitySize ? element(app, "session.media.time").label : nil
        XCTAssertEqual(try rawReadCount(), before + 1)
        try capture(app, "before-background")
        for _ in 0..<3 {
            XCUIDevice.shared.press(.home)
            XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.springboard").wait(for: .runningForeground, timeout: 10))
            app.activate()
            expectPlayer(app)
            XCTAssertEqual(try rawReadCount(), before + 1)
            if accessibilitySize {
                let clock = element(app, "session.media.time")
                XCTAssertTrue(clock.waitForExistence(timeout: 10))
                let retained = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", try XCTUnwrap(caption)), object: clock)
                XCTAssertEqual(XCTWaiter.wait(for: [retained], timeout: 3), .completed)
            } else {
                revealControls(app, position)
                XCTAssertEqual(elapsedSeconds(position), elapsed)
            }
        }
        try capture(app, "after-background")
        if accessibilitySize {
            dismissViewer(app)
            return
        }
        element(app, "session.media.share").tap()
        let shareAction = app.cells["Copy"].firstMatch
        XCTAssertTrue(shareAction.waitForExistence(timeout: 10))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        expectPlayer(app)
        XCTAssertEqual(try rawReadCount(), before + 1)
        try capture(app, "after-share")
        dismissViewer(app)
    }

    @MainActor private func elapsedSeconds(_ slider: XCUIElement) -> Int {
        Int((slider.value as? String ?? "").split(separator: " ").first ?? "") ?? -1
    }

    private func rawReadCount() throws -> Int {
        let state = try JSONSerialization.jsonObject(with: request("state")) as? [String: Any]
        let requests = try XCTUnwrap(state?["requests"] as? [[String: Any]])
        return requests.filter { ($0["path"] as? String) == fixture.clip && ($0["raw"] as? Bool) == true }.count
    }

    @MainActor func testTimelineLinkAndMissingFileRecovery() throws {
        let app = try openSession()
        let clip = app.links.matching(NSPredicate(format: "label CONTAINS 'walkthrough.mp4'")).firstMatch
        XCTAssertTrue(clip.waitForExistence(timeout: 15)); clip.tap()
        expectPlayer(app)
        try capture(app, "timeline-video")
        dismissViewer(app)
        let missing = app.links.matching(NSPredicate(format: "label CONTAINS 'restored.mp4'")).firstMatch
        XCTAssertTrue(missing.waitForExistence(timeout: 15)); missing.tap()
        let retry = element(app, "session.media.retry")
        XCTAssertTrue(retry.waitForExistence(timeout: 15))
        _ = try request("restore", method: "POST")
        retry.tap(); expectPlayer(app)
        try capture(app, "missing-file-recovered")
    }

    @MainActor func testLargeUppercaseVideoAndTextHTMLRegressions() throws {
        let app = try openSession(); openFiles(app)
        openFile(app, "large walkthrough.MP4"); expectPlayer(app)
        try capture(app, "large-video")
        let state = try JSONSerialization.jsonObject(with: request("state")) as? [String: Any]
        let requests = try XCTUnwrap(state?["requests"] as? [[String: Any]])
        let raw = try XCTUnwrap(requests.last { ($0["path"] as? String) == fixture.large && ($0["raw"] as? Bool) == true })
        XCTAssertGreaterThan(raw["bytes"] as? Int ?? 0, 2 * 1_048_576)
        dismissViewer(app)
        openFile(app, "readme.txt")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'File preview regression: line one'")).firstMatch.waitForExistence(timeout: 15))
        dismissViewer(app)
        openFile(app, "report.html")
        XCTAssertTrue(element(app, "session.files.viewer.sourceToggle").waitForExistence(timeout: 15))
        try capture(app, "html-regression")
    }

    @MainActor func testOfflineRetryAndCancelDuringDownload() throws {
        let app = try openSession(); openFiles(app)
        _ = try request("fault?mode=offline", method: "POST")
        openFile(app, "walkthrough.mp4")
        let retry = element(app, "session.media.retry")
        XCTAssertTrue(retry.waitForExistence(timeout: 15))
        try capture(app, "offline-error")
        _ = try request("fault?mode=off", method: "POST")
        retry.tap(); expectPlayer(app)
        dismissViewer(app)
        _ = try request("fault?mode=delay", method: "POST")
        openFile(app, "large walkthrough.MP4")
        XCTAssertTrue(app.staticTexts["Downloading media…"].waitForExistence(timeout: 5))
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5)); cancel.tap()
        _ = try request("fault?mode=off", method: "POST")
        openFile(app, "walkthrough.mp4"); expectPlayer(app)
        try capture(app, "cancel-and-reopen")
    }

    @MainActor private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @discardableResult private func request(_ route: String, method: String = "GET", body: Data? = nil) throws -> Data {
        let url = try XCTUnwrap(URL(string: server + "/__media/" + route))
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 15; request.httpBody = body
        let complete = DispatchSemaphore(value: 0)
        let result = ResultBox()
        URLSession.shared.dataTask(with: request) { data, response, error in
            result.data = data; result.response = response as? HTTPURLResponse; result.error = error; complete.signal()
        }.resume()
        guard complete.wait(timeout: .now() + 20) == .success else { throw NSError(domain: "MediaUITests", code: 2) }
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
