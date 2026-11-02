import XCTest

/// Guard for "a composer under a pushed page loops" (2026-11-02): with Main pushed
/// over the Chat tab, the chat's own composer underneath had its appear and disappear
/// re-run by SwiftUI about 100 times a second, each round's writes (the file-preview
/// dock, the model pill, the mode read: a GET /controls) starting the next. A page that
/// pushes over a composer must tell it so with `composerCovered`; this test reads the
/// app's views and fails on a new host that pushes over a composer without it.
final class ComposerCoveredGuardTests: XCTestCase {

    private static var viewsRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Views")
    }

    private func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    /// Code only: the doc comments name these types in prose.
    private func code(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testEveryPageThatPushesOverAComposerMarksItCovered() throws {
        guard let walker = FileManager.default.enumerator(at: Self.viewsRoot, includingPropertiesForKeys: nil) else {
            throw XCTSkip("no views at \(Self.viewsRoot.path)")
        }
        var hosts: [String] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let text = code(try String(contentsOf: url, encoding: .utf8))
            let pushes = count(".navigationDestination(", in: text)
            guard pushes > 0 else { continue }
            // A composer on this page: one it builds itself (the chat's, a box that
            // joins a send gate, a dictation field), or a session page it shows as
            // its own content (more session pages than pushes of one).
            let ownComposer = ["ComposerBar(", "ComposerView()", ".joinsSendGate(", "VoiceDictationField("]
                .contains { text.contains($0) }
            let sessionPage = count("SessionConversationView(", in: text) > pushes
            guard ownComposer || sessionPage else { continue }
            hosts.append(url.lastPathComponent)
            XCTAssertTrue(
                text.contains(".environment(\\.composerCovered,"),
                "\(url.lastPathComponent) pushes a page over a composer without .environment(\\.composerCovered, …): "
                    + "the composer underneath would run its appear work in a loop"
            )
        }
        // The two writers that kept the loop going read the flag.
        let composer = code(try String(contentsOf: Self.viewsRoot.appendingPathComponent("Chat/ComposerView.swift"), encoding: .utf8))
        XCTAssertTrue(composer.contains("if !covered, !onScreen { composerAppeared() }"), "a covered composer skips its appear work")
        XCTAssertTrue(composer.contains(".onChange(of: covered)"), "a composer uncovered by a pop comes back on screen")
        let gate = code(try String(contentsOf: Self.viewsRoot.appendingPathComponent("Shared/DictationSendGate.swift"), encoding: .utf8))
        XCTAssertTrue(gate.contains("@Environment(\\.composerCovered)"), "a covered composer leaves the send gate")
        // A disappear SwiftUI takes straight back does no work (AppearanceSettle).
        XCTAssertTrue(composer.contains("settle.disappeared(disappearWork())"),
                      "the composer's disappear work waits until the disappear stood")
        XCTAssertTrue(gate.contains("settle.disappeared { Self.leave(gate, voice, membership) }"),
                      "so does the send gate's leave, with what it needs taken at the disappear")
        XCTAssertTrue(composer.contains("settle.flush()"), "a phase change runs a disappear on its way first")
        XCTAssertFalse(gate.contains("@State private var token"),
                       "the gate membership lives in an unobserved box, not in view state")
        // Every tab tells its views when another tab is in front: TabView keeps
        // them alive, and a hidden tab's composer loops the same way.
        let app = code(try String(contentsOf: Self.viewsRoot.deletingLastPathComponent()
            .appendingPathComponent("App/WalnutApp.swift"), encoding: .utf8))
        let tabs = count(".tag(Tab.", in: app)
        XCTAssertGreaterThan(tabs, 3, "the tab bar's tabs were found")
        XCTAssertEqual(count(".environment(\\.composerCovered, selection != .", in: app), tabs,
                       "every tab of the tab bar marks its composers covered while another tab is in front")
        // A host that sets the flag on its own composer keeps the tab's value too.
        for host in ["Chat/ChatView.swift", "Tasks/TasksTabView.swift", "Inbox/LetterReaderView.swift"] {
            let text = code(try String(contentsOf: Self.viewsRoot.appendingPathComponent(host), encoding: .utf8))
            XCTAssertTrue(text.contains(".environment(\\.composerCovered, tabHidden ||"),
                          "\(host) combines its own cover with the tab's")
        }
        // A session page pushed over a tab's composer passes its host's cover on.
        let session = code(try String(contentsOf: Self.viewsRoot.appendingPathComponent(
            "Sessions/SessionConversationView.swift"), encoding: .utf8))
        XCTAssertTrue(session.contains(".environment(\\.composerCovered, coveredByHost ||"),
                      "SessionConversationView combines its own cover with its host's")
        // The hosts known today, so a broken walk cannot pass by finding none.
        for known in ["ChatView.swift", "TasksTabView.swift", "SessionConversationView.swift", "LetterReaderView.swift"] {
            XCTAssertTrue(hosts.contains(known), "\(known) is no longer seen as a host: check this guard")
        }
    }
}
