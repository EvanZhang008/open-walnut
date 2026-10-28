import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// Markdown tables on a phone (2026-10-27 report): a cell too wide for the screen
/// WRAPS inside its column instead of running off the right edge, a line runs
/// between rows, and only a table whose columns cannot all keep a readable width
/// scrolls sideways.
///
/// The chat draws each cell in a frame of the height the actor computed, so a cell
/// whose wrapped text needs more lines than that is CUT (the hosted-row parity gate
/// cannot see it: the frame is exactly the height it was given). This gate lays
/// every cell out in SwiftUI at its column width and compares.
@MainActor
final class MarkdownTableLayoutTests: XCTestCase {
    private let pageWidth: CGFloat = 393

    // MARK: - Column widths

    func testATableThatFitsKeepsEveryColumnAtItsOwnWidth() {
        XCTAssertEqual(MarkdownTableLayout.columnWidths(
            natural: [60, 120], available: 300, spacing: 16, minColumnWidth: 96), [60, 120])
    }

    func testTheWideColumnWrapsAndTheNarrowOneKeepsItsWidth() {
        // The reported shape: a short host name beside a long list of tasks.
        let widths = MarkdownTableLayout.columnWidths(
            natural: [70, 640], available: 329, spacing: 16, minColumnWidth: 96)
        XCTAssertEqual(widths[0], 70)
        XCTAssertEqual(widths[1], 243)
        XCTAssertLessThanOrEqual(MarkdownTableLayout.contentWidth(widths, spacing: 16), 329)
    }

    func testWideColumnsShareTheRoomByTheirContent() {
        let widths = MarkdownTableLayout.columnWidths(
            natural: [400, 800], available: 316, spacing: 16, minColumnWidth: 96)
        XCTAssertEqual(widths, [100, 200])
    }

    func testAColumnNeverWrapsNarrowerThanTheFloor() {
        let widths = MarkdownTableLayout.columnWidths(
            natural: [90, 1200], available: 300, spacing: 16, minColumnWidth: 96)
        // 90 is under an even share (142), so it stays whole; the wide one takes the rest.
        XCTAssertEqual(widths, [90, 194])
        let tiny = MarkdownTableLayout.columnWidths(
            natural: [300, 900], available: 200, spacing: 16, minColumnWidth: 96)
        XCTAssertEqual(tiny[0], 96, "a wrapped column keeps the floor even when the table must scroll")
    }

    func testTooManyWideColumnsMakeTheTableScroll() {
        let widths = MarkdownTableLayout.columnWidths(
            natural: [200, 200, 300, 300, 300], available: 329, spacing: 16, minColumnWidth: 96)
        XCTAssertEqual(widths, [96, 96, 96, 96, 96])
        XCTAssertGreaterThan(MarkdownTableLayout.contentWidth(widths, spacing: 16), 329)
    }

    func testEmptyAndSingleColumnTables() {
        XCTAssertEqual(MarkdownTableLayout.columnWidths(
            natural: [], available: 300, spacing: 16, minColumnWidth: 96), [])
        XCTAssertEqual(MarkdownTableLayout.columnWidths(
            natural: [900], available: 300, spacing: 16, minColumnWidth: 96), [300])
    }

    // MARK: - The chat's table rows

    /// The reported table: a host column and a column of several tasks per cell,
    /// joined by `<br>`, in English and CJK.
    private let running = """
    | \u{5728}\u{54EA}\u{8DD1} | \u{6B63}\u{5728}\u{8DD1}\u{7684}\u{4EFB}\u{52A1} |
    |---|---|
    | devbox | Every input box keeps its unsent draft (\u{8349}\u{7A3F}\u{6C38}\u{4E45}\u{4FDD}\u{5B58},\u{6362}\u{8BBE}\u{5907}\u{4E5F}\u{5728})<br>Phones & Cloud settings confusion and QR flow<br>Reply-language line in the per-message banner<br>Notes lead (Notes VP) |
    | Mac | Main (\u{6211})<br>Walnut lead (Walnut VP)<br>iOS - \u{4E91}\u{7AEF} Walnut \u{67B6}\u{6784}\u{8BBE}\u{8BA1} \u{B7} App Store<br>iOS uploads files and videos into a session<br>Ask here \u{4E0E}\u{8F93}\u{5165}\u{6846}\u{5F15}\u{7528} \u{B7} Voice Settings<br>Walnut Demo and Promotion Campaign\u{3001}Growth: weekly report and pain map<br>\u{8FD8}\u{6709}\u{51E0}\u{4E2A}\u{6682}\u{65F6}\u{7A7A}\u{95F2}\u{7684}:\u{72B6}\u{6001}\u{548C} Board \u{91CD}\u{65B0}\u{8BBE}\u{8BA1}\u{3001}Usage & Costs \u{9875}\u{9762}\u{91CD}\u{505A} |
    """

