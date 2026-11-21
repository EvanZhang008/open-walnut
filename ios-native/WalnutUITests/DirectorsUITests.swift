import XCTest

/// Directors in the Chat drawer's Org view, the task page's menu and Settings (2026-11-20, the
/// user: "we can also promote a task to director, which will show under the VP ... we can also
/// create director", "I still want the original collapse", and both layouts to choose from in
/// the settings, with or without project names).
///
/// Paired to `ChatPlaceFixtureServer`, a loopback server this runner hosts, with an org served
/// on top of it (`DirectorsFixture`): no Walnut anywhere and nobody's data. The writes it checks
/// (Remove, New Director, the layout) land in the fixture and are read back from what it got.
final class DirectorsUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    private let org = DirectorsFixture()

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        let org = self.org
        server.extraRoutes = { method, target, body in org.answer(method, target, body) }
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func launchPaired() throws -> XCUIApplication {
        let token = "chat-place-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", try XCTUnwrap(fixture).url, "-walnut.deviceToken", token])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func openOrgDrawer(_ app: XCUIApplication) {
        let menu = app.buttons["chat.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 60), "the chat never appeared")
        menu.tap()
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "the chat drawer did not open")
        if picker.buttons["Org"].exists, !picker.buttons["Org"].isSelected { picker.buttons["Org"].tap() }
        XCTAssertTrue(app.buttons["chat.drawer.org.project:walnut"].waitForExistence(timeout: 20), "no Walnut VP row")
    }

    func testFoldRemoveAndNewDirectorFromTheDrawer() throws {
        let app = try launchPaired()
        openOrgDrawer(app)
        let fold = element(app, "chat.drawer.directors.fold.project:walnut")
        XCTAssertTrue(fold.waitForExistence(timeout: 20), "no Directors fold under the Walnut VP")
        XCTAssertTrue(fold.label.hasPrefix("4 directors"), "the fold reads \(fold.label)")
        // Folded by default; a VP with none has no fold row.
        XCTAssertFalse(element(app, "chat.drawer.director.d1").exists, "the fold opened by itself")
        XCTAssertFalse(element(app, "chat.drawer.directors.fold.project:atlas").exists)
        Thread.sleep(forTimeInterval: 1)
        attach(app, "ios-directors-fold-closed")

        fold.tap()
        let nested = element(app, "chat.drawer.director.d2")
        XCTAssertTrue(nested.waitForExistence(timeout: 5), "the fold did not open")
        let top = element(app, "chat.drawer.director.d1")
        XCTAssertGreaterThan(nested.frame.minX, top.frame.minX - 1, "a nested Director is not indented")
        XCTAssertTrue(app.staticTexts["Garden"].exists, "no project heading for the led project")
        Thread.sleep(forTimeInterval: 0.6)
        attach(app, "ios-directors-fold-open")

        // Long press: Remove from Directors, then it is gone and the server got `no`.
        longPress(element(app, "chat.drawer.director.d3"))
        let remove = app.buttons["Remove from Directors"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5), "no Remove from Directors on a long press")
        attach(app, "ios-directors-longpress")
        remove.tap()
        XCTAssertTrue(element(app, "chat.drawer.director.d3").waitForNonExistence(timeout: 10), "the removed Director stayed")
        XCTAssertEqual(org.writes(.patch).last?["director"] as? String, "no")
        XCTAssertEqual(org.patchedIds.last, "d3")

        // Long press on the VP: New Director… asks a name and (it leads two) a project.
        longPress(app.buttons["chat.drawer.org.project:walnut"])
        let new = app.buttons["New Director…"]
        XCTAssertTrue(new.waitForExistence(timeout: 5), "no New Director on a VP's long press")
        attach(app, "ios-directors-vp-longpress")
        new.tap()
        let field = element(app, "chat.newDirector.field")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the New Director sheet did not open")
        XCTAssertTrue(element(app, "chat.newDirector.project").exists, "no project picker for a VP of two projects")
        field.tap()
        field.typeText("Release notes")
        Thread.sleep(forTimeInterval: 0.5)
        attach(app, "ios-directors-new-sheet")
        app.buttons["chat.newDirector.confirm"].tap()
        // It is made a Director in the VP's own project, and opens on its first message.
        let first = element(app, "chat.orgFirstMessage.field")
        XCTAssertTrue(first.waitForExistence(timeout: 15), "the new Director did not open")
        let made = try XCTUnwrap(org.writes(.post).last)
        XCTAssertEqual(made["title"] as? String, "Release notes")
        XCTAssertEqual(made["project"] as? String, "Walnut")
        XCTAssertEqual(made["director"] as? String, "yes")
        attach(app, "ios-directors-new-first-message")
    }

    func testSettingsSwitchTheLayoutToSections() throws {
        let app = try launchPaired()
        let settings = app.tab(.settings)
        XCTAssertTrue(settings.waitForExistence(timeout: 60))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20), "Settings did not open")
        // The Org section sits below the first screen: scroll it in (a List builds rows as they come).
        let sections = element(app, "settings.directors.layout.sections")
        XCTAssertTrue(revealInList(app, sections), "no Org section in Settings")
        XCTAssertTrue(element(app, "settings.directors.showProjects").exists)
        attach(app, "ios-directors-settings")
        sections.tap()
        XCTAssertTrue(waitFor { self.org.writes(.put).last?["directorsLayout"] as? String == "sections" }, "the layout was not written")

        app.tab(.chat).tap()
        openOrgDrawer(app)
        let header = element(app, "chat.drawer.directors.header")
        XCTAssertTrue(header.waitForExistence(timeout: 10), "no Directors section")
        let vp = app.buttons["chat.drawer.org.project:walnut"]
        XCTAssertGreaterThan(header.frame.minY, vp.frame.maxY, "the Directors section is not after the VPs")
        XCTAssertTrue(element(app, "chat.drawer.director.d2").exists, "a nested Director is missing from the section")
        XCTAssertFalse(element(app, "chat.drawer.directors.fold.project:walnut").exists, "the fold row shows in the sections layout")
        Thread.sleep(forTimeInterval: 0.6)
        attach(app, "ios-directors-sections")
    }

    private func waitFor(timeout: TimeInterval = 10, _ check: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if check() { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return check()
    }
}

