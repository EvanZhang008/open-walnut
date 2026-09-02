---
name: walnut-markdown-rendering
description: How Walnut turns model text into rendered output — the two marked instances and the CJK retunes registered on both, why we extend marked through its public API and never patch it, the rich-HTML block chunker's prefix invariant and blank-line content-model rule, DOMPurify policy per surface, and the marked 15 → 18 upgrade path. MUST read before changing anything in web/src/utils/markdown.ts, rich-blocks.ts, or adding a marked extension.
---

# Markdown & rich-HTML rendering

Every visible model reply goes through `web/src/utils/markdown.ts`. Rich (HTML) replies additionally go through `web/src/utils/rich-blocks.ts` before rendering. Both files are incident-dense: each rule below is a shipped bug.

## Hard rules

1. **Never patch, fork, or vendor `marked`.** It has a public extension API (`marked.use({ tokenizer }|{ extensions })`); use it. Verify before believing otherwise: both installed copies (`node_modules/marked` and `web/node_modules/marked`, both 15.0.12) are byte-identical to the published tarball, and `patches/` holds exactly one patch, for an unrelated package that has no public switch for what it does. A patched renderer has to be re-applied on every install and blocks every upgrade.
2. **There are TWO `Marked` instances. A retune must be registered on both.** The global singleton serves chat, the session timeline, the file/diff preview, the context inspector and copy-as-rich-text; `noteMarked` (bottom of the file) serves task notes. `marked.use()` mutates only the instance it is called on, so a fix applied to one silently leaves the other broken. Do NOT unify them: `noteMarked` escapes raw inline HTML, which would turn chat's pre-injected task-ref and file-link anchors into visible escaped text.
3. **A tokenizer override returns `undefined`, never `false`.** `false` means "fall through to marked's default", which resurrects the exact behavior the override removes. This has been mis-"fixed" before; the comments say so at each site.
4. **Only ADD, never reinterpret.** marked's emphasis flanking rules are a compiled regex built from its own Unicode punctuation classes. Rebuilding that regex locally is Walnut reinterpreting someone else's grammar. Prefer an extension that hands the decision back the moment marked would have made it (see `cjkStrongExtension`: the first genuinely right-flanking `**` returns `undefined`, so working emphasis can never be lengthened or reshaped).
5. **Blank-line collapsing is RENDER-TIME only.** The rich chunker must see the model's bytes exactly as they arrive, or its prefix invariant shifts and already-frozen blocks visibly jump. `collapseHtmlBlankLines` runs at the single render call site in `RichBlocks.tsx`, never inside the chunker.

## The CJK retunes (three, and why they keep happening)

marked's defaults assume words are separated by spaces. Chinese and Japanese prose has no such spaces, so three separate GFM/CommonMark rules misfire. All three live at the top of `markdown.ts` and are registered on both instances.

| Retune | Shape that broke | Rule at fault |
|---|---|---|
| `doubleTildeDelTokenizer` | `~550K objects … (~20 min rebuild)` struck out the whole span between two unrelated approximations | GFM `del` opens on a SINGLE `~`; GitHub itself needs `~~` |
| `cjkAwareUrlTokenizer` | `打开 https://a.com/x,个人账户,enroll` put half the sentence inside the anchor | autolinks only stop at whitespace |
| `cjkStrongExtension` | `**便签的比喻还成立。**之前我说:` printed four literal asterisks | CommonMark closes `**` only on a RIGHT-FLANKING run |

### The flanking rule, in detail (asked about more than once)

A `**` run preceded by punctuation and followed by an alphanumeric is not right-flanking, so it cannot close. English earns that rule (`**a.**b` is genuinely ambiguous). Chinese does not: a bold sentence ends in `。` or `?` and the next sentence starts immediately.

This is the **spec**, not a library bug. `marked` 15 and `markdown-it` (strict `commonmark` preset AND default config) return byte-identical output on `**中文。**后面` (plain), `**中文**后面` (bold) and `**a.**b` (plain). `commonmark/commonmark-spec` issue 650, "Emphasis with CJK punctuation", has been open since 2020-05-26 with 237 comments.

Only ONE shape is refused: `。**` followed by a space, a newline, or more punctuation all close correctly. That is why a broken reply still shows mostly-correct bold and only some clauses fail, which reads like an intermittent regression and is not one.

### The upstream plugin, and why we are not on it yet

`tats-u/markdown-cjk-friendly` (by the person driving the spec change) ships opt-in plugins: `markdown-it-cjk-friendly`, `remark-cjk-friendly`, `micromark-extension-cjk-friendly`, and `marked-cjk-friendly`. Measured 2026-09-02:

