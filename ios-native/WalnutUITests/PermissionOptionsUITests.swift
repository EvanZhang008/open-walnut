import XCTest

/// UI layer for the permission card's answers: a Claude prompt's remembering
/// options as rows with their rule, an ACP adapter's own options, the plain
/// Allow / Deny, and the note a deny carries to the agent.
///
/// Drives the DEBUG `-perm-harness` (PermissionOptionsHarnessView), which renders
/// the PRODUCT stack against the shapes the server sends and reads each answer
/// back as its request body would carry it.
final class PermissionOptionsUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        UITestLaunch.launch(["-perm-harness"])
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func all(_ identifier: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier))
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func answer(_ requestId: String, in app: XCUIApplication) -> String? {
        let row = id("perm.harness.answer.\(requestId)", in: app)
        guard row.waitForExistence(timeout: 10) else { return nil }
        return row.label
    }

    func testOptionsShowTheirRuleAndAnswerWithTheirId() {
        let app = launch()
        let session = id("session.permission.option.allow_session", in: app)
        XCTAssertTrue(session.waitForExistence(timeout: 30))
        XCTAssertTrue(id("session.permission.option.allow_always", in: app).exists)
        XCTAssertTrue(id("session.permission.option.reject_once", in: app).exists)
        // The rule each remembering option allows is on screen under its label.
        XCTAssertTrue(session.label.contains("Bash(npm test:*)"), "row label was \(session.label)")
        // The ACP card's own options, and the plain pair on the third card.
        XCTAssertTrue(id("session.permission.option.approved-for-session", in: app).exists)
        XCTAssertTrue(id("session.permission.option.abort", in: app).exists)
        XCTAssertTrue(id("session.permission.allow", in: app).exists)
        XCTAssertTrue(id("session.permission.deny", in: app).exists)
        // A note field on the Claude card and the plain card, none on the ACP one.
        XCTAssertEqual(all("session.permission.note", in: app).count, 2)
        shot("permission-options", app)

        session.tap()
        let sent = answer("perm-claude-bash", in: app)
        XCTAssertEqual(sent, "perm-claude-bash: allow=true optionId=allow_session message=-")

        id("session.permission.option.abort", in: app).tap()
        XCTAssertEqual(answer("perm-acp-edit", in: app), "perm-acp-edit: allow=false optionId=abort message=-")
    }

    func testARuleKeptInAFileTakesASecondTap() {
        let app = launch()
        let always = id("session.permission.option.allow_always", in: app)
        XCTAssertTrue(always.waitForExistence(timeout: 30))
        // The first tap only arms it: nothing is sent, and the row says what the next tap does.
        always.tap()
        let armed = expectation(for: NSPredicate(format: "label CONTAINS %@", "Tap again within 5 s to save to .claude/settings.local.json"), evaluatedWith: always)
        wait(for: [armed], timeout: 5)
        XCTAssertFalse(id("perm.harness.answer.perm-claude-bash", in: app).exists)
        shot("permission-always-armed", app)
        always.tap()
        XCTAssertEqual(answer("perm-claude-bash", in: app), "perm-claude-bash: allow=true optionId=allow_always message=-")
    }

    func testATypedNoteTurnsTheAllowChoicesOff() {
        let app = launch()
        let note = all("session.permission.note", in: app).element(boundBy: 0)
        XCTAssertTrue(note.waitForExistence(timeout: 30))
        note.tap()
        note.typeText("Use pnpm here")
        let session = id("session.permission.option.allow_session", in: app)
        let off = expectation(for: NSPredicate(format: "isEnabled == false"), evaluatedWith: session)
        wait(for: [off], timeout: 5)
        XCTAssertFalse(id("session.permission.option.allow_always", in: app).isEnabled)
        XCTAssertTrue(id("session.permission.option.reject_once", in: app).isEnabled)
    }

    func testANoteTurnsDenyIntoDenyWithNoteAndReturnSendsIt() {
        let app = launch()
        let note = all("session.permission.note", in: app).element(boundBy: 0)
        XCTAssertTrue(note.waitForExistence(timeout: 30))
        note.tap()
        note.typeText("Use pnpm here")
        let deny = id("session.permission.option.reject_once", in: app)
        let relabeled = expectation(for: NSPredicate(format: "label == %@", "Deny with note"), evaluatedWith: deny)
        wait(for: [relabeled], timeout: 5)
        shot("permission-deny-with-note", app)
        // Return in the note sends that deny, with the note as the agent reads it.
        note.typeText("\n")
        XCTAssertEqual(
            answer("perm-claude-bash", in: app),
            "perm-claude-bash: allow=false optionId=reject_once message=The user denied this tool call and said: Use pnpm here"
        )

        // The plain pair's Deny carries a note too, and a tap sends it the same way.
        let plainNote = id("session.permission.note", in: app)
        XCTAssertTrue(plainNote.waitForExistence(timeout: 5))
        plainNote.tap()
        plainNote.typeText("Fetch the docs page instead")
        let plainDeny = id("session.permission.deny", in: app)
        let plainRelabeled = expectation(for: NSPredicate(format: "label == %@", "Deny with note"), evaluatedWith: plainDeny)
        wait(for: [plainRelabeled], timeout: 5)
        plainDeny.tap()
        XCTAssertEqual(
            answer("perm-claude-plain", in: app),
            "perm-claude-plain: allow=false optionId=- message=The user denied this tool call and said: Fetch the docs page instead"
        )
    }
}
