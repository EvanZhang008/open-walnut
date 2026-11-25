import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// A box that takes the keyboard does it after SwiftUI's update, never inside it.
///
/// TestFlight 176 (2026-11-24): a transcript dictated into a thread's Follow up box on an org
/// node's Threads page focused the box, its `updateUIView` called `becomeFirstResponder()`
/// inside the update, and the main thread stayed in AttributeGraph until iOS killed the app
/// (watchdog 0x8BADF00D, "Failed to terminate gracefully after 5.0s"; the phone's crash upload
/// and the stall samples before it). `UIView.followFocus` (LetterReplyField.swift) moves the
/// change to the next main-queue turn; `tests/web/ios-representable-focus-guard.test.ts` keeps
/// every representable on it.
@MainActor
final class FirstResponderUpdatePassTests: XCTestCase {
    private typealias H = VerticalPageHarness

    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        super.tearDown()
    }

    private func textViewInWindow() -> UITextView {
        let w = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let vc = UIViewController()
        w.rootViewController = vc
        w.makeKeyAndVisible()
        let view = UITextView(frame: CGRect(x: 0, y: 100, width: 300, height: 44))
        vc.view.addSubview(view)
        window = w
        return view
    }

    /// Turn the main run loop until `done` holds (or 3 s pass): the deferred change runs on a
    /// later main-queue turn, and a test window's keyboard scene can take a few turns to settle.
    private func spin(until done: () -> Bool) {
        let end = Date().addingTimeInterval(3)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    private func turn() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }

    func testTheChangeWaitsForTheNextTurnAndThenHappens() {
        let view = textViewInWindow()
        view.followFocus { true }
        XCTAssertFalse(view.isFirstResponder, "never inside the caller's update")
        spin { view.isFirstResponder }
        XCTAssertTrue(view.isFirstResponder)

        view.followFocus { false }
        XCTAssertTrue(view.isFirstResponder)
        spin { !view.isFirstResponder }
        XCTAssertFalse(view.isFirstResponder)
    }

    func testAWishChangedBeforeTheTurnWins() {
        let view = textViewInWindow()
        var wanted = true
        view.followFocus { wanted }
        wanted = false
        turn()
        turn()
        XCTAssertFalse(view.isFirstResponder, "the wish is read again when the change runs")
    }

    func testAViewThatLeftTheWindowIsLeftAlone() {
        let view = textViewInWindow()
        view.followFocus { true }
        view.removeFromSuperview()
        turn()
        XCTAssertFalse(view.isFirstResponder)
    }

    // MARK: - The report's case

    /// `count` open threads, each with its Follow up box, as an org node's Threads page holds them.
    private func openThreads(_ count: Int) throws -> [OrgThread] {
        let at = WideText.isoAgo
        let all: [[String: Any]] = (0..<count).map { i in
            [
                "id": String(format: "th-5ee%05d", i), "title": "Thread \(i): \(WideText.threadTitle)",
                "state": i % 3 == 0 ? "needs" : "answered", "reply": WideText.markdown, "shown": true,
                "tasks": [WideText.taskId], "createdAt": at(Double(90 + i)), "updatedAt": at(Double(5 + i)),
                "messages": [[
                    "id": String(format: "tm-5ee%05d", i), "at": at(30), "via": "follow-up", "text": WideText.followUp,
                    "answer": ["text": WideText.plain, "at": at(29)],
                ]],
            ]
        }
        return try JSONDecoder().decode([OrgThread].self, from: JSONSerialization.data(withJSONObject: all))
    }

    /// What the process writes to stderr while `body` runs (AttributeGraph prints its cycle
    /// reports there). Through a file, never a pipe: a full pipe would block the writer.
    private static func capturingStderr(_ body: () -> Void) -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stderr-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let file = try? FileHandle(forWritingTo: url) else { body(); return "" }
        fflush(stderr)
        let saved = dup(STDERR_FILENO)
        dup2(file.fileDescriptor, STDERR_FILENO)
        body()
        fflush(stderr)
        dup2(saved, STDERR_FILENO)
        close(saved)
        try? file.close()
        defer { try? FileManager.default.removeItem(at: url) }
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    private func textViews(_ v: UIView) -> [UITextView] {
        ((v as? UITextView).map { [$0] } ?? []) + v.subviews.flatMap(textViews)
    }

    /// The report's steps on the real Threads page: a 76-character transcript lands in a card's
    /// Follow up box, and one turn later the box asks for the keyboard (what
    /// `VoiceDictationBody.insert` does). The keyboard must arrive and the main thread stay free:
    /// on build 176 this was where the app hung until the watchdog killed it.
    func testFocusingAFollowUpBoxAfterATranscriptOnAFullThreadsPageIsQuick() throws {
        let stores = H.Stores()
        let store = OrgThreadsStore(taskId: "task-fixture-vp", threads: try openThreads(40), cache: nil,
                                    read: { throw URLError(.notConnectedToInternet) })
        let page = OrgThreadsView(store: store, name: "Walnut VP", sessionId: "sess-fixture-vp", cover: .constant(nil))
        let hosted = H.host(H.provided(page, stores), width: 440)
        defer { hosted.close() }

        let boxes = textViews(hosted.window).filter { ($0.accessibilityIdentifier ?? "").hasSuffix(".input") }
        XCTAssertGreaterThanOrEqual(boxes.count, 5, "the page lays out its cards' Follow up boxes")
        let box = try XCTUnwrap(boxes.dropFirst(2).first)
        let field = try XCTUnwrap(box.delegate as? LetterReplyField.Coordinator)

        let transcript = "Walnut crash \u{4E86}\u{FF1F}\u{4F60}\u{53EF}\u{4EE5}\u{770B}\u{4E00}\u{4E0B}\u{6211} send \u{7684}\u{90A3}\u{4E2A} crash report\u{3002}"
            + String(repeating: "\u{5947}", count: 40)
        field.parent.text = transcript
        turn()
        let start = Date()
        var elapsed: TimeInterval = 0
        let errText = Self.capturingStderr {
            field.parent.isFocused = true
            while !box.isFirstResponder, Date().timeIntervalSince(start) < 20 {
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
            elapsed = Date().timeIntervalSince(start)
            turn()
        }
        let cycles = errText.components(separatedBy: "AttributeGraph: cycle detected").count - 1
        print("FirstResponderUpdatePass: keyboard after \(Int(elapsed * 1000)) ms with \(boxes.count) boxes, \(cycles) AttributeGraph cycles")
        XCTAssertTrue(box.isFirstResponder, "the box takes the keyboard")
        XCTAssertLessThan(elapsed, 1.0, "the keyboard came \(Int(elapsed * 1000)) ms after the focus")
        // The bug's own mark on the simulator: with the keyboard taken inside the update,
        // AttributeGraph reports a cycle on every pass (61 lines on iOS 26.2 before the fix,
        // none after). On the phone (iOS 27) the same walk hung the main thread for seconds.
        XCTAssertEqual(cycles, 0, "taking the keyboard made AttributeGraph report cycles")
        XCTAssertEqual(box.text, transcript)
        box.resignFirstResponder()
    }
}
