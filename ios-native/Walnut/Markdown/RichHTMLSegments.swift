import Foundation

/// One piece of an assistant message, in source order.
enum RichSegment: Equatable {
    /// Ordinary markdown / prose. Renders through the app's existing native
    /// markdown pipeline (unchanged).
    case markdown(String)
    /// A raw-HTML run to render as ONE web document. `html` is render-ready:
    /// the message's harvested <style> blocks are already prepended.
    /// `key` is a stable content digest (height-cache key).
    case html(html: String, key: String)
    /// A ```html-app fenced island (scripts allowed, sandboxed).
    /// `complete` is false while the fence/markup is still arriving.
    case island(html: String, key: String, complete: Bool)
}

/// Splits an assistant message into native-markdown runs and raw-HTML runs, so
/// the phone renders a model's HTML reply as real DOM instead of showing literal
/// `<div style="…">` tags.
///
/// This is a selective port of the web console's splitter
/// (web/src/utils/rich-blocks.ts), which is the semantic source of truth. What
/// carries over unchanged, because each rule is a shipped incident there:
///
///  - The ELEMENT ALLOWLIST. A `<` in prose is overwhelmingly not a tag:
///    `Array<T>`, `<https://example.com>`, `<user@host>` and walnut's own
///    `<task-ref id="…"/>` pill all look like one. Counting them opened a depth
///    level that never closed, which disabled every later boundary decision.
///  - A NAME STACK, not a counter, for element depth: a counter cannot tell
///    `</div>` from `</p>`, so one stray closer shifted every later depth by one.
///  - CODE REGIONS are not markup. A tag inside a fence is a SAMPLE.
///  - THE PREFIX INVARIANT: a boundary is decided only from facts a later delta
///    cannot change (a complete line, or a partial one whose answer is already
///    settled either way), and anything genuinely undecided resolves the
///    conservative way: don't cut. Not cutting is always safe, because the text
///    stays in the growing tail; cutting too early is not.
///  - TEXT PRESERVATION: the segments' source text, concatenated, is the input
///    byte for byte (minus the withheld streaming tail). A renderer that drops or
///    duplicates a byte here shows the user a different answer than the model sent.
///
/// Four deliberate divergences from the web version, each with a reason:
///
///  1. `isRich` SKIPS code regions (web's `hasRichContent` does not). On the phone
///     a code sample rendering as native monospace is the CORRECT outcome; routing
///     the whole message into a web view because it quotes `<div>` in a fence
///     would be a regression, not a feature.
///  2. Consecutive same-kind chunks are COALESCED into one segment, but ONLY once
///     the message has settled. The web keeps chunk granularity because all chunks
///     share one DOM; here each html run is its own web document, so two sibling
///     top-level elements must not become two documents with a gap between them.
///     While the reply streams there is no coalescing at all — merging then would
///     move a boundary that is already on screen (see `groups`).
///  3. `<style>` blocks are HARVESTED to message level and copied into every html
///     segment (see `stylePrefix`). The web scopes CSS per MESSAGE for the
///     same reason; separate documents force a copy instead of a scope.
///  4. INLINE MARKDOWN inside an html run is applied at RENDER time
///     (`inlineMarkdown`, called where the document body is built). The web runs md
///     AND html chunks through the same markdown renderer — `kind` there only picks
///     a CSS class — so `**Bottom line:**` written beside a `<div>` is bold on the
///     Mac. WebKit gets bytes, so the phone showed the asterisks instead.
///
/// NOT ported: `collapseRawtextBlankLines`. That exists because CommonMark ends a
/// raw-HTML block at the first blank line, so a blank line inside `<style>` made
/// marked() markdown-parse the rest of the stylesheet. No BLOCK markdown parser sees
/// an html run here (WebKit gets it as written, and divergence 4's inline pass never
/// enters a rawtext body), so a blank line in CSS is just whitespace again.
///
/// NO SANITISING, on purpose. A `.content` document runs with JavaScript OFF at
/// the web-view level, under `default-src 'none'` (no scripts, no frames, no
/// network of any kind) and with `baseURL: nil`, so a `<script>` in it is inert
/// and a tracker pixel cannot phone home. Markup that WANTS to run gets an island
/// instead — exactly like the web console. Stripping tags would only make the
/// phone render a different answer than the Mac.
///
/// Pure Foundation (no UIKit/SwiftUI) so scripts/ios-perf can compile and
/// budget-test it headlessly, and safe to call off the main thread: every entry
/// point is a pure function of its input with no shared mutable state.
enum RichHTMLSegments {

    // MARK: - Public API

    /// Cheap precheck: could this text carry raw HTML (or an html-app fence) that
    /// the native markdown path would show as literal tags?
    ///
    /// False keeps the caller on the plain native render it has always used, so an
    /// ordinary message is untouched by any of this. Beyond the gate this
    /// deliberately does the REAL classification rather than a cheaper guess,
    /// because `isRich` and `segments` disagreeing means a message gets routed rich
    /// and then produces zero html segments (or the reverse).
    /// `RichHTMLSegmentsTests` pins the pairing.
    ///
    /// The gate has to be genuinely CHEAP, because every assistant message pays it
    /// on every cache miss and the live tail pays it ~8x a second on the layout
    /// actor. It was the most expensive scan in the file instead (measured with
    /// `-O` on 10KB of plain prose containing no `<` at all): the `html-app` probe
    /// ran EAGERLY even when there was no chance of a fence, and it ran through
    /// `String.range(of:options:.caseInsensitive)`, which bridges to NSString and
    /// folds Unicode canonically — 3.2ms for that one probe against 0.05ms for the
    /// same probe done LITERALLY on the NSString. Whole call: 3.9ms → 0.05ms.
    static func isRich(_ text: String) -> Bool {
        if containsAngle(text) {
            let t = Text(text)
            let lines = Lines(t)
            // A markup tag OUTSIDE code always lands in a chunk classified html or
            // app (chunk boundaries never fall inside a code region, so the
            // per-chunk code map agrees with this one) — so one hit is enough.
            if !markupTagNames(t, CodeSkip(t, lines), firstOnly: true).isEmpty { return true }
        }
        // The one remaining rich shape has no markup tag outside code: a pure
        // ```html-app fence, whose body is entirely inside the fence. Probed only
        // HERE, once the tag scan has already come up empty — which is why an
        // ordinary reply never pays for it.
        guard mayHaveAppFence(text) else { return false }
        return classifiedChunks(text).contains { $0.kind == .app }
    }

    /// `text` holds a `<`, over UTF-8 bytes.
    ///
    /// `String.contains("<")` walks GRAPHEMES (0.70ms on the same 10KB); a byte
    /// scan cannot false-positive because no UTF-8 continuation byte can equal an
    /// ASCII one.
    private static func containsAngle(_ text: String) -> Bool {
        text.utf8.contains(UInt8(ascii: "<"))
    }

    /// Could an ```html-app fence be in here? `.literal` is load-bearing: without
    /// it the same case-insensitive probe folds Unicode canonically and costs ~60x
    /// more (see `isRich`).
    private static func mayHaveAppFence(_ text: String) -> Bool {
        (text as NSString)
            .range(of: "html-app", options: [.literal, .caseInsensitive])
            .location != NSNotFound
    }

    /// Split a message into renderable segments.
    ///
    /// `streaming` true = the text may end mid-construct, so the trailing
    /// unterminated fragment is withheld (never rendered as text, never rendered
    /// as half a tag) and islands that have not closed report `complete: false`.
    static func segments(_ text: String, streaming: Bool) -> [RichSegment] {
        groups(text, streaming: streaming).map { group in
            switch group.kind {
            case .md:
                return .markdown(group.source)
            case .html:
                return .html(html: group.html, key: key(for: group.html))
            case .app:
                return .island(html: group.html, key: key(for: group.html), complete: group.complete)
            }
        }
    }