    private let wide = """
    | Host | Owner | What runs there | Why it runs there | Next step |
    |---|---|---|---|---|
    | devbox | Walnut lead | Builds, Linux tests and long gates | Always on, more cores than the Mac | Move the nightly gate there |
    | Mac | Main | The server, iOS builds and simulators | Signing and WebKit need the Mac | Keep the simulators on lane B |
    """

    private let mixed = """
    | Key | Value |
    |---|---|
    | path | `ios-native/Walnut/Timeline/TimelineComponentCells.swift` is where the cell lives |
    | url | https://example.com/a/really/long/path/that/has/no/spaces/at/all/anywhere |
    | **bold** | **a bold sentence that is long enough to wrap onto a second line here** |
    | empty |  |
    """

    private func table(_ markdown: String, category: UIContentSizeCategory = .unspecified) async -> TimelineTable? {
        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(TimelineInput(
            messages: [ChatMessage(id: "t-1", role: "assistant", text: markdown,
                                   createdAt: "2026-10-27T06:00:00Z", kind: nil)],
            streaming: false, liveText: "", liveTextTruncated: false, activity: nil,
            showLoadEarlier: false, width: pageWidth, expandedRowIDs: [],
            queuedMessageStates: [:], sizeCategory: category
        ))
        for row in snapshot.rows { if case .table(let table) = row.content { return table } }
        return nil
    }

