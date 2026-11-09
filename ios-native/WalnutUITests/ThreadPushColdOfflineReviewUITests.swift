import XCTest

/// A cached VP thread tapped at a cold launch while the server is unreachable.
/// The last saved chat belongs to another VP, so restoring it is not a successful open.
final class ThreadPushColdOfflineReviewUITests: ThreadPushUITestCase {
    override var shotPrefix: String { "CO" }

    func testColdOfflineTapUsesTheCachedTargetVPInsteadOfTheLastSavedChat() throws {
        let server = try XCTUnwrap(fixture)
        let target = ids[7]

        // Read the target VP online so its threads and session list are cached on disk.
        try openBarPage("online-cache")
        XCTAssertTrue(cardTitle(target).exists, "Setup: the target thread was not read online")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10),
                      "Setup: Back did not reach Growth VP's chat")

        // Leave another VP's chat as the saved place before the process ends.
        push(ids2[0], task: vp2)
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 20),
                      "Setup: Design VP's page did not open")
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 10),
                      "Setup: the page is not Design VP's")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10),
                      "Setup: Back did not reach Design VP's chat")
        XCTAssertTrue(titled("Design").waitForExistence(timeout: 10),
                      "Setup: Design VP's chat is not the last saved place")
        shot("last-place-is-other-vp")

        // Let pending cache writes settle, then end the app and refuse every connection.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.terminate()
        server.setReachable(false)
        defer { server.setReachable(true) }

        // Launch through the shared helper so test keychain and silent audio flags stay on.
        // No pairing form is allowed here: the pairing from the online setup must survive.
        app = UITestLaunch.launch([
            "-walnut.serverUrl", server.url,
            "-walnut.deviceToken", "chat-place-fixture",
            "-walnut.debugThreadPushLate", "\(vp) \(target)",
        ])
        let reachedPage = el("org.node.page").waitForExistence(timeout: 75)
        shot("cold-offline-result")
        XCTAssertTrue(reachedPage,
                      "Cold offline push opened no VP Threads page despite the phone holding the target VP's session and threads; a failure banner or restoration of Design VP is not a successful open")
        XCTAssertTrue(titled(OrgThreadsFixture.vpName).waitForExistence(timeout: 10),
                      "Cold offline push opened the wrong VP instead of Growth VP")
        XCTAssertTrue(poll(10) { segment("Threads").isSelected },
                      "Cold offline push did not bring Threads to the front")
        XCTAssertTrue(poll(15) { inView(cardTitle(target)) },
                      "Cold offline push did not reveal its cached target thread: \(whereIs(cardTitle(target)))")
        XCTAssertFalse(titled(OrgThreadsFixture.vp2Name).exists,
                       "Cold offline push restored the last saved Design VP over the requested Growth VP")
        shot("cached-target-visible")
    }
}
