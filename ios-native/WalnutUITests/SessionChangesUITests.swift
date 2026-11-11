import XCTest

/// The session's Changed page, driven like a person would on the demo's sample
/// edits: open it from the session menu, read the list's counts, open a diff,
/// select lines and comment, wrap long lines, open a fold, page through a large
/// file, then send the review and find it in the conversation.
final class SessionChangesUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let tablePath = "src/pages/pricing/PricingTable.tsx"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func text(_ app: XCUIApplication, containing fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Types only once the keyboard is up, so a keystroke never lands on a
    /// target that takes no text (the simulator beeps for each one).
    private func type(_ app: XCUIApplication, _ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no field to type into")
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "no keyboard: nothing typed")
        field.typeText(text)
    }

    /// A beat between steps, so the screen recording shows each one.
    private func beat(_ seconds: Double = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func openPricingSession(_ app: XCUIApplication) {
        let tryDemo = app.buttons["setup.tryDemo"]
        if tryDemo.waitForExistence(timeout: 15) { tryDemo.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 20))
        tasks.tap()
        if !element(app, "tasks.drawer.scrim").waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        let search = app.searchFields["Search tasks & sessions"]
        XCTAssertTrue(search.waitForExistence(timeout: 30), "no search on the board")
        search.tap()
        type(app, search, "pricing")
        let hit = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Redesign the pricing page")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 20), "no hit for pricing")
        hit.tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 20), "the hit opened no session")
    }

    func testReviewADiffLineByLineAndSendItToTheAgent() throws {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        openPricingSession(app)

        // The session menu opens the Changed page.
        app.buttons["session.menu"].tap()
        let changes = element(app, "session.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10), "no Changed Files in the session menu")
        changes.tap()
        let table = element(app, "changes.file.\(Self.tablePath)")
        XCTAssertTrue(table.waitForExistence(timeout: 20), "the Changed list did not show the edited file")
        XCTAssertTrue(text(app, containing: "7 files changed").waitForExistence(timeout: 5), "no file count")
        XCTAssertTrue(text(app, containing: "added").exists, "no line counts on the list")
        beat()
        shot(app, "1-changed-list")

        // A diff, colored and folded.
        table.tap()
        let first = element(app, "diff.line.n1")
        XCTAssertTrue(first.waitForExistence(timeout: 20), "the diff did not draw")
        XCTAssertTrue(element(app, "diff.hint").exists, "no hint on how to comment")
        beat()
        shot(app, "2-diff")

        // Select two lines (tap, then tap the other end) and comment on them.
        first.tap()
        XCTAssertTrue(element(app, "diff.comment").waitForExistence(timeout: 5), "a tap selected nothing")
        element(app, "diff.line.n2").tap()
        XCTAssertTrue(text(app, containing: "2 lines selected").waitForExistence(timeout: 5), "the second tap did not stretch the selection")
        beat()
        element(app, "diff.comment").tap()
        let box = element(app, "diff.comment.text")
        XCTAssertTrue(box.waitForExistence(timeout: 10), "no comment box")
        type(app, box, "Is React state the right place for the annual toggle?")
        beat()
        shot(app, "3-comment-box")
        element(app, "diff.comment.add").tap()
        XCTAssertTrue(element(app, "diff.commentCard").waitForExistence(timeout: 10), "the comment has no card under its lines")
        XCTAssertTrue(element(app, "changes.review").waitForExistence(timeout: 5), "no review bar")
        beat()
        shot(app, "4-comment-card")

        // Long lines: wrap them, then back to one line each.
        element(app, "diff.more").tap()
        let wrapToggle = element(app, "diff.wrap")
        XCTAssertTrue(wrapToggle.waitForExistence(timeout: 5))
        wrapToggle.tap()
        beat()
        shot(app, "5-wrapped")
        element(app, "diff.more").tap()
        XCTAssertTrue(wrapToggle.waitForExistence(timeout: 5))
        wrapToggle.tap()

        // A fold of unchanged lines opens.
        let fold = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'diff.fold.'")).firstMatch
        for _ in 0..<6 where !fold.isHittable { app.swipeUp() }
        XCTAssertTrue(fold.exists, "no fold in a file with distant changes")
        fold.tap()
        beat()

        // Next file, then the large generated one a page at a time.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let big = element(app, "changes.file.src/data/price-history.json")
        XCTAssertTrue(big.waitForExistence(timeout: 10))
        big.tap()
        let more = element(app, "diff.showMore")
        XCTAssertTrue(element(app, "diff.line.n1").waitForExistence(timeout: 30), "the large file did not draw")
        for _ in 0..<40 where !more.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(more.exists, "a 3,600-line file drew without paging")
        more.tap()
        beat()
        shot(app, "6-large-file")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The review goes to the agent as one message, and the page gives way to the conversation.
        let review = element(app, "changes.review")
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()
        let send = element(app, "review.send")
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        beat()
        shot(app, "7-review")
        send.tap()
        XCTAssertTrue(element(app, "changes.list").waitForNonExistence(timeout: 15), "the Changed page stayed up after the send")
        XCTAssertTrue(text(app, containing: "\(Self.tablePath):L1-L2").waitForExistence(timeout: 20),
                      "the review is not in the conversation")
        beat(1.5)
        shot(app, "8-sent")

        // The review is empty now: the page opens without its bar.
        app.buttons["session.menu"].tap()
        element(app, "session.changes").tap()
        XCTAssertTrue(element(app, "changes.list").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "changes.review").waitForExistence(timeout: 2), "the sent comments are still in the review")
    }

    /// The same page in dark mode at the largest text size: the list, the Compare
    /// menu, a diff with a selection, the comment box, the card and the review.
    func testTheChangedPageInDarkModeAtTheLargestTextSize() throws {
        // The simulator's own setting (a launch argument does not reach iOS's
        // appearance); back to light afterwards for the tests that follow.
        XCUIDevice.shared.appearance = .dark
        addTeardownBlock { XCUIDevice.shared.appearance = .light }
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL,
                                       "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openPricingSession(app)
        app.buttons["session.menu"].tap()
        element(app, "session.changes").tap()
        let table = element(app, "changes.file.\(Self.tablePath)")
        XCTAssertTrue(table.waitForExistence(timeout: 20), "the Changed list did not show the edited file")
        beat()
        shot(app, "d1-list")

        element(app, "changes.compare").tap()
        let uncommitted = element(app, "changes.compare.uncommitted")
        XCTAssertTrue(uncommitted.waitForExistence(timeout: 5), "no Uncommitted in the Compare menu")
        beat()
        shot(app, "d2-compare-menu")
        uncommitted.tap()
        XCTAssertTrue(text(app, containing: "Uncommitted changes").waitForExistence(timeout: 10))
        XCTAssertTrue(table.waitForExistence(timeout: 20))
        table.tap()

        let first = element(app, "diff.line.n1")
        XCTAssertTrue(first.waitForExistence(timeout: 20), "the diff did not draw")
        beat()
        shot(app, "d3-diff")
        first.tap()
        XCTAssertTrue(element(app, "diff.comment").waitForExistence(timeout: 5), "a tap selected nothing")
        element(app, "diff.line.n2").tap()
        XCTAssertTrue(text(app, containing: "2 lines selected").waitForExistence(timeout: 5))
        beat()
        shot(app, "d4-selected")
        element(app, "diff.comment").tap()
        let box = element(app, "diff.comment.text")
        XCTAssertTrue(box.waitForExistence(timeout: 10), "no comment box")
        type(app, box, "Keep the toggle in the URL.")
        beat()
        shot(app, "d5-comment-box")
        element(app, "diff.comment.add").tap()
        XCTAssertTrue(element(app, "diff.commentCard").waitForExistence(timeout: 10), "no card under the lines")
        beat()
        shot(app, "d6-card")

        app.navigationBars.buttons.element(boundBy: 0).tap()
        let review = element(app, "changes.review")
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()
        XCTAssertTrue(element(app, "review.send").waitForExistence(timeout: 10))
        beat()
        shot(app, "d7-review")
    }

    /// Every other way in: the comparison menu and the branch-or-commit picker,
    /// a long press, editing, removing and restoring a card, a sideways scroll, the next
    /// file, Send Now, a minified line, and the review's copy, swipe and the
    /// comment that opens its own diff from another comparison.
    func testEveryOtherWayToUseTheChangedPage() throws {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        openPricingSession(app)
        app.buttons["session.menu"].tap()
        element(app, "session.changes").tap()
        XCTAssertTrue(element(app, "changes.file.\(Self.tablePath)").waitForExistence(timeout: 20))

        // The comparison menu, then the picker with a search.
        element(app, "changes.compare").tap()
        let uncommitted = element(app, "changes.compare.uncommitted")
        XCTAssertTrue(uncommitted.waitForExistence(timeout: 5), "no Uncommitted in the Compare menu")
        beat()
        shot(app, "c1-compare-menu")
        uncommitted.tap()
        XCTAssertTrue(text(app, containing: "Uncommitted changes").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "changes.file.\(Self.tablePath)").waitForExistence(timeout: 20))
        element(app, "changes.compare").tap()
        element(app, "changes.compare.other").tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10), "no search in the picker")
        // The field shows under the title as it opens, not folded into a blank round
        // button at the bottom (2026-11-11 acceptance, shot a17).
        XCTAssertTrue(search.isHittable, "the picker's search is not on screen as it opens")
        XCTAssertLessThan(search.frame.midY, app.frame.height / 3, "the picker's search is not under its title")
        search.tap()
        type(app, search, "annual")
        let commit = element(app, "compare.commit.4f2c9e1")
        XCTAssertTrue(commit.waitForExistence(timeout: 10), "the search did not find the commit")
        beat()
        shot(app, "c2-compare-picker")
        commit.tap()
        XCTAssertTrue(text(app, containing: "Commit 4f2c9e1").waitForExistence(timeout: 10), "the commit is not the comparison")
        let table = element(app, "changes.file.\(Self.tablePath)")
        XCTAssertTrue(table.waitForExistence(timeout: 20))
        table.tap()

        // A long press selects one line (Copy and Comment in the bar); a tap on the
        // card edits it; x removes one, and Undo brings it back.
        let first = element(app, "diff.line.n1")
        XCTAssertTrue(first.waitForExistence(timeout: 20))
        first.press(forDuration: 1.0)
        XCTAssertTrue(text(app, containing: "1 line selected").waitForExistence(timeout: 5), "a long press selected nothing")
        XCTAssertTrue(element(app, "diff.selection.copy").exists, "no Copy in the selection bar")
        beat()
        shot(app, "c3-line-selected")
        // Copy takes the line and says so; a second long press selects it again.
        element(app, "diff.selection.copy").tap()
        XCTAssertTrue(element(app, "diff.notice").waitForExistence(timeout: 5), "Copy said nothing")
        first.press(forDuration: 1.0)
        XCTAssertTrue(element(app, "diff.comment").waitForExistence(timeout: 5))
        element(app, "diff.comment").tap()
        let box = element(app, "diff.comment.text")
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        type(app, box, "Why import useState here?")
        element(app, "diff.comment.add").tap()
        let card = element(app, "diff.commentCard")
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        text(app, containing: "Why import useState here?").tap()
        XCTAssertTrue(element(app, "diff.comment.save").waitForExistence(timeout: 10), "a tap on the card did not open it")
        // The box opens focused with the cursor after the words.
        type(app, element(app, "diff.comment.text"), " It is used once.")
        element(app, "diff.comment.save").tap()
        XCTAssertTrue(text(app, containing: "It is used once.").waitForExistence(timeout: 10), "the edit did not save")
        element(app, "diff.line.n4").tap()
        element(app, "diff.comment").tap()
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        type(app, box, "Throwaway")
        element(app, "diff.comment.add").tap()
        XCTAssertTrue(text(app, containing: "Throwaway").waitForExistence(timeout: 10))
        let removeButtons = app.buttons.matching(identifier: "diff.comment.remove")
        XCTAssertEqual(removeButtons.count, 2)
        removeButtons.element(boundBy: 1).tap()
        // Undo first: it stays 5 seconds, and a wait for the card to be gone would
        // spend them on a slow runner before Undo was looked for.
        let undo = element(app, "diff.undoRemove")
        XCTAssertTrue(undo.waitForExistence(timeout: 4), "no Undo after removing a comment")
        XCTAssertFalse(text(app, containing: "Throwaway").exists, "x did not remove the card")
        undo.tap()
        XCTAssertTrue(text(app, containing: "Throwaway").waitForExistence(timeout: 5), "Undo did not bring the comment back")
        app.buttons.matching(identifier: "diff.comment.remove").element(boundBy: 1).tap()
        XCTAssertFalse(text(app, containing: "Throwaway").waitForExistence(timeout: 2))

        // Sideways: the lines move, the fold stays in view.
        let lines = element(app, "diff.lines")
        lines.swipeLeft()
        lines.swipeLeft()
        let fold = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'diff.fold.'")).firstMatch
        XCTAssertTrue(fold.waitForExistence(timeout: 5))
        XCTAssertTrue(fold.isHittable, "the fold scrolled away with the lines")
        beat()
        shot(app, "c4-scrolled-sideways")
        lines.swipeRight()
        lines.swipeRight()

        // The next file, and Send Now from there.
        element(app, "diff.nextFile").tap()
        XCTAssertTrue(app.navigationBars["plans.ts"].waitForExistence(timeout: 10), "the next file did not open")
        let planLine = element(app, "diff.line.n1")
        XCTAssertTrue(planLine.waitForExistence(timeout: 20))
        planLine.tap()
        element(app, "diff.comment").tap()
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        type(app, box, "Keep Plan in its own file?")
        element(app, "diff.comment.sendNow").tap()
        XCTAssertTrue(element(app, "diff.notice").waitForExistence(timeout: 15), "Send Now said nothing")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // A built bundle's one line is drawn cut, with how much is left.
        let bundle = element(app, "changes.file.public/assets/pricing.min.js")
        for _ in 0..<4 where !bundle.isHittable { app.swipeUp() }
        bundle.tap()
        XCTAssertTrue(text(app, containing: "more characters").waitForExistence(timeout: 20), "the long line is not cut")
        XCTAssertTrue(element(app, "diff.cutNote").exists, "the header does not say the line is cut")
        beat()
        shot(app, "c5-minified-line")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // From another comparison, the review opens the comment's own diff at it.
        element(app, "changes.compare").tap()
        element(app, "changes.compare.session").tap()
        XCTAssertTrue(text(app, containing: "What this session changed").waitForExistence(timeout: 10))
        element(app, "changes.review").tap()
        let row = app.buttons.matching(identifier: "review.row").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(element(app, "diff.commentCard").waitForExistence(timeout: 20), "the comment's diff opened without its card")
        XCTAssertTrue(text(app, containing: "It is used once.").exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Copy, then swipe the comment away: the review is empty and sends nothing.
        element(app, "changes.review").tap()
        element(app, "review.more").tap()
        element(app, "review.copy").tap()
        XCTAssertTrue(app.alerts["Copied"].waitForExistence(timeout: 5))
        app.alerts["Copied"].buttons["OK"].tap()
        beat()
        shot(app, "c6-review")
        row.swipeLeft()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "no swipe to remove")
        delete.tap()
        let undoSwipe = element(app, "review.undoRemove")
        XCTAssertTrue(undoSwipe.waitForExistence(timeout: 3), "no Undo after a swipe")
        undoSwipe.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Undo did not bring the comment back")
        row.swipeLeft()
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        XCTAssertTrue(text(app, containing: "No comments yet").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "review.send").isEnabled)
    }
}
