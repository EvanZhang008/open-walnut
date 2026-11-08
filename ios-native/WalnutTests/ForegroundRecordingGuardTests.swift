import XCTest

/// iOS records for an app that is not on screen only through an `AudioRecordingIntent`,
/// and only while that take's Live Activity shows, which must be up BEFORE the
/// microphone opens (Apple, AudioRecordingIntent: "you must start a Live Activity when
/// you begin the audio recording and keep it active as long as you record audio").
/// Build 160 opened the microphone first: on a real iPhone every Action Button press
/// failed with "Audio is in use by another app" (`'!int'`, a non-mixable session going
/// active in the background), and the simulator, which has no such rule, never showed
/// it. Build 161 opened Walnut for every press; since then the press records from
/// behind, with the Live Activity first, and opens Walnut only when that cannot work.
/// Nor does the work card belong on that press: a Live Activity started anywhere else
/// checks that Walnut is in front.
///
/// Read as TEXT, like `UITestLaunchRatchetTests`: the property is about every declaration
/// in the app's sources, so a new intent or a new Live Activity fails here the day it is
/// added, not on the next person's phone.
final class ForegroundRecordingGuardTests: XCTestCase {
    /// `Activity.request` sites that may start a Live Activity without checking that Walnut
    /// is in front, each with why.
    private static let requestsAllowedAnywhere: [String: String] = [
        // The take's own bar, started by TalkSession.start before the microphone (guarded below).
        "TalkActivity.swift": "the take's Live Activity, started before the microphone",
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

    /// How an intent that starts a take gets the microphone: by opening Walnut and waiting
    /// until it is in front, or from behind as an AudioRecordingIntent that may start the
    /// Live Activity (LiveActivityIntent) and opens Walnut when that fails. Nil: neither,
    /// with what is missing.
    static func recordingProblem(_ block: String) -> String? {
        let header = String(block.prefix(while: { $0 != "{" }))
        let opensFirst = block.range(of: #"openAppWhenRun(\s*:\s*Bool)?\s*=\s*true"#, options: .regularExpression) != nil
        if opensFirst {
            if block.range(of: #"supportedModes[^{]*\{\s*(return\s+)?\.foreground"#, options: .regularExpression) == nil {
                return "opens Walnut but declares no foreground mode for iOS 26"
            }
            return block.contains("waitUntilInFront") ? nil : "opens Walnut but does not wait until it is in front"
        }
        guard header.contains("AudioRecordingIntent") else {
            return "records without opening Walnut and is no AudioRecordingIntent, which iOS refuses on a real phone"
        }
        guard header.contains("LiveActivityIntent") else {
            return "an AudioRecordingIntent that is no LiveActivityIntent cannot start the Live Activity from behind, and iOS stops the recording"
        }
        guard block.range(of: #"supportedModes[^{]*\{[^}]*\.background[^}]*\.foreground\(\.dynamic\)"#, options: .regularExpression) != nil else {
            return "declares no [.background, .foreground(.dynamic)] modes for iOS 26"
        }
        guard block.contains("continueInForeground("), block.contains("requestToContinueInForeground("),
              block.contains("waitUntilInFront") else {
            return "has no way to open Walnut and record there when the take cannot start from behind"
        }
        // AppIntents ends the process when an AudioRecordingIntent returns with the microphone
        // on and no Live Activity showing (build 162's first run: "performed with an active
        // audio session but without a Live Activity").
        guard block.contains("showsLiveActivity") else {
            return "does not check a Live Activity can show before it touches the take: AppIntents ends the process when it returns with the microphone on and none showing"
        }
        return nil
    }

    /// Whether, in `TalkSession.start`, the Live Activity is asked for before the microphone,
    /// for every take: in front as well as behind. An AudioRecordingIntent that returns with
    /// the microphone on and no Live Activity is a fatal error in AppIntents, so a start
    /// skipped in front (build 162's first try) killed every press that opened Walnut.
    static func startsTheLiveActivityBeforeTheMicrophone(in session: String) -> Bool {
        guard let start = session.range(of: "func start(source: String)") else { return false }
        let rest = session[start.upperBound...]
        let body = rest.range(of: "\n    func ").map { rest[..<$0.lowerBound] } ?? rest
        guard let live = body.range(of: "activity.start("), let mic = body.range(of: "recorder.begin(") else { return false }
        let line = body[..<live.lowerBound].split(separator: "\n", omittingEmptySubsequences: false).last ?? ""
        if line.contains("foreground") || line.contains("inFront") { return false }
        return live.lowerBound < mic.lowerBound
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

    func testEveryIntentThatRecordsCanRecordOnARealPhone() throws {
        var intents = 0
        for (name, text) in try sources() {
            for block in Self.recordingIntents(in: text) {
                intents += 1
                let title = block.prefix(while: { $0 != "{" }).trimmingCharacters(in: .whitespacesAndNewlines)
                XCTAssertNil(Self.recordingProblem(block), "\(name), \(title)")
            }
        }
        XCTAssertGreaterThan(intents, 0, "no intent that starts a take found: the guard reads nothing")
    }

    /// iOS keeps a recording from behind only while its Live Activity shows, started first,
    /// and AppIntents ends a recording run that has none, in front too.
    func testATakeStartsItsLiveActivityBeforeTheMicrophone() throws {
        let session = try XCTUnwrap(try sources().first { $0.name == "TalkSession.swift" }, "TalkSession.swift not found").text
        XCTAssertTrue(
            Self.startsTheLiveActivityBeforeTheMicrophone(in: session),
            "TalkSession.start opens the microphone before the take's Live Activity: build 160's '!int'"
        )
        XCTAssertTrue(Self.matches(#"Activity(<[^>]*>)?\.request\("#, in: session).isEmpty, "TalkSession asks for a Live Activity itself, around TalkActivity")
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

    /// The guard itself: each declaration is judged on its own, and each way of getting it
    /// wrong is named.
    func testTheGuardJudgesEachDeclaration() {
        let text = """
        struct A: AppIntent {
            static let openAppWhenRun = true
            static var supportedModes: IntentModes { .foreground(.immediate) }
            func perform() async throws { await TalkSession.shared.waitUntilInFront(); try await TalkSession.shared.toggle(source: "x") }
        }
        struct B: AudioRecordingIntent {
            func perform() async throws {}
        }
        struct C: AppIntent {
            func perform() async throws { try await TalkSession.shared.toggle(source: "x") }
        }
        struct D: LiveActivityIntent {
            func perform() async throws { await TalkSession.shared.cancel(source: "x") }
        }
        struct E: AudioRecordingIntent, LiveActivityIntent, ForegroundContinuableIntent {
            static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
            func perform() async throws {
                if !TalkSession.shared.showsLiveActivity { return }
                try await TalkSession.shared.toggle(source: "x")
                try await continueInForeground(nil, alwaysConfirm: false)
                try await requestToContinueInForeground()
                _ = await TalkSession.shared.waitUntilInFront()
            }
        }
        struct F: AudioRecordingIntent, LiveActivityIntent {
            static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
            func perform() async throws { try await TalkSession.shared.toggle(source: "x") }
        }
        """
        let blocks = Self.recordingIntents(in: text)
        XCTAssertEqual(blocks.count, 5, "A, B, C, E and F start takes; D does not")
        XCTAssertNil(Self.recordingProblem(blocks[0]), "A opens Walnut and waits")
        XCTAssertNotNil(Self.recordingProblem(blocks[1])?.range(of: "LiveActivityIntent"), "B cannot start the Live Activity")
        XCTAssertNotNil(Self.recordingProblem(blocks[2])?.range(of: "no AudioRecordingIntent"), "C records from behind as a plain intent")
        XCTAssertNil(Self.recordingProblem(blocks[3]), "E records from behind and falls back")
        let blind = blocks[3].replacingOccurrences(of: "showsLiveActivity", with: "isReady")
        XCTAssertNotNil(Self.recordingProblem(blind)?.range(of: "Live Activity can show"), "an intent that never asks if a Live Activity can show")
        XCTAssertNotNil(Self.recordingProblem(blocks[4])?.range(of: "open Walnut"), "F has no fallback")

        let good = "func start(source: String) async throws {\n if !activity.start(s) {}\n _ = await recorder.begin()\n }\n    func other() {}"
        let bad = "func start(source: String) async throws {\n _ = await recorder.begin()\n _ = activity.start(s)\n }"
        let later = "func start(source: String) async throws {\n _ = await recorder.begin()\n }\n    func other() { activity.start(s) }"
        XCTAssertTrue(Self.startsTheLiveActivityBeforeTheMicrophone(in: good))
        XCTAssertFalse(Self.startsTheLiveActivityBeforeTheMicrophone(in: bad))
        XCTAssertFalse(Self.startsTheLiveActivityBeforeTheMicrophone(in: later), "a start in another function does not count")
        let behindOnly = "func start(source: String) async throws {\n if !foreground, !activity.start(s) {}\n _ = await recorder.begin()\n }"
        XCTAssertFalse(Self.startsTheLiveActivityBeforeTheMicrophone(in: behindOnly), "a take in front with no Live Activity")

        XCTAssertTrue(Self.checksInFrontBeforeEachRequest(in: "func s() { guard Self.isInFront() else { return }; try Activity.request(x) }"))
        XCTAssertFalse(Self.checksInFrontBeforeEachRequest(in: "func s() { try Activity<W>.request(x); _ = isInFront() }"))
        XCTAssertFalse(Self.checksInFrontBeforeEachRequest(in: "func a() { _ = isInFront() }\nfunc s() { try Activity.request(x) }"))
    }
}
