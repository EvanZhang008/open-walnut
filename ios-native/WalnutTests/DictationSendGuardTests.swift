import XCTest

/// Every mic box in the app follows "Send waits for the words being spoken"
/// (`DictationSendGate`), or says why it has no Send to wait.
///
/// Reads the app's source: every Swift file that makes a `VoiceRecorder` or puts a
/// `VoiceDictationField` on screen must either use the gate (hold one, send through
/// it, and join its boxes to it) or be listed below with its reason. A new composer
/// with a mic that does neither fails here, so it cannot quietly send without the
/// words the person is still speaking.
final class DictationSendGuardTests: XCTestCase {

    /// Files with a mic and no Send to wait, each with why.
    static let exempt: [String: String] = [
        "Views/Notes/NoteEditorView.swift":
            "The note editor saves as the person types and has no Send; its source sheet's Done only closes it, and words still on their way land in the note and are saved.",
        "Stores/VoiceModeController.swift":
            "Voice mode has no Send button: each take is sent by the voice loop itself when it stops.",
        "Talk/TalkRecorder.swift":
            "Talk to Walnut has no text box: Send, a pause or a second press stops the recording first, then the words are made from the whole take and sent.",
        "Views/Inbox/InboxItemConfirmation.swift":
            "The work goal is reviewed before anything is sent, and Review and Confirm are held while the goal records or transcribes.",
    ]

    /// Mic boxes inside a gated file that are not under its gate, each with why.
    /// Documentation only: the file passes because it gates its Send.
    static let partial: [String: String] = [
        "Views/Inbox/LetterReaderView.swift":
            "The decision note's choices are held while the note records (VoiceDictationUITests pins it), so a choice never leaves without the spoken note; the reply's Send is gated.",
    ]

    /// The machinery itself.
    static let infrastructure: Set<String> = [
        "Core/VoiceRecorder.swift",
        "Views/Shared/VoiceDictation.swift",
        "Views/Shared/DictationSendGate.swift",
    ]

    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // WalnutTests
            .deletingLastPathComponent()  // ios-native
            .appendingPathComponent("Walnut", isDirectory: true)
            .resolvingSymlinksInPath()
    }

    /// What marks a mic box: a recorder made here, or one of the mic controls.
    static let micMarkers = ["VoiceRecorder(", "VoiceDictationField(", "VoiceMicButton(", "VoiceRecordingBar("]

    /// Source with `//` comment lines dropped, so a sentence about a recorder does
    /// not count as one.
    private static func code(_ url: URL) -> String {
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        return text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// Every app source file with a mic box, by path under `Walnut/`.
    static func micFiles() -> [String: String] {
        var found: [String: String] = [:]
        let root = appRoot
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return found }
        for case let url as URL in walker where url.pathExtension == "swift" {
            let source = code(url)
            guard Self.micMarkers.contains(where: source.contains) else { continue }
            let path = url.resolvingSymlinksInPath().path
            guard path.hasPrefix(root.path + "/") else { continue }
            let relative = String(path.dropFirst(root.path.count + 1))
            found[relative] = source
        }
        return found
    }

    func testTheScanSeesTheKnownMicBoxes() {
        let files = Self.micFiles()
        XCTAssertGreaterThanOrEqual(files.count, 8, "the source scan found too few mic boxes: \(files.keys.sorted())")
        for known in ["Views/Chat/ComposerView.swift", "Views/Inbox/LetterReaderView.swift", "Stores/VoiceModeController.swift"] {
            XCTAssertNotNil(files[known], "the scan no longer sees \(known)")
        }
    }

    func testEveryMicBoxWaitsForItsWordsOrSaysWhyNot() {
        var offenders: [String] = []
        for (file, source) in Self.micFiles() where !Self.infrastructure.contains(file) {
            if Self.exempt[file] != nil { continue }
            let holdsGate = source.contains("DictationSendGate()")
            let sendsThroughIt = source.range(of: #"[Gg]ate\.send\s*[{(]"#, options: .regularExpression) != nil
            let joinsBoxes = source.contains(".dictationSendGate(") || source.contains(".joinsSendGate(")
            if !(holdsGate && sendsThroughIt && joinsBoxes) {
                offenders.append("\(file) (gate: \(holdsGate), send through it: \(sendsThroughIt), boxes joined: \(joinsBoxes))")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            A mic box whose Send does not wait for the words being spoken. Hold a \
            DictationSendGate, send through gate.send, and join the boxes \
            (.dictationSendGate(gate) around VoiceDictationFields, .joinsSendGate for \
            a recorder row), or list the file in DictationSendGuardTests.exempt with why.
            """
        )
    }

    func testExemptionsAreCurrentAndExplained() {
        let files = Self.micFiles()
        for (file, reason) in Self.exempt.merging(Self.partial, uniquingKeysWith: { a, _ in a }) {
            XCTAssertNotNil(files[file], "\(file) has no mic any more: drop its exemption")
            XCTAssertGreaterThanOrEqual(reason.count, 40, "\(file): say why, in a sentence")
        }
        for file in Self.exempt.keys {
            XCTAssertFalse(
                files[file]?.contains("DictationSendGate()") ?? false,
                "\(file) uses the gate now: drop its exemption"
            )
        }
        for file in Self.partial.keys {
            XCTAssertTrue(files[file]?.contains("DictationSendGate()") ?? false, "\(file) is listed as partly gated but holds no gate")
        }
    }
}
