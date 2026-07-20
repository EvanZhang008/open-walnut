# Notes / PKM Redesign — Frontend Editor Architecture (TipTap / ProseMirror)

> **Scope rule (inherited):** Markdown files on disk are the source of truth. The editing experience is
> the **#1 priority** — every tradeoff below resolves in favor of editing quality and the "no data loss /
> no jank / byte-clean Markdown" bar. This is a **design doc**: extension list, configs, data contracts,
> round-trip contracts, and pseudocode only — no full implementation.
>
> **Inputs (read first-hand):** `web/src/components/notes/NotesEditor.tsx` (610 LOC), the
> `slash-commands/` + `wiki-link/` folders, `web/src/utils/markdown.ts`, `notes-markdown.ts`,
> `ux-decision.md` (winning UX = Approach C spine + A feel + B backbone), and the sibling
> `02-search-and-index-design.md` (owns identity + sidecar — this doc must not contradict it).

---

## Executive Summary

- **Problem.** The editor is a solid TipTap 3.x base but the slash menu only inserts *task references*,
  there are **no tables, no tags, no callouts, no block drag-handle, no bubble menu**, and `[[wikilinks]]`
  resolve by **basename** (collision-prone, rename rewrites the whole vault). New blocks risk breaking the
  delicate hand-rolled list logic (`TightTaskList`, `tryJoinPreviousListAndSink`, `detachListItemChildren`,
  custom Tab/ArrowUp `handleKeyDown`) and, worse, breaking the Markdown round-trip — which is the single
  biggest bug source because **Markdown is the storage format**.
- **What we'll build.** Add five capabilities by *extending* the existing engine: (1) evolve the
  one-entry `SlashCommandExtension` into a Notion-style **block-insert menu**; (2) add the first-party
  `@tiptap/extension-table` family — pipe tables round-trip *for free* through the table serializer that
  `tiptap-markdown` already ships; (3) add `@tiptap/extension-bubble-menu` (selection toolbar) and
  `@tiptap/extension-drag-handle-react` (the `⠿` grip + `＋`); (4) build two tiny custom nodes — a `#tag`
  inline node (clone of the `[[` trigger) and a `> [!note]` **callout** — each with one explicit
  `tiptap-markdown` serialize/parse rule; (5) make the wiki-link autocomplete **insert the stable-id form
  under the hood** (`[[Title|n_id]]`, displayed as `[[Title]]`) to match the backend identity contract.
- **Simplest first step (ships a Notion feel day one, zero new dependencies).** Swap the single-entry
  `NOTE_SLASH_COMMANDS` array for a real block list and add a per-block command dispatch in the existing
  portal. Heading / list / quote / code / divider / to-do all insert through commands TipTap already has.
  No new package, no round-trip risk — the slash *machinery* already exists and is proven.
- **Root-cause fixes (not patches).** (a) Custom-node round-trips go through `tiptap-markdown`'s
  **per-extension `addStorage().markdown` serialize/parse hook** — the same mechanism the library uses for
  its own nodes — so there is *one* tested serialization path per block, never an ad-hoc post-processor.
  (b) Link identity moves from basename to a **stable id carried in the link** (`[[Title|n_id]]`), killing
  the collision + whole-vault-rewrite bug class at its root. (c) **Frontmatter is parsed out before the
  editor sees it and re-attached on save** — it is metadata, never editable body — so the id line can never
  be corrupted by editing.
- **User-visible outcome.** A block-based WYSIWYG that feels like Notion: type `/` for any block, drag the
  `⠿` grip to reorder, select text for a floating format bar, build real tables with `Tab`-driven cell
  nav, drop `#tags` inline, write callouts — and every one of those saves to clean, portable, git-friendly
  Markdown that reopens byte-identical. "All the good features and no bug."

---

## 0. Grounding — what the code actually does today (verified first-hand)

