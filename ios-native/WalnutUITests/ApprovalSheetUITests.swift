import XCTest

/// The approval sheet, read and answered the way the person does, against a fixture that serves one
/// approval the way the server does.
///
/// 2026-11-14, the user: "这个手机上没办法approve啊", with a sheet that showed the whole signed envelope
/// as raw JSON above its buttons: it leads with the summary, names the repository and branch, and folds
/// the signed context under Details.
/// 2026-11-15, the user, on the video of that sheet: "你那个到底在哪里？而且为什么到最后它的 UI 还 flicky 了？
/// 就显示了一个 small box of deny": a phone that could not sign showed Deny alone, and after Deny the bar
/// shrank to a small "Denied on a device" box. Approve and Deny now always come together, the end state
/// fills the bar and says who answered, and a request whose time runs out says so.
final class ApprovalSheetUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    private var answered: [String] = []
    /// The approval this test serves.
    private var served: [String: Any] = [:]
    /// Set: the served approval's time runs out this long after the app first reads it (a slow launch never eats it).
    private var expiresAfterFirstRead: TimeInterval?
    /// The fixture answers on its own thread: its state is read and written under this lock.
    private let lock = NSLock()

    static let approvalID = "apr-fixture-push"
    static let summary = "Pushes the two tracking commits to the shared repo, so the team reads today's numbers."
    static let leakWhat = "Publish a leak gate change: fix(leak-gate): the check before a push of main tries a failed read of GitHub again"
    static let leakWhy = "It edits scripts/leak-scan/check-on-github.sh, part of the check that guards the public repository, so only you can let it go to GitHub. Approving lets this exact change through for six hours."

    private static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    private static func json(_ o: Any) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!
    }

    /// A signed single-use Git push, as the private Git gate asks it (Walnut wrote the summary).
    static func gitPush(expiresIn: TimeInterval = 600) -> [String: Any] {
        let gitContext: [String: Any] = [
            "version": "walnut-git-operation-v1", "operation": "push", "remote": "origin",
            "remoteRef": "refs/heads/mainline", "localRef": "refs/heads/mainline",
            "repository": "/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh",
            "commitSha": "770164961fc7c5491a827f1047c45c94989b8071",
        ]
        let envelope: [String: Any] = [
            "version": "walnut-single-use-v1", "sessionId": "sess-fixture", "taskId": "task-fixture-main",
            "host": "clouddev", "nonce": String(repeating: "ab", count: 32), "context": json(gitContext),
        ]
        let now = Date()
        return [
            "id": approvalID, "what": "Push commit 7701649 to origin mainline in meta-fresh", "detail": json(envelope),
            "digest": String(repeating: "0", count: 64), "mode": "biometric", "status": "pending", "singleUse": true,
            "requester": ["host": "clouddev", "taskId": "task-fixture-main", "taskTitle": "Platform Lead",
                          "cwd": "/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh"],
            "createdAt": iso(now), "expiresAt": iso(now.addingTimeInterval(expiresIn)),
            "signingKeyIds": ["ak-0000000000000001", "ak-0000000000000002"],
            "context": ["summary": summary, "whyFrom": "session"],
        ]
    }

    /// The request the user answered at 23:08Z on 2026-11-15, as the server holds it: the leak gate asks,
    /// on the Mac (its host name a container's hash), with its own why, bound to the Mac's and the phone's keys.
    static func leakGate(mode: String = "biometric", expiresIn: TimeInterval = 300) -> [String: Any] {
        let gate: [String: Any] = [
            "version": "walnut-leak-gate-approval-v1",
            "changes": ["cd1c4a0e21 changes the leak gate itself (scripts/leak-scan/check-on-github.sh): only the user lets that through, with Touch ID"],
            "digest": "144c436de03540f8684d2e70c416f1531336e4a43a7fc0359df438ba59217e67",
        ]
        let envelope: [String: Any] = [
            "version": "walnut-single-use-v1", "sessionId": "fed826e3-fixture", "taskId": "7b9459ea-fixture",
            "host": "842f578d365e", "nonce": String(repeating: "cd", count: 32), "context": json(gate), "why": leakWhy,
        ]
        let now = Date()
        var a: [String: Any] = [
            "id": approvalID, "what": leakWhat, "detail": json(envelope),
            "digest": String(repeating: "1", count: 64), "mode": mode, "status": "pending", "singleUse": true,
            "requester": ["host": "842f578d365e", "local": true, "taskId": "7b9459ea-fixture",
                          "taskTitle": "Code repo secret protection: make it extremely strict",
                          "cwd": "/Users/me/.local/state/open-walnut/tasks/7b9459ea/walnut", "command": "leak-gate-approve"],
            "createdAt": iso(now), "expiresAt": iso(now.addingTimeInterval(expiresIn)),
            "context": ["why": leakWhy, "whyFrom": "asker", "project": "Walnut"],
        ]
        if mode == "biometric" { a["signingKeyIds"] = ["ak-dcb776df2641b2ff", "ak-e71d5e306b094f97"] }
        return a
    }

    /// The served approval once answered: its status, and who answered on which device.
    private func settled(_ decision: String) -> [String: Any] {
        var a = served
        a["status"] = decision == "approve" ? "approved" : "denied"
        a["answer"] = ["decision": decision, "at": Self.iso(Date()), "mode": "tap",
                       "device": ["name": "iPhone 17 Pro", "kind": "iphone"]]
        return a
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        server.extraRoutes = { [weak self] method, target, body in
            guard let self else { return nil }
            self.lock.lock()
            defer { self.lock.unlock() }
            let path = String(target.split(separator: "?").first ?? "")
            let decision = self.answered.last
            if let after = self.expiresAfterFirstRead, path.hasPrefix("/api/v1/approvals") {
                self.served["expiresAt"] = Self.iso(Date().addingTimeInterval(after))
                self.expiresAfterFirstRead = nil
            }
            switch (method, path) {
            case ("GET", "/api/v1/approvals"):
                return (200, ["approvals": decision == nil ? [self.served] : [], "keys": []])
            case ("GET", "/api/v1/approvals/\(Self.approvalID)"):
                return (200, ["approval": decision.map(self.settled) ?? self.served])
            case ("POST", "/api/v1/approvals/\(Self.approvalID)/answer"):
                let sent = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let d = sent?["decision"] as? String ?? "?"
                self.answered.append(d)
                return (200, ["approval": self.settled(d)])
            default: return nil
            }
        }
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private func openSheet(serving approval: [String: Any]) throws -> XCUIApplication {
        served = approval
        let server = try XCTUnwrap(fixture)
        try server.start()
        let token = "approval-sheet-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", server.url, "-walnut.deviceToken", token])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        let sheet = app.descendants(matching: .any)["approval.sheet"].firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 60), "the approval sheet never opened")
        return app
    }

    /// A screenshot kept with the result (the fleet brings it back): the proof of what the person sees.
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// Deny and Approve side by side on one row, both on screen; Approve dimmed when `approveEnabled` is false.
    private func assertBothButtons(_ app: XCUIApplication, approveEnabled: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deny = app.buttons["approval.deny"]
        let approve = app.buttons["approval.approve"]
        XCTAssertTrue(deny.waitForExistence(timeout: 10), "no Deny", file: file, line: line)
        XCTAssertTrue(approve.exists, "Deny showed without Approve", file: file, line: line)
        XCTAssertTrue(deny.isHittable && approve.isHittable, "a button was out of sight", file: file, line: line)
        XCTAssertEqual(approve.isEnabled, approveEnabled, file: file, line: line)
        XCTAssertEqual(deny.frame.midY, approve.frame.midY, accuracy: 2, "Deny and Approve are not on one row", file: file, line: line)
    }

    /// The end of a request: one line saying which, across the bar, with Done, and no answer buttons.
    private func assertEnded(_ app: XCUIApplication, saying words: String, within timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        let result = app.staticTexts["approval.result"]
        XCTAssertTrue(result.waitForExistence(timeout: timeout), "the sheet never showed its end", file: file, line: line)
        XCTAssertTrue(result.label.contains(words), result.label, file: file, line: line)
        XCTAssertFalse(result.label.contains("a device"), result.label, file: file, line: line)
        XCTAssertFalse(app.buttons["approval.deny"].exists, "an ended request kept its Deny", file: file, line: line)
        XCTAssertFalse(app.buttons["approval.approve"].exists, "an ended request kept its Approve", file: file, line: line)
        let done = app.buttons["approval.done"]
        XCTAssertTrue(done.exists, file: file, line: line)
        // Across the bar, as Deny and Approve were: never a small box in its middle.
        XCTAssertGreaterThan(done.frame.width, app.windows.firstMatch.frame.width * 0.75, "Done is a small box", file: file, line: line)
    }

    func testASignedPushLeadsWithItsSummaryAndFoldsTheEnvelope() throws {
        let app = try openSheet(serving: Self.gitPush())

        // The summary leads, whole; the request's signed line and the Repo line sit under it.
        let lead = app.staticTexts["approval.summary"]
        XCTAssertTrue(lead.waitForExistence(timeout: 10))
        XCTAssertEqual(lead.label, Self.summary)
        XCTAssertTrue(app.staticTexts["approval.what"].exists)
        let repo = app.staticTexts["approval.repo"]
        XCTAssertTrue(repo.exists)
        XCTAssertTrue(repo.label.contains("meta-fresh \u{2192} mainline"), repo.label)
        // The envelope is folded: none of its JSON is on screen until Details opens.
        XCTAssertFalse(app.descendants(matching: .any)["approval.detail"].exists, "the signed context showed before Details opened")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "walnut-single-use-v1")).firstMatch.exists)
        // This simulator has no Face ID: Approve stays beside Deny, dimmed, under where to approve it.
        assertBothButtons(app, approveEnabled: false)
        let blocked = app.staticTexts["approval.blocked"]
        XCTAssertTrue(blocked.exists)
        XCTAssertTrue(blocked.label.contains("Walnut Mac app with Touch ID"), blocked.label)
        shot(app, "push-1-waiting")
        Thread.sleep(forTimeInterval: 2)

        var details = app.buttons["Details (signed)"]
        if !details.waitForExistence(timeout: 5) { details = app.staticTexts["Details (signed)"] }
        XCTAssertTrue(details.exists, "no Details (signed) row")
        details.tap()
        let detail = app.descendants(matching: .any)["approval.detail"].firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 5))
        XCTAssertTrue(detail.label.contains("refs/heads/mainline"), detail.label)
        XCTAssertFalse(detail.label.contains("walnut-single-use-v1"), "Details holds the signed context, not its envelope")
        shot(app, "push-2-details-open")
        Thread.sleep(forTimeInterval: 2)
        details.tap()
        XCTAssertTrue(detail.waitForNonExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)

        // Deny answers it and the sheet shows the end, across the bar.
        app.buttons["approval.deny"].tap()
        assertEnded(app, saying: "Denied on iPhone 17 Pro")
        shot(app, "push-3-denied")
        XCTAssertEqual(lock.withLock { answered }, ["deny"])
        Thread.sleep(forTimeInterval: 2)
    }

    /// The leak gate's request as the user got it: what, why, who and where, Approve and Deny together.
    func testTheLeakGateRequestShowsWhatWhyAndWhoWithBothButtons() throws {
        let app = try openSheet(serving: Self.leakGate())
        let what = app.staticTexts["approval.what"]
        XCTAssertTrue(what.waitForExistence(timeout: 10))
        XCTAssertEqual(what.label, Self.leakWhat)
        XCTAssertEqual(app.staticTexts["approval.why"].label, Self.leakWhy)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "on the computer Walnut runs on")).firstMatch.exists,
                      "the asker's computer was named by its hash")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "842f578d365e")).firstMatch.exists)
        assertBothButtons(app, approveEnabled: false)
        shot(app, "leak-1-waiting")
        Thread.sleep(forTimeInterval: 3)
        app.buttons["approval.deny"].tap()
        assertEnded(app, saying: "Denied on iPhone 17 Pro")
        shot(app, "leak-2-denied")
        Thread.sleep(forTimeInterval: 2)
    }

    /// A tap approval: Approve answers it, and the end says who approved, how.
    func testATapApprovalApprovesAndSaysWhere() throws {
        let app = try openSheet(serving: Self.leakGate(mode: "tap"))
        assertBothButtons(app, approveEnabled: true)
        XCTAssertFalse(app.staticTexts["approval.blocked"].exists, "a tap approval said this phone cannot approve it")
        shot(app, "tap-1-waiting")
        Thread.sleep(forTimeInterval: 2)
        app.buttons["approval.approve"].tap()
        assertEnded(app, saying: "Approved on iPhone 17 Pro with a tap")
        shot(app, "tap-2-approved")
        XCTAssertEqual(lock.withLock { answered }, ["approve"])
        Thread.sleep(forTimeInterval: 2)
    }

    /// Open when its time runs out: the sheet says so and drops its buttons, before any refresh.
    func testARequestThatRunsOutOfTimeWhileOpenSaysSo() throws {
        expiresAfterFirstRead = 35
        let app = try openSheet(serving: Self.leakGate(mode: "tap"))
        assertBothButtons(app, approveEnabled: true)
        // Its time runs out 35 s after the app first read it: wait past that, not the default 15 s.
        shot(app, "expiry-1-waiting")
        assertEnded(app, saying: "Expired: nobody answered in time", within: 60)
        shot(app, "expiry-2-expired")
        XCTAssertTrue(lock.withLock { answered.isEmpty })
        Thread.sleep(forTimeInterval: 2)
    }
}
