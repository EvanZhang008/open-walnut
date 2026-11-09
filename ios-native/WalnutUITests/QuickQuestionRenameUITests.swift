import XCTest

final class QuickQuestionRenameUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        if ProcessInfo.processInfo.environment["WALNUT_UITEST_RENAME_SERVER"] == nil {
            let server = try ChatPlaceFixtureServer()
            server.extraProjectCount = 40
            try server.start()
            fixture = server
        }
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private func launchPaired() throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let token = environment["WALNUT_UITEST_RENAME_TOKEN"] ?? "quick-question-fixture"
        let server: String
        if let isolated = environment["WALNUT_UITEST_RENAME_SERVER"] { server = UITestLaunch.pairedServer(isolated) }
        else { server = try XCTUnwrap(fixture).url }
        if environment["WALNUT_UITEST_RENAME_SERVER"] != nil {
            let components = try XCTUnwrap(URLComponents(string: server))
            XCTAssertEqual(components.scheme, "http")
            XCTAssertTrue(["localhost", "127.0.0.1"].contains(components.host ?? ""),
                          "The isolated test server has an unexpected host: \(components.host ?? "nil") (\(server))")
            let port = try XCTUnwrap(components.port)
            XCTAssertGreaterThan(port, 0)
            XCTAssertNotEqual(port, 3456)
            XCTAssertNotEqual(port, 3457)
        }
        let app = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token])
        // A Release build takes no token from the command line: pair it on the setup page.
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        // Off any session a previous run left pushed over the chat.
        if app.buttons["session.title"].waitForExistence(timeout: 3) { app.leaveChatPeerForTheChat() }
        XCTAssertTrue(app.buttons["chat.menu"].waitForExistence(timeout: 60), "the chat never appeared")
        return app
    }

    private func openDrawer(_ app: XCUIApplication, view: String) {
        app.buttons["chat.menu"].tap()
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5) {
            let segment = picker.buttons[view]
            if segment.exists, !segment.isSelected { segment.tap() }
        }
    }

    private var placeholderTaskID: String {
        ProcessInfo.processInfo.environment["WALNUT_UITEST_RENAME_TASK"] ?? ChatPlaceFixtureServer.placeholderAskTaskID
    }

    private func placeholderRow(_ app: XCUIApplication) -> XCUIElement {
        let row = app.buttons["chat.drawer.ask.\(placeholderTaskID)"]
        for _ in 0..<20 {
            if row.exists && row.isHittable { return row }
            app.scrollViews.firstMatch.swipeUp()
        }
        return row
    }

    private func anything(_ app: XCUIApplication, labelled fragment: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label ==[c] %@", fragment))
            .firstMatch
    }

    func testPlaceholderAskReadsQuickQuestion() throws {
        let app = try launchPaired()
        openDrawer(app, view: "Chats")
        let heading = app.staticTexts["chat.drawer.asksHeading"]
        XCTAssertTrue(heading.waitForExistence(timeout: 30), "the drawer has no asks heading")
        XCTAssertEqual(heading.label, "Quick question")
        XCTAssertTrue(app.buttons["chat.drawer.newChat"].label.contains("New quick question"))
        let row = placeholderRow(app)
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the placeholder ask is not in the drawer")
        XCTAssertTrue(row.label.contains("Quick question"), "drawer row reads \"\(row.label)\"")
        XCTAssertFalse(anything(app, labelled: "Ask Walnut").exists, "the drawer still shows \"Ask Walnut\"")
        attach(app, "drawer-quick-question")

        row.tap()
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 30), "the ask's chat did not open")
        XCTAssertTrue(title.label.contains("Quick question"), "chat title reads \"\(title.label)\"")
        XCTAssertFalse(title.label.contains("Ask Walnut"), "chat title still says \"Ask Walnut\"")
        attach(app, "chat-title-quick-question")
    }

    /// Main's node in the drawer's Org view is named CEO.
    func testMainNodeReadsCEO() throws {
        let app = try launchPaired()
        openDrawer(app, view: "Org")
        let ceo = app.buttons["chat.drawer.org.ceo"]
        XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no CEO row in the drawer's Org view")
        XCTAssertTrue(ceo.label.hasPrefix("CEO"), "the org row reads \"\(ceo.label)\"")
        attach(app, "drawer-org-ceo")
        ceo.tap()
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 30), "the CEO chat did not open")
        XCTAssertTrue(title.label.contains("CEO"), "the opened chat reads \"\(title.label)\"")
        attach(app, "opened-ceo")
        app.buttons["session.menu"].tap()
        let details = app.buttons["session.taskDetails"]
        XCTAssertTrue(details.waitForExistence(timeout: 15))
        details.tap()
        XCTAssertTrue(app.buttons["task.title"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["task.title"].label.contains("CEO"))
        let sessionRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "task.session.")).firstMatch
        XCTAssertTrue(sessionRow.waitForExistence(timeout: 30))
        let detailScroll = app.scrollViews.containing(.button, identifier: "task.title").firstMatch
        XCTAssertTrue(detailScroll.waitForExistence(timeout: 15))
        for _ in 0..<8 {
            if sessionRow.isHittable { break }
            detailScroll.swipeUp()
        }
        XCTAssertTrue(sessionRow.isHittable, "the CEO's session row did not scroll into view")
        XCTAssertTrue(sessionRow.label.contains("CEO") || sessionRow.staticTexts["CEO"].exists,
                      "the CEO's session row reads \"\(sessionRow.label)\"")
        attach(app, "ceo-detail-session-name")
    }

    func testStoredAskProjectReadsQuickQuestionInDetailsAndPicker() throws {
        let app = try launchPaired()
        openDrawer(app, view: "Chats")
        let row = placeholderRow(app)
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        title.tap()
        let project = app.buttons["task.prop.project"]
        XCTAssertTrue(project.waitForExistence(timeout: 30), "task details have no project field")
        XCTAssertTrue(project.label.contains("Quick question"), "project reads \"\(project.label)\"")
        XCTAssertTrue(app.buttons["task.title"].label.contains("Quick question"))
        XCTAssertFalse(anything(app, labelled: "Ask Walnut").exists)
        attach(app, "task-project-quick-question")
        project.tap()
        let picker = app.descendants(matching: .any)["task.project.picker"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 15))
        XCTAssertTrue(picker.buttons["Quick question"].waitForExistence(timeout: 15))
        XCTAssertFalse(picker.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "Ask Walnut")).firstMatch.exists)
        let search = app.textFields["task.project.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        // A long list opens scrolled to the current project, so a tap on the search that resets the
        // list to its top shows as the stored project's row leaving the screen.
        let selected = picker.buttons["Quick question"]
        if ProcessInfo.processInfo.environment["WALNUT_UITEST_RENAME_SERVER"] == nil {
            XCTAssertFalse(picker.buttons["Inbox"].isHittable,
                           "the list is not longer than the screen: the extra projects did not load, or it opened at the top")
        }
        let rowBefore = selected.frame.minY
        search.tap()
        assertStableKeyboard(app, message: "the project search did not focus after one tap")
        XCTAssertTrue(selected.exists, "the selected project left the list after the search was tapped")
        XCTAssertLessThan(abs(selected.frame.minY - rowBefore), 200, "the list jumped when the search was tapped")
        attach(app, "project-search-first-tap-keyboard")
        search.typeText("Quick question")
        XCTAssertEqual(search.value as? String, "Quick question")
        XCTAssertTrue(picker.buttons["Quick question"].exists)
        XCTAssertFalse(app.buttons["task.project.create"].exists, "the display name must not create a duplicate project")
        attach(app, "project-picker-quick-question")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        XCTAssertTrue(picker.waitForExistence(timeout: 15))
        let rawSearch = app.textFields["task.project.search"]
        XCTAssertTrue(rawSearch.waitForExistence(timeout: 15))
        rawSearch.tap()
        assertStableKeyboard(app, message: "the reopened project search did not focus after one tap")
        attach(app, "project-search-reopened-first-tap-keyboard")
        rawSearch.typeText("Ask Walnut")
        XCTAssertEqual(rawSearch.value as? String, "Ask Walnut")
        let storedRow = picker.buttons["Quick question"]
        XCTAssertTrue(storedRow.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["task.project.create"].exists)
        storedRow.tap()
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        XCTAssertTrue(project.label.contains("Quick question"))
        attach(app, "project-picked-from-stored-name")
    }

    /// The description editor, raised by the task page, takes the keyboard on its first tap: the
    /// same class as the project search (a sheet raised from inside the page's scroll content was
    /// rebuilt when its text field took focus).
    func testTaskDescriptionEditorKeepsKeyboardOnFirstTap() throws {
        let app = try launchPaired()
        openDrawer(app, view: "Chats")
        let row = placeholderRow(app)
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        title.tap()
        let edit = app.buttons["task.editDescription"]
        XCTAssertTrue(edit.waitForExistence(timeout: 30), "task details have no description editor")
        let detailScroll = app.scrollViews.containing(.button, identifier: "task.title").firstMatch
        for _ in 0..<10 where !edit.isHittable { detailScroll.swipeUp() }
        XCTAssertTrue(edit.isHittable, "the description editor button did not scroll into view")
        edit.tap()
        let editor = app.textViews["task.descriptionEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15), "the description editor did not open")
        editor.tap()
        assertStableKeyboard(app, message: "the description editor did not focus after one tap")
        editor.typeText("First tap")
        XCTAssertTrue((editor.value as? String ?? "").contains("First tap"), "the editor reads \"\(editor.value ?? "")\"")
        attach(app, "description-editor-first-tap")
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(edit.waitForExistence(timeout: 15), "cancel did not return to the task page")
    }

    private func assertStableKeyboard(_ app: XCUIApplication, message: String) {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), message)
        let disappeared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !keyboard.exists }, object: nil)
        disappeared.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [disappeared], timeout: 2), .completed,
                       "the project search keyboard disappeared before typing")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
