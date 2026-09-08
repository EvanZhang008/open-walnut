import XCTest
import UIKit
@testable import Walnut

/// The rendering half of the 2026-09-08 chat-richness report: "I can't see what
/// tool it used, and thinking is completely hidden — it only shows a blinking
/// 'thinking'. Collapsing is fine, but when I TAP it, it should expand and show
/// the detail."
///
/// Three shipped gaps are pinned here, one group each:
///  1. a `kind:"thinking"` message built the fixed one-line `.chip` capsule,
///     which had no `onToggle` and no gesture — the row COULD NOT expand;
///  2. the expanded tool card rendered `resultPreview` only: no Input section,
///     so the one question a tool name raises ("what did it run?") had no answer;
///  3. a tool row with an empty `resultPreview` was deliberately inert, which
///     reads as "tapping does nothing" rather than as "no output".
///
/// Pure logic: rows come from the real `TimelineLayoutActor`, so the assertions
/// are about the same measured rows the collection view stacks.
@MainActor
final class ChatRichnessRowTests: XCTestCase {
    private let pageWidth: CGFloat = 393

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    override func tearDown() {
        // The styler's font box is process-global (it has to be: the layout actor
        // and the cells both read it). A test that adopted an accessibility text
        // size must hand it back, or it leaks into whatever runs next.
        TimelineTextStyler.adopt(.unspecified)
        super.tearDown()
    }

    // MARK: - Fixtures