    /// Safe prefix / withheld pending fragment for a streaming text.
    ///
    /// `pending` is a tag with no `>`, an unterminated comment, or an unclosed
    /// `<style>`/`<script>`/`<textarea>` body. `safe + pending == text`, always.
    ///
    /// Why withhold instead of render (inc-1788209680147, the server twin lives at
    /// src/core/stream/pending-markup.ts): a reply flushed one character into an
    /// attribute rendered `…padding:8` as an empty coloured pill and then
    /// `px">全部降级…` as visible prose. One sentence, cut in half, permanently.
    /// The fragment belongs to the text that CONTINUES it.
    static func splitPending(_ text: String) -> (safe: String, pending: String) {
        guard containsAngle(text) else { return (text, "") }
        let t = Text(text)
        let lines = Lines(t)
        let skip = CodeSkip(t, lines)
        var i = 0
        var pendingAt = -1

        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            if skip.contains(lt) { i = lt + 1; continue }

            if t.matchesComment(at: lt) {
                guard let close = t.rangeOf("-->", from: lt + 4) else { pendingAt = lt; break }
                i = close.location + close.length
                continue
            }
            if lt + 1 < t.length, t[lt + 1] == uBang { // <!DOCTYPE …>
                guard let gt = t.indexOf(uGT, from: lt) else { pendingAt = lt; break }
                i = gt + 1
                continue
            }
            // A bare `<` (or `</`) at the very end is a tag whose NAME has not
            // arrived. Holding one or two characters for one tick beats rendering
            // them as prose and never being able to take them back.
            if lt == t.length - 1 || (lt == t.length - 2 && t[lt + 1] == uSlash) {
                pendingAt = lt
                break
            }
            guard let tag = tagName(t, at: lt) else { i = lt + 1; continue } // `a < b`, `<3`
            let end = tagEnd(t, from: lt)
            if end < 0 { pendingAt = lt; break }
            let raw = t.substring(lt..<end)
            // Prose that only LOOKS like a tag is never withheld.
            if isAutolinkForm(raw) || (!raw.contains(where: \.isWhitespace) && raw.contains("@")) {
                i = end
                continue
            }
            if rawtextTags.contains(tag.name), !tag.closing {
                guard let close = rawtextClose(t, from: end, name: tag.name) else { pendingAt = lt; break }
                i = close.end
                continue
            }
            i = end
        }