| Concern | Today | Evidence |
|---|---|---|
| Editor core | TipTap **3.20.1** (`@tiptap/*` + `tiptap-markdown@0.9.0`), web deps in `web/node_modules` | `web/package.json`; `web/node_modules/@tiptap/core/package.json` = 3.20.1 |
| Storage format | Markdown. `editor.storage.markdown.getMarkdown()` on every save; `Markdown.configure({ html:true })` | `NotesEditor.tsx:325,504` |
| Slash menu | **One entry** (`task`), opens a task-search sub-panel — not a block menu | `slash-commands/types.ts:20`; `SlashCommandPortal.tsx:83` |
| Slash machinery | `findSlashTrigger()` → tracked `range{from,to}` → `{phase:'commands',range,query}` → portal does `.deleteRange(range).insertContent(...)` at `coordsAtPos(range.from)` | `SlashCommandExtension.ts:24,86`; `SlashCommandPortal.tsx:53,102` |
| Wiki-link | `[[` trigger, same detect→range→autocomplete shape; commits **plain `[[name]]` text**; resolves by **basename** | `WikiLinkExtension.ts`; `NotesEditor.tsx:557` |
| Tables / tags / callouts / drag-handle / bubble | **None installed** | `@tiptap/extension-table` etc. = NOT INSTALLED |
| Markdown round-trip engine | `tiptap-markdown` uses `markdown-it@14.1.1` (parse) + `prosemirror-markdown` (serialize); collects per-extension specs via `getMarkdownSpec(ext) = ext.storage.markdown` | `web/node_modules/tiptap-markdown/src/util/extensions.js`; `src/serialize/MarkdownSerializer.js:58` |
| **Tables round-trip for free** | `tiptap-markdown` **ships** a table node serializer (GFM pipe, detects header row) **and** markdown-it **enables `table` by default** | `tiptap-markdown/src/extensions/nodes/table.js`; `md.block.ruler` includes `table` |
| Hand-rolled fragility | `TightTaskList`, `tryJoinPreviousListAndSink`, `detachListItemChildren`, custom Tab/ArrowUp `handleKeyDown`, `isSourceRef` save-sync guard with cursor/scroll restore | `NotesEditor.tsx:57,120,197,419,494` |
| Read-only render path | Separate: `marked + DOMPurify` (`notes-markdown.ts`, `markdown.ts`) — **NOT** TipTap | `notes-markdown.ts:22` |
| Semantic index | `getNotesStore()` (QMD) indexed by `qmd-watcher.ts` (debounced fs.watch → `store.update()+embed()`), today only under PARA folders | `qmd-store.ts:60`; `qmd-watcher.ts:42` |

**Two engines, one contract.** The editor (TipTap) and the read-only viewer (`marked`) are independent
parsers. Anything we add must round-trip through **both**: TipTap for editing fidelity, `marked` for the
rendered view (search snippets, backlinks panel, mobile). Where they can diverge (callout admonitions,
tags), the doc names the rule for each. This is an explicit, named risk — see §5.

---

## 1. Target architecture (additive — no rewrite)

```
                     NotesEditor.tsx  (stays the single editor component)
                              │
          ┌───────────────────┼─────────────────────────────────────────────┐
          │                   │                                              │
   EXISTING (keep)      EVOLVE (1 file)                          ADD (new, additive)
   ─────────────        ───────────────                          ──────────────────
   StarterKit           SlashCommandExtension  ───────────▶  BlockMenu command registry
   TightTaskList          (trigger unchanged;                  (one list → many entries,
   TaskItem                swap command list +                  each = an editor.chain())
   Placeholder             add dispatch)                       Table family (@tiptap/extension-table,
   Image                                                          -row, -cell, -header)  [buys it]
   Markdown(tiptap-md)  WikiLinkExtension  ───────────────▶   BubbleMenu (@tiptap/extension-bubble-menu)
   TaskAwareLink          (insert [[Title|n_id]]                DragHandle (@tiptap/extension-
   custom handleKeyDown    under the hood)                       drag-handle-react)  [buys grip + ＋]
   isSourceRef guard                                           TagNode (custom inline node + suggestion)
                                                               Callout (custom block node)
                                                               Frontmatter strip/reattach (wrapper, not a node)
                              │
                    editor.storage.markdown.getMarkdown()  ──▶  byte-clean Markdown  ──▶  PUT /content
                              │
              ┌────────────────┴───────────────┐
       per-extension addStorage().markdown    one shared "block transforms" module
       { serialize, parse } hooks             (turnInto / insert / move / delete) —
       (the ONLY round-trip path per block)   called by slash + bubble + grip menus
```

**Design principle (from `ux-decision.md`): one transform, three surfaces.** Slash menu, bubble
"Turn into", and grip block-menu all call the **same** node-conversion commands. One tested code path,
one mental model. No surface gets its own bespoke insert/convert logic.