- On our **marked 15.0.12 it throws** (`rules.inline.delLDelim` is an internal rule that only exists in later marked; its declared peer range `marked >= 15` is wrong).
- On **marked 18.0.11 it works** and covers more than our extension does: `*em*`, `__strong__`, `~~del~~`, `***both***`. Ours covers `**` only, which is what models actually write.
- marked 18 also changed `~~中文。~~后面` from `<del>` (15's behavior) to literal, so **upgrading marked without the plugin regresses CJK strikethrough**. The two changes must land together.

Path if picked up: bump marked 15 → 18, adopt `marked-cjk-friendly`, delete `cjkStrongExtension`, and use `tests/web/markdown/cjk-strong.test.ts` unchanged as the acceptance gate.

## Rich HTML blocks (`rich-blocks.ts`)

- `splitRichChunks` is dependency-free and holds one invariant: the stable chunks of any prefix are an element-wise prefix of the stable chunks of the full text (fuzz-verified). Freezing in `RichBlocks.tsx` works by keeping the `__html` string identical so React skips the DOM write, so any byte change upstream un-freezes a block in the user's face.
- `collapseHtmlBlankLines` deletes a blank line only when it sits **directly inside an element whose content model has no room for a paragraph** (`NO_PARAGRAPH_CHILDREN`: SVG containers plus table/list/select structure). Reason: a blank line ends a CommonMark raw-HTML block, and an indented line after it becomes an indented code block, which is how half of a two-column SVG once rendered as visible `<rect …/>` source. It is NOT "delete every blank line in markup": inside `div`/`td`/`li` a paragraph is legal and the browser reassembles the intent, and in `<pre>` the blank line IS content. The discriminator is destructive vs merely lossy.
- Unfinished markup at an interrupt belongs to the text that will finish it: `splitPendingMarkup` (`src/core/stream/pending-markup.ts`, zero imports, aliased) holds the fragment so a bookkeeping card cannot cut an element in half. Four mirrors share that one rule (browser reducer, `useSessionStream`, `session-cache`, and the server twin `session-stream-buffer`); fixing only the client makes the artifact reappear after a refresh.

## DOMPurify policy per surface

- Sanitize with `FORCE_BODY: true` on the rich path. Default `false` parses a leading `<style>` into `head` and drops it, and models naturally write style first.
- `<style>` survival is one flag, not a per-surface decision: `FORBID_TAGS: allowStyle ? ['form'] : ['form', 'style']` in `markdown.ts`. Only the rich-chunk path passes `allowStyle`, and only after `rich-css-scope.ts` has rewritten selectors to the message-level `[data-rblk]`. Everything else (plan popup, thinking, tool results, cards, triage, diff) gets `style` stripped. Scoping at BLOCK level is wrong: a `<style>` in chunk 1 must still match markup in chunk 2.

## Tests

`vitest.markdown.config.ts` is the **only** tier where real `marked` and `dompurify` resolve (they live in `web/node_modules`; the config aliases them and installs a linkedom window). Elsewhere they are unavailable or a passthrough, so sanitizer assertions belong in the Playwright layer instead.

| What | Where |
|---|---|
| Renderer behavior, CJK shapes, sanitize | `tests/web/markdown/*.test.ts` (`npm run test:focus tests/web/markdown`) |
| Chunker invariants, blank-line collapsing | `tests/web/rich-blocks.test.ts` |
| Interrupt carry, both sides | `tests/web/session-stream-buffer-pending-markup.test.ts`, `tests/core/stream/*` |
| Real pipeline, real browser | `tests/e2e/browser/rich-html-streaming.spec.ts` |

Every fix here should carry a negative control: neuter the fix and confirm the browser test fails. Two are recorded in that spec (blank line inside `<svg>`, and a card landing mid-tag).

## File map

| File | Role |
|---|---|
| `web/src/utils/markdown.ts` | all markdown rendering; retunes and both `Marked` instances at top and bottom |
| `web/src/utils/rich-blocks.ts` | chunker, blank-line collapsing, app-block detection |
| `web/src/utils/rich-css-scope.ts` | `<style>` selector rewriting to message scope |
| `web/src/components/chat/RichBlocks.tsx` | the single render call site; block freezing |
| `src/core/stream/pending-markup.ts` | unfinished-markup split, shared by client and server |
| `src/core/sessions/output-mode.ts` | edge-triggered markdown/rich instruction injection |
