import XCTest
@testable import Walnut

/// Invariants of the phone's rich-HTML segmenter (the port of the web console's
/// `rich-blocks.ts` splitter). Each of these pins a way the feature can go wrong
/// in the reader's hands: a reply showing literal `<div>` tags, a tag rendered in
/// half, text silently dropped or duplicated, or a card reloading under the finger
/// of someone who is mid-tap on it.
final class RichHTMLSegmentsTests: XCTestCase {

    // MARK: - Helpers

    private func kinds(_ text: String, streaming: Bool = false) -> [String] {
        RichHTMLSegments.segments(text, streaming: streaming).map { segment in
            switch segment {
            case .markdown: return "md"
            case .html: return "html"
            case .island(_, _, let complete): return complete ? "island" : "island-partial"
            }
        }
    }

    private func htmlPayloads(_ text: String, streaming: Bool = false) -> [String] {
        RichHTMLSegments.segments(text, streaming: streaming).compactMap { segment in
            if case .html(let html, _) = segment { return html }
            return nil
        }
    }

    private func islands(_ text: String, streaming: Bool = false) -> [(html: String, complete: Bool)] {
        RichHTMLSegments.segments(text, streaming: streaming).compactMap { segment in
            if case .island(let html, _, let complete) = segment { return (html, complete) }
            return nil
        }
    }

    /// A message with no raw HTML must be routed to the native markdown path, and
    /// a message with raw HTML must not be.
    private func hasNonMarkdownSegment(_ text: String) -> Bool {
        RichHTMLSegments.segments(text, streaming: false).contains { segment in
            if case .markdown = segment { return false }
            return true
        }
    }

    // MARK: - isRich

    func testIsRichIsFalseForOrdinaryProse() {
        // Each of these is prose that only LOOKS like markup. Routing any of them
        // into a web view would take a normal answer off the native render path.
        let notRich = [
            "",
            "Just an ordinary answer with no angle brackets at all.",
            "The signature is Array<T> and the other one is Vec<u8>.",
            "See <https://example.com/docs> for the details.",
            "Mail it to <user@host> and wait.",
            #"Created: <task-ref id="mt5zagj8-3621" label="Watch the release"/> in the Inbox."#,
            #"Opened <session-ref id="abc-123"/> for that."#,
            "Arithmetic reads fine too: 5 < 3 is false and 4 > 2 is true.",
        ]
        for text in notRich {
            XCTAssertFalse(RichHTMLSegments.isRich(text), "must not be rich: \(text.debugDescription)")
        }
    }

    func testIsRichIsTrueForRealMarkup() {
        let rich = [
            "<div>a card</div>",
            "<details><summary>more</summary>the long version</details>",
            #"<style>.k { color: var(--accent) }</style>"#,
            // A tag still arriving counts: classification has to be right from the
            // first delta, not only once the `>` lands.
            #"A diagram: <svg viewBox="0 0 40 10""#,
            "```html-app\n<b>hi</b>\n```",
        ]
        for text in rich {
            XCTAssertTrue(RichHTMLSegments.isRich(text), "must be rich: \(text.debugDescription)")
        }
    }

    /// A tag inside a fence is a SAMPLE. The web version deliberately does not skip
    /// code regions here; the phone must, because a code block rendering as native
    /// monospace is the CORRECT outcome and routing the whole message into a web
    /// view to show it would be a regression.
    func testIsRichIgnoresTagsInsideCodeRegions() {
        let fenced = """
        Here is the markup you asked about:

        ```html
        <div class="card">sample</div>
        ```

        Copy it as-is.
        """
        XCTAssertFalse(RichHTMLSegments.isRich(fenced))
        XCTAssertEqual(kinds(fenced), ["md"])
        XCTAssertFalse(RichHTMLSegments.isRich("Inline `<div>` is a sample too."))
    }

    /// The words "html-app" in prose are not an island. The fence probe is the LAST
    /// resort — consulted only once the tag scan has found nothing — and it has to be
    /// backed by the real classification, or a reply that merely mentions the fence
    /// name mounts a web view for nothing.
    ///
    /// The same probe is also lazy and `.literal` for COST, not correctness: eager,
    /// and through the folding form of a case-insensitive search, `isRich` measured
    /// 3.9ms per call on 10KB of plain prose with no `<` in it at all (0.07ms after),
    /// and it is paid by every assistant message on every cache miss plus ~8x a
    /// second by the live tail. Keep both properties; the numbers are the reason.
    func testTheWordsHTMLAppInProseAreNotRich() {
        XCTAssertFalse(RichHTMLSegments.isRich("I put it behind an html-app fence earlier."))
        XCTAssertFalse(RichHTMLSegments.isRich("Use HTML-APP for anything that needs JS."))
        XCTAssertEqual(kinds("Use an html-app fence for that."), ["md"])
        // A real fence still is, in either case.
        XCTAssertTrue(RichHTMLSegments.isRich("```HTML-APP\nplain body\n```"))
    }

