import UIKit
import XCTest

/// ONE MESSAGE, ONE TURN, ACROSS A LOST ANSWER, on the real app.
///
/// Every attempt of a message goes out under the id the phone minted for it, and the
/// server answers a repeat of a message it already took once (`chat-send-once.ts`, the
/// session queue's `qm-*` ids). The unit tests pin the stores; what they cannot show is
/// the real order of events on a phone: the stream's frames beating a slow answer, the
/// app going to the background with a request in flight, a person tapping a retry.
/// The send-once gate r1 saw two of those only here (its MEDIUM-2 and MEDIUM-3):
///
///  - a SESSION send whose automatic retry the background cuts short goes out again
///    when the page comes back, under the same id, and the session gets it once;
///  - a CHAT message whose answer is lost while the app is away shows once, as its own
///    server row, and never as "Not sent. Tap to retry." beside that row (Q1chat-x), a
///    turn still running included;
///  - a CHAT retry tap goes out under the first attempt's id, and the agent gets the
///    message once.
///
/// THE SERVER IS REAL, THE FAULTS ARE STAGED. `ios-native/tests/ui/send-once-server.ts`
/// runs a real Walnut in a throwaway home (mock daemon, mock CLI) behind a proxy that
/// refuses, holds or swallows the message POSTs a test arms, records every attempt with
/// its message id, and reads back the server's own rows. Run it with
/// `ios-native/tests/ui/run-send-once-ui.sh`: without that harness every test here skips,
/// like the other paired UI tests.
///
/// Each step's screen and the proxy's record go to the harness's out dir
/// (`uitest.log`, `shots/`), so a failing run shows what the page showed.
final class SendOnceUITests: XCTestCase {

    struct Seeded: Decodable { let sessionId: String; let taskId: String }
    struct Config: Decodable { let token: String; let sessions: [String: Seeded] }
    struct Post: Decodable {
        let n: Int
        let kind: String
        let conversationId: String
        let text: String
        let messageId: String?
        let step: String
        let status: Int?
        let forwarded: Bool
        let clientGone: Bool
    }
    struct State: Decodable { let posts: [Post] }
    struct Rows: Decodable { let status: Int; let user: Int; let assistant: Int }

    private var server = ""
    private var config: Config!
    private let runTag = String(UUID().uuidString.prefix(6)).lowercased()
    private var runName = ""
    private var t0 = Date()

