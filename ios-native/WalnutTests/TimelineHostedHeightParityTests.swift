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
    ///
    /// `category` overrides the hosted content's text size. It is REQUIRED for any
    /// row the actor measured at a non-default size: SwiftUI's `.caption` comes from
    /// the environment while the row's height came from `TimelineInput.sizeCategory`,
    /// so leaving it out compares a row measured at XXXL against content laid out at
    /// the simulator's size — a gate that fails on arithmetic that is actually
    /// correct.
    ///
    /// IT HAS TO BE `dynamicTypeSize`, NOT `traitOverrides`. Measured on the pinned
    /// simulator: a `UIHostingController` whose
    /// `traitOverrides.preferredContentSizeCategory` is AccessibilityXXXL still
    /// lays `Text(…).font(.caption)` out at 13.33pt — the same number it gives at
    /// `.large` — because nothing propagates that trait through `sizeThatFits` on a
    /// controller that was never in a window. `.dynamicTypeSize` moves it for real
    /// (13.33 → 44.33 on the same probe). The trait override is set ANYWAY, for the
    /// UIKit-font paths inside hosted content (the chevron reads
    /// `TimelineTextStyler`, which the actor has already adopted), so the two halves
    /// of a chip cannot be sized for two different text sizes.
    private func renderedHeight(_ row: TimelineRow,
                                category: UIContentSizeCategory = .unspecified) -> CGFloat {
        let content = TimelineHostedCell.content(for: row, delegate: nil)
        let host: UIHostingController<AnyView>
        if category != .unspecified, let size = DynamicTypeSize(category) {
            host = UIHostingController(rootView: AnyView(content.dynamicTypeSize(size)))
            host.traitOverrides.preferredContentSizeCategory = category
        } else {
            XCTAssertEqual(category, .unspecified,
                           "\(category.rawValue) has no DynamicTypeSize — the override "
                               + "would silently measure at the simulator's own size")
            host = UIHostingController(rootView: AnyView(content))
        }
        host.view.backgroundColor = .clear
        let fitted = host.sizeThatFits(in: CGSize(width: pageWidth, height: .greatestFiniteMagnitude))
        return fitted.height
    }

    private func message(_ id: String, text: String, role: String = "assistant",
                         kind: ChatMessage.Kind? = nil, source: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: "2026-09-03T06:00:00Z",
                    kind: kind, source: source)
    }

    /// `queued` and `category` are what let this gate reach a row it could not build
    /// before: a banked-send row only exists when the store says a message is queued,
    /// and its height is derived from FONTS, so it can only be judged at a stated
    /// text size (the actor measures at `sizeCategory`, the cell renders at the
    /// environment's — see `renderedHeight`).
    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      queued: [String: QueuedSend.Status] = [:],
                      category: UIContentSizeCategory = .unspecified) async -> [TimelineRow] {
        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(TimelineInput(
            messages: messages, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: pageWidth, expandedRowIDs: expanded,
            queuedMessageStates: queued, sizeCategory: category
        ))
        return snapshot.rows
    }

    /// Which row kinds this gate is responsible for (everything hosted).
    private static let hostedKinds: Set<String> = [
        "toolChip", "thinking", "chip", "notification", "image", "localImages", "table",
        "truncationChip", "activity", "failedNotice", "queuedNotice", "loadEarlier",
    ]

    /// Kinds whose height is pure arithmetic over one or two lines, so the row may
    /// also be held to a TIGHT upper bound.
    ///
    /// `queuedNotice` belongs here: its height is `max(capsule, button)` while the
    /// two sit side by side and their SUM once an accessibility size stacks them,
    /// over two fonts it reads at build time, one line each by construction, so it
    /// has nothing to round up by beyond the shared per-line cushion.
    ///
    /// The two kinds left out are known, measured gaps rather than oversights:
    /// `failedNotice` is a fixed 24pt constant for 13.3pt of content (unchanged in
    /// this pass, deliberately), and an EXPANDED notification measures its body with
    /// TextKit while SwiftUI renders it, which over-measures by 15 to 24pt on long
    /// bodies. Both only cost empty space; neither can shave ink.
    private static let tightKinds: Set<String> = [
        "chip", "toolChip", "thinking", "table", "queuedNotice",
    ]

    /// Extra round-up allowance for a row that models SEVERAL independent text
    /// blocks. Each block's height is its own line-count model of SwiftUI's
    /// layout and each has to round UP on its own, so the allowance scales with
    /// the NUMBER of blocks — a flat percentage of the row either fails an
    /// honest multi-block card or stops catching a genuinely wrong one-block row.
    ///
    /// Concretely: only ONE row kind still models more than a single line, the
    /// LIVE thinking row (a capsule plus a wrapped prose preview). Tool rows and
    /// history thinking rows became flat capsules when their inline expansion
    /// moved to the activity drawer, so they model one line and get no allowance
    /// at all — which is the tighter bar, and the right one.
    private func blockSlack(_ row: TimelineRow) -> CGFloat {
        switch row.content {
        case .thinking(_, let preview, _, _, _, _):
            return preview != nil ? 4 : 0
        default:
            return 0
        }
    }

    private func assertFits(_ rows: [TimelineRow], _ label: String,
                            category: UIContentSizeCategory = .unspecified,
                            file: StaticString = #filePath, line: UInt = #line) -> Int {
        var checked = 0
        for row in rows where Self.hostedKinds.contains(row.content.reuseKind) {
            let rendered = renderedHeight(row, category: category)
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
                let slack = max(4, rendered * 0.02) + blockSlack(row)
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

    /// The banked-send row, whose height used to be a 30pt CONSTANT while its content
    /// is a `.caption2` capsule beside a `.caption` button. At the default size the
    /// constant happened to be right; at accessibility-XXXL both controls clip, and a
    /// hosted row that needs more height than it was given does not truncate, it draws
    /// over its neighbour. Both states and both ends of the Dynamic Type range,
    /// because the badge swaps to a longer word once delivery starts.
    func testQueuedNoticeRowsFitAtEveryTextSize() async {
        var message = ChatMessage(id: "queued-1", role: "user", text: "waiting to send",
                                  createdAt: "2026-09-03T06:00:00Z", kind: nil)
        message.pending = true
        var checked = 0
        for status in [QueuedSend.Status.pending, .processing] {
            for category in [UIContentSizeCategory.large,
                             .accessibilityExtraExtraExtraLarge] {
                let built = await rows([message], queued: ["queued-1": status],
                                       category: category)
                XCTAssertTrue(built.contains { $0.content.reuseKind == "queuedNotice" },
                              "\(status) produced no queuedNotice row to check")
                checked += assertFits(built, "queuedNotice \(status) at \(category.rawValue)",
                                      category: category)
                // Printed for the same reason the two fixed constants below are: the
                // numbers in a follow-up should be measured, not derived twice.
                if let row = built.first(where: { $0.content.reuseKind == "queuedNotice" }) {
                    print("[height-report] queuedNotice \(status) at \(category.rawValue): "
                        + "row=\(row.height)pt rendered=\(renderedHeight(row, category: category))pt")
                }
            }
        }
        XCTAssertGreaterThanOrEqual(checked, 4, "gate checked nothing (n=\(checked))")
    }

    /// The measurements the review asked for on the two PRE-EXISTING fixed constants.
    /// Deliberately not a pass/fail on them (they are unchanged in this pass, and the
    /// activity row is on every turn's hot path) — it PRINTS what they are, so the
    /// numbers in the follow-up are measured rather than guessed.
    func testReportsWhatTheFixedNoticeConstantsMeasureAtTheLargestTextSize() async {
        var failedMessage = ChatMessage(id: "f-1", role: "user", text: "not sent",
                                        createdAt: "2026-09-03T06:00:00Z", kind: nil)
        failedMessage.failed = true
        for category in [UIContentSizeCategory.large,
                         .accessibilityExtraExtraExtraLarge] {
            let built = await rows([failedMessage], category: category)
            if let row = built.first(where: { $0.content.reuseKind == "failedNotice" }) {
                print("[height-report] failedNotice at \(category.rawValue): "
                    + "row=\(row.height)pt rendered=\(renderedHeight(row, category: category))pt")
            }
            let activity = TimelineRow(id: "a-1", revision: 0,
                                       content: .activity("Bash · npm run test:quick"),
                                       height: TimelineMetrics.activityHeight)
            print("[height-report] activity at \(category.rawValue): "
                + "row=\(activity.height)pt rendered=\(renderedHeight(activity, category: category))pt")
        }
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

    /// The EXPANDED reasoning card is the new asymmetric case: its height is a
    /// line-count model of SwiftUI's wrapped prose, so a line-breaking
    /// disagreement is a whole line of overflow. Sampled across the shapes that
    /// break line breaking: CJK, an unbreakable URL, hard-wrapped prose, and an
    /// excerpt past the row's own line cap.
    func testExpandedThinkingCardsFitTheRowTheyWereGiven() async {
        let excerpts = [
            "the pgid scan has to skip any sid the reconcile pass already adopted, "
                + "or the daemon ends up owning the same CLI twice",
            String(repeating: "先确认锁的持有者是不是上一次的写入方,再决定要不要合并。", count: 6),
            "the log is at https://example.com/a/very/long/path/that/cannot/break/nicely/at/all/run.txt",
            (0..<12).map { "step \($0): re-read the transcript and compare the leaf uuid" }
                .joined(separator: "\n"),
            String(repeating: "one two three four five six seven eight nine ten ", count: 40),
        ]
        var checked = 0
        for (i, excerpt) in excerpts.enumerated() {
            var msg = message("k-\(i)", text: "short collapsed line", kind: .thinking)
            msg = ChatMessage(id: msg.id, role: "assistant", text: msg.text,
                              createdAt: msg.createdAt, kind: .thinking, thinkingText: excerpt)
            checked += assertFits(await rows([msg]), "reasoning \(i) collapsed")
            checked += assertFits(await rows([msg], expanded: ["k-\(i)#0"]), "reasoning \(i) expanded")
        }
        XCTAssertGreaterThanOrEqual(checked, 10, "gate checked nothing (n=\(checked))")
    }

    /// The expanded TOOL card, with both sections present — the shape the row's
    /// arithmetic gained (Input then Result) and the one a flat percentage slack
    /// could not model.
    func testExpandedToolCardsWithBothSectionsFit() async {
        let inputs: [(String?, String?)] = [
            ("command: npm run test:quick\ncwd: /repo", (0..<24).map { "line \($0) of output" }.joined(separator: "\n")),
            ("path: src/agent/tools.ts\nlimit: 200", nil),                 // running
            (nil, "42 passing"),                                            // result only
            (nil, nil),                                                     // no output
            ((0..<20).map { "key\($0): value \($0)" }.joined(separator: "\n"), "ok"),
        ]
        var checked = 0
        for (i, pair) in inputs.enumerated() {
            let msg = ChatMessage(id: "x-\(i)", role: "assistant", text: "Bash",
                                  createdAt: "2026-09-08T04:00:00Z", kind: .tool,
                                  detail: "npm run test:quick", resultPreview: pair.1,
                                  inputPreview: pair.0)
            checked += assertFits(await rows([msg]), "tool \(i) collapsed")
            checked += assertFits(await rows([msg], expanded: ["x-\(i)#0"]), "tool \(i) expanded")
        }
        XCTAssertGreaterThanOrEqual(checked, 10, "gate checked nothing (n=\(checked))")
    }

    /// The rows a live turn puts on screen. The activity row is a CONSTANT 28pt
    /// under a `ThinkingRow`, so a long activity label ("Bash · npm run …") is
    /// exactly the shape that outgrows it — and it is on screen for every turn.
    func testLiveTurnRowsFit() async {
        let actor = TimelineLayoutActor()
        // The live REASONING row rides the same turn now, so every case carries
        // one: it is rebuilt on every streaming tick, which makes it the row a
        // height model gets wrong most often.
        let reasoning = (0..<20).map { "step \($0): 读取下一个候选路径并核对 mtime" }
            .joined(separator: "\n")
        // The turn's TOOL CHIPS ride along too: a live turn now keeps a row per
        // call, running and finished, and a running chip animates its icon — which
        // must not change the height the row was measured at.
        let tools = [
            LiveToolCall(id: "t1", name: "Read", detail: "src/agent/tools.ts", finished: true),
            LiveToolCall(id: "t2", name: "mcp__walnut__task_create",
                         detail: "title: 把远端会话的镜像路径改成按 build 分目录", finished: true),
            LiveToolCall(id: "t3", name: "WebFetch",
                         detail: "https://example.com/a/very/long/path/that/cannot/break/nicely/at/all",
                         finished: false),
        ]
        for activity in ["Thinking", "Bash · npm run test:quick in the repo root",
                         "正在读取 /tmp 下的会话流文件并核对时间戳", nil] {
            let snapshot = await actor.buildSnapshot(TimelineInput(
                messages: [], streaming: true,
                liveText: "第一段结论已经写完,继续第二段。\n\n- 一\n- 二",
                liveTextTruncated: true, liveThinking: reasoning,
                liveTools: tools,
                activity: activity, showLoadEarlier: true,
                width: pageWidth, expandedRowIDs: []))
            let checked = assertFits(snapshot.rows, "live turn (\(activity ?? "no activity"))")
            XCTAssertGreaterThanOrEqual(checked, 4, "gate checked nothing (n=\(checked))")
        }
    }

    /// The COLLAPSED rows at an accessibility text size, which is where a chip's
    /// one-line height model is under the most pressure: the capsule's font grows,
    /// the chevron scales with it, and the row still may not outgrow the number the
    /// actor computed (the cell clips). Both chips, both with a long line to
    /// truncate, at the two extremes.
    func testChipRowsFitAtAccessibilityTextSizes() async {
        let long = "checking the pgid files before adopting them, because a daemon "
            + "restart must skip any sid the reconcile pass already took over"
        var checked = 0
        for category in [UIContentSizeCategory.extraSmall,
                         .large,
                         .accessibilityExtraExtraExtraLarge] {
            var reasoning = message("k-1", text: long, kind: .thinking)
            reasoning = ChatMessage(id: reasoning.id, role: "assistant", text: long,
                                    createdAt: reasoning.createdAt, kind: .thinking,
                                    thinkingText: long + " " + long)
            let tool = ChatMessage(id: "t-1", role: "assistant",
                                   text: "mcp__walnut__task_create",
                                   createdAt: "2026-09-12T06:00:00Z", kind: .tool,
                                   detail: long, resultPreview: "ok", agent: "reviewer")
            let actor = TimelineLayoutActor()
            let snapshot = await actor.buildSnapshot(TimelineInput(
                messages: [reasoning, tool], streaming: false, liveText: "",
                liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                width: pageWidth, expandedRowIDs: [], sizeCategory: category))
            checked += assertFits(snapshot.rows, "chips at \(category.rawValue)",
                                  category: category)
        }
        TimelineTextStyler.adopt(.unspecified)
        XCTAssertGreaterThanOrEqual(checked, 6, "gate checked nothing (n=\(checked))")
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