    /// SwiftUI's height for one cell's text at its column width.
    private func renderedHeight(_ cell: AttributedString, width: CGFloat, header: Bool,
                                category: UIContentSizeCategory) -> CGFloat {
        let text = Text(cell).font(header ? .subheadline.weight(.semibold) : .subheadline)
        let content: AnyView = DynamicTypeSize(category).map {
            AnyView(text.dynamicTypeSize($0))
        } ?? AnyView(text)
        let host = UIHostingController(rootView: content)
        if category != .unspecified { host.traitOverrides.preferredContentSizeCategory = category }
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    private func assertEveryCellFits(_ table: TimelineTable, _ label: String,
                                     category: UIContentSizeCategory = .unspecified,
                                     file: StaticString = #filePath, line: UInt = #line) {
        let lines = [table.header] + table.rows
        for (r, row) in lines.enumerated() {
            for (c, cell) in row.enumerated() where c < table.columnWidths.count {
                let rendered = renderedHeight(cell, width: table.columnWidths[c],
                                              header: r == 0, category: category)
                XCTAssertLessThanOrEqual(
                    rendered, table.rowHeights[r] + 0.5,
                    "\(label): row \(r) column \(c) needs \(rendered)pt at "
                        + "\(table.columnWidths[c])pt wide but its row is \(table.rowHeights[r])pt: "
                        + "the cell is cut", file: file, line: line)
            }
            // Room to spare is at most one line, the slack measuring a little narrow buys.
            let tallest = row.enumerated().filter { $0.offset < table.columnWidths.count }.map {
                renderedHeight($0.element, width: table.columnWidths[$0.offset],
                               header: r == 0, category: category)
            }.max() ?? 0
            let oneLine = TimelineTextStyler.subheadlineFont.lineHeight
                + TimelineTextStyler.subheadlineFont.leading
            XCTAssertLessThanOrEqual(table.rowHeights[r], tallest + oneLine + 1,
                                     "\(label): row \(r) reserves more than a spare line",
                                     file: file, line: line)
        }
    }

    func testTheReportedTableWrapsInsideThePage() async throws {
        let built = await table(running)
        let table = try XCTUnwrap(built)
        XCTAssertFalse(table.overflows, "two columns fit a phone: nothing scrolls, nothing is cut")
        let content = MarkdownTableLayout.contentWidth(table.columnWidths,
                                                       spacing: TimelineMetrics.tableColSpacing)
        XCTAssertLessThanOrEqual(content, TimelineMetrics.tableContentWidth(pageWidth))
        // Several tasks per cell, each now on one line or more: taller than its breaks.
        XCTAssertGreaterThan(table.rowHeights[2], table.rowHeights[1])
        assertEveryCellFits(table, "reported table")
    }

    func testAWideTableScrollsAndKeepsReadableColumns() async throws {
        let built = await table(wide)
        let table = try XCTUnwrap(built)
        XCTAssertTrue(table.overflows)
        let floor = TimelineTextStyler.scaled(MarkdownTableLayout.baseMinColumnWidth, relativeTo: .subheadline)
        // The three long columns wrap at the floor; the short ones keep their own width.
        XCTAssertGreaterThanOrEqual(table.columnWidths.filter { $0 >= floor }.count, 3)
        assertEveryCellFits(table, "wide table")
    }

    func testCodePathsUrlsBoldAndEmptyCellsFit() async throws {
        let built = await table(mixed)
        let table = try XCTUnwrap(built)
        assertEveryCellFits(table, "mixed cells")
    }

    func testCellsFitAtLargeAndAccessibilityTextSizes() async throws {
        for category: UIContentSizeCategory in [.extraSmall, .extraExtraExtraLarge, .accessibilityLarge] {
            for (name, markdown) in [("reported", running), ("wide", wide), ("mixed", mixed)] {
                let built = await table(markdown, category: category)
        let table = try XCTUnwrap(built)
                assertEveryCellFits(table, "\(name) at \(category.rawValue)", category: category)
            }
        }
        // Leave the shared fonts at the simulator's own size for the next test.
        _ = await table(running)
    }

    /// Headers that break or wrap, bold that is long enough to fill a column without
    /// wrapping, and a table with no body rows yet (a reply mid-stream). Each was a
    /// way the computed heights came out short (review, 2026-10-27).
    private let headers = """
    | Step<br>(owner) | **Estimated completion date for the whole migration** | Notes |
    |---|---|---|
    | Build | **a bold phrase that fits** | one<br>two |
    """
    private let headerOnly = """
    | Host | What runs there |
    |---|---|
    """

    func testBrokenWrappedAndBoldHeadersFit() async throws {
        for category: UIContentSizeCategory in [.unspecified, .extraExtraExtraLarge] {
            let built = await table(headers, category: category)
            let table = try XCTUnwrap(built)
            XCTAssertGreaterThan(table.rowHeights[0], table.rowHeights[1] - 1,
                                 "the two-line header is at least as tall as a two-line row")
            assertEveryCellFits(table, "headers at \(category.rawValue)", category: category)
        }
        _ = await table(running)
    }

    /// The row the collection view reserves against what the hosted grid really lays
    /// out: rules, spacing and the caption row included, with and without body rows.
    func testTheRowHeightIsTheGridItDraws() async throws {
        let long = "| n | text |\n|---|---|\n" + (0..<70).map { "| \($0) | row \($0) |" }.joined(separator: "\n")
        for (name, markdown) in [("reported", running), ("wide", wide), ("header only", headerOnly),
                                 ("capped", long), ("headers", headers)] {
            let actor = TimelineLayoutActor()
            let snapshot = await actor.buildSnapshot(TimelineInput(
                messages: [ChatMessage(id: "g-1", role: "assistant", text: markdown,
                                       createdAt: "2026-10-27T06:00:00Z", kind: nil)],
                streaming: false, liveText: "", liveTextTruncated: false, activity: nil,
                showLoadEarlier: false, width: pageWidth, expandedRowIDs: [],
                queuedMessageStates: [:], sizeCategory: .unspecified
            ))
            let row = try XCTUnwrap(snapshot.rows.first { $0.content.reuseKind == "table" }, name)
            let host = UIHostingController(rootView: TimelineHostedCell.content(for: row, delegate: nil))
            let rendered = host.sizeThatFits(in: CGSize(width: pageWidth, height: .greatestFiniteMagnitude)).height
            XCTAssertEqual(rendered, row.height, accuracy: 1, "\(name): the grid lays out at another height")
        }
    }
}