    /// `isRich` and `segments` must never disagree: a message routed rich that then
    /// produces zero non-markdown segments mounts a web view for nothing, and the
    /// reverse shows literal tags.
    func testIsRichAgreesWithSegmentClassification() {
        let table = [
            "",
            "plain prose",
            "Array<T> in prose",
            "<div>x</div>",
            "<script>let n = 1</script>",
            "```html-app\n<b>x</b>\n```",
            "```html\n<b>x</b>\n```",
            // An `html-app` opener that does NOT start its own block: the fence is
            // glued to the prose above it, so it is markdown, not an island.
            "prose\n```html-app\n<b>x</b>\n```",
            // Fence plus trailing prose in one chunk: the island would swallow the
            // prose, so the whole chunk stays markdown.
            "```html-app\n<b>x</b>\n```\ntrailing prose",
            "Intro.\n\n```html-app\n<b>x</b>\n```\n\nOutro.",
        ]
        for text in table {
            XCTAssertEqual(
                RichHTMLSegments.isRich(text), hasNonMarkdownSegment(text),
                "isRich disagrees with segments for \(text.debugDescription)"
            )
        }
    }

    // MARK: - Classification

    func testMarkdownHTMLAndIslandClassification() {
        let message = """
        Intro prose.

        <div class="card">Card body</div>

        More prose.
        """
        XCTAssertEqual(kinds(message), ["md", "html", "md"])

        // A `<script>` can only render faithfully in a sandboxed island, so the
        // chunk carrying one is an island even without a fence.
        XCTAssertEqual(kinds("<div>x</div>\n<script>let a = 1</script>"), ["island"])
        XCTAssertEqual(kinds("Intro.\n\n```html-app\n<b>x</b>\n```\n\nOutro."), ["md", "island", "md"])
    }

    func testConsecutiveSameKindChunksCoalesce() {
        // Two sibling top-level elements must not become two documents with a gap
        // between them.
        let siblings = "<div>one</div>\n\n<div>two</div>"
        XCTAssertEqual(kinds(siblings), ["html"])
        XCTAssertEqual(htmlPayloads(siblings), [siblings])

        // Same for prose paragraphs: one markdown segment, not two.
        XCTAssertEqual(kinds("First paragraph.\n\nSecond paragraph."), ["md"])
        XCTAssertEqual(
            RichHTMLSegments.sourceTexts("First paragraph.\n\nSecond paragraph.", streaming: false),
            ["First paragraph.\n\nSecond paragraph."]
        )
    }

    /// …but coalescing is a property of a SETTLED message, never of a streaming one.
    ///
    /// While the reply is arriving it is one chunk, one segment — the granularity the
    /// web freezes at. Merging during streaming means a chunk that freezes GROWS the
    /// run before it, and that run is a card already on screen: new html, new key,
    /// reload, and any open `<details>` in it resets. The residual cost of splitting
    /// the two modes is one settle at turn end; reverting to "always coalesce"
    /// trades that for a boundary that moves under the reader mid-reply.
    func testCoalescingWaitsUntilTheMessageIsSettled() {
        let siblings = "<div>one</div>\n\n<div>two</div>"
        XCTAssertEqual(kinds(siblings, streaming: true), ["html", "html"])
        XCTAssertEqual(kinds(siblings), ["html"])
        // Neither mode may drop or duplicate a byte.
        XCTAssertEqual(RichHTMLSegments.sourceTexts(siblings, streaming: true).joined(), siblings)
    }

