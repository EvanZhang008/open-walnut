import XCTest

/// The approval sheet for a signed Git push (2026-11-14, the user: "这个手机上没办法approve啊", with a
/// sheet that showed the whole signed envelope as raw JSON above its buttons): it leads with the
/// summary, names the repository and branch, folds the signed context under Details, and opens it
/// on a tap. The fixture serves one pending single-use approval the way the server does.
final class ApprovalSheetUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    private var answered: [String] = []

    static let approvalID = "apr-fixture-push"
    static let summary = "Pushes the two tracking commits to the shared repo, so the team reads today's numbers."

    static func approval(status: String = "pending") -> [String: Any] {
        let gitContext: [String: Any] = [
            "version": "walnut-git-operation-v1", "operation": "push", "remote": "origin",
            "remoteRef": "refs/heads/mainline", "localRef": "refs/heads/mainline",
            "repository": "/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh",
            "commitSha": "770164961fc7c5491a827f1047c45c94989b8071",
        ]
        let ctx = String(data: try! JSONSerialization.data(withJSONObject: gitContext, options: [.sortedKeys]), encoding: .utf8)!
        let envelope: [String: Any] = [
            "version": "walnut-single-use-v1", "sessionId": "sess-fixture", "taskId": "task-fixture-main",
            "host": "clouddev", "nonce": String(repeating: "ab", count: 32), "context": ctx,
        ]
        let detail = String(data: try! JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]), encoding: .utf8)!
        let now = Date()
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [
            "id": approvalID, "what": "Push commit 7701649 to origin mainline in meta-fresh", "detail": detail,
            "digest": String(repeating: "0", count: 64), "mode": "biometric", "status": status, "singleUse": true,
            "requester": ["host": "clouddev", "taskId": "task-fixture-main", "taskTitle": "Platform Lead",
                          "cwd": "/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh"],
            "createdAt": iso.string(from: now), "expiresAt": iso.string(from: now.addingTimeInterval(600)),
            "signingKeyIds": ["ak-0000000000000001", "ak-0000000000000002"],
            "context": ["summary": summary, "whyFrom": "session"],
        ]
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        server.extraRoutes = { [weak self] method, target, _ in
            let path = String(target.split(separator: "?").first ?? "")
            switch (method, path) {
            case ("GET", "/api/v1/approvals"):
                let done = self?.answered.isEmpty == false
                return (200, ["approvals": done ? [] : [Self.approval()], "keys": []])
            case ("GET", "/api/v1/approvals/\(Self.approvalID)"):
                return (200, ["approval": Self.approval(status: self?.answered.isEmpty == false ? "denied" : "pending")])
            case ("POST", "/api/v1/approvals/\(Self.approvalID)/answer"):
                self?.answered.append("deny")
                return (200, ["approval": Self.approval(status: "denied")])
            default: return nil
            }
        }
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    func testASignedPushLeadsWithItsSummaryAndFoldsTheEnvelope() throws {
        let server = try XCTUnwrap(fixture).url
        let token = "approval-sheet-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        let sheet = app.descendants(matching: .any)["approval.sheet"].firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 60), "the approval sheet never opened")

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
        Thread.sleep(forTimeInterval: 2)

        var details = app.buttons["Details (signed)"]
        if !details.waitForExistence(timeout: 5) { details = app.staticTexts["Details (signed)"] }
        XCTAssertTrue(details.exists, "no Details (signed) row")
        details.tap()
        let detail = app.descendants(matching: .any)["approval.detail"].firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 5))
        XCTAssertTrue(detail.label.contains("refs/heads/mainline"), detail.label)
        XCTAssertFalse(detail.label.contains("walnut-single-use-v1"), "Details holds the signed context, not its envelope")
        Thread.sleep(forTimeInterval: 2)
        details.tap()
        XCTAssertTrue(detail.waitForNonExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)

        // Deny answers it and the sheet shows the end.
        app.buttons["approval.deny"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["approval.result"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertEqual(answered, ["deny"])
        Thread.sleep(forTimeInterval: 2)
    }
}
