import UIKit
import XCTest

/// THE MID-TURN COMPOSER, driven as a finger drives it.
///
/// The reported bug was not a wrong value anywhere — it was a missing control. The
/// composer's trailing seat turned into a red STOP the moment a turn began, so a
/// user who had just dictated a paragraph while the agent was talking had nowhere
/// to send it ("he is talking and I have no way to send"). The fix is two halves
/// that have to hold at the same time: the seat keeps a SEND whenever there is
/// something to send, and `ChatStore` BANKS that send behind the running turn —
/// the bubble appears at once with a `Queued` badge and a `Withdraw` button, and
/// it is POSTed as an ordinary new turn once the turn settles.
///
/// WHY EVERY ASSERTION HERE IS EITHER A SCREEN FACT OR A WIRE FACT. `ComposerPrimaryAction`
/// and `ChatSendQueueRules` are already pinned by `WalnutTests`, and they were green
/// while the button was still missing: the interesting half is whether the control a
/// thumb can reach is the right one, and whether the words went ON THE WIRE at the
/// right moment. So this file only ever reads what is rendered (`chat.send` vs
/// `chat.stop`, `chat.queuedBadge`, `chat.withdrawQueued`) and what the server was
/// asked for (the stub's recorded request log). Nothing reaches into the store.
///
/// THE TURN IS STAGED, NOT REAL. A model turn ends when it decides to, which makes
/// "while the agent is talking" a race, and the only box that has one is the
/// human's production Walnut, which this layer may not write to. So
/// `tests/ui/mid-turn-stub-server.mjs` accepts the POST, streams a couple of
/// frames, and then holds the stream open until this test says
/// `POST /__stub/finish-turn`. That gives a mid-turn window of any length and a
/// wire log that can prove the two facts a screen cannot: nothing was posted
/// while the turn was held, and exactly one thing was posted after it settled.
///
/// RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh` and the stub running, not
/// with a bare `xcodebuild`. Exporting `WALNUT_UITEST_SERVER` in your shell does
/// NOT reach an XCUITest runner (the variable has to be in the `.xctestrun`, which
/// only that script guarantees), and every test here skips without it. See
/// `BoardRingTapUITests` for the same policy and the same dead end.
///
/// EVERY TEST HERE IS `@MainActor`, and it has to be. These cases are `async`
/// because they talk to the stub's control plane over HTTP, and XCTest runs a bare
/// `async` case on a cooperative thread — where `XCUIApplication.launch()` raises
/// `must be called on the main thread`. Measured: without the annotation all three
/// cases fail in 0.3s having launched nothing at all, which reads like a broken
/// fixture rather than a threading rule.
final class MidTurnQueueUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - The payload

    /// A realistic dictated Chinese paragraph, 121 characters.
    ///
    /// It is the actual reported input shape: the user dictates while the agent is
    /// mid-answer, so the text is long, unpunctuated at the ends, and CJK — which
    /// also makes it the wrapping case a badge-plus-button row is most likely to
    /// overflow on. Written as explicit scalars because non-ASCII may appear in
    /// this repo only as test DATA, never as a literal a reader could mistake for
    /// a UI string.
    ///
    /// It reads: "do not rush on with those commands, I have just remembered
    /// something more important: the deploy script we discussed in yesterday
    /// afternoon's meeting still seems to hard-code a platform-specific log path,
    /// so once this round is done, dig it out for me, check it carefully, then
    /// write a regression test to pin it, and do not forget to update the related
    /// docs too."
    private static let dictatedParagraph =
        "\u{4F60}\u{5148}\u{522B}\u{6025}\u{7740}\u{7EE7}\u{7EED}\u{8DD1}"
        + "\u{90A3}\u{4E9B}\u{547D}\u{4EE4}\u{FF0C}\u{6211}\u{521A}\u{521A}"
        + "\u{60F3}\u{8D77}\u{6765}\u{4E00}\u{4EF6}\u{66F4}\u{8981}\u{7D27}"
        + "\u{7684}\u{4E8B}\u{60C5}\u{FF1A}\u{6628}\u{5929}\u{4E0B}\u{5348}"
        + "\u{6211}\u{4EEC}\u{5728}\u{4F1A}\u{4E0A}\u{8BA8}\u{8BBA}\u{8FC7}"
        + "\u{7684}\u{90A3}\u{4E2A}\u{90E8}\u{7F72}\u{811A}\u{672C}\u{FF0C}"
        + "\u{597D}\u{50CF}\u{4E00}\u{76F4}\u{6CA1}\u{6709}\u{628A}\u{65E5}"
        + "\u{5FD7}\u{8DEF}\u{5F84}\u{6539}\u{6210}\u{8DDF}\u{5E73}\u{53F0}"
        + "\u{65E0}\u{5173}\u{7684}\u{5199}\u{6CD5}\u{FF0C}\u{7B49}\u{8FD9}"
        + "\u{4E00}\u{8F6E}\u{8BF4}\u{5B8C}\u{4E4B}\u{540E}\u{FF0C}\u{5E2E}"
        + "\u{6211}\u{628A}\u{5B83}\u{7FFB}\u{51FA}\u{6765}\u{4ED4}\u{7EC6}"
        + "\u{68C0}\u{67E5}\u{4E00}\u{904D}\u{FF0C}\u{7136}\u{540E}\u{987A}"
        + "\u{624B}\u{5199}\u{4E2A}\u{56DE}\u{5F52}\u{6D4B}\u{8BD5}\u{9489}"
        + "\u{4F4F}\u{5B83}\u{FF0C}\u{522B}\u{5FD8}\u{4E86}\u{628A}\u{76F8}"
        + "\u{5173}\u{6587}\u{6863}\u{4E5F}\u{4E00}\u{8D77}\u{66F4}\u{65B0}"
        + "\u{6389}"

    /// The message that STARTS the turn every scenario needs. Deliberately short
    /// and ASCII: it is scaffolding, and the interesting text is what gets typed
    /// on top of the turn it opens.
    private static let opener = "Read the deploy script and tell me what it does"

    private static let withdrawn = "Actually never mind, withdraw this one"

    // MARK: - Scenario 1 to 3: the reported bug, banked, delivered once

    /// Mid-turn: SEND is offered, the tap is banked and NOT posted, and it goes out
    /// exactly once after the turn settles.
    ///
    /// The three scenarios are one test on purpose. They are three readings of ONE
    /// message's life, and splitting them would mean staging the same turn three
    /// times and asserting scenario 3 against a queued message some other test
    /// enqueued — which is exactly the confusion ("was it posted twice, or once by
    /// each test?") the wire log exists to remove.
    @MainActor
    func testMidTurnSendStaysASendIsBankedAndGoesOutOnceTheTurnSettles() async throws {
        let stub = try await stubUnderTest()
        _ = try await stub.reset()
        let app = try launchPaired()
        openChatTab(app)

        // ── A turn is running ──────────────────────────────────────────────────
        let composer = composerField(app)
        type(Self.opener, into: composer, of: app)
        tapSend(app)
        try await stub.waitForHeldTurn()
        let postsBefore = try await stub.messagePosts()
        XCTAssertEqual(postsBefore.count, 1, "the opener should be the only POST so far")

        // ── Scenario 1: the reported bug ───────────────────────────────────────
        type(Self.dictatedParagraph, into: composer, of: app)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(
            send.waitForExistence(timeout: 10),
            "the composer offered no send button mid-turn — this is the reported bug: "
                + "the seat was a red STOP and a dictated paragraph had nowhere to go"
        )
        XCTAssertTrue(
            send.isEnabled,
            "the send button is present but dead mid-turn, which is the same dead end "
                + "for the user as having no button at all"
        )
        XCTAssertFalse(
            app.buttons["chat.stop"].exists,
            "both a send and a stop are on screen — the composer has ONE seat, and "
                + "which control a thumb reaches must not be an ordering detail"
        )
        try await stub.screenshot(app, "01-midturn-send-button-enabled")
        tapSend(app)

        // ── Scenario 2: it was taken, and it was NOT sent ──────────────────────
        let badge = element(app, "chat.queuedBadge")
        XCTAssertTrue(
            badge.waitForExistence(timeout: 15),
            "no Queued badge appeared — the tap was accepted but the user is not told "
                + "the words are waiting, so the only honest reading of the screen is "
                + "that they were lost"
        )
        XCTAssertTrue(
            element(app, "chat.withdrawQueued").exists,
            "the badge has no Withdraw beside it — a message banked with no way to take "
                + "it back is worse than a refused one"
        )
        // WAITING, not already going out. The same badge element carries a second
        // state ("Delivering…", with the Withdraw gone), and the two are opposite
        // promises to the user: one says the words can still be taken back, the
        // other says a POST is already out for them. `exists` alone cannot tell
        // them apart, so the sentence VoiceOver would read is the assertion.
        XCTAssertTrue(
            badge.label.contains("Queued"),
            "the badge reads \(badge.label) while the turn is still held — the message "
                + "is being announced as on its way before anything could have sent it"
        )
        assertBadgeRowFits(app, badge: badge)
        try await stub.screenshot(app, "02-queued-badge")
        // A real chance to have gone out early. Without the wait an assertion that
        // nothing was posted would pass simply by running before the POST did.
        try await Task.sleep(for: .seconds(4))
        let heldPosts = try await stub.messagePosts()
        XCTAssertEqual(
            heldPosts.count, 1,
            "a banked message went on the wire while the turn was still held "
                + "(posts: \(heldPosts.map(\.text)))"
        )
        let stillHeld = try await stub.state().turnHeld
        XCTAssertNotNil(stillHeld, "the stub stopped holding the turn on its own")

        // ── Scenario 3: it is delivered once the turn ends ─────────────────────
        _ = try await stub.finishTurn()
        // The badge may pass through "Delivering…" on its way out (a POST is out for
        // the message, so it is no longer withdrawable). Gone is the resting state,
        // and 30s is generous for a stub that answers 202 at once.
        XCTAssertTrue(
            waitForDisappearance(badge, timeout: 30),
            "the badge is still on screen (\(badge.label)) after the turn settled — a "
                + "banked message that has been delivered is an ordinary message, and "
                + "anything still pinned to it says the words are waiting when they are not"
        )
        let delivered = try await stub.waitForMessagePosts(count: 2)
        XCTAssertEqual(
            delivered.count, 2,
            "the banked message was posted \(delivered.count - 1) times after the turn "
                + "settled, not once (texts: \(delivered.map { String(($0.text ?? "").prefix(12)) }))"
        )
        XCTAssertEqual(
            delivered[1].text, Self.dictatedParagraph,
            "the delivered POST does not carry the paragraph that was typed"
        )
        try await stub.screenshot(app, "03-delivered")
        // Let a second, wrong delivery arrive if one is coming. Exactly-once is the
        // claim, and it cannot be read off a single sample taken the instant the
        // first POST lands.
        try await Task.sleep(for: .seconds(5))
        let settled = try await stub.messagePosts()
        XCTAssertEqual(
            settled.count, 2,
            "a second POST followed the drain — the banked message was delivered more "
                + "than once (texts: \(settled.map { String(($0.text ?? "").prefix(12)) }))"
        )
    }

    // MARK: - Scenario 4: withdraw

    @MainActor
    func testAQueuedMessageCanBeWithdrawnAndIsNeverPosted() async throws {
        let stub = try await stubUnderTest()
        _ = try await stub.reset()
        let app = try launchPaired()
        openChatTab(app)

        let composer = composerField(app)
        type(Self.opener, into: composer, of: app)
        tapSend(app)
        try await stub.waitForHeldTurn()

        type(Self.withdrawn, into: composer, of: app)
        tapSend(app)
        let badge = element(app, "chat.queuedBadge")
        XCTAssertTrue(badge.waitForExistence(timeout: 15), "nothing was banked to withdraw")
        let withdraw = element(app, "chat.withdrawQueued")
        XCTAssertTrue(withdraw.exists, "no Withdraw control on the banked bubble")
        try await stub.screenshot(app, "04-withdraw-before")
        // XCUITest's `isHittable` asks the ACCESSIBILITY hit test, and inside a
        // `UIHostingConfiguration` cell that answer is not the touch's answer: the
        // thinking chip real users tap all day reports the same way (recorded below
        // as the control). So the tap is a synthesized touch at the control's centre,
        // which is what a thumb is, and the hierarchy is kept for anyone who wants to
        // see the two verdicts side by side.
        let chip = element(app, "thinking.chip")
        if !withdraw.isHittable {
            diagnose(app, "04-withdraw-not-hittable"
                + "-chipHittable-\(chip.exists ? String(chip.isHittable) : "absent")")
        }
        withdraw.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertTrue(
            waitForDisappearance(badge, timeout: 15),
            "the banked bubble survived its own Withdraw"
        )
        try await stub.screenshot(app, "04-withdraw")

        // The turn is STILL held here, so a withdrawn message has had no settle to
        // ride out on. Finish the turn anyway: the claim is that nothing is ever
        // posted for it, and the only moment it could be is the drain that a settle
        // starts.
        _ = try await stub.finishTurn()
        try await Task.sleep(for: .seconds(6))
        let posts = try await stub.messagePosts()
        XCTAssertEqual(
            posts.count, 1,
            "a withdrawn message was posted anyway (texts: \(posts.map(\.text)))"
        )
        XCTAssertFalse(
            posts.contains { $0.text == Self.withdrawn },
            "the withdrawn text reached the server"
        )
    }

    // MARK: - Scenario 5: the half that must not regress

    /// An EMPTY composer mid-turn still shows STOP.
    ///
    /// This is the other side of the same rule, and the one a fix for the reported
    /// bug could easily take away: the seat belongs to stop only when there is
    /// nothing to send, so a change that simply made it always a send would pass
    /// every assertion above and leave a user with no way to interrupt the agent.
    @MainActor
    func testAnEmptyComposerMidTurnStillOffersStop() async throws {
        let stub = try await stubUnderTest()
        _ = try await stub.reset()
        let app = try launchPaired()
        openChatTab(app)

        let composer = composerField(app)
        type(Self.opener, into: composer, of: app)
        tapSend(app)
        try await stub.waitForHeldTurn()

        // The send cleared the draft, so the composer is empty and the turn is running.
        let stop = app.buttons["chat.stop"]
        XCTAssertTrue(
            stop.waitForExistence(timeout: 15),
            "no stop control with a turn running and an empty composer — the user "
                + "cannot interrupt the agent"
        )
        XCTAssertTrue(stop.isEnabled, "the stop control is present but dead")
        XCTAssertFalse(
            app.buttons["chat.send"].exists,
            "a send button sits in the stop's seat on an empty composer, so the row "
                + "carries a control that can do nothing"
        )
        try await stub.screenshot(app, "05-empty-midturn-stop")
    }

    // MARK: - Driving the app

    /// The live app, paired ONLY through launch arguments at the stub (see
    /// `UITestLaunch`: an explicit pairing is kept, and a test that says nothing
    /// gets the blackhole rather than whatever this simulator last talked to).
    private func launchPaired() throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch([
            "-walnut.serverUrl", server,
            "-walnut.deviceToken", token,
        ])
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner — run this through "
                    + "ios-native/tests/ui/run-ui-tests.sh with WALNUT_UITEST_SERVER pointed "
                    + "at a running tests/ui/mid-turn-stub-server.mjs (exporting the variable "
                    + "in your shell does not reach an XCUITest runner; it has to be in the "
                    + ".xctestrun, which the script guarantees)"
            )
        }
        return (server, token)
    }

    private func openChatTab(_ app: XCUIApplication) {
        let chat = app.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 60), "the tab bar never appeared")
        // Chat is the resting tab, but a warm launch can land anywhere, and a tap on
        // the tab already selected is a no-op.
        chat.tap()
    }

    /// The composer's text field.
    ///
    /// Matched by identifier across every element type on purpose: the composer is a
    /// plain `TextField` under `ComposerBar.longDraftThreshold` and a UITextView-backed
    /// editor above it, both carrying `chat.composer`, and which one is on screen is a
    /// cost decision the test has no business encoding.
    private func composerField(_ app: XCUIApplication) -> XCUIElement {
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.waitForExistence(timeout: 45), "the chat composer never appeared")
        return field
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    /// Put text in the composer the way a person does, and PROVE it landed.
    ///
    /// The proof is the point. `typeText` delivers ASCII through synthesized key
    /// events, and a CJK paragraph through a different path that can silently
    /// deliver nothing; a test that typed into the void would then assert the
    /// composer's EMPTY-mid-turn behaviour while believing it had typed a
    /// paragraph, and report the reported bug as fixed. So the field's own value is
    /// read back, and the pasteboard is the fallback for a keyboard that will not
    /// carry the characters.
    private func type(_ text: String, into field: XCUIElement, of app: XCUIApplication) {
        XCTAssertTrue(field.waitForExistence(timeout: 45), "the composer never appeared")
        // `isHittable` is deliberately NOT the gate. Measured on this build: the
        // composer answers `exists` and reports `isHittable == false` for as long as
        // you care to poll, while `tap()` on it works perfectly — so an assertion on
        // it fails a healthy screen. The gate is the OUTCOME (`fieldHolds`), and the
        // steps in between only widen the chance of getting there.
        field.tap()
        if !app.keyboards.element.waitForExistence(timeout: 10) {
            // A coordinate tap does not consult hit-testability at all, so it is the
            // one retry worth having when the first tap focused nothing.
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            if !app.keyboards.element.waitForExistence(timeout: 10) {
                diagnose(app, "diag-no-keyboard")
            }
        }
        field.typeText(text)
        if fieldHolds(text, field) { return }

        // Fallback: the system pasteboard, then the field's own Paste. The runner is
        // an app on this simulator, so `UIPasteboard.general` IS the one the app
        // reads. This exists for the CJK paragraph: `typeText` carries ASCII as
        // synthesized key events and non-ASCII through a different path that can
        // deliver nothing at all.
        UIPasteboard.general.string = text
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].firstMatch
        if paste.waitForExistence(timeout: 5) {
            paste.tap()
        } else {
            // iOS renders the edit menu out of process on some versions.
            XCUIApplication(bundleIdentifier: "com.apple.springboard")
                .menuItems["Paste"].firstMatch.tap()
        }
        if fieldHolds(text, field) { return }

        // Both paths failed. Put the TREE somewhere a human can open, not only the
        // verdict: "the text did not land" is unactionable, and whatever swallowed it
        // is in the hierarchy.
        diagnose(app, "diag-typing-failed")
        XCTFail(
            "neither typing nor pasting put the text in the composer (its value reads "
                + "\(String(describing: field.value))) — every assertion after this would "
                + "be about an empty field"
        )
    }

    /// Ship the accessibility hierarchy and a screenshot to the stub, which is a host
    /// process and can therefore leave them at a path a human can open.
    private func diagnose(_ app: XCUIApplication, _ name: String) {
        let tree = app.debugDescription
        let attachment = XCTAttachment(string: tree)
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: name) { $0.add(attachment) }
        guard let base = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
              let url = URL(string: base + "/__stub/diag?name=" + name)
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(tree.utf8)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 15)
    }

    /// Does the field now hold this text? Compared on a PREFIX because a composer
    /// field reports its value with the placeholder replaced and may clip a long
    /// string in its accessibility value.
    private func fieldHolds(_ text: String, _ field: XCUIElement) -> Bool {
        let needle = String(text.prefix(6))
        return waitUntil(timeout: 8) {
            (field.value as? String)?.contains(needle) == true
        }
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }

    /// A badge and a button in ONE row is the shape that overflows at a large text
    /// size, so this is asserted as geometry rather than trusted to a screenshot.
    ///
    /// Deliberately size-INDEPENDENT: it does not say "side by side" (that is only
    /// true at ordinary sizes — at an accessibility size the two stack vertically),
    /// it says they must not sit on top of each other and must both be inside the
    /// window. Those are the two ways this row actually fails: one control painted
    /// over the other, or one pushed off the edge where no thumb can reach it.
    private func assertBadgeRowFits(_ app: XCUIApplication, badge: XCUIElement) {
        let withdraw = element(app, "chat.withdrawQueued")
        guard withdraw.exists else { return }
        let window = app.windows.firstMatch.frame
        XCTAssertFalse(
            badge.frame.intersects(withdraw.frame),
            "the Queued badge \(badge.frame) and Withdraw \(withdraw.frame) overlap — "
                + "one is painted over the other, so which one a tap reaches is not a "
                + "decision anybody made"
        )
        for (name, frame) in [("badge", badge.frame), ("withdraw", withdraw.frame)] {
            XCTAssertTrue(
                window.contains(frame),
                "the \(name) at \(frame) is outside the window \(window) — it has been "
                    + "pushed off the edge, which is what this row does when it runs out "
                    + "of width"
            )
        }
    }

    private func tapSend(_ app: XCUIApplication) {
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 15), "no send button to tap")
        XCTAssertTrue(send.isEnabled, "the send button is disabled with content typed")
        send.tap()
    }

    private func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            usleep(300_000)
        }
        return !element.exists
    }

    // MARK: - The stub

    /// The throwaway server this test drives, proved to BE the throwaway server.
    ///
    /// The control plane is the proof: a live Walnut has no `/__stub/state`, so a
    /// pairing that happens to point at :3456 or at a dogfood box SKIPS here
    /// instead of sending a message into somebody's real conversation. Refusing to
    /// fall back is the whole policy — there is no degraded mode in which this test
    /// runs against a real server.
    private func stubUnderTest() async throws -> StubControl {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StubControl(base: base)
        do {
            _ = try await stub.state()
        } catch {
            throw XCTSkip(
                "\(server) is not the mid-turn stub (no /__stub/state: \(error)) — start "
                    + "ios-native/tests/ui/mid-turn-stub-server.mjs and point "
                    + "WALNUT_UITEST_SERVER at the port it prints. This test never runs "
                    + "against a real Walnut: a send here would be a real turn in a real "
                    + "conversation."
            )
        }
        return stub
    }

    struct MessagePost: Decodable {
        let seq: Int
        let path: String
        let text: String?
    }

    struct StubState: Decodable {
        let generation: Int
        let turnHeld: String?
        let messagePosts: [MessagePost]
        let requestCount: Int
    }

    /// Thin HTTP client for the stub's control plane. No retries and no tolerance:
    /// a control call that does not answer means the fixture is gone, and carrying
    /// on would produce a verdict about nothing.
    struct StubControl {
        let base: URL

        /// `path` is appended as a RAW relative reference, not through
        /// `appendingPathComponent` — that helper percent-encodes `?` and `=`, which
        /// turned `__stub/screenshot?name=x` into one long path component and made
        /// every screenshot land under the same default name.
        private func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "unusable control URL \(root)\(path)",
                ])
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            if let body {
                request.httpBody = body
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw NSError(domain: "stub", code: code, userInfo: [
                    NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)",
                ])
            }
            return data
        }

        func state() async throws -> StubState {
            try JSONDecoder().decode(StubState.self, from: try await call("GET", "__stub/state"))
        }

        @discardableResult
        func reset() async throws -> Int {
            _ = try await call("POST", "__stub/reset")
            return try await state().generation
        }

        @discardableResult
        func finishTurn() async throws -> String? {
            _ = try await call("POST", "__stub/finish-turn")
            return try await state().turnHeld
        }

        func messagePosts() async throws -> [MessagePost] {
            try await state().messagePosts
        }

        /// Wait until the stub is holding a turn open. Until it is, "mid-turn" is a
        /// claim about timing rather than a fact, and every assertion after it would
        /// be measuring a composer that is between states.
        func waitForHeldTurn(timeout: TimeInterval = 45) async throws {
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                let held = try await state().turnHeld
                if held != nil { return }
                try await Task.sleep(for: .milliseconds(400))
            }
            XCTFail("the stub never received a message POST to hold — the opener never went out")
        }

        func waitForMessagePosts(count: Int, timeout: TimeInterval = 45) async throws -> [MessagePost] {
            let deadline = Date().addingTimeInterval(timeout)
            var latest: [MessagePost] = []
            while Date() < deadline {
                latest = try await messagePosts()
                if latest.count >= count { return latest }
                try await Task.sleep(for: .milliseconds(400))
            }
            return latest
        }

        /// Hand a screenshot to the stub, which is a HOST process and can therefore
        /// put the PNG somewhere a human can open it. The runner is sandboxed on the
        /// simulator, so a direct write to a host path is not something to rely on.
        func screenshot(_ app: XCUIApplication, _ name: String) async throws {
            let shot = app.screenshot()
            // Keep the attachment too: it is what survives in the .xcresult when the
            // stub is gone, and it is how a failure is read months later.
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
            _ = try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        }
    }
}