/// The org this test serves: the Walnut VP (also leading Garden) with Directors, one nested and
/// one under a task that is no Director; the Atlas VP with none. Remembers what the app wrote.
final class DirectorsFixture: @unchecked Sendable {
    enum Write { case patch, post, put }

    private let lock = NSLock()
    private var removed = Set<String>()
    private var layout = "fold"
    private var log: [(Write, [String: Any])] = []
    private(set) var patchedIds: [String] = []

    func writes(_ kind: Write) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return log.filter { $0.0 == kind }.map(\.1)
    }

    func answer(_ method: String, _ target: String, _ body: Data) -> (Int, Any)? {
        lock.lock(); defer { lock.unlock() }
        let path = target.split(separator: "?").first.map(String.init) ?? target
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        switch (method, path) {
        case ("GET", "/api/v1/org"):
            return (200, ["tree": tree()])
        case ("GET", "/api/v1/org/settings"):
            return (200, settings())
        case ("PUT", "/api/v1/org/settings"):
            log.append((.put, json))
            if let l = json["directorsLayout"] as? String { layout = l }
            return (200, settings())
        case ("POST", "/api/v1/tasks"):
            log.append((.post, json))
            return (201, ["task": row("new-1", json["title"] as? String ?? "", project: json["project"] as? String ?? "")])
        case ("GET", "/api/v1/tasks/new-1"):
            var detail = row("new-1", "Release notes", project: "Walnut")
            detail["session_ids"] = [] as [Any]
            return (200, ["task": detail])
        default:
            if method == "PATCH", path.hasPrefix("/api/v1/tasks/") {
                let id = String(path.dropFirst("/api/v1/tasks/".count))
                log.append((.patch, json))
                patchedIds.append(id)
                if json["director"] as? String == "no" { removed.insert(id) }
                var r = row(id, id, project: "Walnut")
                r["director"] = json["director"]
                return (200, ["task": r])
            }
            return nil
        }
    }

    private func settings() -> [String: Any] {
        ["name": "Org", "founderTitle": "Founder", "enabled": true,
         "directorsEnabled": true, "directorsLayout": layout, "directorsShowProjects": true]
    }

    private func row(_ id: String, _ title: String, project: String) -> [String: Any] {
        ["id": id, "title": title, "status": "todo", "phase": "TODO", "priority": "none", "project": project,
         "created_at": "2026-11-20T08:00:00.000Z", "updated_at": "2026-11-20T08:00:00.000Z"]
    }

    private func node(_ id: String, _ title: String, _ project: String, _ state: String, director: Bool, _ workers: [[String: Any]] = []) -> [String: Any] {
        ["kind": "task", "id": id, "title": title, "project": project, "phase": state == "working" ? "IN_PROGRESS" : "TODO",
         "userState": state, "hasSession": false, "director": director && !removed.contains(id), "workers": workers,
         "counts": ["open": 1 + workers.count, "running": state == "working" ? 1 : 0, "needsYou": state == "needs" ? 1 : 0, "waiting": 0]]
    }

    private func tree() -> [String: Any] {
        let walnutTeams = [
            node("d1", "Search ranking rewrite", "Walnut", "working", director: true, [
                node("d2", "Golden set refresh", "Walnut", "needs", director: true, [
                    node("w1", "Collect real queries", "Walnut", "waiting", director: false),
                ]),
            ]),
            node("p1", "Platform upkeep", "Walnut", "waiting", director: false, [
                node("d3", "Deploy guard follow-ups", "Walnut", "waiting", director: true),
            ]),
        ]
        let counts: [String: Any] = ["open": 6, "running": 1, "needsYou": 1, "waiting": 4]
        return [
            "main": ["id": ChatPlaceFixtureServer.mainTaskID, "title": "Main", "phase": "IN_PROGRESS", "hasSession": true],
            "counts": ["open": 9, "running": 1, "needsYou": 1, "waiting": 7],
            "projects": [
                ["project": "Walnut", "lead": ["id": "lead-w", "title": "Walnut VP", "phase": "IN_PROGRESS", "hasSession": true],
                 "contactId": "lead-w", "needsLead": true, "counts": counts, "teams": walnutTeams],
                ["project": "Garden", "lead": ["id": "lead-w", "title": "Walnut VP", "phase": "IN_PROGRESS", "hasSession": true],
                 "contactId": "lead-w", "vp": "Walnut", "needsLead": false, "counts": ["open": 1, "running": 0, "needsYou": 0, "waiting": 1],
                 "teams": [node("g1", "Spring planting plan", "Garden", "waiting", director: true)]],
                ["project": "Atlas", "lead": ["id": "lead-a", "title": "Atlas VP", "phase": "TODO", "hasSession": true],
                 "contactId": "lead-a", "needsLead": false, "counts": ["open": 1, "running": 0, "needsYou": 0, "waiting": 1],
                 "teams": [node("a1", "Map tiles", "Atlas", "waiting", director: false)]],
            ],
        ]
    }
}
