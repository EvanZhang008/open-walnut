import XCTest

/// Guard for "a tapped notification aborts the app" (2026-11-03, found driving a real
/// `simctl push` tap on a thread push): the async `UNUserNotificationCenterDelegate` callbacks
/// hide a completion the system calls when the body returns, and UIKit asserts that call is on
/// the main thread (`_performBlockAfterCATransactionCommitSynchronizes`). A nonisolated
/// callback returned on the generic executor and the process got SIGABRT. Every
/// `userNotificationCenter(` callback in the app must be `@MainActor`. This reads the app's own source, so a new callback added without it fails.
final class NotificationRoutingGuardTests: XCTestCase {

    private static var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testEveryNotificationCenterCallbackRunsOnTheMainActor() throws {
        let root = Self.iosRoot.appendingPathComponent("Walnut")
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no source tree at \(root.path)")
        }
        var found = 0
        for case let url as URL in walker where url.pathExtension == "swift" {
            let lines = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains("func userNotificationCenter(") {
                found += 1
                XCTAssertFalse(line.contains("nonisolated"), "\(url.lastPathComponent):\(i + 1) a nonisolated notification callback")
                // The attribute sits on the same line or the lines just above (comments may come between).
                var j = i - 1
                var isolated = line.contains("@MainActor")
                while !isolated, j >= 0 {
                    let above = lines[j].trimmingCharacters(in: .whitespaces)
                    if above.hasPrefix("@MainActor") { isolated = true; break }
                    if above.hasPrefix("//") || above.hasPrefix("///") || above.hasPrefix("@") { j -= 1; continue }
                    break
                }
                XCTAssertTrue(isolated, "\(url.lastPathComponent):\(i + 1) a notification callback without @MainActor")
            }
        }
        XCTAssertGreaterThanOrEqual(found, 2, "the walk found the notification router's callbacks")
    }

    /// A push open closes the chat tab's "First message" dialogs (and the keyboard) as it starts,
    /// before anything it waits for: an open that then fails (no chat yet, no network) shows its
    /// notice with no dialog left over it (2026-11-06 gate, predicted from the code: the dialogs
    /// were closed only after the node's read succeeded).
    func testAPushOpenClosesTheFirstMessageDialogsBeforeItWaits() throws {
        let url = Self.iosRoot.appendingPathComponent("Walnut/Views/Chat/ChatView.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func openLinkedOrgNode()"), "the push open is in ChatView")
        let rest = source[start.upperBound...]
        let end = rest.range(of: "\n    private func ")?.lowerBound
            ?? rest.range(of: "\n    /// ")?.lowerBound ?? rest.endIndex
        let body = rest[..<end]
        let dismiss = try XCTUnwrap(body.range(of: "dismissChatPrompts()"), "the push open closes the dialogs")
        for wait in ["Task {", "await "] {
            if let first = body.range(of: wait) {
                XCTAssertLessThan(dismiss.lowerBound, first.lowerBound, "the dialogs close before the first `\(wait)`")
            }
        }
        XCTAssertEqual(body.components(separatedBy: "dismissChatPrompts()").count, 2, "closed once, at the start")
    }
}
