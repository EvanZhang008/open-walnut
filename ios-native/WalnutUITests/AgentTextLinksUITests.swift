import UIKit
import XCTest

final class AgentTextLinksUITests: XCTestCase {
    struct Subjects: Decodable { let target, source, html: String; let oldTurn: String? }
    struct Letters: Decodable { let target, source, html: String; let oldTurn: String?; let subjects: Subjects }
    struct StatusTasks: Decodable { let boardFile, boardLetter, teamFile, teamLetter: String }
    struct OrgThreads: Decodable { let knownId, unknownId: String }
    struct Org: Decodable { let project, leadId, file, letter: String; let threads: OrgThreads? }
    struct Plan: Decodable { let file, marker: String }
    struct Code: Decodable { let marker, wide: String }
    struct Fixture: Decodable {
        let taskId, readme, image: String; let letters: Letters; let statusTasks: StatusTasks?; let org: Org?
        let plan: Plan?; let code: Code?
    }

    static let lineOne = "File preview regression: line one"
    static let lineTwo = "File preview regression: line two"
    static let inlineMarker = "Inline document marker"
    static let deferredMarker = "Deferred turn marker"

    var server = ""
    var token = ""
    var fixture: Fixture!
    var appUnderTest: XCUIApplication?
    var segment: String?

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["WALNUT_UITEST_SERVER"], let bearer = env["WALNUT_UITEST_TOKEN"] else {
            throw XCTSkip("Run with the isolated media fixture")
        }
        server = UITestLaunch.pairedServer(url); token = bearer
        guard let root = URL(string: server), root.scheme == "http",
              ["127.0.0.1", "localhost"].contains(root.host ?? ""),
              let port = root.port, ![3456, 3457].contains(port) else {
            throw XCTSkip("Only an isolated loopback fixture, never the live server")
        }
        let state: Data
        do { state = try request("state") } catch { throw XCTSkip("\(server) is not the media fixture: \(error)") }
        guard let decoded = try? JSONDecoder().decode(Fixture.self, from: state) else {
            throw XCTSkip("The fixture state has no agent text letters")
        }
        fixture = decoded
        // A time mark per test on the fixture's clock, so a recording of the run can be cut per test.
        let mark = Self.queryValue(name)
        if (try? request("segment?phase=start&name=" + mark, method: "POST")) != nil { segment = mark }
        _ = try request("fault?mode=off", method: "POST")
        _ = try request("document-fault?mode=off", method: "POST")
    }

    override func tearDown() {
        if let appUnderTest {
            let attachment = XCTAttachment(string: appUnderTest.debugDescription)
            attachment.name = "final-screen-hierarchy"; attachment.lifetime = .keepAlways; add(attachment)
            let shot = XCTAttachment(screenshot: appUnderTest.screenshot())
            shot.name = "final-screen"; shot.lifetime = .keepAlways; add(shot)
        }
        appUnderTest = nil
        if let segment {
            let result = testRun?.totalFailureCount == 0 ? "passed" : "failed"
            try? request("segment?phase=end&result=\(result)&name=" + segment, method: "POST")
        }
        segment = nil
        try? request("fault?mode=off", method: "POST")
        try? request("document-fault?mode=off", method: "POST")
        UITestLaunch.terminate()
        super.tearDown()
    }

    // MARK: - Scenarios

    @MainActor func testPreviewFileLinkOpensTheViewerNotTheLetter() throws {
        let app = try openInbox()
        let before = try fileReads()
        let row = sourceRow(app)
        try capture(app, "agent-preview-before-tap")
        tapPreviewFileLink(row)
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertFalse(readerOpen(app), "the preview link opened the letter instead of the file")
        XCTAssertGreaterThan(try fileReads(), before, "the viewer did not read the real file")
        try capture(app, "agent-preview-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(element(app, "inbox.list").waitForExistence(timeout: 10))
        XCTAssertFalse(readerOpen(app), "closing the viewer left a letter open")
        XCTAssertTrue(row.isHittable)
        try capture(app, "agent-preview-viewer-closed")
    }

    @MainActor func testMarkdownBodyLetterLinkOpensTheSheetAndDoneReturns() throws {
        let app = try openInbox()
        _ = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        let target = bodyLink(app, label: fixture.letters.target)
        tapReady(target, in: element(app, "inbox.letter.document"))
        expectLetterSheet(app)
        try capture(app, "agent-body-letter-sheet")
        closeLetterSheet(app, returningTo: target)
        try capture(app, "agent-body-letter-sheet-closed")
    }

    @MainActor func testMarkdownBodyFileLinkOpensTheViewer() throws {
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        tapReady(bodyLink(app, label: "readme.txt", contains: true), in: element(app, "inbox.letter.document"))
        expectTextViewer(app, showing: Self.lineTwo)
        try capture(app, "agent-body-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(source.waitForExistence(timeout: 10))
    }

    @MainActor func testAgentPlainTurnLetterLinkOpensTheSheetAndDoneReturns() throws {
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        let conversation = element(app, "inbox.letter.conversation")
        XCTAssertTrue(conversation.waitForExistence(timeout: 20), "the letter shows no conversation")
        tapReady(link(in: conversation, fixture.letters.target), in: conversation)
        expectLetterSheet(app)
        try capture(app, "agent-turn-letter-sheet")
        closeLetterSheet(app, returningTo: link(in: conversation, fixture.letters.target))
        XCTAssertTrue(conversation.exists)
        try capture(app, "agent-turn-letter-sheet-closed")
    }

    @MainActor func testInlineHTMLFileAndLetterLinksOpenInTheApp() throws {
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        let page = try routedPage(app, marker: Self.inlineMarker, turn: nil)
        try capture(app, "agent-html-routed")
        let before = try fileReads()
        tapReady(link(in: page, "readme.txt line 2", contains: true), in: element(app, "inbox.letter.document"))
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertGreaterThan(try fileReads(), before)
        try capture(app, "agent-html-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        tapReady(link(in: page, fixture.letters.target), in: element(app, "inbox.letter.document"))
        expectLetterSheet(app)
        try capture(app, "agent-html-letter-sheet")
        closeLetterSheet(app, returningTo: link(in: page, fixture.letters.target))
    }

    @MainActor func testDeferredHTMLTurnFileAndLetterLinksOpenInTheApp() throws {
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        XCTAssertGreaterThan(try routedRead(turn: 0).bytes, 1_048_576, "the turn was not served as a deferred document")
        let page = try routedPage(app, marker: Self.deferredMarker, turn: 0)
        XCTAssertFalse(element(app, "inbox.letter.turn.deferredBodyError").exists)
        let conversation = element(app, "inbox.letter.conversation")
        try capture(app, "agent-deferred-routed")
        tapReady(link(in: page, "turn readme line 1", contains: true), in: conversation)
        expectTextViewer(app, showing: Self.lineOne)
        try capture(app, "agent-deferred-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        tapReady(link(in: page, fixture.letters.target), in: conversation)
        expectLetterSheet(app)
        try capture(app, "agent-deferred-letter-sheet")
        closeLetterSheet(app, returningTo: link(in: page, fixture.letters.target))
    }

    @MainActor func testDragsThatStartOnLinksOpenNothing() throws {
        let app = try openInbox()
        drag(from: previewLinkPoint(sourceRow(app)), by: 160)
        assertNothingOpens(app, "a drag over the preview link")
        XCTAssertFalse(readerOpen(app), "a drag over the preview opened the letter")
        try capture(app, "agent-drag-preview")

        _ = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        let body = bodyLink(app, label: fixture.letters.target)
        makeHittable(body, in: element(app, "inbox.letter.document"))
        drag(from: body.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), by: 220)
        assertNothingOpens(app, "a drag over the body's letter link")
        try capture(app, "agent-drag-body")
        goBack(app)

        _ = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        let web = link(in: try routedPage(app, marker: Self.inlineMarker, turn: nil), fixture.letters.target)
        makeHittable(web, in: element(app, "inbox.letter.document"))
        drag(from: web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), by: 220)
        assertNothingOpens(app, "a drag over the HTML letter link")
        try capture(app, "agent-drag-html")
    }

    @MainActor func testCloseAndReopenOpensNothingByItself() throws {
        let app = try openInbox()
        for round in 0..<2 {
            let source = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
            assertNothingOpens(app, "reopening the markdown letter (round \(round))")
            let target = bodyLink(app, label: fixture.letters.target)
            tapReady(target, in: element(app, "inbox.letter.document"))
            expectLetterSheet(app)
            closeLetterSheet(app, returningTo: target)
            assertNothingOpens(app, "closing the letter sheet (round \(round))")
            try capture(app, "agent-reopen-markdown-\(round)")
            goBack(app)
            assertNothingOpens(app, "going back to the inbox (round \(round))")
        }
        for round in 0..<2 {
            let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
            assertNothingOpens(app, "reopening the HTML letter (round \(round))")
            let page = try routedPage(app, marker: Self.inlineMarker, turn: nil)
            tapReady(link(in: page, fixture.letters.target), in: element(app, "inbox.letter.document"))
            expectLetterSheet(app)
            closeLetterSheet(app, returningTo: link(in: page, fixture.letters.target))
            assertNothingOpens(app, "closing the HTML letter's sheet (round \(round))")
            try capture(app, "agent-reopen-html-\(round)")
            goBack(app)
            assertNothingOpens(app, "going back from the HTML letter (round \(round))")
        }
    }

    @MainActor func testSelectModeTapOnThePreviewLinkSelectsTheRow() throws {
        let app = try openInbox()
        let row = sourceRow(app)
        tap(element(app, "inbox.select"))
        XCTAssertTrue(app.navigationBars["Select Letters"].waitForExistence(timeout: 10))
        tapPreviewFileLink(row)
        XCTAssertTrue(app.navigationBars["1 Selected"].waitForExistence(timeout: 10), "the tap did not select the row")
        assertNothingOpens(app, "a Select mode tap on the preview link")
        XCTAssertFalse(readerOpen(app), "a Select mode tap opened the letter")
        try capture(app, "agent-select-preview")
        tap(element(app, "inbox.selectDone"))
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 10))
        tapPreviewFileLink(row)
        expectTextViewer(app, showing: Self.lineTwo)
        try capture(app, "agent-select-done-preview")
        closeTextViewer(app)
    }

    @MainActor func testMarkdownBodyImageLoadsFromTheFixtureRoot() throws {
        let seq = try lastSeq()
        let app = try openInbox()
        _ = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        // The letter's sender runs on the primary: its image is the primary's raw file, never the
        // media route (which reads the primary's copy first whichever machine was meant).
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            ((try? self.rawFileReads(of: self.fixture.image, served: true)) ?? 0) > 0
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 30), .completed, "the image was never read from the server")
        XCTAssertEqual(try mediaRequests(after: seq), 0, "the image went through the media route")
        let failed = app.staticTexts.matching(NSPredicate(format: "label == 'Fixture chart'")).firstMatch
        XCTAssertFalse(failed.waitForExistence(timeout: 3), "the image shows its failure line")
        try capture(app, "agent-body-image")
    }

    @MainActor func testTaskDetailSummaryLinksOpenHereNotAnotherTask() throws {
        let app = try openSession()
        tap(element(app, "session.menu"))
        tap(element(app, "session.taskDetails"))
        let heading = app.staticTexts.matching(NSPredicate(format: "label == 'Summary'")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 20), "the task details show no summary")
        let summary = element(app, "task.summary")
        XCTAssertTrue(summary.waitForExistence(timeout: 20) && summary.label.contains("Summary:"), "the seed summary was replaced")
        let sheet = element(app, "task.detail.scroll")
        XCTAssertTrue(sheet.waitForExistence(timeout: 15))
        let tasks = taskPagesOpen(app)
        let before = try fileReads()
        let seqBefore = try lastSeq()
        try capture(app, "agent-summary-before-tap")
        tapReady(link(in: summary, "readme.txt", contains: true), in: sheet)
        // The fixture's summary records no writer session: the phone names no machine for it and
        // reads nothing until the user picks one.
        let missing = element(app, "session.files.viewer.missing")
        XCTAssertTrue(missing.waitForExistence(timeout: 20), "an unknown writer did not open the not-recorded viewer")
        let notRecorded = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'was not recorded'")).firstMatch
        XCTAssertTrue(notRecorded.waitForExistence(timeout: 5), "the viewer does not say the source was not recorded")
        XCTAssertTrue(app.staticTexts["Choose a machine"].exists, "the question to answer is titled as a fault")
        XCTAssertFalse(app.staticTexts["Not Found"].exists, "choosing a machine reads as a missing file")
        let local = element(app, "session.files.viewer.pick.local")
        XCTAssertTrue(local.waitForExistence(timeout: 5), "the viewer offers no Local choice")
        XCTAssertEqual(try fileReads(), before, "an unknown writer read a file before the user picked a machine")
        XCTAssertEqual(try locates(after: seqBefore), 0, "an unknown writer was looked up on a guessed machine")
        XCTAssertEqual(taskPagesOpen(app), tasks, "the file link opened a task")
        try capture(app, "agent-summary-unknown-source")
        local.tap()
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertGreaterThan(try locates(after: seqBefore), 0, "Local did not look the path up")
        XCTAssertGreaterThan(try fileReads(), before)
        try capture(app, "agent-summary-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(heading.waitForExistence(timeout: 10), "closing the viewer left the task details")
        XCTAssertEqual(taskPagesOpen(app), tasks)
        tapReady(link(in: summary, fixture.letters.target), in: sheet)
        expectLetterSheet(app)
        XCTAssertEqual(taskPagesOpen(app), tasks, "the letter link opened a task")
        try capture(app, "agent-summary-letter-sheet")
        closeLetterSheet(app, returningTo: link(in: summary, fixture.letters.target))
        XCTAssertEqual(taskPagesOpen(app), tasks)
        XCTAssertTrue(element(app, "chat.composer").exists, "the session under the task details is gone")
    }

    @MainActor func testOfflineDocumentRouteShowsRetryThenLinksWork() throws {
        _ = try request("document-fault?mode=offline", method: "POST")
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        let failure = element(app, "inbox.letter.bodyRouteError")
        XCTAssertTrue(failure.waitForExistence(timeout: 30), "the refused route shows no Retry line")
        let line = failure.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Links in this document couldn")).firstMatch
        XCTAssertTrue(line.exists, "the failure line does not say the links are not ready")
        XCTAssertTrue(try reads().contains { $0.isDocument(fixture.letters.html, turn: nil) && $0.status == 503 })
        try capture(app, "agent-route-offline")
        _ = try request("document-fault?mode=off", method: "POST")
        let seq = try lastSeq()
        let retry = failure.buttons["Retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10) && retry.isHittable, "no Retry to tap")
        retry.tap()
        try routedRead(turn: nil, after: seq)
        let page = try routedPage(app, marker: Self.inlineMarker, turn: nil)
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: failure)
        XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 15), .completed, "the failure line stayed after Retry")
        try capture(app, "agent-route-retried")
        tapReady(link(in: page, "readme.txt line 2", contains: true), in: element(app, "inbox.letter.document"))
        expectTextViewer(app, showing: Self.lineTwo)
        try capture(app, "agent-route-retried-file")
        closeTextViewer(app)
        XCTAssertTrue(source.waitForExistence(timeout: 10))
    }

    @MainActor func testLeavingADelayedDocumentCancelsItsRouteRead() throws {
        _ = try request("document-fault?mode=delay", method: "POST")
        let seq = try lastSeq()
        let app = try openInbox()
        _ = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        let asked = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            ((try? self.reads()) ?? []).contains { $0.seq > seq && $0.fault == "delay" }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [asked], timeout: 20), .completed, "the document route was never asked")
        try capture(app, "agent-route-delayed")
        goBack(app)
        let source = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        let replaced = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !source.exists || app.webViews.containing(NSPredicate(format: "label CONTAINS %@", Self.inlineMarker)).firstMatch.exists
        }, object: nil)
        replaced.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: 20), .completed, "the late HTML document replaced the markdown letter")
        let marker = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Source markdown marker'")).firstMatch
        XCTAssertTrue(marker.exists, "the markdown letter's body is gone")
        try capture(app, "agent-route-late-next-letter")
        let delayed = try reads().filter { $0.seq > seq && $0.fault == "delay" }
        XCTAssertFalse(delayed.isEmpty)
        XCTAssertTrue(delayed.allSatisfy { $0.cancelled && $0.status == 0 && $0.bytes == 0 },
                      "a delayed document was not closed by the app, or was still streamed after it closed")
    }

    @MainActor func testOfflineDeferredTurnTryAgainThenLinksWork() throws {
        _ = try request("document-fault?mode=offline", method: "POST")
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        XCTAssertTrue(element(app, "inbox.letter.turn.deferredBodyError").waitForExistence(timeout: 30), "the refused turn shows no Try Again")
        XCTAssertTrue(try reads().contains { $0.isDocument(fixture.letters.html, turn: 0) && $0.status == 503 })
        let conversation = element(app, "inbox.letter.conversation")
        try capture(app, "agent-turn-offline")
        _ = try request("document-fault?mode=off", method: "POST")
        let seq = try lastSeq()
        tapReady(conversation.buttons["Try Again"].firstMatch, in: conversation)
        try routedRead(turn: 0, after: seq)
        let page = try routedPage(app, marker: Self.deferredMarker, turn: 0)
        XCTAssertFalse(element(app, "inbox.letter.turn.deferredBodyError").exists, "the turn still shows its failure")
        try capture(app, "agent-turn-retried")
        tapReady(link(in: page, "turn readme line 1", contains: true), in: conversation)
        expectTextViewer(app, showing: Self.lineOne)
        try capture(app, "agent-turn-retried-file")
        closeTextViewer(app)
        XCTAssertTrue(source.waitForExistence(timeout: 10))
    }

    @MainActor func testDelayedDocumentRouteArrivesLateAndInstallsItsLinks() throws {
        _ = try request("document-fault?mode=delay", method: "POST")
        let seq = try lastSeq()
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.html, fixture.letters.subjects.html)
        let page = app.webViews.containing(NSPredicate(format: "label CONTAINS %@", Self.inlineMarker)).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the inline copy did not show while the route was late")
        let routed = link(in: page, fixture.letters.target)
        XCTAssertFalse(routed.exists, "the linked copy showed before the late route answered")
        try capture(app, "agent-route-late-loading")
        let late = try routedRead(turn: nil, after: seq, fault: "delay")
        XCTAssertFalse(late.cancelled, "the late route was cut before it answered")
        XCTAssertTrue(routed.waitForExistence(timeout: 30), "the late linked copy was never installed")
        try capture(app, "agent-route-late-installed")
        tapReady(routed, in: element(app, "inbox.letter.document"))
        expectLetterSheet(app)
        closeLetterSheet(app, returningTo: routed)
    }

    /// An agent turn from before the server recorded its writer: its image is a link, not bytes
    /// read on a guess, and a tap opens the not-recorded viewer with no lookup and no read.
    @MainActor func testAnOldTurnWithNoWriterLoadsNoImageAndReadsNoFile() throws {
        let id = try XCTUnwrap(fixture.letters.oldTurn, "the fixture seeded no old turn")
        let subject = try XCTUnwrap(fixture.letters.subjects.oldTurn)
        let seq = try lastSeq()
        let imageReads = try fileContentReads(of: fixture.image)
        let app = try openInbox()
        _ = try openLetter(app, id, subject)
        let conversation = element(app, "inbox.letter.conversation")
        XCTAssertTrue(conversation.waitForExistence(timeout: 20), "the letter shows no conversation")
        let imageLink = link(in: conversation, "Image: Old chart")
        XCTAssertTrue(imageLink.waitForExistence(timeout: 20), "the old turn's image is not drawn as a link")
        XCTAssertEqual(try mediaRequests(after: seq), 0, "an unknown writer's image was requested")
        try capture(app, "agent-old-turn-image-link")
        tapReady(imageLink, in: conversation)
        let missing = element(app, "session.files.viewer.missing")
        XCTAssertTrue(missing.waitForExistence(timeout: 20), "the image link did not open the not-recorded viewer")
        XCTAssertTrue(element(app, "session.files.viewer.pick.local").waitForExistence(timeout: 5))
        XCTAssertEqual(try locates(after: seq), 0, "an unknown writer was looked up on a guessed machine")
        XCTAssertEqual(try mediaRequests(after: seq), 0)
        XCTAssertEqual(try fileContentReads(of: fixture.image), imageReads, "a file was read for an unknown writer")
        try capture(app, "agent-old-turn-not-recorded")
        // The user names the machine: the picture is read from there, as raw file bytes.
        tap(element(app, "session.files.viewer.pick.local"))
        let picture = element(app, "session.files.viewer.image")
        XCTAssertTrue(picture.waitForExistence(timeout: 30), "picking Local did not show the image")
        XCTAssertGreaterThan(picture.frame.width, 100, "the image is drawn too small to be the fixture picture")
        XCTAssertFalse(element(app, "session.files.viewer.imageFailed").exists)
        XCTAssertFalse(missing.exists, "the not-recorded line stayed after the pick")
        XCTAssertGreaterThan(try locates(after: seq), 0, "Local did not look the path up")
        XCTAssertGreaterThan(try rawFileReads(of: fixture.image, served: true), 0, "the image was not read as raw file bytes")
        XCTAssertEqual(try mediaRequests(after: seq), 0, "the media route was used")
        try capture(app, "agent-old-turn-image-local")
        tap(app.navigationBars["fixture-chart.png"].buttons["Done"])
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: picture)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the viewer did not close")
    }

    /// The session's own plan, from the real plan route: its file link opens the text viewer, and
    /// its picture (a known session, not the primary) is a link that reads nothing until tapped.
    @MainActor func testPlanFileAndPictureLinksOpenHereAndDoneReturnsToThePlan() throws {
        let plan = try XCTUnwrap(fixture.plan, "the fixture seeded no plan")
        let app = try openSession()
        let seq = try lastSeq()
        let imageReads = try fileContentReads(of: fixture.image)
        tap(element(app, "session.menu"))
        tap(app.buttons.matching(identifier: "session.plan").firstMatch)
        let bar = app.navigationBars["Plan"]
        XCTAssertTrue(bar.waitForExistence(timeout: 20), "View Plan opened no plan sheet")
        let marker = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", plan.marker)).firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 20), "the plan sheet does not show the seeded plan")
        let sheet = app.scrollViews.containing(NSPredicate(format: "label CONTAINS %@", plan.marker)).firstMatch
        let picture = link(in: sheet, "Image: Plan chart")
        XCTAssertTrue(picture.waitForExistence(timeout: 20), "the plan's picture is not drawn as a link")
        XCTAssertEqual(try mediaRequests(after: seq), 0, "the plan's picture was requested before a tap")
        XCTAssertEqual(try fileContentReads(of: fixture.image), imageReads, "the plan's picture was read before a tap")
        try capture(app, "agent-plan-before-tap")
        tapReady(link(in: sheet, "readme.txt", contains: true), in: sheet)
        expectTextViewer(app, showing: Self.lineTwo)
        try capture(app, "agent-plan-file-viewer")
        closeTextViewer(app)
        XCTAssertTrue(bar.waitForExistence(timeout: 10) && marker.exists, "closing the viewer left the plan")
        tapReady(picture, in: sheet)
        let shown = element(app, "session.files.viewer.image")
        XCTAssertTrue(shown.waitForExistence(timeout: 30), "the picture link did not show the picture")
        XCTAssertGreaterThan(shown.frame.width, 100, "the picture is drawn too small to be the fixture picture")
        XCTAssertFalse(element(app, "session.files.viewer.imageFailed").exists)
        XCTAssertFalse(element(app, "session.files.viewer.missing").exists, "a known session read as an unknown source")
        XCTAssertGreaterThan(try rawFileReads(of: fixture.image, served: true), 0, "the picture was not read as raw file bytes")
        XCTAssertEqual(try mediaRequests(after: seq), 0, "the media route was used")
        try capture(app, "agent-plan-picture")
        tap(app.navigationBars["fixture-chart.png"].buttons["Done"])
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: shown)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the picture viewer did not close")
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "Done did not return to the plan")
        XCTAssertTrue(marker.exists && marker.isHittable, "the plan is not in front after Done")
        try capture(app, "agent-plan-after-done")
    }

    /// A fenced block is drawn as written and its path opens here: a letter's (SwiftUI) and the
    /// session timeline's (UIKit), each selectable and scrolling sideways after the viewer closes.
    @MainActor func testCodeBlockPathsOpenHereAndTheCodeSelectsAndScrolls() throws {
        let code = try XCTUnwrap(fixture.code, "the fixture seeded no code block")
        let marks = "`raw` *stars*"
        let inbox = try openInbox()
        _ = try openLetter(inbox, fixture.letters.target, fixture.letters.subjects.target)
        let body = element(inbox, "inbox.letter.document")
        let letterCode = inbox.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", code.marker)).firstMatch
        XCTAssertTrue(letterCode.waitForExistence(timeout: 20), "the letter shows no code block")
        XCTAssertTrue(letterCode.label.contains(marks), "the letter's code lost its characters: \(letterCode.label)")
        var reads = try fileReads()
        try capture(inbox, "agent-code-letter-before")
        tapReady(link(in: body, "readme.txt", contains: true), in: body)
        expectTextViewer(inbox, showing: Self.lineOne)
        XCTAssertGreaterThan(try fileReads(), reads, "the letter's code link read no file")
        try capture(inbox, "agent-code-letter-viewer")
        closeTextViewer(inbox)
        XCTAssertTrue(letterCode.waitForExistence(timeout: 10) && body.exists, "closing the viewer left the letter")
        try expectSelectsAndScrolls(inbox, letterCode, "agent-code-letter")

        let app = try openSession()
        let sessionCode = app.textViews.matching(NSPredicate(
            format: "identifier == 'timeline.code' AND value CONTAINS %@", code.marker)).firstMatch
        XCTAssertTrue(sessionCode.waitForExistence(timeout: 30), "the session shows no code block")
        XCTAssertTrue((sessionCode.value as? String)?.contains(marks) == true, "the session's code lost its characters")
        reads = try fileReads()
        try capture(app, "agent-code-session-before")
        tapReady(link(in: sessionCode, "readme.txt", contains: true), in: app)
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertGreaterThan(try fileReads(), reads, "the session's code link read no file")
        try capture(app, "agent-code-session-viewer")
        closeTextViewer(app)
        XCTAssertTrue(sessionCode.waitForExistence(timeout: 10), "closing the viewer left the session")
        XCTAssertTrue(element(app, "chat.composer").exists, "the session is gone after Done")
        try expectSelectsAndScrolls(app, sessionCode, "agent-code-session")
    }

    @MainActor func testBoardStatusFileLinkOpensHereNotTheTask() throws {
        let tasks = try XCTUnwrap(fixture.statusTasks, "the fixture seeded no status tasks")
        let app = openBoard()
        let row = boardRow(app, tasks.boardFile)
        try tapStatusLink(app, row, at: statusLinkPoint(row, font: .caption1, lastLine: true), file: true, name: "agent-board-file")
    }

    @MainActor func testBoardStatusLetterLinkOpensHereNotTheTask() throws {
        let tasks = try XCTUnwrap(fixture.statusTasks, "the fixture seeded no status tasks")
        let app = openBoard()
        let row = boardRow(app, tasks.boardLetter)
        try tapStatusLink(app, row, at: statusLinkPoint(row, font: .caption1, lastLine: true), file: false, name: "agent-board-letter")
    }

    @MainActor func testTeamStatusFileLinkOpensHereNotTheTask() throws {
        _ = try XCTUnwrap(fixture.statusTasks, "the fixture seeded no status tasks")
        let app = try openTeam()
        let line = teamNeedLine(app, containing: "readme.txt")
        try tapStatusLink(app, line, at: statusLinkPoint(line, font: .footnote, lastLine: false), file: true, name: "agent-team-file")
    }

    @MainActor func testTeamStatusLetterLinkOpensHereNotTheTask() throws {
        _ = try XCTUnwrap(fixture.statusTasks, "the fixture seeded no status tasks")
        let app = try openTeam()
        let line = teamNeedLine(app, containing: fixture.letters.target)
        try tapStatusLink(app, line, at: statusLinkPoint(line, font: .footnote, lastLine: false), file: false, name: "agent-team-letter")
    }

    @MainActor func testOrgTaskStatusFileLinkOpensHereNotTheTask() throws {
        let org = try XCTUnwrap(fixture.org, "the fixture seeded no org")
        let app = try openOrgTasks(org)
        let row = orgTaskRow(app, "Org file status")
        try tapStatusLink(app, row, at: orgLinkPoint(row), file: true, name: "agent-org-file")
    }

    @MainActor func testOrgTaskStatusLetterLinkOpensHereNotTheTask() throws {
        let org = try XCTUnwrap(fixture.org, "the fixture seeded no org")
        let app = try openOrgTasks(org)
        let row = orgTaskRow(app, "Org letter status")
        try tapStatusLink(app, row, at: orgLinkPoint(row), file: false, name: "agent-org-letter")
    }

    @MainActor func testWorkCardStatusFileLinkOpensHereNotTheTask() throws {
        let app = try openWorkCardNeeds()
        let line = workCardNeedLine(app, containing: "readme.txt")
        try tapStatusLink(app, line, at: statusLinkPoint(line, font: .footnote, lastLine: false), file: true, name: "agent-workcard-file")
    }

    @MainActor func testWorkCardStatusLetterLinkOpensHereNotTheTask() throws {
        let app = try openWorkCardNeeds()
        let line = workCardNeedLine(app, containing: fixture.letters.target)
        try tapStatusLink(app, line, at: statusLinkPoint(line, font: .footnote, lastLine: false), file: false, name: "agent-workcard-letter")
    }

    /// An Org thread card's summary and opening post: a path opens on the machine of the session
    /// the server recorded as its writer, and a card with no recorded writer asks which machine
    /// (it reads nothing until the user picks one), then opens from the one picked.
    @MainActor func testOrgThreadCardPathsOpenOnTheirWritersMachineAndAskWhenTheWriterIsUnknown() throws {
        let org = try XCTUnwrap(fixture.org, "the fixture seeded no org")
        let threads = try XCTUnwrap(org.threads, "the fixture seeded no org threads")
        let app = try openOrgThreads(org)
        let known = element(app, "org.thread.\(threads.knownId)")
        XCTAssertTrue(known.waitForExistence(timeout: 30), "the writer-known thread is not on the page")
        let scroll = app.scrollViews.containing(.any, identifier: "org.thread.\(threads.knownId)").firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 15), "the Threads scroll is missing")
        let summary = threadPathLink(known, in: "org.thread.summary", "readme.txt")
        XCTAssertTrue(summary.exists, "the card's summary draws its path as a link")
        makeVisible(summary, in: scroll)
        try capture(app, "agent-org-thread-known-before")
        let seq = try lastSeq()
        tapWrappedLink(summary, in: scroll)
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertGreaterThan(try locates(after: seq), 0, "the summary's path was not looked up")
        try capture(app, "agent-org-thread-known-summary")
        closeTextViewer(app)
        XCTAssertTrue(known.waitForExistence(timeout: 10), "closing the viewer left the Threads page")

        // The opening post is folded to a few words; its path is whole only once it is expanded.
        let expand = known.descendants(matching: .any).matching(identifier: "org.thread.answer.body.expand").firstMatch
        tapWrappedLink(expand, in: scroll)
        let opener = threadPathLink(known, in: "org.thread.answer.body", "readme.txt")
        XCTAssertTrue(opener.exists, "the card's opening post draws its path as a link")
        tapWrappedLink(opener, in: scroll)
        expectTextViewer(app, showing: Self.lineOne)
        try capture(app, "agent-org-thread-known-opener")
        closeTextViewer(app)

        let unknown = element(app, "org.thread.\(threads.unknownId)")
        XCTAssertTrue(unknown.waitForExistence(timeout: 20), "the writer-unknown thread is not on the page")
        // The expanded post above grew the page: the card is scrolled back into view the way a person does.
        makeVisible(unknown, in: scroll)
        let guess = threadPathLink(unknown, in: "org.thread.summary", "readme.txt")
        XCTAssertTrue(guess.exists, "the old card's summary draws its path as a link")
        let before = try fileReads()
        let asked = try lastSeq()
        tapWrappedLink(guess, in: scroll)
        XCTAssertTrue(element(app, "session.files.viewer.missing").waitForExistence(timeout: 20), "an unknown writer did not ask which machine")
        XCTAssertTrue(element(app, "session.files.viewer.pick.local").waitForExistence(timeout: 5))
        XCTAssertEqual(try locates(after: asked), 0, "an unknown writer was looked up on a guessed machine")
        XCTAssertEqual(try fileReads(), before, "a file was read for an unknown writer")
        try capture(app, "agent-org-thread-unknown-asks")
        tap(element(app, "session.files.viewer.pick.local"))
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertGreaterThan(try locates(after: asked), 0, "Local did not look the path up")
        closeTextViewer(app)
        XCTAssertTrue(unknown.waitForExistence(timeout: 10), "closing the viewer left the Threads page")
        assertNothingOpens(app, "closing the picked machine's viewer")
    }

    @MainActor func testMarkdownBodyTaskMentionOpensItsTaskAndDoneReturns() throws {
        let app = try openInbox()
        let source = try openLetter(app, fixture.letters.source, fixture.letters.subjects.source)
        let reads = try fileReads()
        let mention = bodyLink(app, label: "Phone media fixture")
        makeHittable(mention, in: element(app, "inbox.letter.document"))
        try capture(app, "agent-body-task-before")
        mention.tap()
        let sheet = element(app, "task.open.session")
        XCTAssertTrue(sheet.waitForExistence(timeout: 30), "the task mention opened no task session")
        let transcript = sheet.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Media fixture ready'")).firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 30), "the sheet is not the fixture task's session")
        XCTAssertFalse(letterSheetOpen(app), "the task mention opened a letter")
        XCTAssertFalse(textViewerOpen(app), "the task mention opened a file")
        XCTAssertEqual(try fileReads(), reads, "the task mention read a file")
        try capture(app, "agent-body-task-opened")
        tap(element(app, "task.open.done"))
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the task sheet did not close")
        XCTAssertTrue(source.waitForExistence(timeout: 10) && readerOpen(app), "Done did not return to the letter")
        XCTAssertTrue(mention.isHittable, "Done did not preserve the tapped link's scroll position")
        assertNothingOpens(app, "closing the task sheet")
    }

    @MainActor func testTeamBriefFileThenLetterLinksOpenHere() throws {
        let app = try openTeam()
        let brief = element(app, "task.team.brief")
        XCTAssertTrue(brief.waitForExistence(timeout: 20), "the team shows no brief")
        let file = briefLink(app, containing: "readme.txt")
        let letter = briefLink(app, containing: fixture.letters.target)
        XCTAssertTrue(file.exists && letter.exists, "the brief does not carry both asks' links")
        let pages = taskPagesOpen(app)
        makeHittable(file, in: app)
        try capture(app, "agent-team-brief-before")
        file.tap()
        expectTextViewer(app, showing: Self.lineTwo)
        XCTAssertEqual(taskPagesOpen(app), pages, "the brief's file link opened a task")
        try capture(app, "agent-team-brief-file")
        closeTextViewer(app)
        XCTAssertTrue(brief.waitForExistence(timeout: 10), "closing the viewer left the team")
        makeHittable(letter, in: app)
        letter.tap()
        expectLetterSheet(app)
        XCTAssertEqual(taskPagesOpen(app), pages, "the brief's letter link opened a task")
        try capture(app, "agent-team-brief-letter")
        closeLetterSheet(app, returningTo: letter)
        XCTAssertEqual(taskPagesOpen(app), pages)
        assertNothingOpens(app, "closing the brief's letter sheet")
    }

    // MARK: - Fixture

    /// A test name as one query value: the server keeps only letters, digits, dot, dash and underscore.
    static func queryValue(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._")) ?? ""
    }

    @discardableResult func request(_ route: String, method: String = "GET", body: Data? = nil) throws -> Data {
        try AgentTextFixtureClient.call(XCTUnwrap(URL(string: server + "/__media/" + route)), method: method, body: body)
    }
}
