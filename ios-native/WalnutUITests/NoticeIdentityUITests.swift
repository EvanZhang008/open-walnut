import XCTest

/// Every notice can be found by its own id, alone on the stack or among others.
///
/// A lone notice lost its id (2026-11-22 to 11-24): the stack wrapped its cards in an accessibility
/// container of its own, SwiftUI folds a container over one child into that child, and the stack's
/// "notice.stack" replaced the card's id. Every push test that waits for "chat.orgOpening" or
/// "chat.orgOpenNotice" then failed, though the card was on screen. Any id a notice is posted with
/// is the same case, so the check runs on the debug samples (`NoticeDebugSamples`), with no server.
final class NoticeIdentityUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func testALoneNoticeKeepsItsOwnId() {
        let app = UITestLaunch.launch(["-walnut.debugNotices", "one"])
        defer { app.terminate() }
        let card = element(app, "debug.ok")
        XCTAssertTrue(card.waitForExistence(timeout: 20), "a lone notice cannot be found by its id")
        XCTAssertTrue(element(app, "debug.ok.close").exists, "its close button has no id of the notice")
        XCTAssertTrue(card.frame.contains(element(app, "debug.ok.close").frame),
                      "the element with the notice's id is not the card that holds its close button")
    }

    func testEveryNoticeOnTheStackKeepsItsOwnId() {
        let app = UITestLaunch.launch(["-walnut.debugNotices", "YES"])
        defer { app.terminate() }
        // The three newest are in sight; the oldest folds into "1 more".
        for id in ["debug.ok", "debug.upload", "debug.error"] {
            XCTAssertTrue(element(app, id).waitForExistence(timeout: 20), "the notice \(id) cannot be found by its id")
        }
        XCTAssertTrue(element(app, "notice.more").exists, "the folded notice has no \"more\" key")
    }
}
