import XCTest
@testable import Walnut

/// What a diff page shows in the cases a plain sample never hits: a file whose
/// text never came, one the session's history could not rebuild, a binary one,
/// a minified line of 50,000 characters, a stray tap, a comment whose lines
/// changed since, and a Reload after the agent edited the file again.
@MainActor
final class SessionChangesDiffStatesTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.reset()
        // The UI tests use this demo session on the same simulator: start from nothing.
        forgetPricing()
    }

    private func forgetPricing() {
        UserDefaults.standard.removeObject(forKey: SessionChangesModel.compareKey("s-pricing"))
        let cwd = DemoServer.shared.withState { $0.sessions[$0.sessionIndex("s-pricing")!].cwd }
        for compare in [DiffCompare.session, .commit(sha: "4f2c9e1b7d"), .uncommitted] {
            DiskCache.remove(key: SessionChangesModel.listKey("s-pricing", compare))
            for file in DemoChanges.files(cwd: cwd) {
                DiskCache.remove(key: SessionChangesModel.fileKey("s-pricing", compare, file.filePath))
            }
        }
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
        forgetPricing()
    }

    private func file(_ status: String, before: String = "", after: String = "", partial: Bool? = nil,
                      additions: Int? = nil, deletions: Int? = nil, wsOnly: Bool? = nil) -> SessionChangedFile {
        SessionChangedFile(filePath: "/r/a.ts", relPath: "a.ts", before: before, after: after, status: status,
                           partial: partial, additions: additions, deletions: deletions, wsOnly: wsOnly)
    }

    private func state(_ f: SessionChangedFile) -> DiffEmptyState? {
        DiffEmptyState.of(f, diff: DiffEngine.diff(before: f.before, after: f.after))
    }

    func testAnEmptyDiffSaysWhatIsTrueNeverNoChangeForWhatWasNotRead() {
        // The session's history could not rebuild the edit: say so, offer git's view.
        let notRebuilt = state(file("modified", before: "a\n", after: "a\n", partial: true))
        XCTAssertEqual(notRebuilt?.title, "This edit could not be rebuilt")
        XCTAssertEqual(notRebuilt?.offersUncommitted, true)
        // No text came (binary, too large): never "Added (it is empty)".
        XCTAssertEqual(state(file("added"))?.title, "No text to show")
        XCTAssertEqual(state(file("modified"))?.title, "No text to show")
        // Empty only when the server counted it empty.
        XCTAssertEqual(state(file("added", additions: 0, deletions: 0))?.title, "Added, empty")
        XCTAssertEqual(state(file("deleted", additions: 0, deletions: 0))?.title, "Deleted, it was empty")
        XCTAssertEqual(state(file("modified", before: "a\u{0}b", after: "a\u{0}c"))?.title, "Binary file")
        XCTAssertEqual(state(file("renamed", before: "x\n", after: "x\n"))?.title, "Renamed, no line changed")
        XCTAssertEqual(state(file("modified", before: "x \n", after: "x \n", wsOnly: true))?.title, "Only whitespace changed")
        XCTAssertEqual(state(file("modified", before: "x\n", after: "x\n"))?.title, "No line changed")
        XCTAssertEqual(state(file("modified", before: "a\r\nb\r\n", after: "a\nb\n"))?.title, "Only line endings changed")
        XCTAssertEqual(SessionFileDiffView.hint(nil).contains("then Comment"), true)
        XCTAssertNotEqual(SessionFileDiffView.hint(3...3), SessionFileDiffView.hint(3...5))
        // A diff with lines shows them, rebuilt best effort or not.
        XCTAssertNil(state(file("modified", before: "a\n", after: "b\n", partial: true)))
        XCTAssertNil(state(file("modified", before: "a\n", after: "b\n")))
    }

    func testAMinifiedLineIsDrawnCutAndCopiesWhole() {
        let bundle = DemoChanges.pricingBundle
        XCTAssertGreaterThan(bundle.count, 50_000)
        let render = DiffRender.make(before: "", after: bundle, fileName: "pricing.min.js")
        XCTAssertEqual(render.diff.lines.count, 1)
        let drawn = String(render.styled[0].characters)
        XCTAssertLessThan(drawn.count, DiffRender.maxShownCharacters + 200, "the row is not a million points wide")
        XCTAssertTrue(drawn.contains("more characters"), "the cut says how much is left")
        XCTAssertLessThan(render.widestLine.count, DiffRender.maxShownCharacters + 200, "the canvas is sized to what is drawn")
        XCTAssertEqual(render.diff.lines[0].text.count, bundle.count - 1, "Copy Line and a comment quote the whole line")
        XCTAssertEqual(render.cutLines, 1, "the header says a line is cut")
        // A line just under the cut is drawn whole, with its colors.
        let near = String(repeating: "a", count: DiffRender.maxShownCharacters)
        XCTAssertEqual(String(DiffRender.make(before: "", after: near + "\n", fileName: "x.js").styled[0].characters), near)
    }

    func testATapAfterARunStartsAgainAndATapOnTheOneLineClearsIt() {
        typealias View = SessionFileDiffView
        XCTAssertEqual(View.selecting(5, current: nil, anchor: nil), 5...5)
        XCTAssertEqual(View.selecting(9, current: 5...5, anchor: 5), 5...9, "the second tap takes in the lines between")
        XCTAssertEqual(View.selecting(2, current: 5...5, anchor: 5), 2...5)
        XCTAssertNil(View.selecting(5, current: 5...5, anchor: 5))
        XCTAssertEqual(View.selecting(300, current: 5...9, anchor: 5), 300...300, "a stray tap never makes a 300-line run")
    }

    func testACardSaysWhenItsLinesChangedSince() {
        let review = DiffReview(sessionId: "states-\(UUID().uuidString)")
        let before = DiffRender.make(before: "a\nb\n", after: "a\nB\n", fileName: "a.ts")
        let line = before.diff.lines.first { $0.kind == .added }!
        let comment = review.add(file: file("modified"), compare: .session, lines: [line], comment: "why B?")
        XCTAssertTrue(before.reads(comment))
        // The agent edits that line again: the card stays under its line number, and says so.
        let after = DiffRender.make(before: "a\nb\n", after: "a\nC\n", fileName: "a.ts")
        XCTAssertFalse(after.reads(comment))
        review.discardAll()
    }

    func testReloadReadsTheFileAgainAfterTheAgentEditedIt() async throws {
        let model = SessionChangesModel(sessionId: "s-pricing")
        await model.load()
        let plans = try XCTUnwrap(model.files.first { $0.relPath == "src/pages/pricing/plans.ts" })
        XCTAssertNotNil(plans.additions, "the list carries counts")
        let first = try await model.content(of: plans)
        XCTAssertNil(first.fromCopy)
        XCTAssertTrue(first.file.after.contains("annualDiscount"))
        let reads = DemoChanges.fileReads

        DemoChanges.rewrite("src/pages/pricing/plans.ts", after: "export const plans = []\n")
        let again = try await model.content(of: plans)
        XCTAssertEqual(again.file.after, first.file.after, "opening it again this visit reads nothing new")
        XCTAssertEqual(DemoChanges.fileReads, reads)

        let reloaded = try await model.content(of: plans, refresh: true)
        XCTAssertEqual(reloaded.file.after, "export const plans = []\n", "Reload asks the server again")
        XCTAssertEqual(DemoChanges.fileReads, reads + 1)
    }

    func testASavedCopyShowsAtOnceAndTheCommentKnowsItsComparison() async throws {
        let model = SessionChangesModel(sessionId: "s-pricing")
        await model.setCompare(.commit(sha: "4f2c9e1b7d"))
        let table = try XCTUnwrap(model.files.first { $0.relPath == "src/pages/pricing/PricingTable.tsx" })
        let none = await model.savedCopy(of: table)
        XCTAssertNil(none, "nothing saved yet")
        _ = try await model.content(of: table)
        // A later visit (a new page) finds the copy without asking the server.
        let later = SessionChangesModel(sessionId: "s-pricing")
        XCTAssertEqual(later.compare, .commit(sha: "4f2c9e1b7d"))
        let found = await later.savedCopy(of: table)
        let saved = try XCTUnwrap(found)
        XCTAssertTrue(saved.file.after.contains("useState"))
        DiskCache.remove(key: SessionChangesModel.fileKey("s-pricing", .commit(sha: "4f2c9e1b7d"), table.filePath))
        DiskCache.remove(key: SessionChangesModel.listKey("s-pricing", .commit(sha: "4f2c9e1b7d")))
    }
}
