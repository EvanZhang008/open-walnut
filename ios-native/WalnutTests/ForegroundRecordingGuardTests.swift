import XCTest

/// iOS starts no recording for an app that is not on screen (a privacy rule; only calling
/// apps are exempt), and `AudioRecordingIntent` does not lift it. Build 160 ran Talk to
/// Walnut in the background: on a real iPhone every Action Button press failed with
/// "Audio is in use by another app" (`'!int'`), and the simulator, which has no such rule,
/// never showed it. Nor did the work card belong on that press, nor any Live Activity
/// (the user, 2026-11-07: "walnut don't need live, just make the action button thing"):
/// since build 162 the press opens Walnut on its Talk screen and nothing else.
///
/// Read as TEXT, like `UITestLaunchRatchetTests`: the property is about every declaration
/// in the app's sources, so a new intent or a new Live Activity fails here the day it is
/// added, not on the next person's phone.
final class ForegroundRecordingGuardTests: XCTestCase {
    /// `Activity.request` sites that may start a Live Activity without checking that Walnut
    /// is in front, each with why.
    private static let requestsAllowedAnywhere: [String: String] = [
        // Kept for later, started by nothing: a take shows no Live Activity (guarded below).
        "TalkActivity.swift": "no caller; TalkSession must not start it",
    ]

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let slashes = line.range(of: "//") else { return String(line) }
                return String(line[..<slashes.lowerBound])
            }
            .joined(separator: "\n")
    }

    private func sources() throws -> [(name: String, text: String)] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // WalnutTests/
            .deletingLastPathComponent()  // ios-native/
        var found: [(String, String)] = []
        for dir in ["Walnut", "WalnutWidgets"] {
            let base = root.appendingPathComponent(dir)
            guard let walk = FileManager.default.enumerator(atPath: base.path) else { continue }
            for case let path as String in walk where path.hasSuffix(".swift") {
                let text = try String(contentsOf: base.appendingPathComponent(path), encoding: .utf8)
                found.append(((path as NSString).lastPathComponent, code(text)))
            }
        }
        XCTAssertGreaterThan(found.count, 50, "the app's sources were not found")
        return found
    }

    static func matches(_ pattern: String, in text: String) -> [Range<String.Index>] {
        guard let regex = try? Regex(pattern) else {
            XCTFail("bad pattern \(pattern)")
            return []
        }
        return text.ranges(of: regex)
    }

    /// Each top-level declaration that is an App Intent which starts a take (it calls
    /// `TalkSession`'s toggle or start, or conforms to `AudioRecordingIntent`), with its body: from its line to the
    /// next top-level declaration, so two intents in one file are judged apart.
    static func recordingIntents(in text: String) -> [String] {
        let starts = Self.matches(#"(?m)^(?:@\w+\s+)*(?:public |private |fileprivate |internal |final )*(?:struct|class|enum|actor|extension)\b"#, in: text)
        var found: [String] = []
        for (n, start) in starts.enumerated() {
            let end = n + 1 < starts.count ? starts[n + 1].lowerBound : text.endIndex
            let block = String(text[start.lowerBound..<end])
            let header = block.prefix(while: { $0 != "{" })
            let isIntent = header.range(of: #"\b(App|AudioRecording|LiveActivity)Intent\b"#, options: .regularExpression) != nil
            // A take starts with `toggle(source:)` or `start(source:)`; Send now and Cancel only end one.
            let startsTake = block.contains("TalkSession") && !Self.matches(#"\.(toggle|start)\(source:"#, in: block).isEmpty
            if isIntent, header.contains("AudioRecordingIntent") || startsTake { found.append(block) }
        }
        return found
    }

    /// Whether `isInFront()` is checked in the function that starts the Live Activity, before it.
    static func checksInFrontBeforeEachRequest(in text: String) -> Bool {
        for request in Self.matches(#"Activity(<[^>]*>)?\.request\("#, in: text) {
            let before = text[..<request.lowerBound]
            let function = before.range(of: "func ", options: .backwards).map { before[$0.lowerBound...] } ?? before
            if !function.contains("isInFront()") { return false }
        }
        return true
    }

    func testEveryIntentThatRecordsOpensWalnutBeforeItRecords() throws {
        var intents = 0
        for (name, text) in try sources() {
            for block in Self.recordingIntents(in: text) {
                intents += 1
                let title = block.prefix(while: { $0 != "{" }).trimmingCharacters(in: .whitespacesAndNewlines)
                XCTAssertNotNil(
                    block.range(of: #"openAppWhenRun(\s*:\s*Bool)?\s*=\s*true"#, options: .regularExpression),
                    "\(name), \(title): an intent that records without opening Walnut records in the background, which iOS refuses on a real phone"
                )
                XCTAssertNotNil(
                    block.range(of: #"supportedModes[^{]*\{\s*(return\s+)?\.foreground"#, options: .regularExpression),
                    "\(name), \(title): an intent that records must declare a foreground mode for iOS 26"
                )
                XCTAssertTrue(block.contains("waitUntilInFront"), "\(name), \(title): the take must wait until Walnut is in front before it opens the microphone")
            }
        }
        XCTAssertGreaterThan(intents, 0, "no intent that starts a take found: the guard reads nothing")
    }

    /// The press does one thing: no Live Activity for a take, and no intent that may run in
    /// the background to record (`AudioRecordingIntent` invites exactly that).
    func testATakeStartsNoLiveActivity() throws {
        let all = try sources()
        for (name, text) in all {
            XCTAssertTrue(
                Self.matches(#":[^{]*\bAudioRecordingIntent\b"#, in: text).isEmpty,
                "\(name): an AudioRecordingIntent; Talk opens Walnut and records in front, with no Live Activity"
            )
        }
        let session = try XCTUnwrap(all.first { $0.name == "TalkSession.swift" }, "TalkSession.swift not found").text
        XCTAssertTrue(Self.matches(#"\bactivity\.start\("#, in: session).isEmpty, "TalkSession starts the Talk Live Activity again")
        XCTAssertTrue(Self.matches(#"Activity(<[^>]*>)?\.request\("#, in: session).isEmpty, "TalkSession asks for a Live Activity")
    }

    func testEveryLiveActivityStartedOutsideATakeChecksWalnutIsInFront() throws {
        let requests = try sources().filter { !Self.matches(#"Activity(<[^>]*>)?\.request\("#, in: $0.text).isEmpty }
        XCTAssertFalse(requests.isEmpty, "no Live Activity start found: the guard reads nothing")
        for (name, text) in requests where Self.requestsAllowedAnywhere[name] == nil {
            XCTAssertTrue(
                Self.checksInFrontBeforeEachRequest(in: text),
                "\(name) starts a Live Activity with no check that Walnut is in front: a run that did not open Walnut would show it"
            )
        }
    }

    /// The guard itself: a second intent with no foreground mode fails even beside a good one,
    /// and a check after the request does not count.
    func testTheGuardJudgesEachDeclaration() {
        let good = """
        struct A: AudioRecordingIntent {
            static let openAppWhenRun = true
            static var supportedModes: IntentModes { .foreground(.immediate) }
            func perform() async throws { await TalkSession.shared.waitUntilInFront() }
        }
        struct B: AudioRecordingIntent, LiveActivityIntent {
            func perform() async throws {}
        }
        struct C: AppIntent {
            func perform() async throws { try await TalkSession.shared.toggle(source: "x") }
        }
        struct D: LiveActivityIntent {
            func perform() async throws { await TalkSession.shared.cancel(source: "x") }
        }
        """
        let blocks = Self.recordingIntents(in: good)
        XCTAssertEqual(blocks.count, 3, "A, B and C start takes; D does not")
        XCTAssertFalse(blocks[2].contains("openAppWhenRun"))
        XCTAssertTrue(blocks[0].contains("openAppWhenRun"))
        XCTAssertFalse(blocks[1].contains("openAppWhenRun"))
        XCTAssertTrue(Self.checksInFrontBeforeEachRequest(in: "func s() { guard Self.isInFront() else { return }; try Activity.request(x) }"))
        XCTAssertFalse(Self.checksInFrontBeforeEachRequest(in: "func s() { try Activity<W>.request(x); _ = isInFront() }"))
        XCTAssertFalse(Self.checksInFrontBeforeEachRequest(in: "func a() { _ = isInFront() }\nfunc s() { try Activity.request(x) }"))
    }
}
