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
                       liveThinking: String = "", streaming: Bool = false,
                       activity: String? = nil,
                       liveTools: [LiveToolCall] = []) -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: "",
                      liveTextTruncated: false, liveThinking: liveThinking,
                      liveTools: liveTools,
                      activity: activity, showLoadEarlier: false, width: pageWidth,
                      expandedRowIDs: expanded, scope: scope)
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      scope: String = TimelineScope.unscoped,
                      liveThinking: String = "", streaming: Bool = false,
                      activity: String? = nil,
                      liveTools: [LiveToolCall] = []) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(
            input(messages, expanded: expanded, scope: scope,
                  liveThinking: liveThinking, streaming: streaming, activity: activity,
                  liveTools: liveTools)
        ).rows
    }

    /// The `.thinking` payload of a row, or a failure. Every thinking assertion
    /// goes through here so the case's shape is destructured in ONE place.
    private func thinkingPayload(
        _ row: TimelineRow?, _ file: StaticString = #filePath, _ line: UInt = #line
    ) throws -> (line: String?, preview: String?, fullText: String, maxLines: Int) {
        guard case .thinking(let line, let preview, let fullText, let maxLines, _, _)
                = try XCTUnwrap(row, "no thinking row", file: file, line: line).content else {
            XCTFail("expected the .thinking case", file: file, line: line)
            throw XCTSkip("not a thinking row")
        }
        return (line, preview, fullText, maxLines)
    }

    private func toolPayload(
        _ row: TimelineRow?, _ file: StaticString = #filePath, _ line: UInt = #line
    ) throws -> (name: String, detail: String?, input: String?,
                 result: String?, agent: String?, running: Bool, stacked: Bool) {
        guard case .toolChip(let name, let detail, let input, let result, let agent,
                             let running, _, let stacked)
                = try XCTUnwrap(row, "no tool row", file: file, line: line).content else {
            XCTFail("expected the .toolChip case", file: file, line: line)
            throw XCTSkip("not a tool row")
        }
        return (name, detail, input, result, agent, running, stacked)
    }

    /// A reasoning message as the wire delivers one: a short collapsed line plus
    /// the fuller excerpt behind it.
    private func thinking(_ id: String, line: String, excerpt: String?) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: line,
                    createdAt: "2026-09-08T04:00:00Z", kind: .thinking,
                    thinkingText: excerpt)
    }

    /// One live tool call as the stream delivers it.
    private func call(_ id: String, _ name: String, _ detail: String? = nil,
                      finished: Bool = false) -> LiveToolCall {
        LiveToolCall(id: id, name: name, detail: detail, finished: finished)
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

    // MARK: - 1. A thinking message builds ONE capsule carrying the full text

    func testThinkingMessageYieldsTheThinkingRowNotAPlainChip() async throws {
        let excerpt = "checking the pgid files before adopting them, "
            + "because a daemon restart must skip any sid the "
            + "reconcile pass already took over"
        let built = await rows([thinking("m0", line: "checking the pgid files",
                                        excerpt: excerpt)])
        XCTAssertEqual(built.map(\.content.reuseKind), ["thinking"],
                       "a kind:\"thinking\" message must build the reasoning row")
        let payload = try thinkingPayload(built.first)
        XCTAssertNil(payload.preview, "a history row shows no inline excerpt")
        XCTAssertEqual(payload.fullText, excerpt,
                       "the whole excerpt must reach the row, for the drawer")
    }

    /// The row is ONE capsule with ONE height, whatever the controller thinks is
    /// expanded. It used to carry a second, pre-measured expanded height and grow
    /// in place, which is what forced a line cap on the reasoning.
    ///
    /// RED PROOF: restoring the `expandedRowIDs.contains(id)` branch in
    /// `thinkingRow` fails the equal-heights assertion.
    func testThinkingRowIsOneCapsuleWhateverIsExpanded() async throws {
        let message = thinking("m0", line: "weighing two fixes",
                               excerpt: String(repeating: "weighing two fixes for the stale "
                                               + "lock, and the second one is cheaper. ", count: 6))
        let closedRows = await rows([message])
        let tappedRows = await rows([message], expanded: ["m0#0"])
        let closed = try XCTUnwrap(thinkingRow(closedRows))
        let tapped = try XCTUnwrap(thinkingRow(tappedRows))
        XCTAssertEqual(closed.height, capsuleHeight, accuracy: 0.5,
                       "the row must stay exactly the capsule it always was")
        XCTAssertEqual(tapped.height, closed.height, accuracy: 0.5,
                       "the tap opens a drawer; it must not move the row's height")
    }

    /// The complaint this whole change answers: "why doesn't the reasoning show in
    /// full?". An unbounded excerpt must reach the row UNCUT, because the drawer
    /// scrolls — the inline card it replaces stopped at 48 wrapped lines and the
    /// tail was unreachable from the phone.
    ///
    /// RED PROOF: re-introducing a `String(fullText.prefix(n))` or a line cap in
    /// `thinkingRow` fails the round-trip assertion.
    func testThinkingRowCarriesTheWholeExcerptUncapped() async throws {
        let huge = (0..<200).map { "reasoning line \($0) with enough words to fill the width" }
            .joined(separator: "\n")
        let built = await rows([thinking("m0", line: "long chain", excerpt: huge)])
        let row = try XCTUnwrap(thinkingRow(built))
        let payload = try thinkingPayload(row)
        XCTAssertEqual(payload.fullText, huge, "the drawer's text must not be truncated")
        XCTAssertEqual(row.height, capsuleHeight, accuracy: 0.5,
                       "and an unbounded excerpt must still produce a one-line row")
    }

    /// A COLUMN of reasoning rows has to be scannable.
    ///
    /// This replaces `testThinkingVocabularyIsOneWordOnEverySurface`, which was a
    /// tautology: it asserted three constants against their own literals and would
    /// have stayed green through the very regression it named. What it failed to
    /// catch shipped — the row dropped the server's line for the fixed word alone,
    /// so five stacked reasoning rows read `Thinking ›` five times and the only way
    /// to find one was to open all five drawers.
    ///
    /// The assertion is DISTINGUISHABILITY, which is the property the reader needs
    /// and the one a constant can never provide.
    ///
    /// RED PROOF: dropping `line:` from `thinkingRow` (passing nil) fails on the
    /// first row; making the line a constant fails the uniqueness assertion.
    func testEveryReasoningRowIsDistinguishableByItsOwnLine() async throws {
        let lines = [
            "checking the pgid files before adopting them",
            "weighing two fixes for the stale lock",
            "re-reading the transcript to find the active leaf",
            "the excerpt cap is what clipped this at 2000",
            "deciding whether the reaper owns this directory",
        ]
        let built = await rows(lines.enumerated().map { index, line in
            thinking("m\(index)", line: line, excerpt: "\(line) — and the rest of it")
        })
        let rendered = try built.map { try thinkingPayload($0).line }
        XCTAssertEqual(rendered, lines,
                       "each row must print the line the server sent for it")
        XCTAssertEqual(Set(rendered.compactMap { $0 }).count, lines.count,
                       "five rows that print the same thing are five drawers to open")
    }

    /// …and what the row prints is what VoiceOver says, on BOTH surfaces, with one
    /// word for reasoning.
    ///
    /// The chips are ONE accessibility element each now (they were three, so
    /// VoiceOver read SF Symbol names: "wrench.and.screwdriver", "Sparkle",
    /// "Forward"), and the label is composed from the values the row draws — so
    /// this covers the vocabulary and the spoken text in one place.
    ///
    /// RED PROOF: giving the live row its own word makes the two leading words
    /// differ; dropping the history row's line makes its label lose the line.
    func testChipLabelsSpeakOneReasoningWordAndTheRowsOwnLine() async throws {
        let history = try thinkingPayload(
            thinkingRow(await rows([thinking("m0", line: "a line the server sent",
                                             excerpt: "the fuller excerpt")])))
        let live = try thinkingPayload(
            thinkingRow(await rows([], liveThinking: "live reasoning", streaming: true)))
        XCTAssertEqual(history.fullText, "the fuller excerpt")
        XCTAssertEqual(live.fullText, "live reasoning")

        let historyLabel = TimelineChipAccessibility.thinking(line: history.line)
        let liveLabel = TimelineChipAccessibility.thinking(line: live.line)
        XCTAssertTrue(historyLabel.contains("a line the server sent"),
                      "the spoken row must carry its own line: \(historyLabel)")
        let word = { (label: String) in label.split(separator: ",").first.map(String.init) }
        XCTAssertEqual(word(historyLabel), word(liveLabel),
                       "one word for reasoning on both surfaces, not two")
        XCTAssertEqual(word(liveLabel), TimelineActivityVocabulary.thinking)
        XCTAssertEqual(TimelineActivityDetail.thinking(id: "r", text: "x").title,
                       TimelineActivityVocabulary.thinking,
                       "and the drawer must be titled with that same word")
        XCTAssertEqual(TimelineLiveThinkingWindow.capsuleLabel,
                       TimelineActivityVocabulary.thinking)

        // A tool chip's label is the same rule: what it draws, in reading order,
        // never a symbol name.
        let toolLabel = TimelineChipAccessibility.tool(
            name: "Bash", detail: "npm run test:quick", agent: "reviewer", running: true)
        XCTAssertEqual(toolLabel, "Bash, delegated to reviewer, npm run test:quick, running")
        XCTAssertFalse(
            TimelineChipAccessibility.tool(name: "Bash", detail: nil, agent: nil,
                                           running: false).contains("running"),
            "a call that has returned says nothing about state")
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

        func reasoning(line: String? = "the collapsed line", preview: String? = "a fuller take",
                       fullText: String = "a fuller take", maxLines: Int = 8,
                       detailRef: String? = nil, stacked: Bool = false) -> TimelineRowContent {
            .thinking(line: line, preview: preview, fullText: fullText,
                      maxLines: maxLines, detailRef: detailRef, stacked: stacked)
        }
        let a = reasoning()
        XCTAssertEqual(a.contentKey, reasoning().contentKey,
                       "equal content must hash equal, or every diff reloads everything")
        // Each associated value is drawn or bounds what is drawn, so each must
        // split the key. `fullText` counts: it is what the drawer renders, and a
        // row whose preview is unchanged while the accumulation grew is a row
        // whose drawer would otherwise open onto stale reasoning. `line` counts for
        // the plainest reason of all — it is the row's visible text.
        XCTAssertNotEqual(a.contentKey, reasoning(line: "a DIFFERENT line").contentKey)
        XCTAssertNotEqual(a.contentKey, reasoning(line: nil).contentKey)
        XCTAssertNotEqual(a.contentKey, reasoning(preview: "a DIFFERENT take").contentKey)
        XCTAssertNotEqual(a.contentKey, reasoning(fullText: "a MUCH fuller take").contentKey)
        XCTAssertNotEqual(a.contentKey, reasoning(maxLines: 24).contentKey)
        XCTAssertNotEqual(a.contentKey, reasoning(detailRef: "ref-1").contentKey)
        // `stacked` counts because it changes the SHAPE the cell draws and the height
        // the row reserved for it: a stacked row reloaded as flat is ink shaved off by
        // the cell's clip.
        XCTAssertNotEqual(a.contentKey, reasoning(stacked: true).contentKey)
        // …and the reuse bucket separates it from the plain capsule that used to
        // render these rows, whose text is identical.
        let chip = TimelineRowContent.chip(icon: "sparkles", text: "same words here")
        XCTAssertNotEqual(a.contentKey, chip.contentKey)
        XCTAssertEqual(a.reuseKind, "thinking")
    }

    // MARK: - 4. A tool row is one capsule whose drawer carries input + result

    /// The row keeps ONE height and hands its whole payload to the drawer. The
    /// inline card it replaces capped the Input at 200pt and the Result at 320pt,
    /// so "what did it run?" was answered with a clipped window.
    ///
    /// RED PROOF: restoring the `expandedRowIDs.contains(id)` branch in
    /// `toolChipRow` fails the equal-heights assertion.
    func testToolRowIsOneCapsuleCarryingItsInputAndResult() async throws {
        let message = tool("m0", name: "Bash", detail: "npm run test:quick",
                           input: "npm run test:quick --silent",
                           result: "306 files, 51s")
        let closedRows = await rows([message])
        let tappedRows = await rows([message], expanded: ["m0#0"])
        let closed = try XCTUnwrap(toolRow(closedRows))
        let tapped = try XCTUnwrap(toolRow(tappedRows))
        XCTAssertEqual(tapped.height, closed.height, accuracy: 0.5,
                       "the tap opens a drawer; it must not move the row's height")
        let payload = try toolPayload(closed)
        XCTAssertEqual(payload.name, "Bash")
        XCTAssertEqual(payload.detail, "npm run test:quick")
        XCTAssertEqual(payload.input, "npm run test:quick --silent")
        XCTAssertEqual(payload.result, "306 files, 51s")
    }

    /// The drawer payload the cell hands the sheet: both sections, and the
    /// running/finished distinction the Result note depends on.
    func testToolDrawerPayloadKeepsBothSectionsAndRunningState() {
        let running = TimelineActivityDetail.tool(
            id: "m0#0", name: "Bash", detail: "npm test", input: "npm test",
            result: nil, agent: nil, running: true)
        XCTAssertEqual(running.title, "Bash")
        XCTAssertEqual(running.input, "npm test")
        XCTAssertNil(running.body)
        XCTAssertEqual(TimelineExpandSection.resultNote(hasInput: running.running), "Running…")

        let finished = TimelineActivityDetail.tool(
            id: "m0#0", name: "Bash", detail: "npm test", input: "npm test",
            result: "3 passed", agent: "reviewer", running: false)
        XCTAssertEqual(finished.body, "3 passed")
        XCTAssertEqual(finished.agent, "reviewer")
        // A tool that produced nothing has to SAY so — "No output", never a blank
        // sheet, which is the "tapping does nothing" report in another costume.
        XCTAssertEqual(TimelineExpandSection.resultNote(hasInput: false), "No output")
    }

    // MARK: - 5. The tool used mid-turn is a REAL tool row

    /// The complaint: "it shows what tool it used, and then after it's done it
    /// doesn't show any more", plus "Bash in the main chat isn't right either".
    ///
    /// Root cause: the live stream's `tool` event was folded into ONE label string
    /// and rendered as the shimmering `.activity` row — no input, no result, no
    /// tap, and a different shape from the `.toolChip` the same call becomes in a
    /// transcript. This pins the live tool to the SAME row case.
    ///
    /// RED PROOF: dropping the `liveToolRows` call from `liveRows` leaves no
    /// "toolChip" in the built kinds.
    func testRunningToolBuildsARealToolRowNotJustAShimmer() async throws {
        let built = await rows([], streaming: true, activity: "Bash · npm run test:quick",
                               liveTools: [call("t1", "Bash", "npm run test:quick")])
        XCTAssertTrue(built.map(\.content.reuseKind).contains("toolChip"),
                      "the running tool must build a tool row: \(built.map(\.content.reuseKind))")
        let payload = try toolPayload(toolRow(built))
        XCTAssertEqual(payload.name, "Bash")
        XCTAssertEqual(payload.detail, "npm run test:quick")
        XCTAssertEqual(payload.input, "npm run test:quick",
                       "`detail` is all the input the live wire carries, so it IS the input")
        XCTAssertNil(payload.result, "a running tool has no result yet")
        XCTAssertTrue(payload.running, "and the chip has to be able to say it is running")
    }

    /// THE 2026-09-12 GATE'S FIRST FINDING: sampled once a second on a real turn,
    /// the tool chip appeared and then VANISHED the moment `tool-result` landed,
    /// coming back only when the whole turn ended and the transcript replaced it.
    ///
    /// A completed call stays on screen continuously, from `tool` to history — it
    /// only stops claiming to be running.
    ///
    /// RED PROOF: filtering `liveToolRows` to unfinished calls (what clearing the
    /// single live-tool slot on its result amounted to) leaves no tool row here.
    func testAFinishedToolKeepsItsRowUntilTheTranscriptTakesOver() async throws {
        let finished = await rows([], streaming: true,
                                  liveTools: [call("t1", "Bash", "npm test", finished: true)])
        let row = try XCTUnwrap(toolRow(finished),
                                "a returned call must NOT vanish mid-turn: "
                                    + "\(finished.map(\.content.reuseKind))")
        let payload = try toolPayload(row)
        XCTAssertEqual(payload.name, "Bash")
        XCTAssertFalse(payload.running, "it has returned, so nothing may claim it is running")

        // Every call the turn made, in call order, running and finished together.
        let many = await rows([], streaming: true, liveTools: [
            call("t1", "Read", "src/agent/tools.ts", finished: true),
            call("t2", "Bash", "npm test", finished: true),
            call("t3", "WebFetch", "https://example.com/x"),
        ])
        let chips = try many.filter { $0.content.reuseKind == "toolChip" }
            .map { try toolPayload($0) }
        XCTAssertEqual(chips.map(\.name), ["Read", "Bash", "WebFetch"])
        XCTAssertEqual(chips.map(\.running), [false, false, true])
        // Distinct row ids, or the diff collapses three chips into one.
        let chipIDs = many.filter { $0.content.reuseKind == "toolChip" }.map(\.id)
        XCTAssertEqual(Set(chipIDs).count, 3, "each call needs its own row identity")
    }

    /// THE GATE'S SECOND FINDING, the other half of the same screen: while the tool
    /// chip was gone, the status line still said "Thinking…" WITH a `Thinking` row
    /// beside it — two Thinkings at once.
    ///
    /// The shimmer is the FALLBACK pulse: it appears only when nothing already on
    /// screen says what the agent is doing.
    ///
    /// RED PROOF: emitting the activity row unconditionally (what shipped) puts a
    /// second row back in both of the first two cases.
    func testTheShimmerNeverDuplicatesARowAlreadyOnScreen() async throws {
        func activityLabel(_ rows: [TimelineRow]) -> (present: Bool, label: String?) {
            guard let row = rows.first(where: { $0.content.reuseKind == "activity" }),
                  case .activity(let label) = row.content else { return (false, nil) }
            return (true, label)
        }

        // 1. A running tool chip names the call — `activity` is that same pair
        //    folded, so the line would be a second copy of a row that opens.
        let withTool = await rows([], streaming: true, activity: "Bash · npm test",
                                  liveTools: [call("t1", "Bash", "npm test")])
        XCTAssertFalse(activityLabel(withTool).present,
                       "the tool row already names the call, and it breathes")

        // 2. A live Thinking capsule already says the only word a label-less
        //    shimmer can say.
        let withReasoning = await rows([], liveThinking: "weighing two fixes", streaming: true)
        XCTAssertTrue(withReasoning.contains { $0.content.reuseKind == "thinking" })
        XCTAssertFalse(activityLabel(withReasoning).present,
                       "\"Thinking…\" under a Thinking row is the same word twice")

        // 3. Nothing else live yet: the shimmer IS the only thing that can say a
        //    turn is running, so it stays.
        let bare = await rows([], streaming: true)
        XCTAssertTrue(activityLabel(bare).present)
        XCTAssertNil(activityLabel(bare).label, "…as the plain \"Thinking…\" pulse")

        // 4. A status no row duplicates survives even beside reasoning — this one
        //    is not about the agent's current step at all.
        let starting = await rows([], liveThinking: "weighing two fixes", streaming: true,
                                  activity: "Starting session…")
        XCTAssertEqual(activityLabel(starting).label, "Starting session…")
    }

    /// A turn with no tool calls builds no tool rows.
    func testTheLiveToolRowGoesWhenNoToolIsRunning() async {
        let built = await rows([], streaming: true, liveTools: [])
        XCTAssertFalse(built.map(\.content.reuseKind).contains("toolChip"))
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

        // Reasoning: one capsule, and the collapsed line the old server DID send
        // becomes the drawer's text — on that server it is everything there is,
        // so the tap is still honest rather than opening onto nothing.
        let closedRows = await rows([decoded[0]])
        let closed = try XCTUnwrap(thinkingRow(closedRows))
        let payload = try thinkingPayload(closed)
        XCTAssertNil(payload.preview, "a history row shows no inline excerpt")
        XCTAssertEqual(payload.fullText, "short thought",
                       "with no excerpt, `text` is what the drawer must show")
        XCTAssertEqual(closed.height, capsuleHeight, accuracy: 0.5)

        // Tool: the result still reaches the row, and the missing input is simply
        // absent rather than an empty section.
        let toolRows = await rows([decoded[1]])
        let toolRowBuilt = try XCTUnwrap(toolRow(toolRows))
        let toolFields = try toolPayload(toolRowBuilt)
        XCTAssertEqual(toolFields.name, "Bash")
        XCTAssertEqual(toolFields.detail, "ls docs/")
        XCTAssertNil(toolFields.input)
        XCTAssertEqual(toolFields.result, "README.md\nreference/")
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
        let payload = try thinkingPayload(row)
        XCTAssertEqual(payload.maxLines, TimelineMetrics.liveThinkingMaxLines)
        let shown = try XCTUnwrap(payload.preview, "the live turn must preview its reasoning")
        XCTAssertTrue(shown.hasSuffix("Step 24: checking hypothesis number 24 against the evidence."),
                      "the card must END on the newest sentence: …\(shown.suffix(70))")
        XCTAssertFalse(shown.contains("Step 1:"),
                       "the OLDEST reasoning must have scrolled off: \(shown.prefix(70))…")
        XCTAssertFalse(shown.contains(TimelineActivityVocabulary.thinking),
                       "the capsule's word must not be reprinted inside the card")
        // …and the WINDOW is a preview only. The drawer gets everything, which is
        // the "why doesn't the reasoning show in full?" half of the report: the
        // reader used to see a middle slice marked "… " with no way to either end.
        XCTAssertTrue(payload.fullText.contains("Step 1:"),
                      "the drawer's text must still hold the reasoning the window dropped")
        XCTAssertTrue(payload.fullText.hasSuffix("against the evidence."))
        XCTAssertGreaterThan(payload.fullText.count, shown.count,
                             "a preview equal to the accumulation means the window is not bounded")
        // Measured through the REAL TextKit stack at the card's real width: the
        // text handed to `Text(...).lineLimit(maxLines)` already fits, so the
        // render has no truncation decision left to make.
        XCTAssertLessThanOrEqual(measuredWrappedLines(shown),
                                 TimelineMetrics.liveThinkingMaxLines)
        // It sits ABOVE the status row, because reasoning precedes the answer in a
        // turn. Asserted on a turn carrying a status NO row duplicates ("Starting
        // session…"): beside a bare shimmer there is no activity row left to order
        // against, since a `Thinking` row and a "Thinking…" shimmer are the same
        // word twice — see `testTheShimmerNeverDuplicatesARowAlreadyOnScreen`.
        let kinds = built.map(\.content.reuseKind)
        XCTAssertFalse(kinds.contains("activity"),
                       "a live reasoning row is itself the proof a turn is running")
        let withStatus = await rows([], liveThinking: reasoning, streaming: true,
                                    activity: "Starting session…").map(\.content.reuseKind)
        XCTAssertLessThan(try XCTUnwrap(withStatus.firstIndex(of: "thinking")),
                          try XCTUnwrap(withStatus.firstIndex(of: "activity")))
    }

    /// The row ADVANCES: the t+18s / t+26s screenshots that showed one frozen
    /// block of the oldest reasoning, as an assertion.
    func testLiveReasoningRowAdvancesAsReasoningArrives() async throws {
        func card(_ steps: Int) async throws -> String {
            let text = (1...steps)
                .map { "Step \($0): checking hypothesis number \($0) against the evidence. " }
                .joined()
            let built = await rows([], liveThinking: text, streaming: true)
            return try XCTUnwrap(thinkingPayload(thinkingRow(built)).preview)
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
        let lines = measuredWrappedLines(try XCTUnwrap(thinkingPayload(row).preview))
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
        XCTAssertNil(try toolPayload(beforeRow).result)
        XCTAssertEqual(try toolPayload(afterRow).result, "3 passed\n0 failed",
                       "the memo served the row built before the result existed")
        // The row's HEIGHT no longer moves with its payload (one capsule, always),
        // so `contentKey` is the only thing left that can tell the diff this row
        // changed — which is exactly why the result rides it.
        XCTAssertEqual(afterRow.height, beforeRow.height, accuracy: 0.5)
        XCTAssertNotEqual(afterRow.contentKey, beforeRow.contentKey,
                          "a row whose result arrived must not diff clean")
    }

    /// Same shape for a reasoning row whose excerpt arrives with a later read.
    func testMemoRebuildsAThinkingRowWhenItsExcerptArrives() async throws {
        let actor = TimelineLayoutActor()
        let bare = thinking("m3", line: "Weighing the two candidates", excerpt: nil)
        let full = thinking("m3", line: "Weighing the two candidates",
                            excerpt: String(repeating: "the kubelet log first. ", count: 12))
        let before = await actor.buildSnapshot(input([bare])).rows
        let after = await actor.buildSnapshot(input([full])).rows
        let beforeRow = try XCTUnwrap(thinkingRow(before))
        let afterRow = try XCTUnwrap(thinkingRow(after))
        XCTAssertEqual(try thinkingPayload(beforeRow).fullText, "Weighing the two candidates",
                       "with no excerpt the collapsed line is all the drawer has")
        XCTAssertTrue(try thinkingPayload(afterRow).fullText.contains("kubelet log first"),
                      "the memo served the row built before the excerpt existed")
        XCTAssertNotEqual(afterRow.contentKey, beforeRow.contentKey)
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
