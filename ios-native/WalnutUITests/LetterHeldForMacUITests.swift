import UIKit
import XCTest

/// The proof video of a reply sent while the Mac is away (2026-11-20): against the real world of
/// tests/e2e/letter-held-for-mac-video.local.ts (a real companion, the Mac asleep), the reply shows
/// "Received · <time>. It goes to <task> when your Mac is back." at once, never "Sending" and
/// never an error; once the world brings the Mac back, the same line reads "Sent to <task> · <time>".
///
/// Runs only when the runner gets `WALNUT_UITEST_LETTER_VIDEO` (the world's marker URL, through
/// run-ui-tests.sh); every step it takes is posted there, so the video's tap dots and captions
/// line up with the host clock.
extension LetterReplyUITests {

    private struct VideoWorld: Decodable { let letterId: String; let recipient: String }

    @MainActor
    func testAReplyWhileTheMacSleepsReadsReceivedThenSentWhenTheMacIsBack() async throws {
        guard let marker = env("WALNUT_UITEST_LETTER_VIDEO"), let base = URL(string: marker) else {
            throw XCTSkip("no video world: run tests/e2e/letter-held-for-mac-video.local.ts and pass WALNUT_UITEST_LETTER_VIDEO")
        }
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("world"))
        let world = try JSONDecoder().decode(VideoWorld.self, from: data)
        func post(_ event: String, _ extra: [String: Any] = [:]) async {
            var comps = URLComponents(url: base.appendingPathComponent("mark"), resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "event", value: event)]
            var req = URLRequest(url: comps.url!)
            req.httpMethod = "POST"
            req.timeoutInterval = 40
            req.httpBody = try? JSONSerialization.data(withJSONObject: extra)
            _ = try? await URLSession.shared.data(for: req)
        }
        /// A tap the video shows as a dot: the point (in screen points) posted first.
        func tap(_ el: XCUIElement, _ name: String, at offset: CGVector = CGVector(dx: 0.5, dy: 0.5)) async {
            let f = el.frame
            await post("tap", ["name": name, "x": f.minX + f.width * offset.dx, "y": f.minY + f.height * offset.dy,
                               "scale": UIScreen.main.scale])
            el.coordinate(withNormalizedOffset: offset).tap()
        }

        await post("begin")
        // The slow re-read every 5 s instead of every minute, so "Sent" shows without a reopen.
        let app = try launchPaired(["-walnut.deliveryLateSeconds", "5"])
        let tab = app.tab(.inbox)
        XCTAssertTrue(tab.waitForExistence(timeout: 60), "the tab bar never appeared")
        try await Task.sleep(for: .seconds(1.5))
        await post("launched")
        await tap(tab, "inbox-tab")
        let all = element(app, "inbox.filter.all")
        if all.waitForExistence(timeout: 20), !all.isSelected { await tap(all, "filter-all") }
        let row = element(app, "inbox.row.\(world.letterId)")
        if !row.waitForExistence(timeout: 30) { app.swipeDown() }
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row for \(world.letterId)")
        try await Task.sleep(for: .seconds(1))
        await tap(row, "letter-row")
        let field = replyField(app)
        XCTAssertTrue(field.waitForExistence(timeout: 20), "the reply box never appeared")
        try await Task.sleep(for: .seconds(1.2))

        // enter() puts the caret with a tap at the field's bottom right.
        let f = field.frame
        await post("tap", ["name": "reply-field", "x": f.minX + f.width * 0.95, "y": f.minY + f.height * 0.85,
                           "scale": UIScreen.main.scale])
        let text = "Use the short wording, and keep the link to the changelog."
        enter(text, app)
        try await Task.sleep(for: .seconds(1))
        await tap(app.buttons["inbox.letter.send"], "send")
        await post("sent-tapped")

        // Received at once: never "Sending", never an error, in every sample until it shows.
        let received = statusLine(app, prefix: "Received")
        var lines: [[String]] = []
        let shown = waitUntil(timeout: 20) {
            lines.append(self.statusLabels(app))
            return received.exists
        }
        XCTAssertTrue(shown, "no Received line: \(lines.last ?? [])")
        let wrong = lines.flatMap { $0 }.filter { $0.hasPrefix("Sending") || $0.hasPrefix("Not sent") || $0.hasPrefix("Not confirmed") }
        XCTAssertEqual(wrong, [], "a wrong line showed on the way")
        XCTAssertTrue(received.label.hasSuffix("It goes to \(world.recipient) when your Mac is back."), received.label)
        add(XCTAttachment(screenshot: app.screenshot()))
        await post("received-shown", ["label": received.label, "lines": statusLabels(app)])
        try await Task.sleep(for: .seconds(2))

        // The world brings the Mac back now; the slow re-read turns the same line to Sent.
        let sent = statusLine(app, prefix: "Sent to \(world.recipient) · ")
        XCTAssertTrue(sent.waitForExistence(timeout: 300), "never Sent: \(statusLabels(app))")
        XCTAssertFalse(received.exists, "Received stayed next to Sent: \(statusLabels(app))")
        add(XCTAttachment(screenshot: app.screenshot()))
        await post("sent-shown", ["label": sent.label, "lines": statusLabels(app)])
        try await Task.sleep(for: .seconds(2.5))
        await post("done")
    }
}