---

## 2. Extensions to ADD — exact packages, versions, configs

All new `@tiptap/*` packages publish on the **same 3.x major** as the installed base (3.26.0 available;
we run 3.20.1 — bump the whole `@tiptap/*` set to a single matching minor in one `npm install` to avoid
skew; `tiptap-markdown@0.9.0` is compatible with TipTap 3.x). Install into **`web/`** (deps live in
`web/node_modules`).

### 2.1 Tables — `@tiptap/extension-table` + `-table-row` + `-table-cell` + `-table-header`

```ts
// pseudocode — config intent, not final code
Table.configure({
  resizable: true,            // column resize handles (Notion-like)
  HTMLAttributes: { class: 'notes-table' },
  // allowTableNodeSelection: lets the grip select the whole table as one block
}),
TableRow,
TableHeader,
TableCell,
```

- **Cell content constraint (round-trip-critical):** restrict cell content to **inline + hard-break
  only** (no nested lists/blocks inside a cell). Rationale, confirmed in source: `tiptap-markdown`'s table
  serializer (`isMarkdownSerializable`) **falls back to raw HTML** if any cell has `childCount > 1`,
  colspan/rowspan, or a header cell in a body row. HTML fallback = non-portable, non-byte-clean Markdown =
  the #1 bug. Constraining cells to inline content **guarantees** the GFM-pipe path is always taken. This
  matches what Notion-grade tables need anyway, and the UX doc already froze this contract (§6).
- **No colspan/rowspan / no merged cells in v1** — they force the HTML fallback. Defer to a later phase.
- **Header row:** `/table` inserts 3×3 **with a header row** (caret in first *body* cell). The serializer
  detects the header row and emits the `| --- | --- |` delimiter automatically — no extra work.

### 2.2 Bubble (selection) menu — `@tiptap/extension-bubble-menu`

```ts
BubbleMenu.configure({
  // shouldShow: show only for non-empty text selections; swap to TABLE ops
  //   when the selection is inside a table (cell/multi-cell) — see §6.
  // The React UI for the floating bar is a separate component anchored by the extension.
})
```

- Buttons call **existing marks** (bold/italic/strike/inline-code/link) and the **shared block
  transforms** (Turn into H1/H2/H3, quote, code, callout). It must not introduce a second conversion
  path — it reuses §3.4's module.
- **Pure DOM overlay** driven by current selection; it does **not** re-render the doc (typing latency
  unaffected — the "no-jank" contract).

### 2.3 Block drag-handle + inserter — `@tiptap/extension-drag-handle-react`

**Recommendation: BUY the off-the-shelf `@tiptap/extension-drag-handle-react`, do NOT hand-roll a
ProseMirror plugin or per-block NodeView.** Reasons, grounded in this codebase:

- Drag-reorder and floating gutter affordances are *exactly* the ProseMirror surface where our existing
  hand-rolled list code (`detachListItemChildren`, `tryJoinPreviousListAndSink`) proves subtle position-
  math bugs breed. The UX doc names this the **single largest new-bug surface** against the #1 priority.
- A NodeView approach would force every block type to participate, fighting the StarterKit nodes and the
  custom task-list logic. The drag-handle extension is a *single global widget* positioned by the current
  hovered block — it does not wrap nodes, so it composes cleanly with everything already there.
- It is first-party and on the same major, so no schema/serialization coupling.

```ts
DragHandle.configure({
  // render the ⠿ grip into the left gutter of the hovered block
  // (fixed left-x; occupies the existing gutter so text never shifts)
})
```

- **`⠿` grip:** click selects the whole block + opens the **block-actions menu** (Turn into / Duplicate /
  Color / Delete / Move up·down). Press-drag lifts the block; a **2 px snap line** marks the nearest gap;
  drop reorders; `Esc` cancels. (A's feel contracts: ~80–120 ms hover-in delay to avoid flicker; grace
  zone so moving onto the rail doesn't dismiss it.)
- **`＋` inserter:** a sibling widget next to the grip; click opens the **same slash menu**, anchored to
  insert a block *below* the hovered one. One menu, two entry points (typed `/` and `＋`).
- **Drop must produce clean Markdown** (no blank-line litter). Because reorder is a normal ProseMirror
  transaction routed through `onUpdate`, it rides the existing `isSourceRef` save path — see §7.

### 2.4 `#tag` — **custom inline `Node`** (not a Mark) + suggestion plugin

**Recommendation: an atomic inline `Node` (a "chip"), NOT a Mark.** A Mark would let the cursor sit
*inside* the tag text and let backspace half-delete it into broken text; the UX doc froze "backspace
selects the whole chip first." An atomic inline node gives us that behavior natively (selectable as a
unit) and a clean place to hang the click handler (open the tag view).

