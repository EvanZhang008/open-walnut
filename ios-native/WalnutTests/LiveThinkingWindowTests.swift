import XCTest
import UIKit
@testable import Walnut

/// The 2026-09-08 gate finding, in one sentence: with 24 numbered reasoning
/// sentences the capsule read "Step 21…" while the card under it rendered
/// "Step 1 … Step 7" and did not move at t+18s or t+26s. One cap, measured in
/// two different units — a NEWLINE-counting trim in front of a WRAPPED-line
/// render, and real reasoning has almost no newlines.
///
/// The fixture text here therefore has NO NEWLINES and is much longer than the
/// window. That matters as much as the assertions: the version that shipped
/// passed a test whose fixture was newline-separated, which is the one shape
/// where the two units agree.
///
/// The wrap function is injected, so these cases are about the DECISION (which
/// slice, anchored at which end) and are independent of any font. The same
/// decision through the real TextKit measurer is pinned in `ChatRichnessRowTests`.
final class LiveThinkingWindowTests: XCTestCase {

    /// 24 numbered sentences, space-separated. ~70 characters each.
    private func reasoning(_ count: Int = 24) -> String {
        (1...count)
            .map { "Step \($0): checking hypothesis number \($0) against the evidence. " }
            .joined()
    }

    /// A deterministic stand-in for TextKit: `perLine` characters is one line.
    private func wrap(_ perLine: Int) -> (String) -> Int {
        { text in max(1, Int(ceil(Double(text.count) / Double(perLine)))) }
    }

    // MARK: - The defect

    func testWindowIsAnchoredToTheNewestTextWhenThereAreNoNewlines() throws {
        let text = reasoning()
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: text, maxLines: 8, wrappedLines: wrap(50)
        ))
        XCTAssertTrue(window.body.hasSuffix("against the evidence."),
                      "the window must END on the newest sentence: \(window.body)")
        XCTAssertTrue(window.body.contains("Step 24"),
                      "the newest step is the whole point: \(window.body)")
        XCTAssertFalse(window.body.contains("Step 1:"),
                       "the OLDEST reasoning must have scrolled off: \(window.body)")
        XCTAssertTrue(window.droppedHead)
        XCTAssertTrue(window.body.hasPrefix(TimelineLiveThinkingWindow.headMark),
                      "a window that dropped its head says so")
        XCTAssertLessThanOrEqual(window.lines, 8)
    }

    /// The window ADVANCES: reasoning that grew must show the part that arrived,
    /// not the part it opened with. This is the t+18s / t+26s screenshot pair as
    /// an assertion.
    func testTheWindowAdvancesAsReasoningArrives() throws {
        let early = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: reasoning(8), maxLines: 8, wrappedLines: wrap(50)))
        let late = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: reasoning(24), maxLines: 8, wrappedLines: wrap(50)))
        XCTAssertNotEqual(early.body, late.body, "the window is frozen")
        XCTAssertTrue(late.body.contains("Step 24"))
        XCTAssertFalse(late.body.contains("Step 8:"),
                       "24 sentences later, step 8 is no longer in an 8-line window")
    }

    /// Every line the card renders is one the trim chose. If the window handed
    /// back MORE than the cap, `Text.lineLimit` would pick the visible part — and
    /// it picks the FIRST n lines, which is the whole bug.
    func testWindowNeverExceedsTheCapItReports() throws {
        let measure = wrap(50)
        for maxLines in [1, 3, 8, 20] {
            let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
                of: reasoning(40), maxLines: maxLines, wrappedLines: measure))
            XCTAssertLessThanOrEqual(measure(window.body), maxLines,
                                     "cap \(maxLines) overflowed: \(window.lines) lines")
            XCTAssertEqual(window.lines, measure(window.body),
                           "the reserved height must describe the rendered text")
        }
    }

    /// …and it keeps as MUCH as fits: a window that showed one sentence out of an
    /// 8-line budget would be honest and useless.
    func testWindowFillsTheBudget() throws {
        let measure = wrap(50)
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: reasoning(40), maxLines: 8, wrappedLines: measure))
        XCTAssertGreaterThanOrEqual(window.lines, 7,
            "8 lines of budget filled with only \(window.lines): the search stopped early")
    }

    // MARK: - Boundaries

    func testTextThatAlreadyFitsIsUntouched() throws {
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: "  Both failures landed on node-7.  ", maxLines: 8, wrappedLines: wrap(50)))
        XCTAssertEqual(window.body, "Both failures landed on node-7.")
        XCTAssertFalse(window.droppedHead)
        XCTAssertFalse(window.body.contains(TimelineLiveThinkingWindow.headMark))
    }

    func testEmptyAndZeroCapProduceNoRow() {
        XCTAssertNil(TimelineLiveThinkingWindow.window(of: "", maxLines: 8, wrappedLines: wrap(50)))
        XCTAssertNil(TimelineLiveThinkingWindow.window(of: "   \n\n ", maxLines: 8,
                                                       wrappedLines: wrap(50)))
        XCTAssertNil(TimelineLiveThinkingWindow.window(of: "anything", maxLines: 0,
                                                       wrappedLines: wrap(50)))
    }

    /// One unbreakable token wider than the whole budget: show it and let the
    /// cell's own `lineLimit` cut it. An empty card while the agent is visibly
    /// reasoning is the worse answer.
    func testOneEnormousTokenStillProducesARow() throws {
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: String(repeating: "x", count: 900), maxLines: 2, wrappedLines: wrap(50)))
        XCTAssertFalse(window.body.isEmpty)
        XCTAssertEqual(window.lines, 2, "the row reserves the cap, never more")
    }

    /// The window opens at a WORD, never mid-word — checked against the original
    /// text rather than against a list of expected words, so the assertion holds
    /// for any fixture.
    func testWindowOpensOnAWordBoundary() throws {
        let text = reasoning(30)
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: text, maxLines: 6, wrappedLines: wrap(50)))
        let full = TimelineLiveThinkingWindow.normalized(text)
        let shown = String(window.body.dropFirst(TimelineLiveThinkingWindow.headMark.count))
        XCTAssertTrue(full.hasSuffix(shown), "the window is not a suffix of the reasoning")
        let start = full.index(full.endIndex, offsetBy: -shown.count)
        XCTAssertTrue(start == full.startIndex || full[full.index(before: start)].isWhitespace,
                      "opened mid-word: …\(full[full.index(before: start)])\(shown.prefix(16))")
    }

    // MARK: - Normalisation

    func testNormalizedCollapsesBlankRunsAndTrimsEnds() {
        XCTAssertEqual(TimelineLiveThinkingWindow.normalized("  a\n\n\n  b  \n\n"), "a\nb")
        XCTAssertEqual(TimelineLiveThinkingWindow.normalized("one two"), "one two")
        XCTAssertEqual(TimelineLiveThinkingWindow.normalized("\n\n"), "")
    }

    /// A paragraph break costs a whole line of a window that only has eight, and
    /// the newline-counting version this replaces dropped empty lines for exactly
    /// the same reason.
    func testParagraphBreaksDoNotEatTheBudget() throws {
        let text = (1...12).map { "Step \($0): a sentence about the evidence.\n\n" }.joined()
        let window = try XCTUnwrap(TimelineLiveThinkingWindow.window(
            of: text, maxLines: 8, wrappedLines: wrap(50)))
        XCTAssertFalse(window.body.contains("\n\n"), window.body)
        XCTAssertTrue(window.body.contains("Step 12"))
    }
}
