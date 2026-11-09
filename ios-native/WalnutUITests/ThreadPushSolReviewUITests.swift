import XCTest

/// Independent review probes for interrupted local work and a sheet owned by the node's chat.
/// Isolated fixture only. No messages are sent, and no production data is changed.
final class ThreadPushSolReviewUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    private var app: XCUIApplication!
    private let vp = OrgThreadsFixture.vpTaskID
    private let ids = OrgThreadsFixture.threadIDs

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        server.extraRoute = OrgThreadsFixture.route
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private func el(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Sol-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func touch(_ element: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: element.frame.midX, dy: element.frame.midY)).tap()
    }

    private func back() throws {
        let named = app.navigationBars.buttons["BackButton"]
        let button = named.waitForExistence(timeout: 3) ? named : app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10), "A node page must have Back")
        button.tap()
    }

    private func launchVPPage() throws {
        let server = try XCTUnwrap(fixture).url
        let token = "chat-place-fixture"
        app = UITestLaunch.launch([
            "-walnut.serverUrl", server, "-walnut.deviceToken", token,
            "-walnut.debugThreadPush", "\(vp) \(ids[0])",
        ])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60))
        XCTAssertTrue(el("org.thread.\(ids[0])").waitForExistence(timeout: 20))
    }

    private func push(_ thread: String) {
        let url = URL(string: "walnut://debug-thread-push?task=\(vp)&thread=\(thread)&n=\(UUID().uuidString)")!
        XCUIDevice.shared.system.open(url)
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    private func followUp(_ thread: String) -> XCUIElement {
        el("org.thread.\(thread)").buttons["org.thread.followUp"]
    }

    func testPushKeepsTheUnsentFollowUpDraftWhenItClosesTheComposer() throws {
        try launchVPPage()
        let follow = followUp(ids[0])
        XCTAssertTrue(follow.waitForExistence(timeout: 10))
        touch(follow)
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let draft = "Please keep this unsent draft while I read the new push."
        input.tap()
        input.typeText(draft)
        XCTAssertEqual(input.value as? String, draft)
        shot("draft-before-push")

        push(ids[9])
        XCTAssertTrue(input.waitForNonExistence(timeout: 15), "The push should close the covering composer")
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 15))
        shot("draft-after-push")

        // Return to the original thread without sending or editing any server record.
        try back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15))
        el("org.bar.threads").tap()
        XCTAssertTrue(el("org.thread.\(ids[0])").waitForExistence(timeout: 15))
        let reopened = followUp(ids[0])
        XCTAssertTrue(reopened.waitForExistence(timeout: 10))
        touch(reopened)
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        shot("draft-reopened")
        XCTAssertEqual(input.value as? String, draft,
                       "A push must not silently discard the words typed into another thread's Follow up")
    }

    func testPushRevealsItsThreadOverTheNodeChatsCoreInstructionsSheet() throws {
        try launchVPPage()
        try back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15))
        let menu = app.buttons["session.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        let memory = app.buttons["session.memoryInstructions"]
        XCTAssertTrue(memory.waitForExistence(timeout: 10))
        memory.tap()
        let sheet = app.navigationBars["Core Instructions"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10))
        shot("core-instructions-before-push")

        push(ids[9])
        let closed = sheet.waitForNonExistence(timeout: 15)
        shot("core-instructions-after-push")
        XCTAssertTrue(closed, "Core Instructions remains above the Threads page after the push")
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 10))
        let title = el("org.thread.\(ids[9])").descendants(matching: .any)
            .matching(identifier: "org.thread.title").firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        let tabs = app.segmentedControls["org.node.tabs"]
        XCTAssertGreaterThanOrEqual(title.frame.minY, tabs.frame.maxY,
                                   "The pushed thread's title must be visible under the view switch")
    }
}