```ts
// TagNode (pseudocode)
Node.create({
  name: 'tag',
  group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes: () => ({ name: { default: '' } }),       // the tag text without '#'
  parseHTML: () => [{ tag: 'span[data-tag]' }],
  renderHTML: ({ node }) => ['span', { 'data-tag': node.attrs.name, class: 'notes-tag' }, `#${node.attrs.name}`],
  // NodeView optional — a styled <span> chip; click → onTagClick(name)
  addStorage: () => ({ markdown: {
    serialize(state, node) { state.write(`#${node.attrs.name}`); },   // ← disk form: literal #tag text
    parse: { /* see §4.3 — markdown-it inline rule that turns #tag into this node */ },
  }}),
})
```

- **Trigger (3rd clone of the proven shape):** `#` at line start or after whitespace, **immediately
  followed by a letter**. This disambiguates from `#1` in "issue #123" and a lone `# ` heading shortcut.
  Reuse the `WikiLinkExtension` plugin structure (`view().update` → walk `textBefore` → emit
  `{phase,range,query}`) — *do not* invent a new mechanism.
- **Autocomplete:** existing vault tags ranked **by frequency** (steers reuse → `#q3-planning` not
  `#Q3Planning`); a "+ Create `#…`" row is always last. Tag list comes from the backend tag index
  (sibling doc §3) via a `GET /api/notes-v2/tags` call; until that lands, derive from the notes `/list`
  + a cheap client scan.