    private func input(_ messages: [ChatMessage], expanded: Set<String> = [],
                       scope: String = TimelineScope.unscoped,
                       liveThinking: String = "", streaming: Bool = false) -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: "",
                      liveTextTruncated: false, liveThinking: liveThinking,
                      activity: nil, showLoadEarlier: false, width: pageWidth,
                      expandedRowIDs: expanded, scope: scope)
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      scope: String = TimelineScope.unscoped,
                      liveThinking: String = "", streaming: Bool = false) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(
            input(messages, expanded: expanded, scope: scope,
                  liveThinking: liveThinking, streaming: streaming)
        ).rows
    }

    /// A reasoning message as the wire delivers one: a short collapsed line plus
    /// the fuller excerpt behind it.
    private func thinking(_ id: String, line: String, excerpt: String?) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: line,
                    createdAt: "2026-09-08T04:00:00Z", kind: .thinking,
                    thinkingText: excerpt)
    }

    private func tool(_ id: String, name: String, detail: String? = nil,
                      input: String? = nil, result: String? = nil,
                      agent: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: name,
                    createdAt: "2026-09-08T04:00:00Z", kind: .tool,
                    detail: detail, resultPreview: result, agent: agent,
                    inputPreview: input)
    }

    /// One line of the reasoning capsule, at the height the row reserves for it —
    /// i.e. what the row measured BEFORE this feature existed. Computed from the
    /// public metrics so the old-server guard below is a number, not a vibe.
    private var capsuleHeight: CGFloat {
        TimelineMetrics.hostedLineHeight(TimelineTextStyler.captionFont)
            + TimelineMetrics.chipVPad * 2 + TimelineMetrics.chipRowVMargin * 2
    }

    private func thinkingRow(_ rows: [TimelineRow]) -> TimelineRow? {
        rows.first { $0.content.reuseKind == "thinking" }
    }

    /// Wrapped-line count through the SAME code the builder measures with (a
    /// second implementation here could agree with the assertion and disagree
    /// with the row), at the card's real content width.
    private func measuredWrappedLines(_ text: String) -> Int {
        TimelineRowBuilder().wrappedLineCount(
            text, font: TimelineTextStyler.captionFont,
            width: TimelineMetrics.expandCardContentWidth(pageWidth))
    }

    private func toolRow(_ rows: [TimelineRow]) -> TimelineRow? {
        rows.first { $0.content.reuseKind == "toolChip" }
    }

    // MARK: - 1. A thinking message builds the new, expandable row

    func testThinkingMessageYieldsTheThinkingRowNotAPlainChip() async {
        let built = await rows([thinking("m0", line: "checking the pgid files",
                                        excerpt: "checking the pgid files before adopting them, "
                                            + "because a daemon restart must skip any sid the "
                                            + "reconcile pass already took over")])
        XCTAssertEqual(built.map(\.content.reuseKind), ["thinking"],
                       "a kind:\"thinking\" message must build the reasoning row")
        guard case .thinking(let line, let body, let collapsible, let expanded, _)
                = built[0].content else {
            return XCTFail("expected the .thinking case, got \(built[0].content.reuseKind)")
        }
        XCTAssertEqual(line, "checking the pgid files")
        XCTAssertNotNil(body, "the excerpt behind the line must reach the row")
        XCTAssertTrue(collapsible, "an excerpt means a chevron and a tap")
        XCTAssertFalse(expanded, "history rows open only when the user taps them")
    }

    /// The gap the user reported: tapping had nowhere to go. Membership in
    /// `expandedRowIDs` must MOVE the row's height, because that height is what
    /// the layout stacks — a cell cannot self-size.
    ///
    /// RED PROOF: routing `.thinking` back to `chipRow` (a single fixed capsule
    /// height) fails the height-grew assertion.
    func testThinkingRowHeightGrowsWhenExpanded() async {
        let message = thinking("m0", line: "weighing two fixes",
                               excerpt: String(repeating: "weighing two fixes for the stale "
                                               + "lock, and the second one is cheaper. ", count: 6))
        let collapsed = await rows([message])
        let opened = await rows([message], expanded: ["m0#0"])
        guard let closedRow = thinkingRow(collapsed), let openRow = thinkingRow(opened) else {
            return XCTFail("no reasoning row built")
        }
        XCTAssertEqual(closedRow.height, capsuleHeight, accuracy: 0.5,
                       "the COLLAPSED row must stay exactly the capsule it always was")
        XCTAssertGreaterThan(openRow.height, closedRow.height + 20,
                             "expanding must reserve room for the excerpt")
        guard case .thinking(_, _, _, let expanded, _) = openRow.content else {
            return XCTFail("expected the .thinking case")
        }
        XCTAssertTrue(expanded)
    }

    /// A long excerpt is truncated at the row's own line cap, not clipped by the
    /// cell — so the reserved height stops growing there too.
    func testThinkingRowHeightIsCappedAtItsLineLimit() async {
        let huge = (0..<200).map { "reasoning line \($0) with enough words to fill the width" }
            .joined(separator: "\n")
        let opened = await rows([thinking("m0", line: "long chain", excerpt: huge)],
                                expanded: ["m0#0"])
        guard let row = thinkingRow(opened) else { return XCTFail("no reasoning row") }
        let cap = capsuleHeight
            + TimelineMetrics.hostedTextHeight(lines: TimelineMetrics.expandThinkingMaxLines,
                                               font: TimelineTextStyler.captionFont)
            + TimelineMetrics.expandCardPadding * 2 + TimelineMetrics.expandCardGap
        XCTAssertEqual(row.height, cap, accuracy: 0.5,
                       "an unbounded excerpt must not produce an unbounded row")
    }

    // MARK: - 2/3. Row identity: the new case joins BOTH defences

    /// Layer A (`TimelineScope`) and layer B (`contentKey`) both have to cover a
    /// new case, or a conversation switch reuses the wrong row — the exact bug
    /// `797f2ee5` fixed for every case that existed then.
    func testThinkingRowJoinsScopingAndContentKey() async {
        let scoped = await rows([thinking("m0", line: "same words here", excerpt: "a fuller take")],
                                scope: "conv-p")
        XCTAssertEqual(scoped.first?.id, "conv-p|m0#0",
                       "the reasoning row must carry its conversation")

        let a = TimelineRowContent.thinking(line: "same words here", body: "a fuller take",
                                            collapsible: true, expanded: false, maxLines: 24)
        let b = TimelineRowContent.thinking(line: "same words here", body: "a fuller take",
                                            collapsible: true, expanded: false, maxLines: 24)
        XCTAssertEqual(a.contentKey, b.contentKey,
                       "equal content must hash equal, or every diff reloads everything")
        // Each associated value is drawn, so each must split the key.
        let otherBody = TimelineRowContent.thinking(line: "same words here", body: "a DIFFERENT take",
                                                    collapsible: true, expanded: false, maxLines: 24)
        let otherState = TimelineRowContent.thinking(line: "same words here", body: "a fuller take",
                                                     collapsible: true, expanded: true, maxLines: 24)
        XCTAssertNotEqual(a.contentKey, otherBody.contentKey)
        XCTAssertNotEqual(a.contentKey, otherState.contentKey)
        // …and the reuse bucket separates it from the plain capsule that used to
        // render these rows, whose text is identical.
        let chip = TimelineRowContent.chip(icon: "sparkles", text: "same words here")
        XCTAssertNotEqual(a.contentKey, chip.contentKey)
        XCTAssertEqual(a.reuseKind, "thinking")
    }

    // MARK: - 4. A tool row with only an input is expandable

    /// RED PROOF: restoring `expanded = contains(id) && resultPreview?.isEmpty
    /// == false` fails the height-grew assertion — the row stays a flat capsule.
    func testToolRowWithOnlyAnInputExpands() async {
        let message = tool("m0", name: "Bash", detail: "npm run test:quick",
                           input: "npm run test:quick --silent")
        let collapsed = await rows([message])
        let opened = await rows([message], expanded: ["m0#0"])
        guard let closedRow = toolRow(collapsed), let openRow = toolRow(opened) else {
            return XCTFail("no tool row built")
        }
        XCTAssertGreaterThan(openRow.height, closedRow.height + 20,
                             "a running tool must still open onto its input")
        guard case .toolChip(_, _, let inputPreview, let result, _, let expanded)
                = openRow.content else {
            return XCTFail("expected the .toolChip case")
        }
        XCTAssertEqual(inputPreview, "npm run test:quick --silent",
                       "the input must reach the card")
        XCTAssertNil(result)
        XCTAssertTrue(expanded)
        // A tool with an input and no result is RUNNING, and the card says so.
        XCTAssertEqual(TimelineExpandSection.resultNote(hasInput: true), "Running…")
    }

    /// The Input section is real height, not a label: a card with both sections
    /// must be taller than the same card with only its result.
    func testExpandedToolCardReservesRoomForBothSections() async {
        let result = (0..<6).map { "out line \($0)" }.joined(separator: "\n")
        let resultOnly = tool("m0", name: "Read", result: result)
        let both = tool("m0", name: "Read", input: "path: src/agent/tools.ts\nlimit: 200",
                        result: result)
        guard let withoutInput = toolRow(await rows([resultOnly], expanded: ["m0#0"])),
              let withInput = toolRow(await rows([both], expanded: ["m0#0"])) else {
            return XCTFail("no tool row built")
        }
        XCTAssertGreaterThan(withInput.height, withoutInput.height + 20,
                             "the Input section must be reserved, not overlaid")
    }

    // MARK: - 5. Nothing to show still opens, and says so

    /// RED PROOF: making `expanded` require either field (`expandedRowIDs
    /// .contains(id) && (input != nil || result != nil)`) fails the height-grew
    /// assertion, which is the "tapping does nothing" report.
    func testToolRowWithNeitherFieldStillOpensToNoOutput() async {
        let message = tool("m0", name: "TodoWrite")
        let collapsed = await rows([message])
        let opened = await rows([message], expanded: ["m0#0"])
        guard let closedRow = toolRow(collapsed), let openRow = toolRow(opened) else {
            return XCTFail("no tool row built")
        }
        XCTAssertGreaterThan(openRow.height, closedRow.height,
                             "a tool row must never swallow the tap")
        XCTAssertEqual(TimelineExpandSection.resultNote(hasInput: false), "No output")
    }

    // MARK: - 6. Old-server guard

    /// A server that has not been redeployed sends neither new field. Every such
    /// row must decode and render exactly as it did before this change: the
    /// reasoning capsule keeps its one-line height and gains no chevron, and the
    /// tool card still opens onto its result.
    func testRowsMissingEveryNewFieldDecodeAndRenderAsBefore() async throws {
        // Decode from the OLD wire shape, so nil-ness is proved by the decoder
        // rather than by a Swift default.
        let json = """
        [{"id":"m0","role":"assistant","text":"short thought","createdAt":"2026-09-08T04:00:00Z",
          "kind":"thinking"},
         {"id":"m1","role":"assistant","text":"Bash","createdAt":"2026-09-08T04:00:01Z",
          "kind":"tool","detail":"ls docs/","resultPreview":"README.md\\nreference/"}]
        """
        let decoded = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        XCTAssertNil(decoded[0].thinkingText, "an absent field must decode to nil, not fail")
        XCTAssertNil(decoded[1].inputPreview)

        // Reasoning: one-line capsule, no body, no chevron, and immune to a
        // stale expanded id.
        let closed = await rows([decoded[0]])
        let tapped = await rows([decoded[0]], expanded: ["m0#0"])
        guard case .thinking(let line, let body, let collapsible, let expanded, _)
                = try XCTUnwrap(thinkingRow(closed)).content else {
            return XCTFail("expected the .thinking case")
        }
        XCTAssertEqual(line, "short thought")
        XCTAssertNil(body, "no excerpt and nothing to unwrap ⇒ nothing to reveal")
        XCTAssertFalse(collapsible, "no chevron, so a tap can never look broken")
        XCTAssertFalse(expanded)
        XCTAssertEqual(try XCTUnwrap(thinkingRow(closed)).height, capsuleHeight, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(thinkingRow(tapped)).height, capsuleHeight, accuracy: 0.5,
                       "a row with nothing to show must ignore an expanded id")

        // Tool: the result is still what the card opens onto.
        let openedToolRows = await rows([decoded[1]], expanded: ["m1#0"])
        let closedToolRows = await rows([decoded[1]])
        let openedTool = try XCTUnwrap(toolRow(openedToolRows))
        let closedTool = try XCTUnwrap(toolRow(closedToolRows))
        guard case .toolChip(let name, let detail, let inputPreview, let resultPreview, _, _)
                = openedTool.content else {
            return XCTFail("expected the .toolChip case")
        }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(detail, "ls docs/")
        XCTAssertNil(inputPreview)
        XCTAssertEqual(resultPreview, "README.md\nreference/")
        XCTAssertGreaterThan(openedTool.height, closedTool.height + 20)
    }

    // MARK: - The live reasoning region

    /// While a turn runs, the accumulated reasoning gets a row of its own —
    /// always open, never collapsible (nothing remembers a chevron's state
    /// across ticks), capped much tighter than a historical row so it cannot
    /// push the reply off the phone.
    /// NO NEWLINES in the fixture, on purpose. The version of this test that
    /// shipped the defect used newline-separated reasoning, which is the one shape
    /// where a newline-counting trim and a wrapped-line render agree — so it was
    /// green while the phone showed the OLDEST seven lines under a capsule
    /// advertising the newest. Real reasoning arrives as sentences.
    func testLiveReasoningRowShowsTheNewestWrappedLinesWhileStreaming() async throws {
        let reasoning = (1...24)
            .map { "Step \($0): checking hypothesis number \($0) against the evidence. " }
            .joined()
        let built = await rows([], liveThinking: reasoning, streaming: true)
        guard let row = thinkingRow(built) else {
            return XCTFail("no live reasoning row in \(built.map(\.content.reuseKind))")
        }
        guard case .thinking(let line, let body, let collapsible, let expanded, let maxLines)
                = row.content else {
            return XCTFail("expected the .thinking case")
        }
        // The capsule is a HEADER, not an echo: it used to print the newest line
        // over a card printing the oldest, and even in agreement it would be the
        // same sentence twice in one row.
        XCTAssertEqual(line, TimelineLiveThinkingWindow.capsuleLabel)
        XCTAssertEqual(maxLines, TimelineMetrics.liveThinkingMaxLines)
        XCTAssertTrue(expanded)
        XCTAssertFalse(collapsible)
        let shown = try XCTUnwrap(body)
        XCTAssertTrue(shown.hasSuffix("Step 24: checking hypothesis number 24 against the evidence."),
                      "the card must END on the newest sentence: …\(shown.suffix(70))")
        XCTAssertFalse(shown.contains("Step 1:"),
                       "the OLDEST reasoning must have scrolled off: \(shown.prefix(70))…")
        XCTAssertFalse(shown.contains(line),
                       "the capsule's word must not be reprinted inside the card")
        // Measured through the REAL TextKit stack at the card's real width: the
        // text handed to `Text(...).lineLimit(maxLines)` already fits, so the
        // render has no truncation decision left to make.
        XCTAssertLessThanOrEqual(measuredWrappedLines(shown),
                                 TimelineMetrics.liveThinkingMaxLines)
        // It sits ABOVE the shimmering activity row, because reasoning precedes
        // the answer in a turn.
        let kinds = built.map(\.content.reuseKind)
        XCTAssertLessThan(try XCTUnwrap(kinds.firstIndex(of: "thinking")),
                          try XCTUnwrap(kinds.firstIndex(of: "activity")))
    }

    /// The row ADVANCES: the t+18s / t+26s screenshots that showed one frozen
    /// block of the oldest reasoning, as an assertion.
    func testLiveReasoningRowAdvancesAsReasoningArrives() async throws {
        func card(_ steps: Int) async throws -> String {
            let text = (1...steps)
                .map { "Step \($0): checking hypothesis number \($0) against the evidence. " }
                .joined()
            let built = await rows([], liveThinking: text, streaming: true)
            let row = try XCTUnwrap(thinkingRow(built))
            guard case .thinking(_, let body, _, _, _) = row.content else {
                XCTFail("expected the .thinking case")
                return ""
            }
            return try XCTUnwrap(body)
        }
        let early = try await card(6)
        let late = try await card(24)
        XCTAssertNotEqual(early, late, "the live window is frozen at the oldest reasoning")
        XCTAssertTrue(late.contains("Step 24"))
        XCTAssertFalse(late.contains("Step 6:"),
                       "18 sentences later, step 6 is no longer inside an 8-line window")
    }

    /// The height the row reserves describes the text it renders. A row measured
    /// for 8 lines while the cell truncates at some other count is how the card
    /// ends up with a band of nothing under it (or its last line shaved).
    func testLiveReasoningRowHeightMatchesTheTextItShows() async throws {
        let reasoning = (1...30)
            .map { "Step \($0): a sentence long enough to wrap on a phone screen. " }
            .joined()
        let built = await rows([], liveThinking: reasoning, streaming: true)
        let row = try XCTUnwrap(thinkingRow(built))
        guard case .thinking(_, let body, _, _, _) = row.content else {
            return XCTFail("expected the .thinking case")
        }
        let lines = measuredWrappedLines(try XCTUnwrap(body))
        let expected = capsuleHeight
            + TimelineMetrics.hostedTextHeight(lines: lines,
                                               font: TimelineTextStyler.captionFont)
            + TimelineMetrics.expandCardPadding * 2 + TimelineMetrics.expandCardGap
        XCTAssertEqual(row.height, expected, accuracy: 0.5)
    }

    /// The handoff: the row OUTLIVES `streaming` so the reasoning does not blink
    /// out for the length of the turn-end refetch (and does not stay blank if
    /// that refetch fails). The store clears `liveThinking` when canonical rows
    /// land, and only then does the row go.
    func testLiveReasoningSurvivesTurnEndUntilTheStoreClearsIt() async {
        let settled = await rows([], liveThinking: "the last thing it considered",
                                 streaming: false)
        XCTAssertEqual(settled.map(\.content.reuseKind), ["thinking"],
                       "a finished turn keeps its reasoning row and nothing else")
        let cleared = await rows([], liveThinking: "", streaming: false)
        XCTAssertTrue(cleared.isEmpty, "clearing the accumulation must remove the row")
    }

    // MARK: - The memo has to notice a POSITIONAL id whose payload changed

    /// `/api/v1` numbers a conversation's messages positionally, and `ChatStore`
    /// keeps those ids verbatim — so a tool row at "m7" that gains its result
    /// across the mid-turn refetch comes back under the SAME id with different
    /// content. Keyed on the id alone, the layout actor's per-message memo kept
    /// serving the row it built before the result existed: the expanded card read
    /// "Running…" at a stale height for the life of the view, and collapsing and
    /// re-expanding (which changes the key) was the only way out.
    func testMemoRebuildsAPositionalRowWhenItsPayloadChanges() async throws {
        let actor = TimelineLayoutActor()
        let expanded: Set<String> = ["m7#0"]
        let running = tool("m7", name: "Bash", detail: "npm test", input: "npm test")
        let finished = tool("m7", name: "Bash", detail: "npm test", input: "npm test",
                            result: "3 passed\n0 failed")
        let before = await actor.buildSnapshot(input([running], expanded: expanded)).rows
        let after = await actor.buildSnapshot(input([finished], expanded: expanded)).rows
        let beforeRow = try XCTUnwrap(toolRow(before))
        let afterRow = try XCTUnwrap(toolRow(after))
        guard case .toolChip(_, _, _, let staleResult, _, _) = beforeRow.content,
              case .toolChip(_, _, _, let freshResult, _, _) = afterRow.content else {
            return XCTFail("expected two .toolChip rows")
        }
        XCTAssertNil(staleResult)
        XCTAssertEqual(freshResult, "3 passed\n0 failed",
                       "the memo served the row built before the result existed")
        XCTAssertGreaterThan(afterRow.height, beforeRow.height,
                             "the stale row also keeps the height it was measured at")
    }

    /// Same shape for a reasoning row whose excerpt arrives with a later read.
    func testMemoRebuildsAThinkingRowWhenItsExcerptArrives() async throws {
        let actor = TimelineLayoutActor()
        let bare = thinking("m3", line: "Weighing the two candidates", excerpt: nil)
        let full = thinking("m3", line: "Weighing the two candidates",
                            excerpt: String(repeating: "the kubelet log first. ", count: 12))
        _ = await actor.buildSnapshot(input([bare])).rows
        let after = await actor.buildSnapshot(input([full], expanded: ["m3#0"])).rows
        guard case .thinking(_, let body, let collapsible, _, _)
                = try XCTUnwrap(thinkingRow(after)).content else {
            return XCTFail("expected the .thinking case")
        }
        XCTAssertTrue(collapsible)
        XCTAssertTrue(try XCTUnwrap(body).contains("kubelet log first"))
    }

    // MARK: - A live text-size change invalidates every measured height

    /// Fonts used to be frozen at first access, so a fresh launch at XXXL was
    /// correct and a LIVE change was not: the hosted cells adopted the new size at
    /// once while every height in the memo still described the old one (rows
    /// overlapping, labels sliced). The category is an input now, and it
    /// invalidates on exactly the line `width` does.
    func testTextSizeChangeRebuildsRowsAtTheNewHeight() async throws {
        let actor = TimelineLayoutActor()
        let message = ChatMessage(id: "m0", role: "assistant",
                                  text: "A reply long enough to wrap more than once on a phone "
                                      + "screen, which is what makes its height move with the "
                                      + "reader's text size.",
                                  createdAt: "2026-09-08T04:00:00Z", kind: nil)
        var small = input([message])
        small.sizeCategory = .large
        var large = input([message])
        large.sizeCategory = .accessibilityExtraExtraExtraLarge
        let atLarge = await actor.buildSnapshot(small).rows
        let atXXXL = await actor.buildSnapshot(large).rows
        let before = try XCTUnwrap(atLarge.first?.height)
        let after = try XCTUnwrap(atXXXL.first?.height)
        XCTAssertGreaterThan(after, before * 1.5,
            "the memo replayed the old heights at the new text size (\(before) → \(after))")
    }
}
