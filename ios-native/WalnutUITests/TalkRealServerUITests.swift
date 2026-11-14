import XCTest

/// Talk to Walnut the way the Action Button runs it, against a real paired server: Walnut in
/// the background, the shortcut run from the Shortcuts app, and the sentence checked in the
/// CEO chat of that server through its API.
///
/// The press listens with Walnut closed (its Live Activity up first, then the microphone),
/// and only the person sends: a second press, or the Live Activity's Send. When it cannot
/// listen from behind (`talkRefuseFromBehind` stands in for a phone that refuses, as build
/// 160's phone did with "Audio is in use by another app"), it opens Walnut listening, and a
/// Send followed at once by leaving Walnut still reaches the CEO. The simulator enforces no
/// background recording rule, so only a phone proves the from-behind path; this proves the
/// rest. The run opens the real voice session the way a press does
/// (`VoiceRecorder.activateForReplay`, the same activation, and a real microphone recorder
/// held open for the take); only the words come from a recorded file, so nothing is played
/// or spoken aloud on the Mac that runs it. Its runner
/// (`ios-native/tests/ui/run-talk-real-server.sh`) hands it:
///
///  - `WALNUT_UITEST_SERVER` / `WALNUT_UITEST_TOKEN`: a paired server (a test copy of the
///    user's data, never the real one), reachable from the simulator;
///  - `WALNUT_UITEST_REAL_SERVER=1`: the opt-in.
///
/// Without them it is skipped. Screenshots are taken every half second and kept, so the run
/// reads as a clip (the runner stitches them into an MP4).
final class TalkRealServerUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var frame = 0

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard env["WALNUT_UITEST_REAL_SERVER"] == "1" else {
            throw XCTSkip("needs a paired test server (WALNUT_UITEST_REAL_SERVER=1)")
        }
        guard env["WALNUT_UITEST_SERVER"] != nil, env["WALNUT_UITEST_TOKEN"] != nil else {
            throw XCTSkip("needs WALNUT_UITEST_SERVER and WALNUT_UITEST_TOKEN")
        }
    }

    private func shot(_ name: String) {
        frame += 1
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = String(format: "frame-%04d-%@", frame, name)
        a.lifetime = .keepAlways
        add(a)
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func labelled(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    /// Screenshots every half second until `done` holds or `seconds` pass.
    private func film(_ name: String, seconds: Double, until done: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            shot(name)
            if done() { return true }
            usleep(500_000)
        }
        shot(name)
        return done()
    }

    private func pairing(refuseFromBehind: Bool = false) throws -> [String] {
        // The words of the take: a recorded sentence the take reads as its microphone.
        let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
        return [
            UITestLaunch.serverURLArgument, UITestLaunch.pairedServer(env["WALNUT_UITEST_SERVER"] ?? ""),
            "-walnut.deviceToken", env["WALNUT_UITEST_TOKEN"] ?? "", "-walnut.debug.talkClearOutbox", "YES",
            "-walnut.debug.talkReplayFile", audio,
            "-walnut.debug.talkRefuseFromBehind", refuseFromBehind ? "YES" : "NO",
        ]
    }

    // MARK: - The CEO chat, read from the server

    /// Words of the recorded sentence ("This is a test from the action button...").
    private static let sentence = "test from the action button"

    private func api(_ method: String, _ path: String) throws -> Data {
        let base = try XCTUnwrap(env["WALNUT_UITEST_SERVER"]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var request = URLRequest(url: try XCTUnwrap(URL(string: base + "/api/v1" + path)), timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("Bearer \(env["WALNUT_UITEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }
        let done = DispatchSemaphore(value: 0)
        var reply: (Data?, Error?) = (nil, nil)
        URLSession.shared.dataTask(with: request) { data, _, error in
            reply = (data, error)
            done.signal()
        }.resume()
        done.wait()
        if let error = reply.1 { throw error }
        return reply.0 ?? Data()
    }

    /// How often the sentence appears in every session of the CEO's task.
    private func timesInCEOChat() throws -> Int {
        let main = try JSONSerialization.jsonObject(with: api("POST", "/org/main")) as? [String: Any]
        let taskId = try XCTUnwrap((main?["task"] as? [String: Any])?["id"] as? String, "no CEO task")
        let task = String(decoding: try api("GET", "/tasks/\(taskId)"), as: UTF8.self)
        var sessions = Set<String>()
        let one = try Regex(#""(?:session_id|exec_session_id|plan_session_id)"\s*:\s*"([^"]+)""#, as: (Substring, Substring).self)
        for match in task.matches(of: one) { sessions.insert(String(match.1)) }
        let list = try Regex(#""session_ids"\s*:\s*\[([^\]]*)\]"#, as: (Substring, Substring).self)
        let quoted = try Regex(#""([^"]+)""#, as: (Substring, Substring).self)
        if let ids = task.firstMatch(of: list) {
            for id in ids.1.matches(of: quoted) { sessions.insert(String(id.1)) }
        }
        var count = 0
        for id in sessions {
            // Only the person's own messages, one per row: the history also carries each row's raw
            // text and hints, rows Walnut injected, and the CEO's answers, any of which can quote
            // the sentence and land in the middle of a later test.
            let history = try JSONSerialization.jsonObject(with: api("GET", "/sessions/\(id)/history")) as? [String: Any]
            for row in (history?["messages"] as? [[String: Any]]) ?? []
            where (row["role"] as? String) == "user" && row["injected"] == nil {
                if ((row["text"] as? String) ?? "").lowercased().contains(Self.sentence) { count += 1 }
            }
        }
        return count
    }

    /// Waits (filming) until the CEO chat holds the sentence more often than `before`.
    private func reachesTheCEO(after before: Int, _ label: String, seconds: Double = 120) -> Bool {
        film("\(label)-to-ceo", seconds: seconds) { ((try? timesInCEOChat()) ?? before) > before }
    }

    // MARK: - The press

    private func tile(_ shortcuts: XCUIApplication, _ name: String = "Talk to Walnut") -> XCUIElement {
        // The tile's own label, exactly: "Dictate" is also the label of the search field's
        // microphone (system dictation), which sits above the tiles.
        let matches = shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name))
        // A fresh install's shortcuts reach the Shortcuts app once iOS has indexed them.
        if !matches.firstMatch.waitForExistence(timeout: 30) {
            shortcuts.terminate()
            shortcuts.launch()
        }
        XCTAssertTrue(matches.firstMatch.waitForExistence(timeout: 60), "\(name) is not in the Shortcuts app")
        // The tile itself, never its title inside it (a static text a tap does not run:
        // 2026-11-13, every press tapped the title and nothing started), nor the search
        // field's microphone.
        let search = shortcuts.searchFields.firstMatch
        let searchFrame = search.exists ? search.frame : .null
        let around = shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", name))
        let tile = around.allElementsBoundByIndex.first {
            $0.isHittable && $0.elementType != .staticText && !$0.frame.intersects(searchFrame)
        }
        print("talk-test: \(name) tile = \(tile.map { "\($0.elementType.rawValue) '\($0.label)' \($0.frame)" } ?? "none, the first match")")
        return tile ?? matches.firstMatch
    }

    /// Walnut opened once (paired), then sent away.
    private func sendAway(_ app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        shot("walnut-open")
        XCUIDevice.shared.press(.home)
    }

    /// The Shortcuts app in front with its tile, Walnut behind it and not in front.
    private func ready(_ shortcuts: XCUIApplication, behind app: XCUIApplication) {
        shortcuts.launch()
        _ = tile(shortcuts)
        shot("shortcuts")
        XCTAssertNotEqual(app.state, .runningForeground, "Walnut is in front before the press")
    }

    /// The press listens with Walnut closed: films `seconds` and fails if Walnut came forward.
    private func listensBehind(_ app: XCUIApplication, _ label: String, seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            shot("\(label)-listening")
            XCTAssertNotEqual(app.state, .runningForeground, "the press opened Walnut")
            usleep(500_000)
        }
    }

    /// Press, the recorded sentence (about 4 s), press again: it reaches the CEO with Walnut
    /// closed all along, and nothing went before the second press.
    @MainActor
    func testThePressListensWithWalnutClosedAndASecondPressSends() throws {
        let app = UITestLaunch.launch(try pairing())
        sendAway(app)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        ready(shortcuts, behind: app)
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        let before = try timesInCEOChat()
        tile(shortcuts).tap()
        // Longer than the sentence and a pause after it: a pause sends nothing.
        listensBehind(app, "press", seconds: 9)
        XCTAssertEqual(try timesInCEOChat(), before, "the take went out before the second press")
        tile(shortcuts).tap()
        XCTAssertTrue(reachesTheCEO(after: before, "press"), "the words never reached the CEO chat")
        XCTAssertNotEqual(app.state, .runningForeground, "the send opened Walnut")
    }

    /// Press, then the Live Activity's big Send, from the Lock Screen's list with Walnut closed.
    @MainActor
    func testTheLiveActivitysSendSendsWithWalnutClosed() throws {
        let app = UITestLaunch.launch(try pairing())
        sendAway(app)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        ready(shortcuts, behind: app)
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        let before = try timesInCEOChat()
        tile(shortcuts).tap()
        listensBehind(app, "activity", seconds: 6)
        // The Lock Screen's list (pulled down from the top), where the Live Activity shows.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.005))
            .press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.7)))
        let send = springboard.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Send")).firstMatch
        let shown = film("activity-lock-screen", seconds: 10) { send.exists }
        XCTAssertTrue(shown, "no Send on the Live Activity")
        XCTAssertTrue(labelled(springboard, "Listening").exists, "the Live Activity does not say Listening")
        send.tap()
        XCTAssertTrue(reachesTheCEO(after: before, "activity"), "the words never reached the CEO chat")
        XCTAssertNotEqual(app.state, .runningForeground, "the send opened Walnut")
    }

    /// From behind refused (a phone that will not let it listen there): the press opens Walnut
    /// listening; Send, then leaving Walnut at once, and the words still reach the CEO.
    @MainActor
    func testRefusedFromBehindItOpensWalnutAndASendSurvivesLeaving() throws {
        let app = UITestLaunch.launch(try pairing(refuseFromBehind: true))
        sendAway(app)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        ready(shortcuts, behind: app)
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        let before = try timesInCEOChat()
        tile(shortcuts).tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "the refused press did not bring Walnut forward")
        let title = element(app, "talk.panel.title")
        let listening = film("fallback-opening", seconds: 15) { title.exists && title.label == "Listening" }
        XCTAssertTrue(listening, "the Talk screen never listened: \(title.exists ? title.label : "no panel")")
        XCTAssertFalse(labelled(app, "Couldn't start listening").exists, "the microphone was refused in front")
        // A pause sends nothing: after the sentence it still listens.
        _ = film("fallback-take", seconds: 7) { false }
        XCTAssertEqual(title.label, "Listening", "the take ended without a Send")
        element(app, "talk.panel.send").tap()
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(reachesTheCEO(after: before, "fallback"), "the send stopped when Walnut was left")
    }

    /// Dictate, the Action Button's other shortcut: the press opens Walnut listening, Done
    /// ends the take, and its words open on one page with Send and Copy (the user,
    /// 2026-11-11: "just one page that can send and can copy"). Copy puts them on the
    /// clipboard and sends nothing; a second dictation's Send reaches the CEO chat.
    @MainActor
    func testDictateShowsOnePageThatCopiesOrSends() throws {
        let app = UITestLaunch.launch(try pairing())
        sendAway(app)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        _ = tile(shortcuts, "Dictate")
        shot("shortcuts-dictate")
        XCTAssertNotEqual(app.state, .runningForeground, "Walnut is in front before the press")
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        let before = try timesInCEOChat()

        // Copy.
        let words = dictateToPage(app, shortcuts, "copy")
        element(app, "talk.review.copy").tap()
        let title = element(app, "talk.panel.title")
        XCTAssertTrue(film("copy-done", seconds: 5) { title.exists && title.label == "Copied" }, "Copy did not say Copied")
        _ = film("copy-closes", seconds: 4) { !element(app, "talk.panel").exists }
        XCTAssertFalse(element(app, "talk.panel").exists, "the page stayed up after Copy")
        app.tabBars.buttons["Settings"].tap()
        let row = element(app, "settings.talkToWalnut")
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        row.tap()
        let result = element(app, "talk.dictate.result")
        for _ in 0..<4 where !result.exists { app.swipeUp() }
        XCTAssertTrue(film("copied-line", seconds: 10) { result.exists && result.label.contains(Self.sentence) },
                      "the Action Button page does not show what was copied: \(result.exists ? result.label : "none")")
        XCTAssertTrue(result.label.hasPrefix("Copied"), result.label)
        XCTAssertEqual(try timesInCEOChat(), before, "Copy reached the CEO chat")
        XCTAssertTrue(words.lowercased().contains(Self.sentence))

        // Send, from a second dictation.
        XCUIDevice.shared.press(.home)
        shortcuts.activate()
        _ = dictateToPage(app, shortcuts, "send")
        element(app, "talk.review.send").tap()
        XCTAssertTrue(reachesTheCEO(after: before, "dictate-send"), "Send never reached the CEO chat")
        XCTAssertTrue(film("send-done", seconds: 6) { !element(app, "talk.panel").exists }, "the page stayed up after Send")
    }

    /// The Dictate tile: Walnut comes forward listening, Done ends the take, and the page
    /// shows its words. Returns the words on the page.
    private func dictateToPage(_ app: XCUIApplication, _ shortcuts: XCUIApplication, _ label: String) -> String {
        tile(shortcuts, "Dictate").tap()
        // Filmed: whatever the Shortcuts app says instead (an alert, an error) shows in the clip.
        XCTAssertTrue(film("\(label)-press", seconds: 20) { app.state == .runningForeground }, "Dictate did not bring Walnut forward")
        let title = element(app, "talk.panel.title")
        XCTAssertTrue(film("\(label)-opening", seconds: 15) { title.exists && title.label == "Listening" },
                      "Dictate never listened: \(title.exists ? title.label : "no panel")")
        XCTAssertEqual(element(app, "talk.panel.send").label, "Done", "listening offers Send, not Done")
        _ = film("\(label)-take", seconds: 7) { false }
        element(app, "talk.panel.send").tap()
        let text = element(app, "talk.review.text")
        XCTAssertTrue(film("\(label)-page", seconds: 40) { text.exists && ((text.value as? String) ?? "").lowercased().contains(Self.sentence) },
                      "the page never showed the words")
        XCTAssertTrue(element(app, "talk.review.copy").isHittable, "no Copy on the page")
        XCTAssertTrue(element(app, "talk.review.send").isHittable, "no Send on the page")
        // Held a moment so the clip shows the page a person reads before picking.
        _ = film("\(label)-page-ready", seconds: 3) { false }
        return (text.value as? String) ?? ""
    }

    /// Right after Walnut's own voice input (the chat's microphone), with Walnut sent away.
    @MainActor
    func testThePressRecordsRightAfterWalnutsOwnVoiceInput() throws {
        let app = UITestLaunch.launch(try pairing())
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        app.tabBars.buttons["Chat"].tap()
        let microphone = element(app, "chat.mic")
        XCTAssertTrue(microphone.waitForExistence(timeout: 30), "no microphone in the chat")
        microphone.tap()
        let stop = element(app, "chat.voiceStop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "the chat's voice input did not start")
        _ = film("dictation", seconds: 4) { false }
        stop.tap()
        _ = film("dictation-done", seconds: 30) { microphone.exists && microphone.isHittable }
        XCUIDevice.shared.press(.home)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        let before = try timesInCEOChat()
        tile(shortcuts).tap()
        listensBehind(app, "after-dictation", seconds: 6)
        tile(shortcuts).tap()
        XCTAssertTrue(reachesTheCEO(after: before, "after-dictation"), "the words never reached the CEO chat")
    }
}