    override func setUpWithError() throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["WALNUT_UITEST_SERVER"], !raw.isEmpty else {
            throw XCTSkip("no WALNUT_UITEST_SERVER: run ios-native/tests/ui/run-send-once-ui.sh")
        }
        server = UITestLaunch.pairedServer(raw)
        guard let data = http("GET", "config"),
              let parsed = try? JSONDecoder().decode(Config.self, from: data) else {
            throw XCTSkip("no send-once harness at \(server): run ios-native/tests/ui/run-send-once-ui.sh")
        }
        config = parsed
        t0 = Date()
    }

    // MARK: - Session: a retry the background cut short

    /// The first POST is refused (the host's bridge is down), so the bubble waits for
    /// its automatic retry. That retry's POST is held where the server never sees it,
    /// and the app goes to the background with it in flight, which cancels it. The
    /// page coming back must send the message again under the SAME id, once.
    func testASessionRetryCutShortByTheBackgroundGoesOutAgainUnderItsIdOnce() throws {
        guard let entry = config.sessions["a"] else { return XCTFail("the harness seeded no session a") }
        runName = "session-retry"
        let marker = "Send once session"
        // The harness's session outlives one run of this test (a mutant app's run
        // follows the fix app's on the same server): the words name this run, so the
        // server's rows of them are this run's alone.
        let reply = "Send once session reply \(runTag)"
        let words = "snapshot-clean-turn:" + reply
        reset()
        arm(marker, ["refuse503", "stall:25000"])
        let app = launch()
        guard openSession(app, entry) else { return XCTFail("the seeded session did not open") }
        send(app, words)
        guard waitPosts(marker, count: 2, timeout: 45) else {
            step(app, "s01-no-retry", words)
            return XCTFail("the automatic retry never went out: \(posts(marker))")
        }
        step(app, "s01-retry-in-flight", words)
        // The bubble holds the words while it waits for its retry: the composer does
        // not get them back as well (a second tap would send them again).
        XCTAssertFalse(composerHolds(app, words), "the composer holds the words its bubble is retrying")
        XCTAssertFalse(refusedNoticeShown(app), "the page says a message it is retrying was not sent")
        XCUIDevice.shared.press(.home)
        log("home at +\(secs())s")
        sleep(8)
        app.activate()
        log("back at +\(secs())s")
        step(app, "s02-back", words)
        XCTAssertTrue(waitLabel(app, reply, timeout: 75), "the message's turn never ran after the return")
        sleep(3)
        step(app, "s03-answered", words)

        let sent = posts(marker)
        log("POSTS \(sent)")
        XCTAssertEqual(sent.first?.status, 503, "the first attempt was meant to be refused")
        XCTAssertEqual(sent.dropFirst().first?.forwarded, false,
                       "the held retry reached the server, so this run says nothing about the return")
        let heldN = sent.count > 1 ? sent[1].n : Int.max
        XCTAssertTrue(sent.contains { $0.n > heldN && $0.forwarded && $0.status == 202 },
                      "no attempt after the held one was taken: \(sent)")
        assertOneId(sent)
        let rows = serverRows("session", entry.sessionId, words)
        XCTAssertEqual(rows?.user, 1, "the session got the message \(rows?.user ?? -1) times")
        XCTAssertEqual(rows?.assistant, 0, "the user's words were echoed into an answer row")
        XCTAssertEqual(serverRows("session", entry.sessionId, reply)?.assistant, 1, "the turn ran a number of times other than once")
        XCTAssertEqual(copies(app, words), 1, "the page shows the message a number of times other than once")
        XCTAssertEqual(notices(app), [], "a failed or waiting copy is left on the page")
        XCTAssertFalse(composerHolds(app, words), "the composer holds a message that was delivered")
        XCTAssertFalse(refusedNoticeShown(app), "the page says a delivered message was not sent")
    }

    // MARK: - Chat: an answer lost in the background

    /// Q1chat-x, the gate's order: the POST reaches the server at once and its answer is
    /// held, so the stream shows the message's own row while the POST is still out; the
    /// app goes home, the request ends cancelled, the app comes back. The page must show
    /// the words once and no "Not sent", on a short turn and on one still running.
    func testAChatMessageWhoseAnswerIsLostShowsOnceAndNeverAsNotSent() throws {
        runName = "chat-lost"
        let short = "snapshot-clean-turn:Send once chat lost"
        let shortReply = "Send once chat lost"
        // A turn that runs about 12 s (the harness's write delay) and is filed in the
        // lane's transcript, so the conversation has the message's own row.
        let long = "snapshot-write-turn:send-once-long.txt:Send once chat long"
        let longReply = "Wrote send-once-long.txt."
        reset()
        arm("Send once chat lost", ["hold:20000"])
        arm("Send once chat long", ["hold:20000"])
        let app = launch()
        guard openNewChat(app) else { return XCTFail("could not open a new chat") }

        send(app, short)
        guard waitPosts("Send once chat lost", count: 1, timeout: 20) else { return XCTFail("the POST never went out") }
        sleep(1)
        step(app, "c01-sent", short)
        awayAndBack(app, seconds: 6)
        var bad: [String] = []
        for i in 0..<6 {
            let shown = notices(app)
            let n = copies(app, short)
            step(app, "c02-back-\(i * 2)s", short)
            if !shown.isEmpty || n != 1 { bad.append("+\(i * 2)s: copies \(n), notices \(shown)") }
            sleep(2)
        }
        XCTAssertEqual(bad, [], "Q1chat-x: the message's own row and a failed copy of it")
        XCTAssertTrue(waitLabel(app, shortReply, timeout: 30), "the short turn's answer never showed")

        send(app, long)
        guard waitPosts("Send once chat long", count: 1, timeout: 20) else { return XCTFail("the long turn's POST never went out") }
        sleep(1)
        step(app, "c03-long-sent", long)
        awayAndBack(app, seconds: 5)
        // While the turn runs the conversation may not show the message's row yet
        // (this harness files a write turn's rows when it ends), and then the copy
        // honestly reads as not sent. What must never happen is the gate's picture: a
        // failed copy BESIDE its own row. Once the row lands the copy is gone (below).
        bad = []
        for i in 0..<4 {
            let shown = notices(app)
            let n = copies(app, long)
            step(app, "c04-long-back-\(i * 3)s", long)
            if n != 1 { bad.append("+\(i * 3)s: copies \(n), notices \(shown)") }
            sleep(3)
        }
        XCTAssertEqual(bad, [], "Q1chat-x while the turn runs: the row and a failed copy of it")
        XCTAssertTrue(waitLabel(app, longReply, timeout: 45), "the long turn's answer never showed")
        sleep(2)
        step(app, "c05-long-answered", long)
        XCTAssertEqual(notices(app), [], "a failed copy is left once both turns ended")
        XCTAssertFalse(composerHolds(app, short) || composerHolds(app, long), "the composer holds a message the server has")

        for (marker, words, answer) in [("Send once chat lost", short, shortReply), ("Send once chat long", long, longReply)] {
            let sent = posts(marker)
            log("POSTS \(marker): \(sent)")
            XCTAssertEqual(sent.count, 1, "\(marker): the phone posted \(sent.count) times")
            assertOneId(sent)
            guard let conversation = sent.first?.conversationId else { continue }
            XCTAssertEqual(serverRows("chat", conversation, words)?.user, 1, "\(marker): the agent got it a number of times other than once")
            XCTAssertEqual(serverRows("chat", conversation, answer)?.assistant, 1, "\(marker): the turn ran a number of times other than once")
            XCTAssertEqual(copies(app, words), 1, "\(marker): the page shows it a number of times other than once")
        }
    }

    // MARK: - Chat: a retry tap

    /// The POST never reaches the server and is answered 504, so the phone cannot tell
    /// whether the server has it and shows "Not sent. Tap to retry.". The tap must go
    /// out under the first attempt's id, and the agent must get the message once.
    func testAChatRetryTapGoesOutUnderTheFirstIdAndRunsOnce() throws {
        runName = "chat-tap"
        let marker = "Send once chat tap"
        let words = "snapshot-clean-turn:Send once chat tap"
        let reply = "Send once chat tap"
        reset()
        arm(marker, ["stall:3000"])
        let app = launch()
        guard openNewChat(app) else { return XCTFail("could not open a new chat") }
        send(app, words)
        guard waitPosts(marker, count: 1, timeout: 20) else { return XCTFail("the POST never went out") }
        guard let notice = hittableNotice(app, timeout: 30) else {
            step(app, "t01-no-notice", words)
            return XCTFail("no Not sent to tap after the lost answer: \(notices(app))")
        }
        step(app, "t01-not-sent", words)
        XCTAssertEqual(notice.label, "Not sent. Tap to retry.")
        if notice.isHittable {
            notice.tap()
        } else {
            log("the notice never became hittable: tapping where it is drawn")
            notice.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        log("tapped retry at +\(secs())s")
        XCTAssertTrue(waitLabel(app, reply, timeout: 45), "the retried message's turn never ran")
        sleep(3)
        step(app, "t02-answered", words)

        let sent = posts(marker)
        log("POSTS \(sent)")
        XCTAssertEqual(sent.count, 2, "one lost attempt and one tap: \(sent)")
        XCTAssertEqual(sent.first?.forwarded, false, "the first attempt was meant never to reach the server")
        XCTAssertEqual(sent.last?.status, 202, "the tap was not taken")
        assertOneId(sent)
        if let conversation = sent.last?.conversationId {
            XCTAssertEqual(serverRows("chat", conversation, words)?.user, 1, "the agent got it a number of times other than once")
            XCTAssertEqual(serverRows("chat", conversation, reply)?.assistant, 1, "the turn ran a number of times other than once")
        }
        XCTAssertEqual(copies(app, words), 1, "the page shows the message a number of times other than once")
        XCTAssertEqual(notices(app), [], "the Not sent stayed after the tap was answered")
        XCTAssertFalse(composerHolds(app, words), "the composer holds a message its bubble sent")
    }

    // MARK: - Reading the page

    /// How many times the conversation shows `words`: elements between the page's
    /// header and its composer whose label holds them, a cell and the text inside it
    /// counted once (the same row within 14 pt). The header is left out because a
    /// chat is titled with its first message, and the composer because it is not
    /// the conversation (`composerHolds` reads it).
    private func copies(_ app: XCUIApplication, _ words: String) -> Int {
        guard let root = try? app.snapshot() else { return -1 }
        var all: [(frame: CGRect, id: String, label: String, type: XCUIElement.ElementType)] = []
        func collect(_ s: XCUIElementSnapshot) {
            all.append((s.frame, s.identifier, s.label, s.elementType))
            for child in s.children { collect(child) }
        }
        collect(root)
        let headerBottom = all.filter { $0.id == "chat.menu" || $0.id == "tasks.menu" }.map(\.frame.maxY).max() ?? 0
        let composerTop = all.first { $0.id == "chat.composer" }?.frame.minY ?? app.frame.maxY
        var ys: [CGFloat] = []
        for e in all where e.frame.height > 0 && e.label.contains(words)
            && e.type != .application && e.type != .window
            && e.frame.minY >= headerBottom && e.frame.maxY <= composerTop + 2 {
            if !ys.contains(where: { abs($0 - e.frame.minY) < 14 }) { ys.append(e.frame.minY) }
        }
        return ys.count
    }

    /// The composer's field holds `words` (its value is the text typed or put back).
    private func composerHolds(_ app: XCUIApplication, _ words: String) -> Bool {
        let field = element(app, "chat.composer")
        guard field.exists else { return false }
        return (field.value as? String)?.contains(words) == true
    }

    /// The composer's line for words it was handed back.
    private func refusedNoticeShown(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "That message was not sent. It is back in the composer"))
            .firstMatch.exists
    }

    /// The labels of every failed or waiting copy on the page.
    private func notices(_ app: XCUIApplication) -> [String] {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "chat.retryFailed"))
            .allElementsBoundByIndex.map(\.label)
    }

    private func hittableNotice(_ app: XCUIApplication, timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let all = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == %@", "chat.retryFailed")).allElementsBoundByIndex
            if let ready = all.first(where: { $0.isHittable }) { return ready }
            // A notice under the keyboard is on the page but not tappable.
            if !all.isEmpty, app.keyboards.element.exists {
                element(app, "chat.composer").swipeDown()
            }
            usleep(500_000)
        }
        return app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "chat.retryFailed")).allElementsBoundByIndex.first
    }

    private func waitLabel(_ app: XCUIApplication, _ text: String, timeout: TimeInterval) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
            .waitForExistence(timeout: timeout)
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func step(_ app: XCUIApplication, _ name: String, _ words: String) {
        log("STEP \(name) +\(secs())s copies=\(copies(app, words)) notices=\(notices(app)) composerHolds=\(composerHolds(app, words)) refusedNotice=\(refusedNoticeShown(app))")
        let png = XCUIScreen.main.screenshot().pngRepresentation
        http("POST", "shot?name=\(runName)-\(name)", body: png)
    }

    // MARK: - Driving

    private func launch() -> XCUIApplication {
        UITestLaunch.launch([
            UITestLaunch.serverURLArgument, server,
            "-walnut.deviceToken", config.token,
        ])
    }

    private func awayAndBack(_ app: XCUIApplication, seconds: UInt32) {
        XCUIDevice.shared.press(.home)
        log("home at +\(secs())s")
        sleep(seconds)
        app.activate()
        log("back at +\(secs())s")
    }

    /// Through the board drawer, by the task's row. The row exists while the drawer is
    /// closed too (laid out off screen), so a tap waits for it to be hittable and opens
    /// the drawer again when a tap during the tab's own transition left it closed.
    private func openSession(_ app: XCUIApplication, _ entry: Seeded) -> Bool {
        let tab = app.tabBars.buttons["Tasks"]
        guard tab.waitForExistence(timeout: 60) else { log("no Tasks tab"); return false }
        tab.tap()
        sleep(2)
        let menu = app.buttons["tasks.menu"]
        let openBoard = app.buttons["tasks.empty.openBoard"]
        let openDrawer = { () -> Bool in
            if openBoard.exists && openBoard.isHittable { openBoard.tap(); return true }
            if menu.exists && menu.isHittable { menu.tap(); return true }
            return false
        }
        guard menu.waitForExistence(timeout: 20) || openBoard.waitForExistence(timeout: 10) else {
            log("no drawer button"); return false
        }
        _ = openDrawer()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.' AND identifier CONTAINS %@", entry.taskId))
            .firstMatch
        guard row.waitForExistence(timeout: 45) else { log("no board row for \(entry.taskId)"); return false }
        for attempt in 0..<4 where !row.isHittable {
            sleep(2)
            if row.isHittable { break }
            log("board row not hittable (attempt \(attempt)): opening the drawer again")
            if !openDrawer() {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
            }
        }
        guard row.isHittable else { log("board row never hittable"); return false }
        row.tap()
        return element(app, "chat.composer").waitForExistence(timeout: 45) && waitLabel(app, "Ready.", timeout: 45)
    }

    private func openNewChat(_ app: XCUIApplication) -> Bool {
        let tab = app.tabBars.buttons["Chat"]
        guard tab.waitForExistence(timeout: 60) else { log("no Chat tab"); return false }
        tab.tap()
        sleep(2)
        let menu = element(app, "chat.menu")
        guard menu.waitForExistence(timeout: 20) else { log("no chat menu"); return false }
        let newChat = element(app, "chat.drawer.newChat")
        // One tap opens the drawer; tapping the menu again would close it. The row is
        // tapped where it is drawn once it is on screen (the drawer's rows can read
        // as not hittable while they are plainly tappable).
        menu.tap()
        for attempt in 0..<3 {
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline, !(newChat.exists && newChat.frame.minX >= 0 && newChat.frame.width > 0) {
                usleep(250_000)
            }
            if newChat.exists && newChat.frame.minX >= 0 && newChat.frame.width > 0 { break }
            log("New chat not on screen (attempt \(attempt), exists \(newChat.exists), frame \(newChat.frame)): opening the drawer again")
            if menu.isHittable { menu.tap() }
        }
        guard newChat.exists, newChat.frame.minX >= 0 else { log("New chat never on screen"); return false }
        sleep(1)
        if newChat.isHittable { newChat.tap() } else {
            log("New chat on screen but not hittable (frame \(newChat.frame)): tapping where it is drawn")
            newChat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        sleep(2)
        return element(app, "chat.composer").waitForExistence(timeout: 30)
    }

    private func send(_ app: XCUIApplication, _ text: String) {
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        field.tap()
        if !app.keyboards.element.waitForExistence(timeout: 8) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            _ = app.keyboards.element.waitForExistence(timeout: 8)
        }
        field.typeText(text)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no send button")
        send.tap()
        log("sent \(text) at +\(secs())s")
    }

    // MARK: - The harness

    private func secs() -> Int { Int(Date().timeIntervalSince(t0)) }

    private func reset() { http("POST", "reset") }

    private func arm(_ marker: String, _ plan: [String]) {
        let body = try? JSONSerialization.data(withJSONObject: ["marker": marker, "plan": plan])
        http("POST", "arm", body: body)
    }

    private func posts(_ marker: String) -> [Post] {
        guard let data = http("GET", "state"),
              let state = try? JSONDecoder().decode(State.self, from: data) else { return [] }
        return state.posts.filter { $0.text.contains(marker) }
    }

    private func waitPosts(_ marker: String, count: Int, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if posts(marker).count >= count { return true }
            usleep(250_000)
        }
        return false
    }

    /// Every attempt of one message carries one message id, and it is the phone's.
    private func assertOneId(_ sent: [Post], line: UInt = #line) {
        XCTAssertFalse(sent.isEmpty, "no attempt was recorded", line: line)
        XCTAssertTrue(sent.allSatisfy { $0.messageId != nil }, "an attempt went out with no id: \(sent)", line: line)
        XCTAssertEqual(Set(sent.compactMap(\.messageId)).count, 1, "the attempts carry more than one id: \(sent)", line: line)
    }

    private func serverRows(_ kind: String, _ id: String, _ text: String) -> Rows? {
        var parts = URLComponents()
        parts.queryItems = [
            URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "id", value: id),
            URLQueryItem(name: "text", value: text),
        ]
        guard let data = http("GET", "rows" + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")) else { return nil }
        let rows = try? JSONDecoder().decode(Rows.self, from: data)
        log("ROWS \(kind) \(text): \(rows.map { "status \($0.status) user \($0.user) assistant \($0.assistant)" } ?? "unreadable")")
        return rows
    }

    private func log(_ line: String) {
        print("SENDONCE \(runName) \(line)")
        http("POST", "log", body: Data("\(runName) \(line)".utf8))
    }

    @discardableResult
    private func http(_ method: String, _ path: String, body: Data? = nil) -> Data? {
        guard let url = URL(string: server + "/__uitest/" + path) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        var out: Data?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            out = data
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 35)
        return out
    }
}