    /// The TRAILING chunk can still change kind — one `<script>` turns an html run
    /// into an island — so it may never share a segment with anything already
    /// emitted.
    ///
    /// Coalescing it (which is what shipped) made `"<div>a</div>\n\nmore <b>x</b>"`
    /// ONE html segment, and the next delta re-split it into a SHORTER html segment
    /// plus an island: a card the reader was already looking at lost half its content
    /// and got a new key, so it reloaded.
    func testATrailingChunkChangingKindLeavesEarlierSegmentsAlone() {
        let before = "<div>a</div>\n\nmore <b>x</b>"
        let after = before + "<script>let n = 1</script>"
        XCTAssertEqual(kinds(before, streaming: true), ["html", "html"])
        XCTAssertEqual(kinds(after, streaming: true), ["html", "island"])
        XCTAssertEqual(
            RichHTMLSegments.sourceTexts(after, streaming: true),
            ["<div>a</div>\n\n", "more <b>x</b><script>let n = 1</script>"]
        )
        // Segment, html and key all identical: the first card is never reloaded.
        XCTAssertEqual(
            RichHTMLSegments.segments(before, streaming: true).first,
            RichHTMLSegments.segments(after, streaming: true).first
        )
    }

    /// A blank line after list content cuts as soon as the successor line PROVES it
    /// is not list content, instead of waiting for that line to finish arriving.
    ///
    /// Waiting is what shipped, and it moved a boundary backwards: while `<details>`
    /// was still incomplete the rule deferred, so the list and the card were ONE html
    /// chunk (the list rendering as literal `1.` text inside a web view), and one
    /// character later the cut appeared and handed the list back to the markdown
    /// segment before it — which had already been emitted. Only a fact that cannot
    /// change may decide a boundary, and `listishPossible` can go from true to false
    /// as characters land, never back.
    func testABlankLineAfterAListCutsWithoutWaitingForTheNextLine() {
        let list = "1. first\n2. second\n\n"
        // One character of the successor line is enough when it settles the question.
        XCTAssertEqual(kinds(list + "<details>", streaming: true), ["md", "html"])
        XCTAssertEqual(
            RichHTMLSegments.sourceTexts(list + "<details>", streaming: true),
            [list, "<details>"]
        )
        // And the boundary stays where it was once the line finishes.
        XCTAssertEqual(
            RichHTMLSegments.sourceTexts(list + "<details>x</details>\n\nafter\n", streaming: true).first,
            list
        )
        // A genuinely ambiguous successor still defers: `-` may still become `- two`,
        // and a loose list has to keep its blank lines inside ONE chunk or per-chunk
        // markdown renders it as two lists with restarted numbering.
        XCTAssertEqual(kinds("- one\n\n- two", streaming: true), ["md"])
        XCTAssertEqual(RichHTMLSegments.sourceTexts("- one\n\n-", streaming: true), ["- one\n\n-"])
        // A non-list predecessor was never in question and still cuts immediately.
        XCTAssertEqual(kinds("prose\n\n<div>x</div>", streaming: true), ["md", "html"])
    }

    /// Islands never merge: each one is its own document, and merging two would run
    /// one fence's script inside the other's page.
    func testEachAppChunkIsItsOwnIsland() {
        let two = "```html-app\n<b>one</b>\n```\n\n```html-app\n<b>two</b>\n```"
        XCTAssertEqual(kinds(two), ["island", "island"])
        XCTAssertEqual(islands(two).map(\.html), ["<b>one</b>", "<b>two</b>"])
    }

    // MARK: - Style harvest

