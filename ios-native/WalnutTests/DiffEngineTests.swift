import XCTest
@testable import Walnut

/// The Changed page's line diff: the lines it aligns, the numbers it gives them,
/// the folds it draws, and how it holds up on a large file.
final class DiffEngineTests: XCTestCase {
    func testAnEditAlignsBothSidesWithTheirOwnLineNumbers() {
        let diff = DiffEngine.diff(before: "a\nOLD\nc\n", after: "a\nNEW\nmore\nc\n")
        XCTAssertEqual(diff.additions, 2)
        XCTAssertEqual(diff.deletions, 1)
        XCTAssertEqual(diff.lines.map(\.kind), [.context, .removed, .added, .added, .context])
        XCTAssertEqual(diff.lines.map(\.oldNumber), [1, 2, nil, nil, 3])
        XCTAssertEqual(diff.lines.map(\.newNumber), [1, nil, 2, 3, 4])
        XCTAssertEqual(diff.lines.map(\.text), ["a", "OLD", "NEW", "more", "c"])
        XCTAssertEqual(diff.lines.map(\.key), ["n1", "o2", "n2", "n3", "n4"])
    }

    func testAnAddedAndADeletedFile() {
        let added = DiffEngine.diff(before: "", after: "x\ny\n")
        XCTAssertEqual(added.lines.map(\.kind), [.added, .added])
        XCTAssertEqual(added.additions, 2)
        let deleted = DiffEngine.diff(before: "x\ny\n", after: "")
        XCTAssertEqual(deleted.lines.map(\.kind), [.removed, .removed])
        XCTAssertEqual(deleted.deletions, 2)
        XCTAssertTrue(DiffEngine.diff(before: "same\n", after: "same\n").isEmpty)
    }

    func testCRLFAndAMissingFinalNewlineAreNotChanges() {
        XCTAssertTrue(DiffEngine.diff(before: "a\r\nb\r\n", after: "a\nb\n").isEmpty)
        XCTAssertTrue(DiffEngine.diff(before: "a\nb", after: "a\nb\n").isEmpty)
    }

    func testUnchangedRunsFoldAndOpenFromBothEnds() {
        let before = (1...200).map { "line \($0)" }.joined(separator: "\n") + "\n"
        var afterLines = (1...200).map { "line \($0)" }
        afterLines[99] = "changed 100"
        let diff = DiffEngine.diff(before: before, after: afterLines.joined(separator: "\n") + "\n")
        let rows = diff.rows()
        // fold, 3 context, removed, added, 3 context, fold
        XCTAssertEqual(rows.count, 10)
        guard case .fold(let head) = rows.first, case .fold(let tail) = rows.last else {
            return XCTFail("expected a fold at each end: \(rows)")
        }
        XCTAssertEqual(head, 0..<96)
        XCTAssertEqual(tail.count, 97)
        let opening = FileDiff.opening(head)
        XCTAssertEqual(opening, [0..<20, 76..<96])
        let opened = diff.rows(opened: opening)
        guard case .fold(let middle) = opened[20] else { return XCTFail("the middle of the fold stays folded") }
        XCTAssertEqual(middle, 20..<76)
        // A short fold opens all at once.
        XCTAssertEqual(FileDiff.opening(0..<30), [0..<30])
    }

    func testARewriteOfALargeFileAnswersFast() {
        let before = (0..<15_000).map { "old \($0)" }.joined(separator: "\n") + "\n"
        let after = (0..<14_000).map { "new \($0)" }.joined(separator: "\n") + "\n"
        var diff = DiffEngine.diff(before: before, after: after)
        // The median of three passes: one stalled pass on a busy runner moves nothing.
        let passes = PerfGate.passes(3) { _ in PerfGate.ms { diff = DiffEngine.diff(before: before, after: after) } }
        XCTAssertLessThan(PerfGate.median(passes), 3_000)
        XCTAssertTrue(diff.approximate)
        XCTAssertEqual(diff.additions, 14_000)
        XCTAssertEqual(diff.deletions, 15_000)
    }

    func testAHalfRewrittenFileStaysWithinTheEditBudget() {
        let before = (0..<10_000).map { "line \($0)" }
        var after = before
        for i in stride(from: 0, to: 10_000, by: 2) { after[i] = "rewritten \(i)" }
        let a = before.joined(separator: "\n") + "\n", b = after.joined(separator: "\n") + "\n"
        var diff = DiffEngine.diff(before: a, after: b)
        let passes = PerfGate.passes(3) { _ in PerfGate.ms { diff = DiffEngine.diff(before: a, after: b) } }
        XCTAssertLessThan(PerfGate.median(passes), 3_000)
        XCTAssertTrue(diff.approximate, "10,000 edits is past the budget: the middle reads as removed, then added")
        XCTAssertNil(DiffEngine.alignedEdits(["a", "b"], ["c", "d"], maxEdits: 3), "4 edits is past a budget of 3")
        let fits = DiffEngine.alignedEdits(["a", "b", "c"], ["a", "x", "c"], maxEdits: 3)
        XCTAssertEqual(fits?.removed, [1])
        XCTAssertEqual(fits?.inserted, [1])
    }

    func testScatteredEditsInALongFileMatchACountByHand() {
        var lines = (0..<4_000).map { "let v\($0) = \($0)" }
        let before = lines.joined(separator: "\n") + "\n"
        for i in stride(from: 50, to: 4_000, by: 400) { lines[i] = "let v\(i) = changed" }
        lines.insert("// inserted", at: 2_000)
        lines.remove(at: 3_999)
        let diff = DiffEngine.diff(before: before, after: lines.joined(separator: "\n") + "\n")
        XCTAssertFalse(diff.approximate)
        XCTAssertEqual(diff.additions, 11)
        XCTAssertEqual(diff.deletions, 11)
    }

    func testTheRenderColorsByLanguageAndKeepsEveryLine() {
        let render = DiffRender.make(before: "let a = 1\n", after: "let a = 2\n\tlet b = \"x\"\n", fileName: "a.swift")
        XCTAssertEqual(render.styled.count, render.diff.lines.count)
        XCTAssertEqual(String(render.styled[2].characters), "    let b = \"x\"", "tabs are drawn as spaces")
        XCTAssertNotEqual(render.styled[1], AttributedString("let a = 2"), "a Swift keyword is colored")
        XCTAssertGreaterThan(render.styled[1].runs.count, 1)
        let plain = DiffRender.make(before: "a\n", after: "b\n", fileName: "notes.txt")
        XCTAssertEqual(plain.styled[1], AttributedString("b"), "a file with no language stays plain")
        XCTAssertEqual(render.widestLine, "    let b = \"x\"")
    }
}
