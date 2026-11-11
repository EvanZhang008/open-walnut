import XCTest
import UIKit
@testable import Walnut

/// A fold's red count holds its failed calls, never more than it ran, and apart from them the
/// runtime's error lines (2026-11-09: a turn of 344 calls read "7859 failed", 7,835 of them
/// error notices of a steering retry loop). The web's twin: `tests/web/fold-failures.test.ts`.
final class FoldFailuresTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    override func tearDown() {
        TimelineTextStyler.adopt(.unspecified)
        super.tearDown()
    }

    // MARK: - Fixtures

    private var clock = 0
    private func at() -> String {
        clock += 1
        return "2026-11-09T00:00:00.\(String(format: "%06d", clock))Z"
    }
    private func person(_ text: String = "Fix the build.") -> ChatMessage {
        var m = ChatMessage(id: "u\(clock)", role: "user", text: text, createdAt: at(), kind: nil)
        m.sentBy = "person"
        return m
    }
    private func said(_ text: String) -> ChatMessage {
        ChatMessage(id: "a\(clock)", role: "assistant", text: text, createdAt: at(), kind: nil)
    }
    private func call(_ isError: Bool? = nil, result: String = "ok", name: String = "Bash") -> ChatMessage {
        ChatMessage(id: "t\(clock)", role: "assistant", text: name, createdAt: at(), kind: .tool,
                    detail: "make", resultPreview: result, inputPreview: "command: make", isError: isError)
    }
    private func errorLine(_ text: String = "Steering failed, retrying") -> ChatMessage {
        ChatMessage(id: "n\(clock)", role: "user", text: text, createdAt: at(), kind: .notification,
                    source: "session-error")
    }
    private func infoLine() -> ChatMessage {
        ChatMessage(id: "n\(clock)", role: "user", text: "Context compacted", createdAt: at(),
                    kind: .notification, source: "compaction")
    }
    private func thought() -> ChatMessage {
        ChatMessage(id: "k\(clock)", role: "assistant", text: "", createdAt: at(), kind: .thinking,
                    thinkingText: "Looking at it.")
    }
    private let interrupted = "[Request interrupted by user for tool use]"
    private let routed = "In this team your questions go to your leader, who answers for the user."

    private func plan(_ rows: [ChatMessage]) -> [TimelineTurnFold.Part] {
        TimelineTurnFold.plan(rows, turns: TimelineTurnShape.shape(rows, streaming: false), additions: .init())
    }
    private func folds(_ parts: [TimelineTurnFold.Part]) -> [TimelineTurnFold.Fold] {
        parts.compactMap { if case .fold(let f) = $0 { return f } else { return nil } }
    }

    // MARK: - Words

    func testWordsMatchTheWeb() {
        XCTAssertEqual(TimelineFoldFailures.none.words, "")
        XCTAssertEqual(TimelineFoldFailures(integerLiteral: 3).words, "3 failed")
        XCTAssertEqual(TimelineFoldFailures(calls: 0, errors: 1).words, "1 error")
        XCTAssertEqual(TimelineFoldFailures(calls: 0, errors: 2).words, "2 errors")
        XCTAssertEqual(TimelineFoldFailures(calls: 1, errors: 2).words, "1 failed \u{00B7} 2 errors")
        XCTAssertEqual(TimelineFoldFailures(calls: 1, errors: 20).words, "1 failed \u{00B7} 20 errors")
        XCTAssertTrue(TimelineFoldFailures.none.isEmpty)
        XCTAssertFalse(TimelineFoldFailures(calls: 0, errors: 1).isEmpty)
        XCTAssertEqual(TimelineChipAccessibility.failedBadge(TimelineFoldFailures(calls: 2, errors: 3)),
                       "2 failed \u{00B7} 3 errors")
        XCTAssertEqual(TimelineChipAccessibility.toolRun(phrase: "Ran 2 tools", failures: TimelineFoldFailures(calls: 0, errors: 1),
                                                         expanded: false),
                       "Ran 2 tools, 1 error, collapsed")
    }

    // MARK: - Counting

    func testErrorLinesAreCountedApartFromFailedCalls() {
        let rows = [call(), call(true), call(), errorLine(), errorLine(), infoLine(), call(true), thought()]
        XCTAssertEqual(TimelineFoldFailures.count(rows), TimelineFoldFailures(calls: 2, errors: 2))
        // A call the person stopped, and a question routed to the lead, did not fail.
        XCTAssertEqual(TimelineFoldFailures.count([call(true, result: interrupted)]), .none)
        XCTAssertEqual(TimelineFoldFailures.count([call(true, result: routed, name: "AskUserQuestion")]), .none)
        // A notice that is not an error is no failure at all.
        XCTAssertEqual(TimelineFoldFailures.count([infoLine()]), .none)
    }

    /// Property: whatever mix of rows a fold holds, its failed calls never exceed the calls it ran,
    /// each failed call is counted once, and each error line is counted as an error, never a call.
    func testFailedNeverExceedsRanOverGeneratedMixes() {
        var seed: UInt64 = 0x5EED_F01D
        func next(_ n: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(n))
        }
        for round in 0..<400 {
            var rows: [ChatMessage] = []
            var ran = 0, failedCalls = 0, errorLines = 0
            for _ in 0..<(1 + next(60)) {
                switch next(8) {
                case 0: rows.append(call()); ran += 1
                case 1: rows.append(call(true)); ran += 1; failedCalls += 1
                case 2: rows.append(call(true, result: interrupted)); ran += 1
                case 3: rows.append(call(true, result: routed, name: "AskUserQuestion")); ran += 1
                // Error lines come in bursts, as a retry loop writes them.
                case 4: let burst = 1 + next(40); errorLines += burst
                    rows += (0..<burst).map { _ in errorLine() }
                case 5: rows.append(infoLine())
                case 6: rows.append(thought())
                default: rows.append(call(false)); ran += 1
                }
            }
            let f = TimelineFoldFailures.count(rows)
            XCTAssertLessThanOrEqual(f.calls, ran, "round \(round)")
            XCTAssertEqual(f.calls, failedCalls, "round \(round)")
            XCTAssertEqual(f.errors, errorLines, "round \(round)")
            // The same rule through a turn's fold: the fold never reads more failed than it ran.
            let parts = plan([person()] + rows + [said("Done.")])
            for fold in folds(parts) {
                XCTAssertLessThanOrEqual(fold.failures.calls, ran, "round \(round)")
                XCTAssertLessThanOrEqual(fold.failures.errors, errorLines, "round \(round)")
            }
        }
    }

    // MARK: - The reported turn

    /// 344 calls, 25 of them failed, and 7,835 error lines of a retry loop between them: the fold
    /// reads "25 failed · 7835 errors", never "7860 failed".
    func testTheReportedTurnLabelsSanely() throws {
        var rows: [ChatMessage] = [person()]
        var lines = 0
        for i in 0..<344 {
            rows.append(call(i % 14 == 0 ? true : nil))
            // 22 lines after each call, the rest after the last one: 7,835 in all.
            let burst = i < 343 ? 22 : 7835 - 22 * 343
            rows += (0..<burst).map { _ in errorLine() }
            lines += burst
        }
        XCTAssertEqual(lines, 7835)
        rows.append(said("The build passes now."))
        let parts = plan(rows)
        XCTAssertEqual(folds(parts).count, 1, "one turn, one fold")
        let fold = try XCTUnwrap(folds(parts).first)
        XCTAssertEqual(fold.failures, TimelineFoldFailures(calls: 25, errors: 7835))
        XCTAssertEqual(fold.failures.words, "25 failed \u{00B7} 7835 errors")
        XCTAssertLessThanOrEqual(fold.failures.calls, 344)

        // The row the timeline draws for it says the same, to the eye and to VoiceOver.
        let builder = TimelineRowBuilder()
        let row = builder.foldRow(id: "f", phrase: fold.phrase, failures: fold.failures,
                                  expanded: false, width: 393)
        guard case .toolRun(let phrase, let failures, _, _, _) = row.content else { return XCTFail("no run row") }
        XCTAssertEqual(TimelineChipAccessibility.failedBadge(failures), "25 failed \u{00B7} 7835 errors")
        XCTAssertFalse(TimelineChipAccessibility.toolRun(phrase: phrase, failures: failures, expanded: false)
            .contains("7860 failed"))
    }

    /// A run of calls (no error lines in it) reads its failed calls alone.
    func testARunCountsItsFailedCallsOnly() {
        let members = [call(true), call(), call(true, result: interrupted), thought()]
        XCTAssertEqual(TimelineFoldFailures.count(members), 1)
    }
}