        guard pendingAt >= 0 else { return (text, "") }
        return (t.substring(0..<pendingAt), t.substring(pendingAt..<t.length))
    }

    /// The SOURCE text of each segment, in order — the same grouping `segments`
    /// returns, without the render-time rewrites (harvested styles prepended, an
    /// island's fence markers stripped).
    ///
    /// Exists so the text-preservation and prefix invariants are testable: joined,
    /// this is the input exactly (minus `splitPending`'s withheld tail). Callers
    /// that RENDER want `segments`.
    static func sourceTexts(_ text: String, streaming: Bool) -> [String] {
        groups(text, streaming: streaming).map(\.source)
    }

    // MARK: - Grouping

    private struct Group {
        let kind: Chunk.Kind
        /// Byte-exact source text of every chunk in this group, in order.
        let source: String
        /// What to render: `source` for markdown, harvested styles + `source` for
        /// html, the fence body (or the chunk as written) for an island.
        let html: String
        /// Islands only; true for everything else.
        let complete: Bool
    }

    /// Chunks, coalesced into segments — but only once the message has SETTLED.
    ///
    /// Coalescing rule: in a finished message consecutive `md` chunks become one
    /// markdown segment and consecutive `html` chunks become one html segment,
    /// because two sibling top-level elements must not become two web documents
    /// with a gap between them. Every `app` chunk always stands alone (an island is
    /// self-contained; merging two would run one script inside the other's page).
    ///
    /// WHILE STREAMING there is no coalescing at all: one chunk, one segment,
    /// exactly the granularity the web freezes at. That is not a style choice, it
    /// is the only shape in which an emitted boundary cannot MOVE, and a boundary
    /// that moves costs the reader a card reload (an open `<details>` resets, and
    /// the row ids after it shift so the diff becomes delete+insert). Two measured
    /// ways the old "coalesce everything" rule moved one:
    ///
    ///  - A chunk that FREEZES joins the run before it, so the run's text grows
    ///    after it was already on screen. `<div>one</div>` … `<div>two</div>` went
    ///    from one card to a card holding both.
    ///  - The TRAILING chunk can still change kind. `"<div>a</div>\n\nmore <b>x</b>"`
    ///    was one html segment; one `<script>` later the same text was a SHORTER
    ///    html segment plus an island, i.e. an already-emitted segment shrank and
    ///    got a new key.
    ///
    /// The residual cost, stated honestly: the streaming→settled hand-off merges
    /// runs ONCE, at turn end, so every html run that spanned more than one chunk
    /// (a `<style>` block plus the card it styles, two sibling cards) reloads one
    /// final time there. Markdown merges are invisible — the same text produces the
    /// same block rows either way. The alternative, never coalescing, pays a
    /// permanent seam and one extra web view per sibling card on every message
    /// forever, so one settle at the end of a turn is the cheaper end of the trade.
    private static func groups(_ text: String, streaming: Bool) -> [Group] {
        let source = streaming ? splitPending(text).safe : text
        guard !source.isEmpty else { return [] }
        let chunks = classifiedChunks(source)
        let stylePrefix = stylePrefix(for: chunks)
        let coalesce = !streaming

        var out: [Group] = []
        var runKind: Chunk.Kind?
        var runText = ""

        func flush() {
            defer { runKind = nil; runText = "" }
            guard let kind = runKind, !runText.isEmpty else { return }
            out.append(Group(
                kind: kind,
                source: runText,
                html: kind == .html ? stylePrefix + runText : runText,
                complete: true
            ))
        }

        for chunk in chunks {
            if chunk.kind == .app {
                flush()
                out.append(Group(
                    kind: .app,
                    source: chunk.text,
                    html: extractAppHTML(chunk.text),
                    complete: isAppComplete(chunk.text)
                ))
                continue
            }
            if !coalesce || runKind != chunk.kind { flush(); runKind = chunk.kind }
            runText += chunk.text
        }
        flush()
        return out
    }

    /// Stable content digest for the height cache: same html, same key.
    ///
    /// Content-derived on purpose, but it is NOT a view identity. The web console
    /// learned that the hard way (`richChunkKey`): a text-derived React key changed
    /// at the exact moment a chunk was promoted to permanent, so the node was
    /// unmounted and remounted, reloading the island and resetting the widget the
    /// user was clicking. Reuse web views by segment INDEX; use this only to look
    /// up a measured height.
    private static func key(for html: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        var count = 0
        for byte in html.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x100_0000_01b3
            count += 1
        }
        return "rh\(String(hash, radix: 36))-\(count)"
    }

    // MARK: - Style harvest

    /// Every `<style>…</style>` block in the message's HTML chunks, in source
    /// order, deduplicated by exact text, ready to prepend to an html segment.
    ///
    /// WHY this is message-level: a `<style>` the model writes first and the markup
    /// it styles second land in DIFFERENT chunks (a blank line between them is
    /// exactly a chunk boundary). The web console handles that by scoping CSS at
    /// MESSAGE level — one DOM, so the rule reaches every chunk. On the phone each
    /// html run is its own document, so the styles have to be COPIED in or the card
    /// arrives unstyled.
    ///
    /// Copied, not moved: the block stays where it was written, so text
    /// preservation still holds and a duplicated rule is just an identical rule.
    ///
    /// Islands are outside this in BOTH directions. They receive nothing (an island
    /// is self-contained, and a stray `<style>` copy could fight its own CSS), and
    /// they CONTRIBUTE nothing: an island's stylesheet belongs to its own document,
    /// so harvesting from an app chunk (a fence-less `<script>` island's CSS is not
    /// in a code region, so it was harvested) pushed one widget's rules into every
    /// content card of the same message. The web has no equivalent bug because it
    /// renders app chunks in an iframe, outside the message's CSS scope.
    private static func stylePrefix(for chunks: [Chunk]) -> String {
        var blocks: [String] = []
        var seen = Set<String>()
        for chunk in chunks where chunk.kind == .html {
            for block in styleBlocks(chunk.text) where !seen.contains(block) {
                seen.insert(block)
                blocks.append(block)
            }
        }
        guard !blocks.isEmpty else { return "" }
        return blocks.joined(separator: "\n") + "\n"
    }

    private static func styleBlocks(_ text: String) -> [String] {
        // `.literal` for the same reason `isRich`'s fence probe needs it: the
        // folding form of this probe is ~60x slower, and this one runs once per
        // html chunk on every split.
        guard (text as NSString)
            .range(of: "<style", options: [.literal, .caseInsensitive]).location != NSNotFound
        else { return [] }
        let t = Text(text)
        let lines = Lines(t)
        let skip = CodeSkip(t, lines)
        var out: [String] = []
        var i = 0
        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            i = lt + 1
            if skip.contains(lt) { continue } // a `<style>` in a fence is a sample
            if t.matchesComment(at: lt) {
                // A `<style>` inside a comment is inert; an unterminated comment
                // swallows the rest, so there is nothing left to harvest.
                guard let close = t.rangeOf("-->", from: lt + 4) else { break }
                i = close.location + close.length
                continue
            }
            guard let tag = tagName(t, at: lt), !tag.closing, tag.name == "style" else { continue }
            let end = tagEnd(t, from: lt)
            guard end > 0 else { break } // the `<style` tag itself is still arriving
            guard isMarkupTag(t.substring(lt..<end), tag.name) else { i = end; continue }
            // An UNCLOSED body still counts: the browser closes it on insert and
            // runs the CSS anyway, so a card must not sit unstyled waiting for
            // `</style>`.
            let stop = rawtextClose(t, from: end, name: "style")?.end ?? t.length
            out.append(t.substring(lt..<stop))
            i = stop
        }
        return out
    }

    // MARK: - Inline markdown (render time)

    /// Inline markdown applied to the TEXT of an html run.
    ///
    /// WHY it exists: the web renders md AND html chunks through the same markdown
    /// renderer (RichBlocks.tsx — `kind` there only selects a CSS class), so a
    /// `**Bottom line:**` the model wrote next to a `<div>` is bold on the Mac. The
    /// phone hands the run to WebKit as bytes, so the same reply showed the reader
    /// the asterisks, while the rich-output skill promises "Markdown still works
    /// alongside".
    ///
    /// WHERE it runs: only where the DOCUMENT BODY is built (RichHTMLDocument.page).
    /// The segment's stored `html` must stay byte-exact — the streaming prefix
    /// invariant compares it, and the height cache keys on it — so this has to be a
    /// deterministic function OF that string, never a rewrite of it. Same html, same
    /// body, same measured height.
    ///
    /// INLINE ONLY, deliberately: bold, italic, inline code, links. Block markdown
    /// (headings, lists, tables, blockquotes) needs a block parser, and a partial one
    /// that turns "1." into a list only sometimes is worse than none — the skill
    /// tells the model to leave a markdown block in its own paragraph, where a blank
    /// line makes it a native markdown segment instead.
    ///
    /// It rewrites TEXT and nothing else. Every region the tag scanner recognises is
    /// copied through byte for byte: no attribute value is ever touched, `<pre>` and
    /// `<code>` bodies keep their asterisks, `<style>`/`<script>`/`<textarea>`
    /// rawtext is jumped over whole, and prose that only LOOKS like a tag
    /// (`<https://x/a_b_c>`, `<user@host>`, `Array<T>`, a walnut ref pill) is
    /// verbatim too — those are precisely the shapes where an underscore is not
    /// emphasis.
    static func inlineMarkdown(_ html: String) -> String {
        guard hasInlineMarker(html) else { return html }
        let t = Text(html)
        var out = ""
        var spanStart = 0
        var verbatim: [String] = [] // open <pre>/<code>: their text keeps its bytes
        var i = 0

        /// Rewrite the text in `[spanStart, textEnd)`, then copy the markup in
        /// `[textEnd, resume)` exactly as the model wrote it.
        func emit(textEnd: Int, resume: Int) {
            if spanStart < textEnd {
                if verbatim.isEmpty {
                    renderInline(t, spanStart, textEnd, depth: 0, into: &out)
                } else {
                    out += t.substring(spanStart..<textEnd)
                }
            }
            out += t.substring(textEnd..<resume)
            spanStart = resume
        }

        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            if t.matchesComment(at: lt) {
                let end = t.rangeOf("-->", from: lt + 4).map { $0.location + $0.length } ?? t.length
                emit(textEnd: lt, resume: end)
                i = end
                continue
            }
            if lt + 1 < t.length, t[lt + 1] == uBang { // <!DOCTYPE …>
                let end = t.indexOf(uGT, from: lt).map { $0 + 1 } ?? t.length
                emit(textEnd: lt, resume: end)
                i = end
                continue
            }
            // A `<` that opens nothing (`a < b`, `<3`) is ordinary text: leave it in
            // the span, so markdown around it still applies.
            guard let tag = tagName(t, at: lt) else { i = lt + 1; continue }
            let end = tagEnd(t, from: lt)
            guard end > 0 else { // a tag mid-arrival: nothing after it is text yet
                emit(textEnd: lt, resume: t.length)
                i = t.length
                continue
            }
            let markup = isMarkupTag(t.substring(lt..<end), tag.name)
            // `<style>`/`<script>`/`<textarea>` bodies are not prose at all: the tag,
            // the body and its closer are ONE verbatim region.
            let resume = markup && !tag.closing && rawtextTags.contains(tag.name)
                ? (rawtextClose(t, from: end, name: tag.name)?.end ?? t.length)
                : end
            // Emit BEFORE the stack moves: a `</code>` pop applied first would have
            // handed the span it closes to the markdown rewriter, which is the
            // opposite of what the tag means.
            emit(textEnd: lt, resume: resume)
            i = resume
            guard markup, verbatimTags.contains(tag.name) else { continue }
            if tag.closing {
                if let at = verbatim.lastIndex(of: tag.name) { verbatim.removeSubrange(at...) }
            } else if !isSelfClosing(t, from: lt, end: end) {
                verbatim.append(tag.name)
            }
        }
        emit(textEnd: t.length, resume: t.length)
        return out
    }

    /// Elements whose TEXT is a sample, not prose. (`<style>`, `<script>` and
    /// `<textarea>` need no entry: they are rawtext, so their whole body is already
    /// copied through as one region.)
    private static let verbatimTags: Set<String> = ["pre", "code"]

    /// Has this segment anything to DRAW?
    ///
    /// A `<style>` block the model writes BEFORE the card it styles is its own
    /// chunk — a blank line between the two is exactly a chunk boundary — and while
    /// streaming one chunk is one segment. So an all-CSS segment became a card row
    /// with nothing in it: an empty `richMinHeight` box sitting above the card the
    /// reader is watching it build, until the end of the turn coalesced the two.
    ///
    /// Nothing is lost by leaving that row out: `stylePrefix` has already COPIED
    /// every message-level `<style>` into every html segment of the message, so the
    /// rules reach the card whether or not their own chunk is on screen.
    ///
    /// "Nothing to draw" is deliberately narrow — an element with no text still
    /// draws (`<div class="chip"></div>` is a border and a background, `<hr>` is a
    /// line), so only these are invisible: `<style>`, `<script>`, comments, a
    /// doctype, and whitespace. Anything else, including a stray `<` the model
    /// wrote as prose, counts as content.
    static func hasRenderableContent(html: String) -> Bool {
        let t = Text(html)
        var i = 0
        var spanStart = 0
        func textInSpan(upTo hi: Int) -> Bool {
            var k = spanStart
            while k < hi {
                if !isWhitespaceUnit(t[k]) { return true }
                k += 1
            }
            return false
        }
        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            if textInSpan(upTo: lt) { return true }
            if t.matchesComment(at: lt) {
                let end = t.rangeOf("-->", from: lt + 4).map { $0.location + $0.length } ?? t.length
                spanStart = end
                i = end
                continue
            }
            if lt + 1 < t.length, t[lt + 1] == uBang { // <!DOCTYPE …>
                let end = t.indexOf(uGT, from: lt).map { $0 + 1 } ?? t.length
                spanStart = end
                i = end
                continue
            }
            // A `<` that opens nothing is a character the reader sees.
            guard let tag = tagName(t, at: lt) else { return true }
            let end = tagEnd(t, from: lt)
            guard end > 0 else { return false } // a tag still arriving draws nothing yet
            guard isMarkupTag(t.substring(lt..<end), tag.name) else { return true }
            guard tag.name == "style" || tag.name == "script" else { return true }
            let close = tag.closing
                ? end
                : (rawtextClose(t, from: end, name: tag.name)?.end ?? t.length)
            spanStart = close
            i = close
        }
        return textInSpan(upTo: t.length)
    }

    /// Nesting cap for the emphasis recursion. A reply never nests three deep; the
    /// cap is here so a text span of nothing but delimiters cannot recurse per pair.
    private static let emphasisDepthLimit = 6

    /// Any delimiter this transform understands, over UTF-8 bytes — the same reason
    /// `containsAngle` scans bytes rather than graphemes.
    private static func hasInlineMarker(_ text: String) -> Bool {
        for byte in text.utf8 where byte == uaStar || byte == uaUnderscore
            || byte == uaBacktick || byte == uaBracket {
            return true
        }
        return false
    }

    /// One text span, rewritten.
    ///
    /// Small and prefix-anchored on purpose, and the three rules that keep it from
    /// inventing emphasis in ordinary prose: a code span wins over emphasis (as in
    /// CommonMark), a delimiter run must HUG its content on both sides (so `2 * 3`
    /// and `40 * 40` open nothing), and `_` never opens or closes against a word
    /// character, which is what leaves `snake_case_names` and `__init__` alone.
    private static func renderInline(
        _ t: Text, _ lo: Int, _ hi: Int, depth: Int, into out: inout String
    ) {
        var plain = lo
        var i = lo
        while i < hi {
            let ch = t[i]
            if ch == uBacktick, let close = codeSpanClose(t, from: i + 1, hi: hi) {
                out += t.substring(plain..<i)
                out += "<code>" + escapedText(t.substring((i + 1)..<close)) + "</code>"
                i = close + 1
                plain = i
                continue
            }
            if ch == uStar || ch == uUnderscore {
                var run = 1
                while i + run < hi, t[i + run] == ch { run += 1 }
                let width = min(run, 3)
                if depth < emphasisDepthLimit,
                   canOpenEmphasis(t, at: i, afterRun: i + run, hi: hi, marker: ch),
                   let close = emphasisClose(t, from: i + run, hi: hi, marker: ch, width: width) {
                    out += t.substring(plain..<i)
                    // 3 is `***both***`; the delimiters nest, so the tags do too.
                    let tags = width == 3 ? ["strong", "em"] : (width == 2 ? ["strong"] : ["em"])
                    for tag in tags { out += "<\(tag)>" }
                    renderInline(t, i + run, close, depth: depth + 1, into: &out)
                    for tag in tags.reversed() { out += "</\(tag)>" }
                    i = close + width
                    plain = i
                    continue
                }
                i += run
                continue
            }
            if ch == uBracket, let link = linkSpan(t, from: i, hi: hi) {
                out += t.substring(plain..<i)
                out += "<a href=\"" + escapedAttribute(link.url) + "\">"
                renderInline(t, link.textLo, link.textHi, depth: depth + 1, into: &out)
                out += "</a>"
                i = link.end
                plain = i
                continue
            }
            i += 1
        }
        out += t.substring(plain..<hi)
    }

    /// The closing backtick of a `` `code` `` span: same line, non-empty content —
    /// the rule `CodeSkip` already uses for an inline span (`` `[^`\n]+` ``).
    private static func codeSpanClose(_ t: Text, from: Int, hi: Int) -> Int? {
        var i = from
        while i < hi {
            if t[i] == uNL { return nil }
            if t[i] == uBacktick { return i > from ? i : nil }
            i += 1
        }
        return nil
    }

    /// Can a delimiter run at `at` OPEN emphasis? It must be followed by content
    /// (not whitespace), and an `_` must not sit against a word character.
    ///
    /// `at - 1` deliberately reads the whole document, not just this span: the
    /// character before a span is markup (`…</b>_x_`), which is exactly the "not a
    /// word character" the flanking rule wants.
    private static func canOpenEmphasis(
        _ t: Text, at: Int, afterRun: Int, hi: Int, marker: unichar
    ) -> Bool {
        guard afterRun < hi, !isSpaceUnit(t[afterRun]) else { return false }
        if marker == uUnderscore, at > 0, isWordUnit(t[at - 1]) { return false }
        return true
    }

    /// Where the emphasis opened at `from - run` closes, or nil.
    ///
    /// An EXACT-length run wins over a longer one, which is what makes one common
    /// nesting read correctly: in `*a **b** c*` the `**` after `b` could close the
    /// single `*`, and taking it would leave the tail as literal asterisks — so the
    /// scan keeps going, finds the closing `*`, and the inner `**b**` is then handled
    /// by the recursion. It never crosses a blank line: emphasis cannot span a
    /// paragraph break, and a `<div>` holding two paragraphs of prose is one span.
    private static func emphasisClose(
        _ t: Text, from: Int, hi: Int, marker: unichar, width: Int
    ) -> Int? {
        var exact: Int?
        var longer: Int?
        var i = from
        while i < hi {
            if t[i] == uNL, blankLineFollows(t, from: i + 1, hi: hi) { break }
            guard t[i] == marker else { i += 1; continue }
            var run = 1
            while i + run < hi, t[i + run] == marker { run += 1 }
            let closes = i > from // non-empty content
                && !isSpaceUnit(t[i - 1]) // the run hugs its content
                && run >= width
                && (marker != uUnderscore || i + run >= hi || !isWordUnit(t[i + run]))
            if closes {
                if run == width { exact = i; break }
                if longer == nil { longer = i }
            }
            i += run
        }
        return exact ?? longer
    }

    /// Is `[from, …)` blank up to the next newline (or the span end)?
    private static func blankLineFollows(_ t: Text, from: Int, hi: Int) -> Bool {
        var i = from
        while i < hi {
            let ch = t[i]
            if ch == uNL { return true }
            guard ch == uSpace || ch == uTab || ch == uCR else { return false }
            i += 1
        }
        return true
    }

    /// `[text](url)` — one line, no nesting, no title. Anything else is left as the
    /// characters the model wrote.
    private static func linkSpan(
        _ t: Text, from: Int, hi: Int
    ) -> (textLo: Int, textHi: Int, url: String, end: Int)? {
        var i = from + 1
        while i < hi, t[i] != uRBracket, t[i] != uBracket, t[i] != uNL { i += 1 }
        guard i < hi, t[i] == uRBracket, i > from + 1 else { return nil }
        let textHi = i
        guard i + 1 < hi, t[i + 1] == uParenL else { return nil }
        var j = i + 2
        while j < hi, t[j] != uParenR, t[j] != uParenL, !isSpaceUnit(t[j]) { j += 1 }
        guard j < hi, t[j] == uParenR, j > i + 2 else { return nil }
        let url = t.substring((i + 2)..<j)
        guard isSafeLinkURL(url) else { return nil }
        return (from + 1, textHi, url, j + 1)
    }

    /// Schemes this transform is willing to MANUFACTURE an `<a href>` for.
    ///
    /// A `.content` document already runs with JavaScript off under
    /// `default-src 'none'`, so a `javascript:` href in it is inert — but markdown
    /// text is not markup, and turning text into a link the model never wrote as one
    /// is not this transform's call. Unknown scheme: leave the characters alone.
    private static func isSafeLinkURL(_ url: String) -> Bool {
        guard let colon = url.firstIndex(of: ":") else { return true } // relative, or `#anchor`
        let scheme = url[url.startIndex..<colon].lowercased()
        let schemeShaped = !scheme.isEmpty && scheme.allSatisfy { ch in
            (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "+" || ch == "." || ch == "-"
        }
        guard schemeShaped else { return true } // `path/to:thing` is not a scheme
        return ["http", "https", "mailto", "tel"].contains(scheme)
    }

    /// Text that is becoming element CONTENT (a code span). marked escapes the same
    /// three, so `` `&lt;` `` reads as the four characters the model typed on both
    /// surfaces.
    private static func escapedText(_ s: String) -> String {
        guard s.contains("&") || s.contains("<") || s.contains(">") else { return s }
        return s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Text that is becoming an ATTRIBUTE value, so the quote must not escape it.
    private static func escapedAttribute(_ s: String) -> String {
        guard s.contains("&") || s.contains("\"") || s.contains("<") else { return s }
        return s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
    }

    // MARK: - Chunking

    private struct Chunk {
        enum Kind { case md, html, app }
        let kind: Kind
        let text: String
    }

    /// `text` split into top-level chunks, each classified.
    ///
    /// A boundary is only ever a blank line at HTML depth 0, outside any code
    /// fence, not inside a multi-line construct — which is exactly a top-level
    /// block boundary, so each chunk parses to the same blocks it would have as
    /// part of the whole.
    private static func classifiedChunks(_ text: String) -> [Chunk] {
        let t = Text(text)
        let lines = Lines(t)
        let skip = CodeSkip(t, lines)
        let state = htmlState(t, lines, skip)

        var cuts: [Int] = []
        var hasContent = false // no chunk is ever pure whitespace
        var i = 0
        while i < lines.count {
            if !lines.isBlank(i, t) { hasContent = true; i += 1; continue }
            var runEnd = i
            while runEnd + 1 < lines.count, lines.isBlank(runEnd + 1, t) { runEnd += 1 }
            let next = runEnd + 1
            // A blank line at end-of-text is NOT a boundary: the successor line
            // that decides it has not arrived, and a cut made now could not be
            // taken back.
            if next >= lines.count { break }
            if hasContent, state.depth[i] == 0, !state.blocked[i], !skip.contains(lines.start(i)),
               cutHere(prev: i > 0 ? lines.text(i - 1, t) : "", next: lines.text(next, t)) {
                cuts.append(lines.start(next)) // the blank run belongs to the chunk it ends
                hasContent = false
            }
            i = runEnd + 1
        }

        var chunks: [Chunk] = []
        var start = 0
        for cut in cuts {
            chunks.append(makeChunk(t.substring(start..<cut)))
            start = cut
        }
        chunks.append(makeChunk(t.substring(start..<t.length)))
        return chunks
    }

    /// Does this line read as list content? Both forms of a loose list's interior:
    /// a bullet/ordered marker, or a continuation line indented under one.
    ///
    /// Monotone under append, which is what makes `cutHere` safe: a partial line
    /// can go from "not list content" (`-`) to "list content" (`- item`) as the
    /// delta lands, never the other way.
    private static func listish(_ line: String) -> Bool {
        var indent = 0
        var rest = Substring(line)
        while let first = rest.first, first == " " || first == "\t" {
            indent += 1
            rest = rest.dropFirst()
        }
        if indent >= 2, let first = rest.first, !first.isWhitespace { return true }
        guard let first = rest.first else { return false }
        if first == "-" || first == "*" || first == "+" {
            return rest.dropFirst().first?.isWhitespace == true
        }
        var digits = 0
        var scan = rest
        while let ch = scan.first, ch.isASCII, ch.isNumber { digits += 1; scan = scan.dropFirst() }
        guard digits > 0, let marker = scan.first, marker == "." || marker == ")" else { return false }
        return scan.dropFirst().first?.isWhitespace == true
    }

    /// Could this line still BECOME list content as more of it arrives?
    ///
    /// The monotone complement of `listish`: false means no possible continuation of
    /// this partial line can match, so the answer is already final. `<details>`
    /// (or any line whose first non-space character is not a list marker) is decided
    /// from its FIRST character; only a line that is still all indent, or sits on an
    /// unfinished marker (`-`, `12`, `12.`), is genuinely undecided.
    private static func listishPossible(_ line: String) -> Bool {
        var indent = 0
        var rest = Substring(line)
        while let first = rest.first, first == " " || first == "\t" {
            indent += 1
            rest = rest.dropFirst()
        }
        // Still nothing but indent: two more spaces and any glyph is list content.
        guard let first = rest.first else { return true }
        if indent >= 2 { return true } // already listish
        if first == "-" || first == "*" || first == "+" {
            guard let second = rest.dropFirst().first else { return true } // a space may follow
            return second.isWhitespace
        }
        var scan = rest
        var digits = 0
        while let ch = scan.first, ch.isASCII, ch.isNumber { digits += 1; scan = scan.dropFirst() }
        guard digits > 0 else { return false }
        guard let marker = scan.first else { return true } // `12` may still become `12.`
        guard marker == "." || marker == ")" else { return false }
        guard let after = scan.dropFirst().first else { return true }
        return after.isWhitespace
    }

    /// Cut at this blank line?
    ///
    /// A loose list keeps its blank lines INSIDE one chunk, otherwise per-chunk
    /// markdown renders one list as two (restarting `1.` numbering, breaking the
    /// spacing). That needs the NEXT line, which may still be arriving.
    ///
    /// Both inputs are therefore read only for facts that CANNOT change later:
    /// `prev` is a complete line (a blank line follows it), and `next` is judged by
    /// `listishPossible`, which can only go from true to false as characters land.
    /// So a cut can only ever APPEAR, never disappear, and it appears as early as
    /// the text allows.
    ///
    /// It used to defer on "is the successor line newline-terminated" instead, which
    /// made the decision depend on text that had not arrived: a reply's list
    /// followed by `<details>` put the card INSIDE the list's chunk (so the chunk
    /// was html, and the list rendered as literal `1.` text in a web view), and one
    /// character later the cut appeared and moved the list back out into the
    /// preceding markdown segment — a boundary moving BACKWARDS, which is exactly
    /// what the prefix invariant forbids.
    private static func cutHere(prev: String, next: String) -> Bool {
        if !listish(prev) { return true }
        return !listishPossible(next)
    }

    // MARK: - Classification

    private static func makeChunk(_ text: String) -> Chunk {
        let t = Text(text)
        let lines = Lines(t)
        let names = markupTagNames(t, CodeSkip(t, lines), firstOnly: false)
        // A `<script>` can only be rendered faithfully inside a sandboxed island,
        // so that decision belongs to the chunk, not the renderer.
        if names.contains("script") || appFence(t) != nil { return Chunk(kind: .app, text: text) }
        return Chunk(kind: names.isEmpty ? .md : .html, text: text)
    }

    /// The HTML an island should run: a fence's body, or the chunk as written.
    private static func extractAppHTML(_ text: String) -> String {
        appFence(Text(text))?.body ?? text
    }

    /// Has an island finished arriving?
    ///
    /// Mounting a half-written island would run half a script. "Is the chunk
    /// stable" is NOT the right test: a reply whose LAST block is the island never
    /// gets a successor line, so it stays the growing tail forever and a
    /// stable-only rule would leave it building for good. Completeness is a
    /// property of the text: the fence closed, or every element it opened is
    /// closed and no tag/comment is mid-arrival.
    private static func isAppComplete(_ text: String) -> Bool {
        let t = Text(text)
        if let fence = appFence(t) { return fence.closed }
        let lines = Lines(t)
        let state = htmlState(t, lines, CodeSkip(t, lines))
        return !state.truncated && state.endDepth == 0
    }

    /// Element names this text opens or closes as MARKUP, lowercased.
    ///
    /// ONE scanner backs both chunk classification and the `isRich` precheck, so
    /// the two can never disagree about what counts as a tag.
    private static func markupTagNames(_ t: Text, _ skip: CodeSkip, firstOnly: Bool) -> [String] {
        var names: [String] = []
        var i = 0
        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            i = lt + 1
            if skip.contains(lt) { continue }
            guard let tag = tagName(t, at: lt) else { continue }
            let end = tagEnd(t, from: lt)
            // A tag still arriving counts by what it has so far — classification
            // has to be right from the first delta, not only once the `>` lands.
            let raw = end < 0 ? t.substring(lt..<t.length) : t.substring(lt..<end)
            if isMarkupTag(raw, tag.name) {
                names.append(tag.name)
                if firstOnly { return names }
            }
            if end > 0 { i = end }
        }
        return names
    }

    // MARK: - Per-line HTML state

    private struct HTMLState {
        /// Element depth at the START of each line.
        var depth: [Int]
        /// True when a construct spans this line start (inside a multi-line tag, a
        /// comment, or a rawtext body) — such a line can never be a boundary.
        var blocked: [Bool]
        var endDepth: Int
        /// The text ends inside an unfinished construct.
        var truncated: Bool
    }

    /// Element depth and "blocked" flag at the start of every line.
    ///
    /// Depth comes from a STACK of open element NAMES: a closer unwinds to its own
    /// element or is ignored, and HTML5's implicit end tags are applied for the
    /// shapes a reply actually writes. `blocked` is what keeps the prefix invariant
    /// across an arriving `<div class="…` : while the tag is incomplete no boundary
    /// forms after it, and once its `>` lands the line is inside a tag, so still no
    /// boundary. Same answer before and after — nothing to unfreeze.
    private static func htmlState(_ t: Text, _ lines: Lines, _ skip: CodeSkip) -> HTMLState {
        var depth = [Int](repeating: 0, count: lines.count)
        var blocked = [Bool](repeating: false, count: lines.count)
        var stack: [String] = []
        var cursor = 0

        /// Record state for every line starting at or before `pos`.
        func assign(_ pos: Int, _ isBlocked: Bool) {
            while cursor < lines.count, lines.start(cursor) <= pos {
                depth[cursor] = stack.count
                blocked[cursor] = isBlocked
                cursor += 1
            }
        }
        func popTo(_ name: String) {
            if let at = stack.lastIndex(of: name) { stack.removeSubrange(at...) }
        }
        /// HTML5 implicit end tags, restricted to the shapes replies actually write.
        func closeImplied(_ name: String) {
            if name == "li" {
                if stack.last == "li" { stack.removeLast() }
            } else if name == "tr" || name == "td" || name == "th" {
                if stack.last == "p" { stack.removeLast() }
                while let top = stack.last, top == "td" || top == "th" || (name == "tr" && top == "tr") {
                    stack.removeLast()
                }
            }
            if blockTags.contains(name), stack.last == "p" { stack.removeLast() }
        }

        var i = 0
        while i < t.length {
            guard let lt = t.indexOf(uLT, from: i) else { break }
            assign(lt, false) // a line STARTING with this '<' carries the pre-tag state
            if skip.contains(lt) { i = lt + 1; continue }

            if t.matchesComment(at: lt) {
                guard let close = t.rangeOf("-->", from: lt + 4) else {
                    assign(t.length, true) // an unfinished construct swallows the rest
                    return HTMLState(depth: depth, blocked: blocked, endDepth: stack.count, truncated: true)
                }
                assign(close.location + 2, true)
                i = close.location + close.length
                continue
            }
            if lt + 1 < t.length, t[lt + 1] == uBang { // <!DOCTYPE …>
                guard let gt = t.indexOf(uGT, from: lt) else {
                    assign(t.length, true)
                    return HTMLState(depth: depth, blocked: blocked, endDepth: stack.count, truncated: true)
                }
                assign(gt, true)
                i = gt + 1
                continue
            }

            guard let tag = tagName(t, at: lt) else { i = lt + 1; continue }
            let end = tagEnd(t, from: lt)
            if end < 0 {
                assign(t.length, true)
                return HTMLState(depth: depth, blocked: blocked, endDepth: stack.count, truncated: true)
            }
            // Blocked BEFORE the markup question: a multi-line `<task-ref\n id=…/>`
            // is not an element, but a boundary inside it would still split the
            // pill in half.
            assign(end - 1, true)
            i = end
            guard isMarkupTag(t.substring(lt..<end), tag.name) else { continue }

            if tag.closing { popTo(tag.name); continue }
            closeImplied(tag.name)
            if voidTags.contains(tag.name) || isSelfClosing(t, from: lt, end: end) { continue }
            stack.append(tag.name)

            if rawtextTags.contains(tag.name) {
                guard let close = rawtextClose(t, from: end, name: tag.name) else {
                    assign(t.length, true)
                    return HTMLState(depth: depth, blocked: blocked, endDepth: stack.count, truncated: true)
                }
                assign(close.end - 1, true)
                popTo(tag.name)
                i = close.end
            }
        }
        assign(t.length, false)
        return HTMLState(depth: depth, blocked: blocked, endDepth: stack.count, truncated: false)
    }

    // MARK: - Tag scanning

    /// Is the `<…>` spanning `raw` real markup, or prose that only looks like a tag?
    ///
    /// Three prose shapes, each of which used to open a depth level that never
    /// closed: a scheme autolink (`<https://example.com/x>`), an email in angle
    /// brackets (`<user@host>` — no whitespace, so it cannot be a tag with
    /// attributes), and a generic parameter (`Array<T>`, `<string>`), which the
    /// element allowlist rejects.
    private static func isMarkupTag(_ raw: String, _ name: String) -> Bool {
        if refTags.contains(name) { return false }
        if isAutolinkForm(raw) { return false }
        if !raw.contains(where: \.isWhitespace), raw.contains("@") { return false }
        return knownElements.contains(name)
    }

    /// `<https://x>`, `<mailto:a@b>` — a markdown autolink, not an element.
    private static func isAutolinkForm(_ raw: String) -> Bool {
        var rest = Substring(raw)
        guard rest.first == "<" else { return false }
        rest = rest.dropFirst()
        if rest.first == "/" { rest = rest.dropFirst() }
        guard let first = rest.first, first.isASCII, first.isLetter else { return false }
        for ch in rest.dropFirst() {
            if ch == ":" { return true }
            let schemeChar = (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "+" || ch == "." || ch == "-"
            if !schemeChar { return false }
        }
        return false
    }

    /// Tag name (lowercased) and direction for the `<` at `at`, or nil when the
    /// `<` opens nothing — `a < b`, `<3`, `< div` are plain text.
    private static func tagName(_ t: Text, at: Int) -> (name: String, closing: Bool)? {
        var i = at + 1
        guard i < t.length else { return nil }
        var closing = false
        if t[i] == uSlash { closing = true; i += 1 }
        guard i < t.length, isASCIILetter(t[i]) else { return nil }
        let start = i
        while i < t.length, isNameChar(t[i]) { i += 1 }
        return (t.substring(start..<i).lowercased(), closing)
    }

    /// End index (exclusive) of the tag opened at `start`, quote-aware so a `>`
    /// inside an attribute value (`<div data-x="a>b">`) cannot end it early.
    /// Returns -1 when the tag is still arriving.
    private static func tagEnd(_ t: Text, from start: Int) -> Int {
        var quote: unichar = 0
        var i = start
        while i < t.length {
            let ch = t[i]
            if quote != 0 {
                if ch == quote { quote = 0 }
            } else if ch == uQuote || ch == uApos {
                quote = ch
            } else if ch == uGT {
                return i + 1
            }
            i += 1
        }
        return -1
    }

    /// `<br/>`, `<img src="x" />` — self-closing syntax.
    private static func isSelfClosing(_ t: Text, from lt: Int, end: Int) -> Bool {
        var i = end - 2 // step over the '>'
        while i > lt, isSpaceUnit(t[i]) { i -= 1 }
        return i > lt && t[i] == uSlash
    }

    /// The `</name>` that ends the rawtext body starting at `from`, or nil when the
    /// closer has not arrived. Case-insensitive and tolerant of `</style >`, and it
    /// cannot be fooled by markup-looking text in the body — inside rawtext the
    /// ONLY thing that ends the element is its own closer, so a `</div>` in CSS is
    /// a string.
    private static func rawtextClose(_ t: Text, from: Int, name: String) -> (at: Int, end: Int)? {
        var search = from
        while search < t.length {
            guard let found = t.rangeOf("</" + name, from: search, caseInsensitive: true) else { return nil }
            var i = found.location + found.length
            while i < t.length, isSpaceUnit(t[i]) { i += 1 }
            if i < t.length, t[i] == uGT { return (found.location, i + 1) }
            search = found.location + found.length
        }
        return nil
    }

    // MARK: - App fences

    private struct AppFence {
        let body: String
        let closed: Bool
    }

    /// Body of a ```html-app fence when the text is NOTHING BUT that fence.
    ///
    /// `html-app` is the explicit opt-in for "run this", so it must be the whole
    /// chunk: prose sitting after the closing fence would be swallowed by the
    /// island. A plain ```html fence is a code SAMPLE and stays markdown.
    ///
    /// Both the opener and the closer tolerate a `\r`: a CRLF stream otherwise left
    /// the closer unmatched forever, so a finished island stayed a "building…"
    /// placeholder for the rest of the session.
    private static func appFence(_ t: Text) -> AppFence? {
        var p = 0
        while p < t.length, isWhitespaceUnit(t[p]) { p += 1 }
        guard p < t.length else { return nil }
        let marker = t[p]
        guard marker == uBacktick || marker == uTilde else { return nil }
        var run = p
        while run < t.length, t[run] == marker { run += 1 }
        let fenceLen = run - p
        guard fenceLen >= 3 else { return nil }

        // Horizontal space only on both sides of the info string: the newline that
        // ends the opener line is a DELIMITER, and a scanner that treated it as
        // skippable whitespace consumed it and then rejected every fence it saw.
        var i = run
        while i < t.length, isHorizontalSpace(t[i]) { i += 1 }
        let info = "html-app"
        guard i + info.utf16.count <= t.length,
              t.substring(i..<(i + info.utf16.count)).caseInsensitiveCompare(info) == .orderedSame
        else { return nil }
        i += info.utf16.count
        while i < t.length, isHorizontalSpace(t[i]) { i += 1 }
        if i < t.length, t[i] == uCR { i += 1 }
        if i < t.length {
            guard t[i] == uNL else { return nil } // `html-appx` is a different info string
            i += 1
        }
        let bodyStart = i

        var lineStart = bodyStart
        while lineStart <= t.length {
            let lineEnd = t.indexOf(uNL, from: lineStart) ?? t.length
            if isCloserLine(t, lineStart: lineStart, lineEnd: lineEnd, marker: marker, minLen: fenceLen) {
                // The `(?:^|\n)` alternation: at the very start of the body the
                // closer matches on its own, otherwise it consumes the preceding
                // newline, which therefore does NOT belong to the body.
                let bodyEnd = lineStart == bodyStart ? lineStart : lineStart - 1
                let after = min(lineEnd + 1, t.length)
                // Fence + trailing prose: render the whole chunk as markdown
                // rather than swallowing the prose into the island.
                guard t.substring(after..<t.length).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return nil }
                return AppFence(body: t.substring(bodyStart..<bodyEnd), closed: true)
            }
            if lineEnd >= t.length { break }
            lineStart = lineEnd + 1
        }
        // Still streaming — no closer yet.
        return AppFence(body: t.substring(bodyStart..<t.length), closed: false)
    }

    /// Is `[lineStart, lineEnd)` a closing fence line (`^ {0,3}` marker run of at
    /// least `minLen`, then nothing but trailing spaces)?
    private static func isCloserLine(
        _ t: Text, lineStart: Int, lineEnd: Int, marker: unichar, minLen: Int
    ) -> Bool {
        var i = lineStart
        var indent = 0
        while i < lineEnd, t[i] == uSpace, indent < 3 { i += 1; indent += 1 }
        var run = 0
        while i + run < lineEnd, t[i + run] == marker { run += 1 }
        guard run >= minLen else { return false }
        var tail = i + run
        while tail < lineEnd {
            let ch = t[tail]
            guard ch == uSpace || ch == uTab || ch == uCR else { return false }
            tail += 1
        }
        return true
    }

    // MARK: - Code regions

    /// Offsets markdown renders as code, where a `<` is a SAMPLE and not markup.
    ///
    /// Only COMPLETE lines matter for the prefix invariant, and this is where that
    /// holds: an inline span cannot cross a newline, so once a line is
    /// newline-terminated its code ranges are final. The only mutable region is the
    /// last, still-growing line — always after every boundary being evaluated.
    private struct CodeSkip {
        /// Ascending, disjoint, merged — so a lookup is binary, not linear. The
        /// linear version was O(inline spans × block ranges) and measured 53ms per
        /// split on a 50KB inline-code-heavy reply, paid again on every delta.
        private let merged: [NSRange]

        init(_ t: Text, _ lines: Lines) {
            var ranges: [NSRange] = []
            var fenceMarker: unichar = 0
            var fenceLen = 0
            var fenceStart = 0
            var prevBlank = true

            for i in 0..<lines.count {
                let start = lines.start(i)
                let end = lines.end(i)
                let fence = CodeSkip.fenceMarker(t, start: start, end: end)
                if fenceMarker != 0 {
                    // A fence of 3+ backticks/tildes is closed only by the same
                    // character at >= its own length, so a ````-wrapped ``` sample
                    // stays protected end to end.
                    if let fence, fence.marker == fenceMarker, fence.len >= fenceLen {
                        ranges.append(NSRange(location: fenceStart, length: end - fenceStart))
                        fenceMarker = 0
                    }
                    continue
                }
                if let fence {
                    fenceMarker = fence.marker
                    fenceLen = fence.len
                    fenceStart = start
                    prevBlank = false
                    continue
                }
                if prevBlank, CodeSkip.isIndentedCode(t, start: start, end: end) {
                    ranges.append(NSRange(location: start, length: end - start))
                }
                prevBlank = lines.isBlank(i, t)
            }
            if fenceMarker != 0 { // an unclosed fence runs to EOF
                ranges.append(NSRange(location: fenceStart, length: t.length - fenceStart))
            }

            // Inline spans, tested against the block ranges by binary search.
            let blockCount = ranges.count
            var i = 0
            while i < t.length {
                guard t[i] == uBacktick else { i += 1; continue }
                var j = i + 1
                guard j < t.length, t[j] != uBacktick, t[j] != uNL else { i += 1; continue }
                while j < t.length, t[j] != uBacktick, t[j] != uNL { j += 1 }
                guard j < t.length, t[j] == uBacktick else { i = j; continue }
                if !CodeSkip.contains(ranges, blockCount, i) {
                    ranges.append(NSRange(location: i, length: j + 1 - i))
                }
                i = j + 1
            }

            ranges.sort { $0.location < $1.location || ($0.location == $1.location && $0.length < $1.length) }
            var merged: [NSRange] = []
            for range in ranges {
                if let last = merged.last, range.location <= last.location + last.length {
                    merged[merged.count - 1] = NSRange(
                        location: last.location,
                        length: max(last.location + last.length, range.location + range.length) - last.location
                    )
                } else {
                    merged.append(range)
                }
            }
            self.merged = merged
        }

        func contains(_ at: Int) -> Bool { CodeSkip.contains(merged, merged.count, at) }

        private static func contains(_ sorted: [NSRange], _ count: Int, _ at: Int) -> Bool {
            var lo = 0
            var hi = count - 1
            while lo <= hi {
                let mid = (lo + hi) / 2
                let range = sorted[mid]
                if at < range.location { hi = mid - 1 }
                else if at >= range.location + range.length { lo = mid + 1 }
                else { return true }
            }
            return false
        }

        /// `^ {0,3}(```+|~~~+)` — a fence opener/closer line.
        private static func fenceMarker(_ t: Text, start: Int, end: Int) -> (marker: unichar, len: Int)? {
            var i = start
            var indent = 0
            while i < end, t[i] == uSpace, indent < 3 { i += 1; indent += 1 }
            guard i < end else { return nil }
            let marker = t[i]
            guard marker == uBacktick || marker == uTilde else { return nil }
            var len = 0
            while i + len < end, t[i + len] == marker { len += 1 }
            return len >= 3 ? (marker, len) : nil
        }

        /// `^ {4,}\S` — an indented code block line (only after a blank line).
        private static func isIndentedCode(_ t: Text, start: Int, end: Int) -> Bool {
            var spaces = 0
            var i = start
            while i < end, t[i] == uSpace { spaces += 1; i += 1 }
            return spaces >= 4 && i < end
        }
    }

    // MARK: - Lines

    /// UTF-16 line spans. `start(i)` is line i's first offset; `end(i)` is its
    /// newline (or the text end), matching `split('\n')` exactly — including the
    /// trailing empty line a text ending in `\n` has.
    private struct Lines {
        private let starts: [Int]
        private let length: Int

        init(_ t: Text) {
            var starts = [0]
            for i in 0..<t.length where t[i] == uNL { starts.append(i + 1) }
            self.starts = starts
            self.length = t.length
        }

        var count: Int { starts.count }
        func start(_ i: Int) -> Int { starts[i] }
        func end(_ i: Int) -> Int { i + 1 < starts.count ? starts[i + 1] - 1 : length }
        func text(_ i: Int, _ t: Text) -> String { t.substring(start(i)..<end(i)) }

        /// `line.trim() === ''` without materialising the line.
        func isBlank(_ i: Int, _ t: Text) -> Bool {
            var at = start(i)
            let stop = end(i)
            while at < stop {
                guard isWhitespaceUnit(t[at]) else { return false }
                at += 1
            }
            return true
        }
    }

    // MARK: - UTF-16 text buffer

    /// One O(n) copy into a flat UTF-16 buffer, then O(1) random access.
    /// `NSString.character(at:)` is an ObjC message per character and the streaming
    /// path re-scans the whole reply every ~8Hz tick; the buffer keeps the scan
    /// O(n) with array-index constants and no per-tick regex compilation anywhere.
    private struct Text {
        private let ns: NSString
        private let units: [unichar]

        init(_ string: String) {
            let ns = string as NSString
            self.ns = ns
            if ns.length == 0 {
                self.units = []
            } else {
                var buffer = [unichar](repeating: 0, count: ns.length)
                buffer.withUnsafeMutableBufferPointer { pointer in
                    if let base = pointer.baseAddress {
                        ns.getCharacters(base, range: NSRange(location: 0, length: ns.length))
                    }
                }
                self.units = buffer
            }
        }

        var length: Int { units.count }
        subscript(_ i: Int) -> unichar { units[i] }

        func substring(_ range: Range<Int>) -> String {
            guard range.lowerBound < range.upperBound else { return "" }
            return ns.substring(with: NSRange(location: range.lowerBound, length: range.count))
        }

        func indexOf(_ unit: unichar, from: Int) -> Int? {
            var i = max(0, from)
            while i < units.count {
                if units[i] == unit { return i }
                i += 1
            }
            return nil
        }

        func rangeOf(_ needle: String, from: Int, caseInsensitive: Bool = false) -> NSRange? {
            guard from < units.count else { return nil }
            let options: NSString.CompareOptions = caseInsensitive ? [.literal, .caseInsensitive] : [.literal]
            let found = ns.range(
                of: needle, options: options,
                range: NSRange(location: from, length: units.count - from)
            )
            return found.location == NSNotFound ? nil : found
        }

        func matchesComment(at i: Int) -> Bool {
            i + 3 < units.count && units[i + 1] == uBang && units[i + 2] == uDash && units[i + 3] == uDash
        }
    }

    // MARK: - Character helpers

    private static let uTab: unichar = 9
    private static let uNL: unichar = 10
    private static let uCR: unichar = 13
    private static let uSpace: unichar = 32
    private static let uBang: unichar = 33
    private static let uQuote: unichar = 34
    private static let uApos: unichar = 39
    private static let uParenL: unichar = 40
    private static let uParenR: unichar = 41
    private static let uStar: unichar = 42
    private static let uDash: unichar = 45
    private static let uSlash: unichar = 47
    private static let uLT: unichar = 60
    private static let uGT: unichar = 62
    private static let uBracket: unichar = 91
    private static let uRBracket: unichar = 93
    private static let uUnderscore: unichar = 95
    private static let uBacktick: unichar = 96
    private static let uTilde: unichar = 126

    /// The same four delimiters as UTF-8 bytes, for the pre-scan that decides
    /// whether `inlineMarkdown` has to build a buffer at all.
    private static let uaStar: UInt8 = 42
    private static let uaBracket: UInt8 = 91
    private static let uaUnderscore: UInt8 = 95
    private static let uaBacktick: UInt8 = 96

    /// `[ \t]` — where a newline is a delimiter, not skippable whitespace.
    private static func isHorizontalSpace(_ unit: unichar) -> Bool {
        unit == uSpace || unit == uTab
    }

    /// `\s` — what the port's `\s*` matches inside a tag (`</style >`, `<br />`).
    private static func isSpaceUnit(_ unit: unichar) -> Bool {
        unit == uSpace || unit == uTab || unit == uNL || unit == uCR
    }

    private static func isWhitespaceUnit(_ unit: unichar) -> Bool {
        isSpaceUnit(unit) || unit == 11 || unit == 12
    }

    private static func isASCIILetter(_ unit: unichar) -> Bool {
        (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122)
    }

    /// A word character for the `_` flanking rule. Every non-ASCII unit counts as
    /// one: CJK and accented letters ARE letters, so `中文_强调_` gets the same
    /// intraword treatment CommonMark gives it, and the few non-ASCII punctuation
    /// marks that fall in with them only cost an emphasis this transform declines to
    /// make — the conservative direction.
    private static func isWordUnit(_ unit: unichar) -> Bool {
        isASCIILetter(unit) || (unit >= 48 && unit <= 57) || unit >= 128 || unit == uUnderscore
    }

    /// `[a-zA-Z0-9:-]` — the tag-name charset the port uses.
    private static func isNameChar(_ unit: unichar) -> Bool {
        isASCIILetter(unit) || (unit >= 48 && unit <= 57) || unit == uDash || unit == 58
    }

    // MARK: - Tag vocabulary

    /// Elements that never open a depth level.
    private static let voidTags: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr",
    ]

    /// Elements whose content is text, not markup: a `</div>` in CSS/JS is a STRING.
    /// (The server twin, pending-markup.ts, also lists `title`; it is absent from
    /// the web splitter's set, and this file follows the splitter so the two halves
    /// of one decision cannot drift.)
    private static let rawtextTags: Set<String> = ["style", "script", "textarea"]

    /// Walnut's own inline pill syntax, NOT model HTML — `MarkdownParser`
    /// rewrites these before anything renders. They are absent from
    /// `knownElements` too, so this is belt-and-braces; it is here to say WHY.
    private static let refTags: Set<String> = ["task-ref", "session-ref"]

    /// Block-level elements whose start tag implicitly ends an open `<p>`, per
    /// HTML5. A model writing `<p>a` … `<p>b` inside a `<div>` is legal HTML that
    /// leaves the div balanced; a scanner that nested the paragraphs would report
    /// depth 2 at the `</div>` and never come back to 0.
    private static let blockTags: Set<String> = [
        "p", "div", "ul", "ol", "li", "table", "section", "article", "blockquote",
        "pre", "h1", "h2", "h3", "h4", "h5", "h6", "details", "figure", "hr",
    ]

    /// Every element name that may affect structure — the sanitizer's default
    /// html + svg + mathml sets, plus the few that still nest in the SOURCE
    /// (`script`, `iframe`, document tags).
    ///
    /// The allowlist is the whole reason prose is safe: `Array<T>`, `Vec<u8>`,
    /// `<string>` and a bare `<https://example.com/x>` autolink all match "looks
    /// like a tag name".
    private static let knownElements: Set<String> = [
        // html
        "a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b",
        "base", "bdi", "bdo", "big", "blink", "blockquote", "body", "br", "button",
        "canvas", "caption", "center", "cite", "code", "col", "colgroup", "content",
        "data", "datalist", "dd", "decorator", "del", "details", "dfn", "dialog",
        "dir", "div", "dl", "dt", "element", "em", "embed", "fieldset", "figcaption",
        "figure", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
        "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input",
        "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark",
        "marquee", "menu", "menuitem", "meta", "meter", "nav", "nobr", "noscript",
        "ol", "optgroup", "option", "output", "p", "param", "picture", "pre",
        "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "section",
        "select", "shadow", "small", "source", "spacer", "span", "strike", "strong",
        "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
        "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "tt",
        "u", "ul", "var", "video", "wbr",
        // svg (camelCase names lowercased — tag matching is case-insensitive)
        "svg", "altglyph", "altglyphdef", "altglyphitem", "animate", "animatecolor",
        "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc",
        "ellipse", "feblend", "fecolormatrix", "fegaussianblur", "femerge",
        "femergenode", "feoffset", "filter", "foreignobject", "g", "glyph",
        "glyphref", "hkern", "image", "line", "lineargradient", "marker", "mask",
        "metadata", "mpath", "path", "pattern", "polygon", "polyline",
        "radialgradient", "rect", "set", "stop", "switch", "symbol", "text",
        "textpath", "tref", "tspan", "use", "view", "vkern",
        // mathml
        "math", "menclose", "merror", "mfenced", "mfrac", "mi", "mmultiscripts",
        "mn", "mo", "mover", "mpadded", "mphantom", "mroot", "mrow", "ms", "mspace",
        "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext",
        "mtr", "munder", "munderover", "semantics", "annotation",
    ]
}
