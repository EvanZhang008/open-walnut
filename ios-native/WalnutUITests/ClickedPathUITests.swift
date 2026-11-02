import XCTest

/// A tapped Mac path in a session that runs on another host opens from the Mac
/// (ClickedPath.locate, GET /v1/files/locate).
///
/// Needs a server that knows such a session: an ephemeral copy of a Walnut whose
/// board has a task running on a remote host and whose transcript names an MP4
/// under /Users/ that exists only on the Mac. WALNUT_UITEST_ROW_ID is that task,
/// WALNUT_UITEST_ROW_QUERY the board search that finds it. Read-only: it opens
/// the session and the file, and types nothing into the session.
final class ClickedPathUITests: XCTestCase {
    private var appUnderTest: XCUIApplication?

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let appUnderTest {
            let shot = XCTAttachment(screenshot: appUnderTest.screenshot())
            shot.name = "final-screen"; shot.lifetime = .keepAlways; add(shot)
        }
        appUnderTest = nil
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor func testAMacPathInARemoteSessionOpensFromTheMac() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["WALNUT_UITEST_SERVER"], let token = env["WALNUT_UITEST_TOKEN"],
              let taskID = env["WALNUT_UITEST_ROW_ID"], !taskID.isEmpty,
              let query = env["WALNUT_UITEST_ROW_QUERY"], !query.isEmpty
        else { throw XCTSkip("Run against a server with a remote session that names a Mac MP4") }
        let root = try XCTUnwrap(URL(string: UITestLaunch.pairedServer(server)))
        guard ["127.0.0.1", "localhost"].contains(root.host ?? ""), ![3456, 3457].contains(root.port ?? 0) else {
            throw XCTSkip("only an ephemeral copy, never the live server")
        }
        let app = UITestLaunch.launch(["-walnut.serverUrl", UITestLaunch.pairedServer(server), "-walnut.deviceToken", token])
        appUnderTest = app

        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 40)); tasks.tap()
        let search = app.searchFields.firstMatch
        if !search.waitForExistence(timeout: 10) {
            let menu = app.buttons["tasks.menu"].firstMatch
            if menu.waitForExistence(timeout: 10) { menu.tap() }
        }
        XCTAssertTrue(search.waitForExistence(timeout: 15)); search.tap(); search.typeText(query + "\n")
        // A pinned task is a board row; any other is a search result row.
        let row = app.descendants(matching: .any).matching(NSPredicate(
            format: "(identifier BEGINSWITH 'board.row.' OR identifier BEGINSWITH 'tasks.row.') AND identifier CONTAINS %@",
            taskID)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the task is not on the board or in the search results")
        for _ in 0..<4 where !row.isHittable { app.swipeUp(velocity: .slow) }
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.composer"].waitForExistence(timeout: 40))

        let link = app.links.matching(NSPredicate(format: "label BEGINSWITH '/Users/' AND label CONTAINS '.mp4'")).firstMatch
        // The session keeps talking: the link may be on an earlier page.
        let earlier = app.buttons["Load earlier messages"].firstMatch
        for _ in 0..<30 where !(link.exists && link.isHittable) {
            if earlier.exists && earlier.isHittable { earlier.tap(); sleep(2) } else { app.swipeDown(velocity: .slow) }
        }
        for _ in 0..<6 where link.exists && !link.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(link.isHittable, "no Mac MP4 link in the session")
        sleep(1)
        link.tap()

        let note = app.descendants(matching: .any)["session.files.viewer.hostNote"]
        XCTAssertTrue(note.waitForExistence(timeout: 20), "the viewer does not say the file came from the Mac")
        XCTAssertTrue(note.label.contains("Opened from your Mac."), note.label)
        XCTAssertFalse(app.descendants(matching: .any)["session.files.viewer.missing"].exists)
        let player = app.descendants(matching: .any)["session.media.player"]
        XCTAssertTrue(player.waitForExistence(timeout: 30), "the MP4 did not open in the player")
        // Play a few seconds, so the recording shows the Mac's video itself.
        let play = app.buttons["Play"].firstMatch
        if !play.waitForExistence(timeout: 3) { player.tap() }
        if play.waitForExistence(timeout: 5) && play.isHittable { play.tap() }
        sleep(6)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "opened-from-mac"; shot.lifetime = .keepAlways; add(shot)
    }
}