    /// A `<style>` and the markup it styles routinely land in different chunks (a
    /// blank line between them IS a chunk boundary). The web console solves that
    /// with one message-level CSS scope; here every html run is its own document, so
    /// the styles must be COPIED into each of them or the card arrives unstyled.
    func testStyleBlocksAreCopiedIntoEveryHTMLSegment() {
        let block = "<style>.k{color:red}</style>"
        let message = """
        \(block)

        Prose between.

        <div class="k">one</div>

        Prose again.

        <div class="k">two</div>
        """
        XCTAssertEqual(kinds(message), ["html", "md", "html", "md", "html"])
        let payloads = htmlPayloads(message)
        XCTAssertEqual(payloads.count, 3)
        for payload in payloads {
            XCTAssertTrue(payload.hasPrefix(block + "\n"), "missing harvested style: \(payload.debugDescription)")
        }
        // Copied, not moved: the block stays where the model wrote it (which is why
        // it appears twice in the segment that owns it), so text preservation holds.
        XCTAssertEqual(payloads[0], block + "\n" + block + "\n\n")
        XCTAssertTrue(payloads[1].hasSuffix(#"<div class="k">one</div>"# + "\n\n"))
    }

    func testStyleHarvestDedupesAndKeepsSourceOrder() {
        let a = "<style>.a{}</style>"
        let b = "<style>.b{}</style>"
        let message = "\(a)\n\ntext\n\n\(b)\n\ntext\n\n\(a)\n\n<div>x</div>"
        guard let last = htmlPayloads(message).last else { return XCTFail("no html segment") }
        // Two distinct blocks, in source order, and the repeat is not harvested twice.
        XCTAssertTrue(last.hasPrefix(a + "\n" + b + "\n"), last.debugDescription)
        XCTAssertEqual(last.components(separatedBy: a).count - 1, 2, "the duplicate block was harvested twice")
        XCTAssertEqual(last.components(separatedBy: b).count - 1, 1)
    }

    /// An island is self-contained; a stray copy of the message's CSS could fight
    /// its own rules, so islands deliberately get none of it.
    func testIslandsDoNotReceiveHarvestedStyles() {
        let message = "<style>.z{color:red}</style>\n\n```html-app\n<b>x</b>\n```"
        XCTAssertEqual(kinds(message), ["html", "island"])
        XCTAssertEqual(islands(message).map(\.html), ["<b>x</b>"])
    }

    /// …and an island's own CSS is not harvested FROM it either.
    ///
    /// The harvest skipped `md` chunks only, so a chunk that became an island by
    /// carrying a `<script>` still donated its stylesheet to every content card of the
    /// same reply: one widget's rules restyling cards they were never written for. (A
    /// FENCED island was safe by accident — its markup sits inside a code region.) The
    /// web has no equivalent bug because it renders app chunks in their own iframe,
    /// outside the message's CSS scope.
    func testAFenceLessIslandsStylesAreNotCopiedIntoContentCards() {
        let island = "<style>.i{color:red}</style><script>let a = 1</script>"
        let message = island + "\n\n<div class=\"c\">card</div>"
        XCTAssertEqual(kinds(message), ["island", "html"])
        XCTAssertEqual(htmlPayloads(message), ["<div class=\"c\">card</div>"])
        // The island keeps its own CSS, exactly as the model wrote it.
        XCTAssertEqual(islands(message).map(\.html), [island + "\n\n"])
    }

    /// The one deliberate exception to "an already-emitted segment never changes":
    /// a `<style>` that arrives LATE is copied into the earlier html segments, which
    /// changes their payload (and therefore their key) exactly once. The alternative
    /// is a card that stays permanently unstyled, so this is the right trade — do
    /// not "fix" it by dropping the copy.
    func testLateStyleBlockUpdatesEarlierHTMLSegments() {
        let early = "<div class=\"k\">card</div>\n\nprose\n\n"
        let late = early + "<style>.k{color:red}</style>\n\n<div class=\"k\">two</div>"
        XCTAssertEqual(htmlPayloads(early, streaming: true), ["<div class=\"k\">card</div>\n\n"])
        guard let first = htmlPayloads(late, streaming: true).first else { return XCTFail("no html segment") }
        XCTAssertTrue(first.hasPrefix("<style>.k{color:red}</style>\n"))
        XCTAssertTrue(first.hasSuffix("<div class=\"k\">card</div>\n\n"))
    }

    // MARK: - Text preservation

    /// The segments' source text, concatenated, is the input byte for byte. A
    /// renderer that drops or duplicates a byte here shows the reader a different
    /// answer than the model sent.
    func testSegmentSourceTextReproducesTheInput() {
        let table = [
            "",
            "plain prose only",
            "  \n\n ",
            "Intro.\n\n<div>card</div>\n\nOutro.",
            "<div>one</div>\n\n<div>two</div>",
            "trailing blank lines matter\n\n\n",
            "Intro.\n\n```html-app\n<b>x</b>\n```\n\nOutro.",
            "```html\n<div>sample</div>\n```\n\nprose after a fence",
            "Intro.\r\n\r\n<div>crlf</div>\r\n",
            "- one\n- two\n\n<div>after a list</div>",
            "Array<T> and <https://example.com> and <user@host>",
            #"<task-ref id="a" label="B"/> then <div>card</div>"#,
            "<style>\n.k { color: red }\n\n.j { color: blue }\n</style>\n\n<div class=\"k\">x</div>",
        ]
        for text in table {
            XCTAssertEqual(
                RichHTMLSegments.sourceTexts(text, streaming: false).joined(), text,
                "text not preserved for \(text.debugDescription)"
            )
            // Streaming preserves everything too — the withheld fragment is the
            // only difference, and it is exactly `splitPending`'s tail.
            let pending = RichHTMLSegments.splitPending(text).pending
            XCTAssertEqual(
                RichHTMLSegments.sourceTexts(text, streaming: true).joined() + pending, text,
                "streaming text not preserved for \(text.debugDescription)"
            )
        }
    }

    // MARK: - Prefix invariant

    /// The whole contract: feed every growing prefix of a realistic streamed reply
    /// and assert nothing already on screen is rewritten.
    ///
    /// Precisely what is guaranteed: only the LAST segment may change. Every earlier
    /// one is byte-identical in SOURCE and KIND, and the count never decreases. A
    /// boundary that moved after the fact reloads the web view (any open `<details>`
    /// resets) and shifts the row ids after it, so the diff becomes delete+insert.
    ///
    /// It is stated this strongly because the looser form this replaced — "frozen"
    /// only below `count - 2`, with the count allowed to shrink — structurally
    /// excluded the segments where boundaries actually moved, and passed while two
    /// separate bugs moved one: the deferred-list rule pushed a list paragraph out of
    /// an html segment into the markdown segment before it, and a coalesced run shrank
    /// when its trailing chunk turned into an island. Revert either fix and this fails
    /// at the prefix where the boundary moves.
    func testGrowingPrefixesNeverRewriteAnEmittedSegment() {
        let reply = """
        Here is the comparison you asked for.

        <style>
        .cmp { display:flex; gap:10px }
        .cmp .col { flex:1; border:1px solid var(--border); border-radius:10px; padding:10px }
        </style>

        <div class="cmp">
          <div class="col"><b>Option A</b><br>cheap, slower</div>
          <div class="col"><b>Option B</b><br>fast, pricier</div>
        </div>

        Two things worth calling out:

        1. The first option needs no migration.
        2. The second needs a backfill.

        <details><summary><b>Why B is still tempting</b></summary>
        <p>It removes a whole queue.</p>
        </details>

        ```html-app
        <div id="out">counting…</div>
        <script>let n = 0; setInterval(() => { document.getElementById('out').textContent = ++n }, 500)</script>
        ```

        That is the whole picture.
        """

        var previous: [(kind: String, source: String)] = []
        let characters = Array(reply)
        for length in 1...characters.count {
            let text = String(characters[0..<length])
            let current = zip(
                kinds(text, streaming: true),
                RichHTMLSegments.sourceTexts(text, streaming: true)
            ).map { (kind: $0, source: $1) }

            XCTAssertGreaterThanOrEqual(
                current.count, previous.count, "a segment disappeared at prefix \(length)"
            )
            for index in 0..<max(0, previous.count - 1) where index < current.count {
                XCTAssertEqual(
                    current[index].kind, previous[index].kind,
                    "emitted segment \(index) changed kind at prefix \(length)"
                )
                XCTAssertEqual(
                    current[index].source, previous[index].source,
                    "emitted segment \(index) was rewritten at prefix \(length)"
                )
            }
            previous = current
        }
        // The settled render coalesces same-kind runs, so it has FEWER segments than
        // the last streaming one: the `<style>` run joins the card it styles, and the
        // prose run joins the list. That merge is the one boundary move in the whole
        // lifetime of a reply, and it happens at turn end (see
        // testCoalescingWaitsUntilTheMessageIsSettled).
        XCTAssertEqual(previous.map(\.kind), ["md", "html", "html", "md", "md", "html", "island", "md"])
        XCTAssertEqual(kinds(reply), ["md", "html", "md", "html", "island", "md"])
    }

    // MARK: - splitPending

    /// A reply flushed one character into an attribute once rendered `…padding:8`
    /// as an empty coloured pill and the rest of the sentence as visible prose
    /// (inc-1788209680147). An unfinished construct belongs to the text that
    /// CONTINUES it, so it is withheld instead.
    func testSplitPendingWithholdsUnfinishedConstructs() {
        let cases: [(text: String, safe: String, pending: String)] = [
            (#"Text before <div style="padding:8"#, "Text before ", #"<div style="padding:8"#),
            ("Text before <!-- unter", "Text before ", "<!-- unter"),
            ("prose\n<style>body{", "prose\n", "<style>body{"),
            ("prose\n<script>let n = 0", "prose\n", "<script>let n = 0"),
            // One or two characters is still worth holding for a tick: the name has
            // not arrived, and prose rendered now could never be taken back.
            ("almost <", "almost ", "<"),
            ("almost </", "almost ", "</"),
        ]
        for testCase in cases {
            let split = RichHTMLSegments.splitPending(testCase.text)
            XCTAssertEqual(split.safe, testCase.safe, "safe for \(testCase.text.debugDescription)")
            XCTAssertEqual(split.pending, testCase.pending, "pending for \(testCase.text.debugDescription)")
            XCTAssertEqual(split.safe + split.pending, testCase.text, "lossy split")
        }
    }

    func testSplitPendingWithholdsNothingForFinishedText() {
        let balanced = [
            "",
            "plain prose",
            "<div>done</div> and prose after it",
            "5 < 3 and 4 > 2",
            "see <https://example.com> and mail <user@host>",
            "<style>.k{}</style> after the block",
            #"<div data-x="a>b">a quoted angle bracket cannot end the tag early</div>"#,
            // Inside a fence the fragment is a code SAMPLE, not arriving markup.
            "```\n<div style=\"padding:8",
        ]
        for text in balanced {
            let split = RichHTMLSegments.splitPending(text)
            XCTAssertEqual(split.pending, "", "unexpected pending for \(text.debugDescription)")
            XCTAssertEqual(split.safe, text)
        }
    }

    // MARK: - Island completeness

    /// Mounting a half-written island would run half a script. And "is the chunk
    /// stable" is the wrong test: a reply whose LAST block is the island never gets
    /// a successor line, so a stable-only rule would leave it building for good.
    func testIslandCompleteness() {
        let open = "```html-app\n<div id=\"out\">counting</div>"
        XCTAssertEqual(kinds(open, streaming: true), ["island-partial"])
        XCTAssertEqual(islands(open, streaming: true).map(\.html), ["<div id=\"out\">counting</div>"])

        let closed = "```html-app\n<div id=\"out\">counting</div>\n```"
        XCTAssertEqual(kinds(closed, streaming: true), ["island"])
        XCTAssertEqual(islands(closed, streaming: true).map(\.html), ["<div id=\"out\">counting</div>"])

        // A fence-less island (a raw `<script>`) is complete only when every
        // element it opened is closed.
        XCTAssertEqual(kinds("<div>x</div>\n<script>let a = 1</script>"), ["island"])
        XCTAssertEqual(kinds("<div>x\n<script>let a = 1</script>"), ["island-partial"])
    }

    // MARK: - Document

    func testContentDocumentForbidsScriptsAndDefinesEverySkillVariable() {
        let page = RichHTMLDocument.page(body: "<p>hello</p>", palette: .light, kind: .content)
        XCTAssertTrue(page.hasPrefix("<!DOCTYPE html>"))
        XCTAssertTrue(page.contains(#"<meta name="viewport" content="width=device-width, initial-scale=1">"#))
        XCTAssertTrue(page.contains(
            #"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:">"#
        ))
        // No scripts and no network of any kind — that is what makes it safe to
        // hand the model's markup over without sanitising it.
        XCTAssertFalse(page.contains("script-src"), "a content document must never allow scripts")
        // `media-src` matches the letter renderer's floor for the reason recorded
        // there: the cell enables inline playback and the base CSS styles `video`, so
        // without it a `<video src="data:…">` in a card renders a control that
        // silently refuses to play. `data:`/`blob:` only, so still no network.
        XCTAssertTrue(page.contains("media-src data: blob:"))
        // ONE scheme, the one the palette was resolved for: "light dark" also
        // governs what WebKit styles itself, and left open a bare `<button>` in an
        // island came out light-on-black in a dark transcript.
        XCTAssertTrue(page.contains("color-scheme: light"))
        XCTAssertFalse(page.contains("color-scheme: light dark"))
        XCTAssertTrue(RichHTMLDocument.page(body: "<p>hi</p>", palette: .dark, kind: .content)
            .contains("color-scheme: dark"))
        XCTAssertTrue(page.contains("-webkit-text-size-adjust: 100%"))
        XCTAssertTrue(page.contains("font: -apple-system-body"))
        XCTAssertTrue(page.contains("<p>hello</p>"))

        // Every variable the rich-output skill promises the model. A missing one
        // renders as nothing at all: `color: var(--fg)` with no `--fg` falls back to
        // the initial colour, so a card the Mac shows correctly would be invisible.
        for variable in [
            "--fg:", "--fg-muted:", "--bg:", "--bg-secondary:", "--border:", "--accent:",
            "--success:", "--warning:", "--error:", "--card-bg:", "--radius-md: 12px",
            "--font-mono: ui-monospace, Menlo, monospace",
        ] {
            XCTAssertTrue(page.contains(variable), "document does not define \(variable)")
        }
    }

    func testIslandDocumentAllowsInlineScriptsButNoNetwork() {
        let page = RichHTMLDocument.page(body: "<script>1</script>", palette: .dark, kind: .island)
        XCTAssertTrue(page.contains("script-src 'unsafe-inline'"))
        XCTAssertTrue(page.contains("default-src 'none'"))
        XCTAssertTrue(page.contains("media-src data: blob:"))
        XCTAssertFalse(page.contains("connect-src"), "an island must not be granted network access")
    }

    // MARK: - Inline markdown in a document body

    /// Markdown written next to HTML renders as markdown, not as its own characters.
    ///
    /// The web runs md AND html chunks through the same markdown renderer (`kind`
    /// there only selects a CSS class), so `**Bottom line:**` beside a `<div>` is bold
    /// on the Mac. The phone handed the run to WebKit as bytes and the reader saw the
    /// asterisks — while the rich-output skill promises "Markdown still works
    /// alongside".
    ///
    /// It happens where the document BODY is built and NOWHERE else: the segment's
    /// html is compared byte for byte by the prefix invariant and is the height
    /// cache's key, so this has to stay a pure function of that string.
    func testInlineMarkdownIsAppliedToAnHTMLDocumentBody() {
        let body = "<div>**Bottom line:** it ships, see [the docs](https://example.com/a_b)"
            + " and run `npm test` *first*</div>"
        let page = RichHTMLDocument.page(body: body, palette: .light, kind: .content)
        XCTAssertTrue(page.contains("<strong>Bottom line:</strong>"), page)
        XCTAssertTrue(page.contains(#"<a href="https://example.com/a_b">the docs</a>"#))
        XCTAssertTrue(page.contains("<code>npm test</code>"))
        XCTAssertTrue(page.contains("<em>first</em>"))
        // A body with no markdown in it comes back byte for byte.
        XCTAssertEqual(RichHTMLSegments.inlineMarkdown("<div>plain</div>"), "<div>plain</div>")
        // An island is an app the model authored, and the web gives it no markdown
        // pass either, so its text stays exactly as written.
        XCTAssertTrue(
            RichHTMLDocument.page(body: "<div>**as written**</div>", palette: .light, kind: .island)
                .contains("**as written**")
        )
    }

    /// The transform rewrites TEXT and only text.
    ///
    /// An attribute value or a `<code>` body that came back with `<strong>` in it
    /// would mean the scanner lost track of where markup ends, which is exactly how a
    /// `style="…"` becomes visible prose (inc-1788209680147, from the other end). The
    /// prose shapes that only LOOK like tags are in here too: an underscore inside
    /// `<https://example.com/a_b_c>` is part of a URL, not emphasis.
    func testInlineMarkdownNeverTouchesMarkupOrCodeBodies() {
        for text in [
            #"<div title="**not bold**" data-k="a_b_c">plain</div>"#,
            "<p><code>a * b * c and **stars**</code></p>",
            "<pre>def f(*args, **kw):\n    return _x_\n</pre>",
            "<pre><code>**sample** and `tick`</code></pre>",
            "<style>.a{margin:0}\n/* **note** */\n.b_c{}</style><p>plain</p>",
            "<textarea>**literal** _here_</textarea>",
            "<!-- **not bold** _either_ --><p>plain</p>",
            "<p>see <https://example.com/a_b_c> for more</p>",
            "<p>mail <user@host_name> please</p>",
            #"<p><task-ref id="a_b" label="**x**"/> done</p>"#,
            // Prose an emphasis parser must leave alone: identifiers, arithmetic, a
            // lone trailing asterisk, and emphasis that would have to cross a
            // paragraph break.
            "<p>set user_name_field on the_other_one</p>",
            "<p>2 * 3 * 4 = 24 and 40 * 40</p>",
            "<p>footnote* and more</p>",
            "<div>a *b\n\nc* d</div>",
            // A link is only manufactured for a scheme this transform trusts.
            "<p>[click](javascript:alert(1))</p>",
        ] {
            XCTAssertEqual(
                RichHTMLSegments.inlineMarkdown(text), text,
                "rewrote markup, code or prose in \(text.debugDescription)"
            )
        }
    }

    /// The accent is the phone's own walnut tint, not the web's iOS blue, so an
    /// accented border inside a card matches the chrome around it.
    func testPaletteAccentIsTheWalnutTint() {
        XCTAssertEqual(RichHTMLPalette.light.accent, "#8B5A2B")
        XCTAssertEqual(RichHTMLPalette.dark.accent, "#C99659")
        XCTAssertFalse(RichHTMLPalette.light.dark)
        XCTAssertTrue(RichHTMLPalette.dark.dark)
        XCTAssertTrue(RichHTMLDocument.page(body: "", palette: .light, kind: .content).contains("--accent: #8B5A2B"))
        XCTAssertTrue(RichHTMLDocument.page(body: "", palette: .dark, kind: .content).contains("--accent: #C99659"))
    }

    // MARK: - Keys

    /// The key is a content digest: same content, same key (so a measured height is
    /// reused), changed content, new key. It is NOT a view identity — reuse web
    /// views by segment index, or promoting a segment remounts it and reloads the
    /// island the reader is using.
    func testKeyIsAStableContentDigest() {
        let card = "<div>a</div>"
        XCTAssertEqual(
            RichHTMLSegments.segments(card, streaming: false),
            RichHTMLSegments.segments(card, streaming: false)
        )
        guard case .html(_, let keyA)? = RichHTMLSegments.segments(card, streaming: false).first,
              case .html(_, let keyB)? = RichHTMLSegments.segments("<div>b</div>", streaming: false).first
        else { return XCTFail("expected one html segment each") }
        XCTAssertNotEqual(keyA, keyB)
        XCTAssertFalse(keyA.isEmpty)
    }

    // MARK: - The stylesheet is valid CSS

    /// Prose belongs inside `/* … */`, and this test exists because it once did not.
    ///
    /// Editing a long explanatory comment left two lines of prose and a second `*/`
    /// OUTSIDE the comment that had already closed. CSS error recovery then discarded
    /// the rule that followed, and the only symptom was one fixture's SVG label going
    /// invisible on the device — a Swift build cannot see it, and every assertion that
    /// looks for a substring of the stylesheet still passed, because the text was
    /// there. So: comment delimiters must nest correctly, and outside a comment the
    /// stylesheet must look like CSS (no backtick, which only ever appears in the
    /// prose of these comments).
    func testTheStylesheetHasNoProseOutsideAComment() {
        for kind in [RichHTMLDocument.Kind.content, .island] {
            let page = RichHTMLDocument.page(body: "x", palette: .dark, kind: kind)
            guard let open = page.range(of: "<style>"), let close = page.range(of: "</style>") else {
                return XCTFail("the document has no stylesheet")
            }
            let css = String(page[open.upperBound..<close.lowerBound])
            var depth = 0
            var outside = ""
            var i = css.startIndex
            while i < css.endIndex {
                let rest = css[i...]
                if depth == 0, rest.hasPrefix("/*") {
                    depth = 1
                    i = css.index(i, offsetBy: 2)
                    continue
                }
                if rest.hasPrefix("*/") {
                    XCTAssertEqual(depth, 1, "a `*/` closes a comment that was never opened")
                    depth = 0
                    i = css.index(i, offsetBy: 2)
                    continue
                }
                if depth == 0 { outside.append(css[i]) }
                i = css.index(after: i)
            }
            XCTAssertEqual(depth, 0, "the stylesheet ends inside an unclosed comment")
            XCTAssertFalse(outside.contains("`"),
                           "prose escaped its comment into the stylesheet: \(outside.prefix(160))")
        }
    }

    // MARK: - Renderable content

    /// An all-CSS segment draws nothing, and an element with no text still does.
    ///
    /// Would-fail-if-reverted: return `true` unconditionally and a `<style>` block
    /// the model writes before its card (its own chunk, and while streaming its own
    /// segment) becomes an empty 40pt card row above the card being written. Return
    /// "has text" instead and a chip or a rule vanishes.
    func testOnlyStyleScriptCommentsAndWhitespaceDrawNothing() {
        for invisible in [
            "<style>.card { color: red }</style>",
            "\n  <style>.a{}</style>\n\n<style>.b{}</style>\n ",
            "<script>let n = 1</script>",
            "<!-- just a note -->\n",
            "   \n\t\n",
            "",
        ] {
            XCTAssertFalse(
                RichHTMLSegments.hasRenderableContent(html: invisible),
                "counted \(invisible.debugDescription) as something to draw"
            )
        }
        for visible in [
            "<div class=\"chip\"></div>",
            "<style>.a{}</style>\n<div>card</div>",
            "<hr>",
            "<img src=\"data:image/png;base64,AA\">",
            "plain words",
            "<style>.a{}</style> 2 < 3",
            "<svg viewBox=\"0 0 4 4\"><rect width=\"4\" height=\"4\"/></svg>",
        ] {
            XCTAssertTrue(
                RichHTMLSegments.hasRenderableContent(html: visible),
                "counted \(visible.debugDescription) as invisible"
            )
        }
    }
}
