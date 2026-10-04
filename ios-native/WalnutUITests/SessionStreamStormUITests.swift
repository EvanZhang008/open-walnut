import XCTest
import UIKit

/// THE SESSION PAGE ON A FLAPPING BRIDGE, driven as a finger drives it.
///
/// Field evidence (2026-09-26): with a heavy session open, the cloud replica took
/// 140-147 `GET /sessions/<sid>/transcript?fresh=1&rich=1` within 1-3 s, six times
/// in eleven minutes, because every page open and every return to the foreground
/// connected without Last-Event-ID and every replayed `turn-end` / `bridge-online`
/// started its own read. And every ~1.3 s bridge redial flashed "Mac unreachable"
/// and locked the composer.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs` in its session-replica mode
/// (`POST /__stub/session-replica?on=1`): the work session's stream answers like
/// the replica's (id-less attach frame, a never-reset 512-frame ring, process-style
/// ids, Last-Event-ID honoured unless told otherwise), and its messages POST banks
/// a send while the bridge is down. Every assertion is a WIRE fact (what the stub
/// was asked, with which Last-Event-ID) or a SCREEN fact (chip, banner, composer).
///
/// RUN IT with the stub running and WALNUT_UITEST_SERVER pointed at it (see
/// `MidTurnQueueUITests` for why a bare `xcodebuild` skips every case here).
final class SessionStreamStormUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private static let chipID = "session.reconnectingChip"
    private static let bannerID = "session.offlineBanner"

    // MARK: - Problem 1: the transcript storm

    /// A first open against a full ring, a reconnect to an OLD server that replays
    /// all 512 frames, a return from the background with 512 missed frames, and a
    /// re-open: each costs at most one transcript read beyond the page's own, and
    /// every stream after the first resumes with Last-Event-ID.
    @MainActor
    func testReplaysCostAtMostOneTranscriptReadAndResumeFromTheLastID() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/work-session?on=1")
        try await stub.call("POST", "__stub/session-replica?on=1&rows=300")
        // The ring a flapping bridge left behind, BEFORE the page ever opened.
        try await stub.call("POST", "__stub/session-emit?n=512")
        let app = try launchPaired()

        // 1. First open: no id to resume from, so the whole ring replays.
        let openedAt = Date()
        try openSessionPage(app)
        let firstOpen = watchForNotice(app, seconds: 8)
        XCTAssertNil(firstOpen, "the first open's replay raised \(firstOpen ?? "")")
        var reads = try await stub.freshTranscriptReads(after: openedAt)
        print("[evidence] first open with a 512-frame ring: \(reads.count) fresh transcript read(s)")
        XCTAssertLessThanOrEqual(reads.count, 2, "open's own fresh read plus at most one for the replay")
        var state = try await stub.sessionState()
        XCTAssertNil(state.attaches.first?.lastEventId, "a first-ever open has nothing to resume from")
        try await stub.screenshot(app, "storm-01-first-open")

        // 2. Stream drop, reconnect to a server that IGNORES Last-Event-ID.
        try await stub.call("POST", "__stub/session-honor?on=0")
        let applied = state.lastId
        let attachesBefore = state.attaches.count
        let dropAt = Date()
        try await stub.dropStreams()
        state = try await stub.waitForAttach(beyond: attachesBefore, timeout: 30)
        let reconnect = watchForNotice(app, seconds: 6)
        XCTAssertNil(reconnect, "the reconnect's 512-frame replay raised \(reconnect ?? "")")
        reads = try await stub.freshTranscriptReads(after: dropAt)
        print("[evidence] reconnect + replay of \(state.ring) frames: \(reads.count) fresh transcript read(s), "
              + "Last-Event-ID \(state.attaches.last?.lastEventId ?? "-")")
        XCTAssertLessThanOrEqual(reads.count, 1, "a 512-frame replay cost \(reads.count) transcript reads")
        XCTAssertEqual(state.attaches.last?.lastEventId, String(applied),
                       "the reconnect must resume from the newest applied frame")

        // 3. Background; 512 NEW frames pile up; foreground (a current server).
        try await stub.call("POST", "__stub/session-honor?on=1")
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(3))
        let beforeBackground = try await stub.sessionState()
        try await stub.call("POST", "__stub/session-emit?n=512")
        let backAt = Date()
        app.activate()
        state = try await stub.waitForAttach(beyond: beforeBackground.attaches.count, timeout: 30)
        let foreground = watchForNotice(app, seconds: 8)
        XCTAssertNil(foreground, "the return from the background raised \(foreground ?? "")")
        reads = try await stub.freshTranscriptReads(after: backAt)
        print("[evidence] foreground with 512 missed frames: \(reads.count) fresh transcript read(s), "
              + "Last-Event-ID \(state.attaches.last?.lastEventId ?? "-")")
        XCTAssertLessThanOrEqual(reads.count, 2, "resume's own read plus at most one for the missed frames")
        XCTAssertEqual(state.attaches.last?.lastEventId, String(beforeBackground.lastId),
                       "the foreground stream must resume, not ask for the whole ring")

        // 4. Pop and re-open the page: the new page resumes from the stored id.
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 10), "no back button on the session page")
        back.tap()
        try await Task.sleep(for: .seconds(2))
        let beforeReopen = try await stub.sessionState()
        let reopenAt = Date()
        try openSessionPage(app)
        state = try await stub.waitForAttach(beyond: beforeReopen.attaches.count, timeout: 30)
        try await Task.sleep(for: .seconds(5))
        reads = try await stub.freshTranscriptReads(after: reopenAt)
        print("[evidence] re-open: \(reads.count) fresh transcript read(s), "
              + "Last-Event-ID \(state.attaches.last?.lastEventId ?? "-")")
        XCTAssertEqual(state.attaches.last?.lastEventId, String(beforeReopen.lastId),
                       "a re-opened page must resume from the id the last one applied")
        XCTAssertLessThanOrEqual(reads.count, 2)
        try await stub.screenshot(app, "storm-02-after-reopen")
    }

    // MARK: - Problem 2: the flicker

    /// A 1.3 s blip shows nothing and never locks the composer. A 12 s outage
    /// shows the chip from 3 s and the banner from 10 s; a send made while
    /// reconnecting is banked and lands exactly once after the bridge returns.
    /// Then a page opened DURING a blip shows nothing either.
    @MainActor
    func testABlipShowsNothingAndAnOutageShowsTheChipThenTheBanner() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/work-session?on=1")
        try await stub.call("POST", "__stub/session-replica?on=1&rows=300")
        let app = try launchPaired()
        try openSessionPage(app)
        try await Task.sleep(for: .seconds(4))

        // 1. The 1.3 s blip.
        try await stub.call("POST", "__stub/session-blip?ms=1300")
        let blip = watchForNotice(app, seconds: 8, composerMustStayEnabled: true)
        XCTAssertNil(blip, "a 1.3 s blip showed \(blip ?? "")")

        // 2. A 12 s outage.
        let downAt = Date()
        try await stub.call("POST", "__stub/session-bridge?up=0")
        let chip = element(app, Self.chipID)
        let banner = element(app, Self.bannerID)
        try await Task.sleep(for: .seconds(1.5))
        XCTAssertFalse(chip.exists || banner.exists, "a notice after 1.5 s of absence")
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no Reconnecting chip within the outage")
        let chipAfter = Date().timeIntervalSince(downAt)
        print("[evidence] chip visible after \(String(format: "%.1f", chipAfter)) s of absence")
        XCTAssertGreaterThanOrEqual(chipAfter, 2.5, "the chip came before the 3 s grace")
        XCTAssertFalse(banner.exists, "the banner came with the chip")
        try await stub.screenshot(app, "flicker-01-reconnecting-chip", cropTop: true)

        // Send while reconnecting: the composer is enabled and the send is banked.
        let text = "Deploy the fix after the canary passes"
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.isEnabled, "the composer locked during the outage")
        type(text, into: field, of: app)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10) && send.isEnabled, "send is not available while reconnecting")
        send.tap()

        let bannerDeadline = downAt.addingTimeInterval(20)
        while !banner.exists && Date() < bannerDeadline { usleep(200_000) }
        XCTAssertTrue(banner.exists, "no banner after continuous absence")
        let bannerAfter = Date().timeIntervalSince(downAt)
        print("[evidence] banner visible after \(String(format: "%.1f", bannerAfter)) s of absence")
        XCTAssertGreaterThanOrEqual(bannerAfter, 9.5, "the banner came before the 10 s grace")
        XCTAssertFalse(chip.exists, "the chip stayed under the banner")
        XCTAssertTrue(field.isEnabled, "the composer locked under the banner")
        try await stub.screenshot(app, "flicker-02-unreachable-banner", cropTop: true)
        var state = try await stub.sessionState()
        XCTAssertEqual(state.posts.count, 1, "one POST for one send")
        XCTAssertEqual(state.banked.count, 1, "the send is banked while the bridge is down")

        // The bridge returns at 12 s: both notices go, the banked send lands once.
        let wait = 12 - Date().timeIntervalSince(downAt)
        if wait > 0 { try await Task.sleep(for: .seconds(wait)) }
        try await stub.call("POST", "__stub/session-bridge?up=1")
        XCTAssertTrue(waitUntil(timeout: 8) { !banner.exists && !chip.exists }, "the notices outlived the outage")
        try await Task.sleep(for: .seconds(4))
        state = try await stub.sessionState()
        XCTAssertEqual(state.posts.count, 1, "the send was re-posted")
        XCTAssertEqual(state.delivered.filter { $0.hasPrefix("qm-") }.count, 1, "delivered exactly once")
        XCTAssertEqual(state.transcriptTexts.filter { $0 == text }.count, 1, "the transcript holds it once")
        let onScreen = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).count
        print("[evidence] after the outage: \(onScreen) on-screen element(s) carry the sent text")
        XCTAssertLessThanOrEqual(onScreen, 1, "the sent message is on screen twice")
        try await stub.screenshot(app, "flicker-03-after-outage")

        // 3. Open the page DURING a blip. The stub brings the bridge back 1.3 s
        // after the page's stream attaches (not after this call), so the page
        // sees exactly the field redial however slowly XCUI reaches the row; the
        // watch starts at the tap, before the attach, so nothing can slip by.
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        try await Task.sleep(for: .seconds(2))
        let beforeBlipOpen = try await stub.sessionState()
        try await stub.call("POST", "__stub/session-blip?ms=1300&from=attach")
        try openSessionPage(app, waitForComposer: false)
        let duringBlip = watchForNotice(app, seconds: 10, composerMustStayEnabled: true)
        XCTAssertNil(duringBlip, "a page opened during a blip showed \(duringBlip ?? "")")
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 30), "no composer on the session page")
        state = try await stub.sessionState()
        let blipAttach = state.attaches.dropFirst(beforeBlipOpen.attaches.count).first
        print("[evidence] page opened during a blip: attach saw bridgeUp=\(blipAttach.map { String($0.bridgeUp) } ?? "-"), "
              + "bridge now up=\(state.bridgeUp)")
        XCTAssertEqual(blipAttach?.bridgeUp, false, "the page did not open during the blip")
        XCTAssertTrue(state.bridgeUp, "the blip never ended")
    }

    /// Screenshots of the chip and the banner, for the light/large pass and the
    /// dark/largest-text pass (the runner changes the simulator between passes).
    @MainActor
    func testTheChipAndTheBannerScreenshots() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/work-session?on=1")
        try await stub.call("POST", "__stub/session-replica?on=1&rows=300")
        let app = try launchPaired()
        try openSessionPage(app)
        try await Task.sleep(for: .seconds(4))
        try await stub.call("POST", "__stub/session-bridge?up=0")
        let chip = element(app, Self.chipID)
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no Reconnecting chip")
        try await stub.screenshot(app, "notice-chip", cropTop: true)
        let banner = element(app, Self.bannerID)
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "no banner")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.contains(banner.frame), "the banner at \(banner.frame) leaves the window \(window)")
        try await stub.screenshot(app, "notice-banner", cropTop: true)
        try await stub.call("POST", "__stub/session-bridge?up=1")
        XCTAssertTrue(waitUntil(timeout: 8) { !banner.exists && !chip.exists })
    }

    // MARK: - Driving the app

    /// Tasks tab → the work task's row → its session page, waiting for the composer.
    @MainActor
    private func openSessionPage(_ app: XCUIApplication, waitForComposer: Bool = true) throws {
        let tasksTab = app.buttons["Tasks"]
        XCTAssertTrue(tasksTab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasksTab.tap()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 45), "the board never showed the work task")
        // At the largest text size the row is taller than the space left above
        // the tab bar, so a tap at its middle lands on the tab bar. Scroll it up
        // a little when too little of it shows, then tap its visible part.
        let bottomLimit = { () -> CGFloat in
            let bar = app.tabBars.firstMatch
            if bar.exists, bar.frame.height > 0 { return bar.frame.minY }
            return tasksTab.frame.minY
        }
        if min(row.frame.maxY, bottomLimit()) - row.frame.minY < 60 {
            let window = app.windows.firstMatch
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
                .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)))
            usleep(600_000)
        }
        let frame = row.frame
        let visibleBottom = min(frame.maxY, bottomLimit())
        let tapY = (max(frame.minY, 0) + visibleBottom) / 2
        let dy = frame.height > 0 ? (tapY - frame.minY) / frame.height : 0.5
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: dy)).tap()
        guard waitForComposer else { return }
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 30), "no composer on the session page")
    }

    /// Poll the screen as fast as XCUI allows for `seconds`; returns what showed
    /// up (chip / banner / locked composer), or nil when nothing ever did.
    @MainActor
    private func watchForNotice(_ app: XCUIApplication, seconds: TimeInterval,
                                composerMustStayEnabled: Bool = false) -> String? {
        let chip = element(app, Self.chipID)
        let banner = element(app, Self.bannerID)
        let field = element(app, "chat.composer")
        let deadline = Date().addingTimeInterval(seconds)
        var samples = 0
        defer { print("[evidence] watched \(Int(seconds)) s, \(samples) samples") }
        while Date() < deadline {
            samples += 1
            if chip.exists { return "the Reconnecting chip" }
            if banner.exists { return "the unreachable banner" }
            if composerMustStayEnabled, field.exists, !field.isEnabled { return "a locked composer" }
        }
        return nil
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

    /// Paired at the stub. The resume ids a previous run stored are masked (an
    /// argument-domain value that is not Data reads as "none"), so the FIRST open
    /// of every run really has nothing to resume from.
    private func launchPaired() throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch([
            "-walnut.serverUrl", server, "-walnut.deviceToken", token,
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

/// The stub's control plane, as this file uses it.
struct StormStub: Sendable {
    let base: URL

    struct Record: Decodable {
        let at: Date
        let method: String
        let path: String
        let query: String?
        let lastEventId: String?
    }

    struct Attach: Decodable {
        let lastEventId: String?
        /// The bridge as the stub reported it in this stream's attach frame.
        let bridgeUp: Bool
    }

    struct Post: Decodable {
        let messageId: String
        let text: String
    }

    struct Banked: Decodable {
        let messageId: String
    }

    struct SessionState: Decodable {
        let bridgeUp: Bool
        let ring: Int
        let lastId: Int
        let attaches: [Attach]
        let posts: [Post]
        let banked: [Banked]
        let delivered: [String]
        let transcriptTexts: [String]
    }

    @discardableResult
    func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
        guard let url = URL(string: root + path) else {
            throw NSError(domain: "stub", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL \(path)"])
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
            throw NSError(domain: "stub", code: code, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)"])
        }
        return data
    }

    func reset() async throws { try await call("POST", "__stub/reset") }
    func dropStreams() async throws { try await call("POST", "__stub/drop-streams") }

    func sessionState() async throws -> SessionState {
        try JSONDecoder().decode(SessionState.self, from: try await call("GET", "__stub/session-state"))
    }

    /// Wait until the page's stream has attached more than `count` times.
    func waitForAttach(beyond count: Int, timeout: TimeInterval) async throws -> SessionState {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let state = try await sessionState()
            if state.attaches.count > count {
                // Let the replay land and its reads (if any) reach the stub.
                try await Task.sleep(for: .seconds(1))
                return try await sessionState()
            }
            try await Task.sleep(for: .milliseconds(300))
        }
        XCTFail("the session stream never re-attached within \(Int(timeout)) s")
        return try await sessionState()
    }

    /// `GET /sessions/<lane>/transcript?fresh=1…` the app made after `date`.
    func freshTranscriptReads(after date: Date) async throws -> [Record] {
        try await requests().filter {
            $0.at > date && $0.method == "GET" && $0.path.hasSuffix("/transcript")
                && ($0.query ?? "").contains("fresh=1")
        }
    }

    func requests() async throws -> [Record] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = parser.date(from: raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
            }
            return date
        }
        return try decoder.decode([Record].self, from: try await call("GET", "__stub/requests"))
    }

    /// Full screenshot, plus (cropTop) the top of the screen where the chip and
    /// the banner live, at most 1280 px wide.
    @MainActor
    func screenshot(_ app: XCUIApplication, _ name: String, cropTop: Bool = false) async throws {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
        try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        guard cropTop, let cg = shot.image.cgImage else { return }
        let width = min(cg.width, 1280)
        let height = min(cg.height, Int(Double(cg.height) * 0.42))
        guard let cropped = cg.cropping(to: CGRect(x: 0, y: 0, width: width, height: height)),
              let png = UIImage(cgImage: cropped).pngData() else { return }
        try await call("POST", "__stub/screenshot?name=\(name)-crop", body: png)
    }
}
