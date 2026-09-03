import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// Height parity for the SwiftUI-HOSTED timeline rows.
///
/// The engine's whole contract is "the layout never self-sizes": the actor
/// computes every row's height, and `TimelineLayout` stacks those numbers. For
/// prose that is safe, because the measurer and the cell run the same TextKit 2
/// stack (`TimelineEngineTests.testMeasuredHeightMatchesRenderedHeight`).
///
/// A hosted row is the asymmetric case and had no gate at all: its height is a
/// hand-written FORMULA in TimelineRowBuilder, while its content is laid out by
/// SwiftUI inside a `UIHostingConfiguration`. Two different layout engines, and
/// nothing clips — a cell whose content needs more height than the row was
/// given does not scroll or truncate, it DRAWS PAST ITS ROW and over whatever
/// comes next, permanently. That is the "text overlapped by the next message"
/// report.
///
/// So the assertion is deliberately one-sided: rendered must not EXCEED the
/// row. Extra room below is a cosmetic gap; missing room is ink on ink.
@MainActor
final class TimelineHostedHeightParityTests: XCTestCase {
    private let pageWidth: CGFloat = 393

    /// Rendered height of exactly the content the cell hosts, at page width.
    private func renderedHeight(_ row: TimelineRow) -> CGFloat {
        let host = UIHostingController(rootView: TimelineHostedCell.content(for: row, delegate: nil))
        host.view.backgroundColor = .clear
        let fitted = host.sizeThatFits(in: CGSize(width: pageWidth, height: .greatestFiniteMagnitude))
        return fitted.height
    }