- **Render vs. disk (the round-trip contract):** renders as a styled inline **chip**; on disk it is
  **literal `#tag` text**. Nothing extra is written to the file → round-trips byte-clean **and** stays
  greppable by the string index and matchable by `marked` in the read-only view. (The read-only viewer
  doesn't need a tag node — `#tag` is just text there, optionally styled by a `marked` post-pass.)
- **Backspace into a committed chip** selects the whole chip first (one more `⌫` deletes it). Atom node
  gives this for free.

### 2.5 Callout — **custom block `Node`** with a frozen admonition serializer

```ts
// Callout (pseudocode) — a labeled blockquote variant
Node.create({
  name: 'callout',
  group: 'block', content: 'block+',
  addAttributes: () => ({ kind: { default: 'note' } }),   // note | tip | warning | …
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node }) => ['div', { 'data-callout': node.attrs.kind, class: `notes-callout notes-callout-${node.attrs.kind}` }, 0],
  addStorage: () => ({ markdown: {
    serialize(state, node) {
      // Obsidian/GFM admonition form:  > [!note]\n> body...
      state.write(`> [!${node.attrs.kind}]`); state.ensureNewLine();
      state.wrapBlock('> ', null, node, () => state.renderContent(node));
    },
    parse: { /* §4.4 — markdown-it rule recognizing  > [!kind]  blockquotes → callout node */ },
  }}),
})
```

- **Disk form (frozen):** `> [!note]` admonition blockquote (Obsidian-compatible, widely portable). This
  is the **single most custom serialization** in the whole design — test effort concentrates here.
- **Read-only viewer parity:** `marked` renders `> [!note]` as a plain blockquote with literal `[!note]`
  text. Add a small `marked`/post-DOM pass in `notes-markdown.ts` to style admonition blockquotes (detect
  a leading `[!kind]` in the first line) so the rendered view matches the editor. Named risk — §5.

### 2.6 Divider, and "all basic styles" — **reuse, zero new code**

- **Divider:** StarterKit `HorizontalRule` (`---`), already round-trips. Slash entry just calls
  `setHorizontalRule()`.
- **Bold / italic / strike / inline-code / headings (H1–H3) / bullet / ordered / blockquote / checklist
  / links:** all already present via StarterKit + `TightTaskList` + `TaskAwareLink`. The slash menu and
  bubble menu only need to *call* their existing commands. **Markdown shortcuts stay on** (`# `, `- `,
  `> `, ` ``` `, `[] `) as the expert path — they produce the *same* nodes as the slash path, so the data
  never forks between a Markdown-typist and a WYSIWYG-clicker.

### 2.7 Frontmatter — handled by a **wrapper, not an editor node** (root-cause)

The sibling doc puts a **stable `id` in YAML frontmatter**. The editor must never expose that block as
editable body (a stray edit could corrupt the id and orphan every backlink). Therefore:

- **On load:** split the file into `{ frontmatter, body }` (parse the leading `---\n…\n---` block). Feed
  **only `body`** to `editor.commands.setContent(...)`. Stash `frontmatter` in a ref.
- **On save:** re-attach the stashed frontmatter verbatim in front of `getMarkdown()` before `PUT`.
- This is a **pure string wrapper around the existing save/load**, not a ProseMirror node. It guarantees
  the id round-trips byte-for-byte and is unreachable by editing. (A future "properties panel" can edit
  frontmatter through a dedicated UI, still outside the body.) **Non-goal for v1:** a frontmatter
  *editing* node (deferred per UX doc §12).

---

## 3. Slash menu — evolve, don't replace (the day-one win)

The trigger, range tracking, positioning (`coordsAtPos`), above/below flip, click-outside, and
capture-phase keyboard nav **all already exist and are correct**. Three concrete changes, all additive:

### 3.1 Replace the command list (`slash-commands/types.ts`)

```ts
// today: NOTE_SLASH_COMMANDS = [ { name:'task', action:'task-search' } ]
// new: a real block catalog, grouped (Basic / Lists / Blocks / Reference)
type BlockCommand = {
  name: string; aliases: string[];     // 'h1' aliases ['heading','title'] for fuzzy hits
  description: string; icon: string;
  group: 'basic' | 'lists' | 'blocks' | 'reference';
  run: (editor, range) => void;        // editor.chain().focus().deleteRange(range).<cmd>().run()
};
// Basic:     Text, H1, H2, H3
// Lists:     Bullet, Numbered, To-do (TightTaskList), Quote
// Blocks:    Divider, Code, Callout, Table, Image
// Reference: Task reference (today's sub-panel), Link to note ([[ flow)
```

### 3.2 Add dispatch in the portal (`SlashCommandPortal.tsx`)

Today `handleCommandSelect` only branches to `task-search`. Generalize: if the chosen command has a
`run`, call `cmd.run(editor, rangeRef.current)` and `onClose()`; the two **Reference** entries keep their
existing sub-panel behavior (task search / `[[` autocomplete). **Insertion is byte-clean:**
`deleteRange(range)` removes the `/query` text, the block lands in its place, caret goes *inside* it
(first table cell, inside the heading). Never leave a trailing space or blank line.

### 3.3 Upgrade the filter to **fuzzy** (`SlashCommandMenu.tsx`)

Today it's `startsWith`. Change to a small fuzzy/subsequence match over `name` + `aliases` so `/cl`→
Callout and `/ck`→Checklist work (UX doc §5). Everything else in `SlashCommandMenu.tsx` (keyboard nav,
`onMouseDown preventDefault` to keep editor focus, empty state) is kept verbatim.

### 3.4 The shared block-transforms module (new, tiny)

A single module exporting `turnInto(editor, blockType, attrs?)`, `insertBlock(editor, blockType, range?)`,
`moveBlock`, `duplicateBlock`, `deleteBlock`. Slash `run`, bubble "Turn into", and grip block-menu all
import from here. **One path = one set of round-trip tests.**

---

## 4. Markdown round-trip — the #1 bug source, and how each block stays lossless

**The mechanism (verified in source).** `tiptap-markdown` resolves a serializer/parser for every
extension via `getMarkdownSpec(ext) = { ...defaultSpec, ...ext.storage.markdown }`
(`util/extensions.js`). So **any custom node/mark that defines `addStorage().markdown.{serialize, parse}`
participates in the same single serialize/parse pipeline as the built-ins** — there is no separate
post-processor to keep in sync. Serialize uses a `prosemirror-markdown` `MarkdownSerializerState`
(`state.write`, `state.renderInline`, `state.wrapBlock`, `state.ensureNewLine`, `state.closeBlock`);
parse uses a `markdown-it` instance you extend via `parse.setup(md)` (add an inline/block rule) and
optionally `parse.updateDOM(el)`.

### 4.1 Round-trip risk register (call these out — they are where bugs live)

| Block | Disk form | Round-trip risk | Strategy to keep it lossless |
|---|---|---|---|
| **Table** | GFM pipe `\| a \| b \|` | Falls back to **raw HTML** if any cell has block children / colspan / rowspan / header-in-body → non-portable | **Constrain cell content to inline + hard-break** (schema-level). Forbid merged cells in v1. Then `isMarkdownSerializable` is always true → always pipe form. Regression test: create→edit→reload diff = 0 bytes. |
| **`#tag`** | literal `#tag` text | A Mark would let `#` text drift / split across nodes; markdown-it could swallow `#` as heading at line start | Atomic inline **Node**; serialize = `#${name}`; parse rule **only** fires on `#` + letter **not at line start preceded by nothing** (heading `# ` keeps winning). Stays plain text to `marked`. |
| **Callout** | `> [!kind]\n> body` | The *only* fully-custom serializer; nested blocks inside the callout must keep `> ` prefix; parser must not capture an ordinary blockquote | `wrapBlock('> ', …)` for the body; parse rule requires the **first line** to be exactly `[!kind]`. Plain blockquotes (no `[!…]`) stay blockquotes. Test both directions + a blockquote-that-looks-like-a-callout. |
| **Task list** | `- [ ] ` / `- [x] ` | Historic: "loose" lists re-inserted blank lines every save (the `TightTaskList` saga) | **Keep `TightTaskList` exactly as is.** Do not let any new block change list tightness. It's in the regression suite. |
| **Wiki-link** | `[[Title\|n_id]]` | Adding the `\|n_id` alias must not break display or `marked` rendering; the id must survive | Authoring inserts the alias form as **plain text** (as today's `[[name]]` is plain text); `marked`/read-only renders `[[Title]]` (strip the `\|n_id` in the viewer). Round-trip is trivial — it's literal text. |
| **Images** | `![](url)` / `<img>` | `Markdown({ html:true })` already needed for `<img>`; base64 paste path exists | Unchanged — keep `Image.configure({ inline:true, allowBase64:true })` + the existing upload/paste/drop handlers. |
| **Frontmatter** | `---\n…\n---` | A stray body edit could corrupt the `id` | **Never an editor node** (§2.7). Stripped on load, re-attached verbatim on save. |

### 4.2 The acceptance gate (frozen — a P0 quality gate, from PRD Risk #2)

A **round-trip corpus** of `.md` files (one per block + nasty combos: table inside a doc with lists,
callout containing a list, `#tag` mid-sentence, mixed headings, code fences with `|` pipes). The gate:
`parse(md) → serialize → md'` must satisfy `md' === md` **byte-for-byte** (after a single normalization
pass agreed up front, e.g. trailing-newline). Run in CI before any new block is allowed to land. This is
the same discipline the `TightTaskList` fix earned the hard way.

### 4.3 `#tag` parse rule (pseudocode)

```ts
parse: { setup(md) {
  md.inline.ruler.after('emphasis', 'wnut_tag', (state, silent) => {
    // match /#([a-zA-Z][\w/-]*)/ at state.pos, only if preceded by start-of-token or whitespace,
    // and NOT a heading context. On match (non-silent) push a token type 'wnut_tag' with the name.
  });
  // renderer: token 'wnut_tag' → <span data-tag="name">#name</span>  (normalizeDOM → TagNode)
}}
```

### 4.4 Callout parse rule (pseudocode)

```ts
parse: { setup(md) {
  // Post-process blockquote tokens: if the blockquote's first line is exactly `[!kind]`,
  // re-tag it as a callout container with attr kind, and drop that first line from the body.
  // Easiest robust approach: a core rule that runs after 'block' and rewrites the token stream,
  // OR an updateDOM(el) pass that finds <blockquote> whose first text node is `[!kind]`.
}}
```

---

## 5. Two-engine consistency (editor vs. read-only `marked`) — named risk

The rendered view (search snippets, backlinks panel, any non-editing surface) uses **`marked`**, a
different parser from the editor's `markdown-it`. Divergence points and the fix:

| Construct | Editor (markdown-it) | Viewer (marked) today | Fix |
|---|---|---|---|
| Table | pipe → table node | GFM tables **on** (`gfm:true`) → renders | already consistent |
| `#tag` | chip node | plain `#tag` text | add a small `notes-markdown.ts` post-pass to wrap `#tag` in a styled span (display-only) so it looks the same; greppable either way |
| Callout | callout node | plain blockquote + literal `[!kind]` | add a `notes-markdown.ts` post-pass: blockquote whose first line is `[!kind]` → styled callout `div` |
| `[[Title\|n_id]]` | autocomplete + plain text | `[[Title\|n_id]]` literal | viewer strips `\|n_id` and renders `[[Title]]` as a note link (resolve via index) |

**Rule:** every new construct gets a viewer-side rendering decision *in the same change* as its editor
node. Never ship an editor block whose disk form renders as raw junk in the read-only view.

---

## 6. Table UX & the one frozen correctness hazard (Tab precedence)

- **Insert:** `/table` (or `＋`→Table) → 3×3 with header row, caret in first body cell.
- **Keyboard model (A's contract):** `Tab` → next cell (wraps to next row's first cell); `Shift+Tab` →
  previous; `↑/↓` → cell above/below; **`Tab` on the last cell appends a new row** and lands in its first
  cell; `Enter` inside a cell → soft line break (hard-break) within the cell.
- **Row/column controls** on hover (`⋯`/`⋮` menus): insert above/below or left/right, move, delete,
  toggle header, align. Cell / multi-cell selection swaps the **bubble** toolbar to table ops (the
  `shouldShow` branch in §2.2).
- **THE HAZARD (frozen decision):** the table extension's `Tab`/`Shift+Tab` keymap will collide with the
  existing `handleKeyDown` list-indent/detach logic in `NotesEditor.tsx:455`. **Precedence rule:** the
  table keymap claims `Tab`/`Shift+Tab` **only when the selection is inside a table**; outside a table,
  the existing list-Tab + ArrowUp logic is **untouched**. Implementation note for the chief architect: in
  `handleKeyDown`, early-return `false` (let the table extension handle it) when the resolved selection is
  inside a `table`/`tableCell` node — *before* the list-item detection runs. This must be covered by a
  **regression test that exercises list-Tab and table-Tab in the same document** (UX doc §6, graft A.5).

---

## 7. The "no-jank" + correctness contract (non-negotiable)

- **No cursor jump on save.** Every new block (insert, reorder via drag, turn-into) is a normal
  ProseMirror transaction → fires `onUpdate` → sets `isSourceRef` → routes through the existing save path
  with cursor/scroll restore (`NotesEditor.tsx:494`). **New blocks must not bypass `onUpdate`** (e.g. no
  out-of-band `setContent`). The `isSourceRef` guard is in the regression suite.
- **Hover rail + bubble are pure DOM overlays** keyed off current selection/hover; they do **not**
  re-render the doc → typing latency unaffected (works on large notes).
- **Hard-won invariants treated as a regression suite *before* new blocks land** (UX doc graft A.7):
  `isSourceRef` loop guard, `tryJoinPreviousListAndSink`, `detachListItemChildren`, the ArrowUp nesting
  fix, `TightTaskList` tightness. Add a Playwright/unit harness asserting each still holds after each new
  extension is wired.

---

## 8. Stable note identity for links (replace basename-matching)

This is owned by the sibling backend doc (`02-search-and-index-design.md` §2); the **editor's job** is to
author links in the id form while *displaying* the friendly title.

- **Disk form:** `[[Title|n_id]]` (display `Title`, stable `n_id` after the pipe). Backend resolves by
  id first, falls back to basename for legacy `[[Title]]` links during migration.
- **Editor change (`WikiLinkExtension` + `NotesEditor.tsx` handlers):** the `[[` autocomplete already has
  the target note in hand (`NoteListItem`). When the backend exposes a stable id on that item, the
  insert changes from `[[${note.name}]] ` to `[[${note.name}|${note.id}]] ` (still **plain text**, so
  round-trip is trivial). Display: a small decoration/NodeView renders only the part before `|`. The
  "Create new" path inserts `[[Title]]`; the backend assigns the id on first save and the next reconcile
  upgrades it.
- **Why the editor doesn't own the id map:** identity lives in frontmatter + the sidecar (source of
  truth). The editor only *references* it. This keeps the editor stateless about identity and avoids a
  second drifting source (the feedback principle: don't cache remote truth locally).
- **Net effect:** rename/move becomes a pure file rename on the backend (no whole-vault `[[name]]`
  rewrite), and same-name notes never collide. The fragile `updateWikiLinksInAll()` regex is retired.

---

## 9. Performance, IME/CJK, paste correctness

- **Large docs.** ProseMirror handles large docs well; the risks are our overlays and `getMarkdown()`
  cost. Keep overlays pure-DOM (§7). `getMarkdown()` runs on the debounced save, not per keystroke.
  Tables are bounded by the inline-only cell constraint (no deep nesting to serialize).
- **IME / CJK input (critical — the user is bilingual).** All suggestion plugins (`/`, `[[`, `#`) **must
  ignore composition events**: the existing menus already check `e.isComposing || e.keyCode === 229`
  (`SlashCommandMenu.tsx:41`) — the new `#tag` menu must do the same. The trigger detection runs in the
  plugin `view().update`, which fires *after* composition commits, so a half-composed CJK string won't
  spuriously open a menu. **Test:** type a `#` then compose a CJK word — the tag menu must not eat the
  composition keystrokes.
- **Paste.** Keep the existing `handlePaste` precedence: image items first, then entity-ref→markdown-link
  conversion, then native `linkOnPaste`. Pasting a **GFM table** as text now round-trips into a real
  table node (markdown-it parses it) — verify pasted-table fidelity. `transformPastedText` stays on so
  pasted Markdown becomes rich blocks. Pasting into a **table cell** must stay inline (strip block
  structure to honor the cell constraint) — name this in the paste tests.

---

## 10. Phased build order (each step ships a working, byte-clean editor)

Mirrors the UX doc's shipping order; every boundary is independently shippable with no half-built rewrite
in the tree.

```
Step 0  Slash-menu content swap → real insert-block menu (H1–H3, lists, to-do, quote, code, divider).
        Reuses the entire existing slash engine. ZERO new deps, ZERO new serialization → ZERO round-trip
        risk. Ships a Notion feel day one.  [+ Cmd+K Jump/Capture lands in parallel — out of scope here.]
          │
Step 1  BubbleMenu (selection toolbar) + DragHandle grip/＋  (both off-the-shelf, pure UI).
        Wire the shared block-transforms module (§3.4) so all three surfaces share one path.
        Regression suite (§7) must be green first.
          │
Step 2  Tables (@tiptap/extension-table family). /Table, Tab nav, row/col ops.
        Enforce the inline-only cell constraint. Wire the frozen Tab-precedence rule (§6) + its
        list-Tab-vs-table-Tab regression test. Tables round-trip via the serializer tiptap-markdown
        already ships — verify against the round-trip corpus.
          │
Step 3  #tag node + frequency autocomplete (clone the [[ pattern) + Callout node + frozen serializer.
        The ONLY new serialization. Gated behind the 0-diff round-trip acceptance corpus (§4.2) AND the
        viewer-parity passes in notes-markdown.ts (§5).
          │
Step 4  Wiki-link id-form authoring (§8): switch insert to [[Title|n_id]] once the backend exposes ids;
        add the display decoration. (Depends on sibling doc's identity landing.)
          │
Step 5  Frontmatter strip/reattach wrapper (§2.7) once the backend writes id frontmatter — ensures the
        editor never corrupts identity. (Can land with Step 4.)
```

**Stop-anywhere property:** after Step 0 you already have a Notion-style block editor that round-trips
cleanly; tables/tags/callouts each add value without destabilizing what shipped before, because each new
node carries its own tested serializer and the shared transform path is established once in Step 1.

---

## 11. Open decisions for the chief architect

1. **Bump all `@tiptap/*` to one minor** (e.g. 3.26.x) in a single install, or pin new extensions to
   3.20.1 if still published? (3.26.0 is current; a uniform set avoids peer-dep skew.)
2. **Tag autocomplete data source** before the backend tag index lands: derive client-side from `/list` +
   a cheap scan, or block the `#tag` feature on the sidecar's `GET /tags`? (Recommend: ship the node +
   manual `#tag` typing in Step 3; wire frequency-ranked autocomplete when `/tags` exists.)
3. **Callout kinds** to support in v1 (`note/tip/warning/danger/info`?) — affects the parser's `[!kind]`
   allow-set and the viewer styling.
4. **Read-only viewer**: extend the existing `marked` pipeline with tag/callout post-passes (recommended,
   low risk), or unify both surfaces on one renderer later? (Unification is a bigger, separate effort —
   out of scope for v1.)
