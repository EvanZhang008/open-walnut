import XCTest
import UIKit

/// A MESSAGE SENT WHILE THE AGENT IS TALKING STAYS BELOW WHAT WAS ON SCREEN.
///
/// Field report (2026-10-24, build 124): on a session page, a message the user sent
/// while the turn was streaming was drawn ABOVE the commentary already on screen,
/// as if it had been sent before the agent started. The saved transcript had the
/// right order; only the phone's drawing was wrong. The fix (`SessionSentRuns`)
/// keeps what was on screen at send time above the bubble, streams later output
/// below it, and lets the turn-end transcript read replace all of it.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs` in its staged-turn mode
/// (`POST /__stub/midturn?step=…`): the work session's turn is moved one step at a
/// time, so every screen below is a known state. Order is read from the rows'
/// on-screen frames (`minY`), so the assertions are about what a person sees.
///
/// RUN IT with the stub running and WALNUT_UITEST_SERVER pointed at it (see
/// `MidTurnQueueUITests` for why a bare `xcodebuild` skips every case here).
final class SessionMidTurnOrderUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // The stub's distinctive strings (MT_* in mid-turn-stub-server.mjs).
    private static let commentaryOne = "Commentary one"
    private static let commentaryTwo = "Commentary two"
    private static let answer = "Answer after your note"
    private static let sent = "Summarize the notes please"

    @MainActor
    func testAMidTurnMessageStaysBelowWhatWasOnScreen() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/work-session?on=1")
        let app = try launchPaired()
        try openSessionPage(app)

        // 1. The turn streams: commentary, a Read call, more commentary.
        try await stub.call("POST", "__stub/midturn?step=start")
        XCTAssertTrue(waitForMatch(app, Self.commentaryTwo, timeout: 20), "the streamed commentary never appeared")
        let streaming = try XCTUnwrap(matches(app, Self.commentaryTwo).first)
        print("[evidence] streaming: commentaryTwo.minY=\(streaming.minY) maxY=\(streaming.maxY)")
        try await stub.screenshot(app, "midturn-01-streaming")

        // 2. Send mid-turn. The bubble goes below what was on screen.
        type(Self.sent, into: element(app, "chat.composer"), of: app)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10) && send.isEnabled, "send is not available mid-turn")
        send.tap()
        XCTAssertTrue(waitForMatch(app, Self.sent, timeout: 15), "the sent message never appeared on the page")
        dismissKeyboard(app, beside: Self.sent)
        var state = try await stub.midTurnState()
        XCTAssertEqual(state.posts.map(\.text), [Self.sent], "one POST for one send")
        do {
            let one = try frame(app, Self.commentaryOne)
            let two = try frame(app, Self.commentaryTwo)
            let bubble = try frame(app, Self.sent)
            print("[evidence] sent: commentaryOne.minY=\(one.minY) commentaryTwo.minY=\(two.minY) "
                  + "commentaryTwo.maxY=\(two.maxY) bubble.minY=\(bubble.minY)")
            XCTAssertGreaterThan(bubble.minY, two.maxY - 1, "the bubble is drawn above the commentary on screen at send time")
            XCTAssertGreaterThan(bubble.minY, one.minY, "the bubble is drawn above the first commentary")
        }
        try await stub.screenshot(app, "midturn-02-sent")

        // 3. The CLI takes the message; its answer streams in below the bubble.
        try await stub.call("POST", "__stub/midturn?step=consume")
        XCTAssertTrue(waitForMatch(app, Self.answer, timeout: 15), "the answer after the note never appeared")
        do {
            let bubble = try frame(app, Self.sent)
            let after = try frame(app, Self.answer)
            print("[evidence] after: bubble.minY=\(bubble.minY) answer.minY=\(after.minY)")
            XCTAssertGreaterThan(after.minY, bubble.minY, "the answer streamed in above the bubble")
        }
        try await stub.screenshot(app, "midturn-03-after")

        // 4. The stream drops and re-attaches mid-turn (a snapshot re-seeds the live
        // region). Nothing is drawn twice.
        let attachesBefore = state.attaches.count
        try await stub.call("POST", "__stub/midturn?step=drop")
        state = try await stub.waitForMidTurnAttach(beyond: attachesBefore, timeout: 20)
        try await Task.sleep(for: .seconds(2))
        do {
            let bubbles = matches(app, Self.sent)
            let answers = matches(app, Self.answer)
            let ones = matches(app, Self.commentaryOne)
            print("[evidence] reconnected (attach #\(state.attaches.count)): bubble count=\(bubbles.count) "
                  + "minY=\(bubbles.map(\.minY)) answer count=\(answers.count) minY=\(answers.map(\.minY)) "
                  + "commentaryOne count=\(ones.count) minY=\(ones.map(\.minY))")
            XCTAssertEqual(bubbles.count, 1, "the sent message is not on screen exactly once after the reconnect")
            XCTAssertEqual(answers.count, 1, "the answer is missing or duplicated after the reconnect")
            XCTAssertEqual(ones.count, 1, "the commentary is missing or duplicated after the reconnect")
            // The snapshot continues the turn, so nothing moves: the answer is
            // still below the message (the app coming back from the background).
            if let b = bubbles.first, let a = answers.first {
                XCTAssertGreaterThan(a.minY, b.minY, "the reconnect drew the answer above the message")
            }
        }
        try await stub.screenshot(app, "midturn-04-reconnected")

        // 4b. A second re-attach (pull to refresh twice, Home and back twice): the
        // read between them already holds the message; still nothing twice.
        let attachesAgain = state.attaches.count
        try await stub.call("POST", "__stub/midturn?step=drop")
        state = try await stub.waitForMidTurnAttach(beyond: attachesAgain, timeout: 20)
        try await Task.sleep(for: .seconds(3))
        do {
            let bubbles = matches(app, Self.sent)
            let answers = matches(app, Self.answer)
            let ones = matches(app, Self.commentaryOne)
            let twos = matches(app, Self.commentaryTwo)
            print("[evidence] reconnected twice: bubble=\(bubbles.map(\.minY)) answer=\(answers.map(\.minY)) "
                  + "one=\(ones.map(\.minY)) two=\(twos.map(\.minY))")
            XCTAssertEqual(bubbles.count, 1, "the message is not on screen exactly once after a second reconnect")
            XCTAssertEqual(answers.count, 1, "the answer is missing or duplicated after a second reconnect")
            XCTAssertEqual(ones.count, 1, "commentary one is missing or duplicated after a second reconnect")
            XCTAssertEqual(twos.count, 1, "commentary two is missing or duplicated after a second reconnect")
            if let b = bubbles.first, let a = answers.first {
                XCTAssertGreaterThan(a.minY, b.minY, "a second reconnect drew the answer above the message")
            }
        }
        try await stub.screenshot(app, "midturn-04b-reconnected-twice")

        // 5. The turn ends; the canonical transcript replaces the page's rows.
        try await stub.call("POST", "__stub/midturn?step=end")
        try await Task.sleep(for: .seconds(4))
        // The answered turn folds its work before the answer (C1 and the read)
        // into one row (TimelineTurnFold); the mid-turn message stays below it.
        _ = waitUntil(timeout: 15) { self.foldedOrderHolds(app) }
        assertFoldedOrder(app, step: "saved")
        try await stub.screenshot(app, "midturn-05-saved")
        try expandFold(app)
        _ = waitUntil(timeout: 15) { self.savedOrderHolds(app) }
        assertSavedOrder(app, step: "saved-expanded")
        try await stub.screenshot(app, "midturn-05b-saved-expanded")

        // 6. Leave and come back: the page reads the same order from the server.
        try closeSessionPage(app)
        try await Task.sleep(for: .seconds(2))
        try openSessionPage(app)
        XCTAssertTrue(waitForMatch(app, Self.answer, timeout: 30), "the reopened page never showed the answer")
        _ = waitUntil(timeout: 15) { self.foldedOrderHolds(app) || self.savedOrderHolds(app) }
        if matches(app, Self.commentaryOne).isEmpty { try expandFold(app) }
        _ = waitUntil(timeout: 15) { self.savedOrderHolds(app) }
        assertSavedOrder(app, step: "reopened")
        try await stub.screenshot(app, "midturn-06-reopened")
    }

    // MARK: - Reading the page

    /// On-screen frames of the elements whose label or value carries `needle`,
    /// top to bottom. The timeline draws prose with TextKit (a text view's VALUE
    /// holds the text), and a container that holds a matching child is the same
    /// text, so only the innermost frame of each is kept. The composer is never
    /// counted: it holds the words until the send clears it.
    @MainActor
    private func matches(_ app: XCUIApplication, _ needle: String) -> [CGRect] {
        let window = app.windows.firstMatch.frame
        let found = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", needle, needle))
            .allElementsBoundByIndex
        var frames: [CGRect] = []
        for element in found where element.identifier != "chat.composer" {
            let f = element.frame
            guard !f.isEmpty, f.intersects(window) else { continue }
            if frames.contains(where: { Self.same($0, f) }) { continue }
            frames.append(f)
        }
        return frames
            // A text view and the paragraph element inside it are one text: keep the
            // inner one (its frame need not lie wholly inside the outer's).
            .filter { outer in
                !frames.contains { inner in
                    !Self.same(inner, outer) && inner.height < outer.height
                        && outer.contains(CGPoint(x: inner.midX, y: inner.midY))
                }
            }
            .sorted { $0.minY < $1.minY }
    }

    /// One row's text: a bubble's cell and the text view inside it share a top edge
    /// and overlap, though their widths and heights differ.
    private static func same(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minY - b.minY) < 1 && a.intersects(b)
    }

    /// The one on-screen frame for `needle`; fails when it is absent.
    @MainActor
    private func frame(_ app: XCUIApplication, _ needle: String) throws -> CGRect {
        let found = matches(app, needle)
        XCTAssertFalse(found.isEmpty, "\"\(needle)\" is not on screen")
        return try XCTUnwrap(found.first)
    }

    @MainActor
    private func waitForMatch(_ app: XCUIApplication, _ needle: String, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { !self.matches(app, needle).isEmpty }
    }

    /// The answered turn's fold row: its phrase names the read before the answer.
    private static let foldPhrase = "Read a file"

    /// Folded: C1 is inside the fold row, and fold < C2 < the bubble < the answer.
    @MainActor
    private func foldedOrderHolds(_ app: XCUIApplication) -> Bool {
        let rows = [Self.foldPhrase, Self.commentaryTwo, Self.sent, Self.answer].map { matches(app, $0) }
        guard matches(app, Self.commentaryOne).isEmpty, rows.allSatisfy({ $0.count == 1 }) else { return false }
        let ys = rows.map { $0[0].minY }
        return zip(ys, ys.dropFirst()).allSatisfy { $0 < $1 }
    }

    @MainActor
    private func assertFoldedOrder(_ app: XCUIApplication, step: String) {
        let names = ["fold", "commentaryTwo", "bubble", "answer"]
        let rows = [Self.foldPhrase, Self.commentaryTwo, Self.sent, Self.answer].map { matches(app, $0) }
        let one = matches(app, Self.commentaryOne)
        print("[evidence] \(step): commentaryOne.count=\(one.count) "
              + zip(names, rows).map { "\($0).count=\($1.count) minY=\($1.map(\.minY))" }.joined(separator: " "))
        XCTAssertEqual(one.count, 0, "\(step): commentary one should be inside the folded turn")
        for (name, found) in zip(names, rows) {
            XCTAssertEqual(found.count, 1, "\(step): \(name) is not on screen exactly once")
        }
        guard rows.allSatisfy({ $0.count == 1 }) else { return }
        let ys = rows.map { $0[0].minY }
        for i in 1..<ys.count {
            XCTAssertLessThan(ys[i - 1], ys[i], "\(step): \(names[i - 1]) is not above \(names[i])")
        }
    }

    /// Open the answered turn's fold row the way a person does: one tap on it.
    @MainActor
    private func expandFold(_ app: XCUIApplication) throws {
        let fold = try frame(app, Self.foldPhrase)
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: fold.midX, dy: fold.midY)).tap()
        XCTAssertTrue(waitForMatch(app, Self.commentaryOne, timeout: 10), "opening the fold did not show commentary one")
    }

    /// The saved turn, in order, each row once: C1 < C2 < the bubble < the answer.
    @MainActor
    private func savedOrderHolds(_ app: XCUIApplication) -> Bool {
        let rows = [Self.commentaryOne, Self.commentaryTwo, Self.sent, Self.answer].map { matches(app, $0) }
        guard rows.allSatisfy({ $0.count == 1 }) else { return false }
        let ys = rows.map { $0[0].minY }
        return zip(ys, ys.dropFirst()).allSatisfy { $0 < $1 }
    }

    @MainActor
    private func assertSavedOrder(_ app: XCUIApplication, step: String) {
        let names = ["commentaryOne", "commentaryTwo", "bubble", "answer"]
        let needles = [Self.commentaryOne, Self.commentaryTwo, Self.sent, Self.answer]
        let rows = needles.map { matches(app, $0) }
        let line = zip(names, rows).map { "\($0).count=\($1.count) minY=\($1.map(\.minY))" }.joined(separator: " ")
        print("[evidence] \(step): \(line)")
        for (name, found) in zip(names, rows) {
            XCTAssertEqual(found.count, 1, "\(step): \(name) is not on screen exactly once")
        }
        guard rows.allSatisfy({ $0.count == 1 }) else { return }
        let ys = rows.map { $0[0].minY }
        for i in 1..<ys.count {
            XCTAssertLessThan(ys[i - 1], ys[i], "\(step): \(names[i - 1]) is not above \(names[i])")
        }
    }

    // MARK: - Driving the app

    /// Tap the empty side of the sent bubble's row: the transcript's tap-away
    /// gesture ends editing, and no row there has a tap action of its own (a tool
    /// chip at 35% of the screen would open its sheet).
    @MainActor
    private func dismissKeyboard(_ app: XCUIApplication, beside needle: String) {
        guard app.keyboards.firstMatch.exists else { return }
        if let row = matches(app, needle).last {
            app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 24, dy: row.midY)).tap()
        }
        if !waitUntil(timeout: 5, { !app.keyboards.firstMatch.exists }) {
            // The timeline dismisses on drag as well.
            app.collectionViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(waitUntil(timeout: 10) { !app.keyboards.firstMatch.exists }, "the keyboard did not go away")
        XCTAssertFalse(element(app, "activity.sheet").exists, "dismissing the keyboard opened a tool sheet")
        usleep(500_000)
    }

    @MainActor
    private func closeSessionPage(_ app: XCUIApplication) throws {
        if app.keyboards.firstMatch.exists {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()
            XCTAssertTrue(waitUntil(timeout: 10) { !app.keyboards.firstMatch.exists }, "the transcript tap did not dismiss the keyboard")
        }
        let notes = app.buttons["Notes"]
        XCTAssertTrue(notes.waitForExistence(timeout: 10), "the tab bar is missing")
        notes.tap()
        XCTAssertTrue(waitUntil(timeout: 15) { !app.buttons["session.menu"].exists }, "leaving Tasks kept the session visible")
    }

    /// Tasks tab → the work task's row → its session page, waiting for the composer.
    @MainActor
    private func openSessionPage(_ app: XCUIApplication) throws {
        let tasksTab = app.buttons["Tasks"]
        XCTAssertTrue(tasksTab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasksTab.tap()
        let scrim = element(app, "tasks.drawer.scrim")
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10))
            menu.tap()
        }
        XCTAssertTrue(scrim.waitForExistence(timeout: 10), "the board drawer did not open")
        let row = element(app, "board.row.task-stub-work")
        XCTAssertTrue(row.waitForExistence(timeout: 45), "the board never showed the work task")
        let ready = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: row)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 10), .completed, "the task row never became hittable")
        row.tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 30), "the task did not open its session")
        XCTAssertTrue(app.buttons["session.title"].label.contains("Stub work task"), "a restored session replaced the work session")
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 30), "no composer on the session page")
    }

    @MainActor
    private func type(_ text: String, into field: XCUIElement, of app: XCUIApplication) {
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the composer never appeared")
        field.tap()
        if !app.keyboards.element.waitForExistence(timeout: 10) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            _ = app.keyboards.element.waitForExistence(timeout: 10)
        }
        field.typeText(text)
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }

    /// Paired at the stub, with the stored stream resume ids masked (see
    /// `SessionStreamStormUITests.launchPaired`).
    private func launchPaired() throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch([
            "-walnut.serverUrl", UITestLaunch.pairedServer(server), "-walnut.deviceToken", token,
            "-walnut.sessionStreamResumeIDs", "",
        ])
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner: run this through ios-native/tests/ui/run-ui-tests.sh "
                    + "with WALNUT_UITEST_SERVER pointed at a running tests/ui/mid-turn-stub-server.mjs"
            )
        }
        return (server, token)
    }

    private func stubUnderTest() async throws -> StormStub {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StormStub(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the UI stub (no /__stub/state: \(error)); this test never runs against a real Walnut")
        }
        return stub
    }
}

/// The staged-turn control (`GET /__stub/midturn`), as this file reads it.
struct MidTurnStubState: Decodable {
    struct Attach: Decodable {
        let lastEventId: String?
    }

    let on: Bool
    let step: String?
    let posts: [StormStub.Post]
    let attaches: [Attach]
}

extension StormStub {
    func midTurnState() async throws -> MidTurnStubState {
        try JSONDecoder().decode(MidTurnStubState.self, from: try await call("GET", "__stub/midturn"))
    }

    /// Wait until the work session's stream has attached in staged-turn mode more
    /// than `count` times (the reconnect after `step=drop`).
    func waitForMidTurnAttach(beyond count: Int, timeout: TimeInterval) async throws -> MidTurnStubState {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let state = try await midTurnState()
            if state.attaches.count > count { return state }
            try await Task.sleep(for: .milliseconds(300))
        }
        XCTFail("the session stream never re-attached within \(Int(timeout)) s")
        return try await midTurnState()
    }
}
