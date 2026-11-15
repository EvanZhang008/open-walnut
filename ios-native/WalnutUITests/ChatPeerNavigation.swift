import XCTest

/// A chat opened over the Chat tab's chat (an ask, Main, a VP) is its peer, not a page above it:
/// it has no Back. The top-left button opens the sidebar, and the sidebar's Chats list is the way
/// to the chat itself. Every UI test that must leave such a chat goes through here, so none taps
/// "the first navigation bar button" and opens the sidebar instead of going back.
extension XCUIApplication {
    /// Off any chat a previous run left over the chat, onto the chat itself.
    func leaveChatPeerForTheChat(file: StaticString = #filePath, line: UInt = #line) {
        guard buttons["session.title"].exists else { return }
        let menu = buttons["chat.session.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "no sidebar button on the session's chat", file: file, line: line)
        menu.tap()
        let picker = segmentedControls["chat.drawer.viewSwitch"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "the sidebar did not open", file: file, line: line)
        if !picker.buttons["Chats"].isSelected { picker.buttons["Chats"].tap() }
        let rows = buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat.drawer.conversation.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "no conversation in the drawer", file: file, line: line)
        rows.firstMatch.tap()
        XCTAssertTrue(buttons["chat.menu"].waitForExistence(timeout: 20), "the sidebar did not return to the chat",
                      file: file, line: line)
    }

    /// Main's chat (the org's CEO node) with its Threads, Tasks and Brief bar, opened from the
    /// chat drawer's Org view, or already open from a last run. A failure says what was on screen
    /// instead: the open's own notice, or the chat that opened without its bar.
    func openMainOrgChat(file: StaticString = #filePath, line: UInt = #line) {
        let threads = descendants(matching: .any)["org.bar.threads"].firstMatch
        if threads.waitForExistence(timeout: 8) { return }
        leaveChatPeerForTheChat(file: file, line: line)
        let menu = buttons["chat.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 60), "the chat never appeared", file: file, line: line)
        menu.tap()
        let picker = segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5), picker.buttons["Org"].exists { picker.buttons["Org"].tap() }
        let ceo = buttons["chat.drawer.org.ceo"]
        XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no Main row in the drawer's Org view", file: file, line: line)
        ceo.tap()
        guard !threads.waitForExistence(timeout: 30) else { return }
        let notice = descendants(matching: .any)["chat.orgOpenNotice"].firstMatch
        let title = buttons["session.title"]
        let seen = notice.exists ? "the open said \"\(notice.label)\""
            : title.exists ? "a chat titled \"\(title.label)\" opened without the bar"
            : "nothing opened"
        XCTFail("Main's chat has no Threads, Tasks and Brief bar: \(seen)", file: file, line: line)
    }
}