    private func message(_ id: String, text: String, role: String = "assistant",
                         kind: ChatMessage.Kind? = nil, source: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: "2026-09-03T06:00:00Z",
                    kind: kind, source: source)
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = []) async -> [TimelineRow] {
        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(TimelineInput(
            messages: messages, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: pageWidth, expandedRowIDs: expanded
        ))
        return snapshot.rows
    }

    /// Which row kinds this gate is responsible for (everything hosted).
    private static let hostedKinds: Set<String> = [
        "toolChip", "chip", "notification", "image", "localImages", "table",
        "truncationChip", "activity", "failedNotice", "loadEarlier",
    ]

    /// Kinds whose height is pure arithmetic over one or two lines, so the row may
    /// also be held to a TIGHT upper bound. The two kinds left out are known,
    /// measured gaps rather than oversights: `failedNotice` is a fixed 24pt row for
    /// 13.3pt of content, and an EXPANDED notification measures its body with
    /// TextKit while SwiftUI renders it, which over-measures by 15 to 24pt on long
    /// bodies. Both only cost empty space; neither can shave ink.
    private static let tightKinds: Set<String> = ["chip", "toolChip", "table"]

    private func assertFits(_ rows: [TimelineRow], _ label: String,
                            file: StaticString = #filePath, line: UInt = #line) -> Int {
        var checked = 0
        for row in rows where Self.hostedKinds.contains(row.content.reuseKind) {
            let rendered = renderedHeight(row)
            let kind = row.content.reuseKind
            checked += 1
            XCTAssertLessThanOrEqual(
                ceil(rendered), ceil(row.height) + 1,
                "\(label): row \(row.id) (\(kind)) was given \(row.height)pt but SwiftUI "
                    + "lays its content out at \(rendered)pt — the cell clips, so "
                    + "\(rendered - row.height)pt of its ink is shaved off",
                file: file, line: line
            )
            if Self.tightKinds.contains(kind) {
                // Absolute slack on a small row, proportional on a tall one: 4pt on
                // a 23pt capsule is a quarter of the row, on an expanded tool card
                // it is noise, and the tall case accumulates it per line (24 lines
                // of monospaced preview measured with UIFont arithmetic).
                let slack = max(4, rendered * 0.02)
                XCTAssertLessThanOrEqual(
                    row.height, rendered + slack,
                    "\(label): row \(row.id) (\(kind)) reserves \(row.height)pt for "
                        + "\(rendered)pt of content — round UP, but not by that much",
                    file: file, line: line
                )
            }
        }
        return checked
    }

    // MARK: - The kinds a real transcript is full of

    func testNotificationCardsFitTheRowTheyWereGiven() async {
        // Notifications are the worst case by construction: the body height is
        // measured with TextKit and rendered with SwiftUI `Text`, so any line-
        // breaking disagreement is a whole line of overflow. Sampled across the
        // shapes that actually arrive (session results, errors, CJK, long URLs,
        // hard-wrapped prose) because line breaking is exactly what differs.
        let bodies = [
            "**Session Result**: the deploy finished and the dist was staged.",
            "**Session Error** (build): " + String(repeating: "the toolchain check failed. ", count: 12),
            "任务已完成:" + String(repeating: "第三步的校验通过,等待人工复核。", count: 8),
            "See https://example.com/a/very/long/path/that/cannot/break/nicely/at/all/index.html for the log.",
            String(repeating: "one two three four five six seven eight nine ten ", count: 9),
        ]
        var checked = 0
        for (i, body) in bodies.enumerated() {
            let msg = message("n-\(i)", text: body, kind: .notification, source: "session")
            // Collapsed AND expanded: they take different height branches.
            checked += assertFits(await rows([msg]), "notification \(i) collapsed")
            checked += assertFits(await rows([msg], expanded: ["n-\(i)#0"]), "notification \(i) expanded")
        }
        XCTAssertGreaterThanOrEqual(checked, 10, "gate checked nothing (n=\(checked))")
    }

    func testToolChipsFitCollapsedAndExpanded() async {
        let msg = ChatMessage(
            id: "t-1", role: "assistant", text: "Bash", createdAt: "2026-09-03T06:00:00Z",
            kind: .tool, detail: "npm run test:quick",
            resultPreview: (0..<24).map { "line \($0) of the captured output" }.joined(separator: "\n"),
            agent: "explorer"
        )
        var checked = assertFits(await rows([msg]), "tool collapsed")
        checked += assertFits(await rows([msg], expanded: ["t-1#0"]), "tool expanded")
        XCTAssertGreaterThanOrEqual(checked, 2, "gate checked nothing (n=\(checked))")
    }

    func testThinkingChipsAndTablesFit() async {
        let messages = [
            message("k-1", text: "checking the daemon's pgid files before adopting", kind: .thinking),
            message("k-2", text: "短", kind: .thinking),
            message("k-3", text: "| host | state | detail |\n|---|---|---|\n"
                + (0..<6).map { "| box-\($0) | ready | nothing to report |" }.joined(separator: "\n")),
        ]
        let checked = assertFits(await rows(messages), "chips + table")
        XCTAssertGreaterThanOrEqual(checked, 3, "gate checked nothing (n=\(checked))")
    }

    /// The rows a live turn puts on screen. The activity row is a CONSTANT 28pt
    /// under a `ThinkingRow`, so a long activity label ("Bash · npm run …") is
    /// exactly the shape that outgrows it — and it is on screen for every turn.
    func testLiveTurnRowsFit() async {
        let actor = TimelineLayoutActor()
        for activity in ["Thinking", "Bash · npm run test:quick in the repo root",
                         "正在读取 /tmp 下的会话流文件并核对时间戳", nil] {
            let snapshot = await actor.buildSnapshot(TimelineInput(
                messages: [], streaming: true,
                liveText: "第一段结论已经写完,继续第二段。\n\n- 一\n- 二",
                liveTextTruncated: true, activity: activity, showLoadEarlier: true,
                width: pageWidth, expandedRowIDs: []))
            let checked = assertFits(snapshot.rows, "live turn (\(activity ?? "no activity"))")
            XCTAssertGreaterThanOrEqual(checked, 3, "gate checked nothing (n=\(checked))")
        }
    }

    func testFailedNoticeFitsBothWordings() async {
        var terminal = message("f-1", text: "did not send", role: "user")
        terminal.failed = true
        var waiting = message("f-2", text: "did not send", role: "user")
        waiting.failed = true
        waiting.retryNotice = "Retrying in 8s"
        let checked = assertFits(await rows([terminal, waiting]), "failed notices")
        XCTAssertGreaterThanOrEqual(checked, 2, "gate checked nothing (n=\(checked))")
    }
}
