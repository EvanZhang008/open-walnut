# Notes / PKM Redesign — Executive Summary (start here)

> **Status:** Design phase complete (two Bar-Raiser rounds + a three-persona customer walkthrough applied).
> No implementation code in this doc series — architecture, data models, API contracts, and pseudocode only.
> **This is the top-level entry doc.** It states the plain-English summary, the agreed scope, the phased
> plan, what's deferred, the non-goals, and the decisions that need the human owner.

---

## Executive Summary (plain English)

- **The problem.** Walnut's note-taking is a single-pane Markdown editor with no Notion-style block editing
  (no slash *insert-block* menu, no tables, no tags, no drag handle, no callouts), and its recall is weak:
  search, backlinks, and rename are all **O(n) full-vault file scans**, and the semantic engine that already
  indexes memory is **never surfaced for notes**. Capture is clumsy; finding a note later is unreliable.
- **What we'll build.** A **Notion-class block editor** as the centerpiece — slash menu that *inserts blocks*,
  hover drag-handle, full text styles, **tables**, **`#tags`**, callouts/dividers — by **extending** the
  TipTap editor we already have (we do not rebuild it). Plus **hybrid search** that runs **string/substring
  AND semantic** together in one labeled list, by wiring notes into the existing embedding engine. **Markdown
  files stay the source of truth; every index is a rebuildable sidecar.**
- **The simplest first step (ships value day one, each side independently).** *Editor:* flip the slash menu
  from "search tasks only" to a real insert-block menu — zero new dependencies, zero round-trip risk.
  *Backend:* make `GET /search` *also* call the existing semantic engine and widen it to the whole vault.
  Each lands before any new block or sidecar exists.
- **The user-visible outcome.** Type `/` for any block; drag the `⠿` grip to reorder; select text for a
  floating format bar; build real tables with `Tab`-driven cell nav; drop `#tags`; write callouts — and
  every note saves to clean, **portable, Obsidian-compatible** Markdown that reopens byte-identical, with one
  `Cmd+Z` per action. Three weeks later you find that note by a vague phrase **and** by an exact substring,
  in one list where exact hits are never buried. Rename a note and every `[[link]]` still resolves.
- **Definition of done (the user's words).** "All the good features and no bug," "really really good,"
  "super easy to use." We hold a no-data-loss, no-jank, byte-clean-Markdown editing bar, verified end-to-end.

---

## Document set & reading order

Read in this order. Where docs overlap, **`02-technical-design.md` is the reconciling authority** (P-levels
and cross-cutting contracts are stated there; the other docs defer to it where they conflict).

| Order | Doc | Role |
|---|---|---|
| 1 | **`00-executive-summary.md`** (this doc) | Top-level entry: summary, scope, plan, deferred, non-goals, unresolved decisions. |
| 2 | **`01-product-design.md`** | The PRD — product intent, personas, end-to-end scenarios, success metrics, risks. |
| 3 | **`ux-decision.md`** | The frozen UX direction (chosen approach + interaction specs). *Carries a supersession banner: where it conflicts with the tech design on P-levels/contracts, the tech design wins.* |
| 4 | **`02-technical-design.md`** | **The authoritative integration design** — architecture, identity/index, editor extensions, round-trip & external-sync contracts, API, phased plan, unresolved decisions (§19). Integrates the two deep dives. |
| — | `02-search-and-index-design.md`, `03-editor-architecture.md` | The two deep dives (backend index/search; TipTap editor). Superseded by `02-technical-design.md` where they overlap. |
| 5 | **`03-review-log.md`** | Audit trail — both Bar-Raiser rounds (findings + resolutions) and the customer walkthrough (friction + delighters). |

> **Note on numbering:** two files share the `02-` prefix (the integration doc + a deep dive). Rather than
> renumber (which would break the by-name cross-references already inside the docs), this table is the
> authoritative reading order; `02-technical-design.md` is the canonical integration doc.

---

## Agreed P0 scope (v1 — editing-experience-first)

The bar: a Notion user feels at home; an Obsidian user keeps their portable Markdown and link integrity.

1. **Notion-style slash insert-block menu** — `/` opens a grouped, fuzzy-filterable block picker (H1–H3,
   lists, to-do, quote, divider, code, callout, table, image) + the preserved Task/Note-link entries.
   **Day-one win** (evolve the existing slash engine; trigger split by command class so inline references
   still fire mid-sentence). — tech §3.3
2. **Tables (Notion-style)** — insert/edit, `Tab`/`Shift+Tab` cell nav, add/remove rows & cols, header row.
   **Owned GFM serializer** (emits alignment, escapes `\|`); cells inline + hard-break only; first row always
   a header; no merged cells — so the pipe round-trip is always byte-clean. — tech §6.1
3. **All basic text styles** — bold/italic/strike/inline-code/headings/lists/quote/checklist/links via slash
   menu + floating bubble toolbar + Markdown shortcuts (reuse StarterKit + existing extensions). — tech §3.2
4. **Tags (v1 = capture + reuse)** — inline `#tag` chip + **frequency-ranked autocomplete**. *(Clickable
   browse, tag-browse view, tag index, rename/merge are **P1**.)* — tech §3.4
5. **Block affordances** — hover `⠿` drag-handle to select/reorder + `＋` inserter (off-the-shelf), feeding
   clean Markdown via the normal save path; gutter-room verified in both editor surfaces. — tech §3.2
6. **Callout + divider** — callout as a `> [!kind]` admonition (custom serializer, kinds =
   `note·tip·warning·danger·info`); divider = `---`. — tech §3.4
7. **Hybrid notes search (BOTH modes, together)** — string + semantic in one ranked, **de-duplicated,
   labeled** list (`● exact / ◐ both / ○ semantic`, exact never below semantic, matched span highlighted,
   plain-language badges). String leg from the new index; semantic leg from the existing engine. — tech §9
8. **Editing-quality bar (cross-cutting)** — no data loss, no save/sync flicker, byte-clean Markdown,
   cursor/scroll preserved across external/AI writes (defer-while-dirty + position-mapping), smooth typing on
   large notes, one `Cmd+Z` per user action. — tech §6
9. **Minimal capture front door (newcomer on-ramp)** — a P0 "New note" affordance + `/notes` empty state so a
   butler user not on `/notes` can capture in seconds (the headline newcomer metric) without the full Cmd+K
   surface. — tech §3.6½

**P1 (lands right after the editor feels right — root-cause durability backbone):** stable note identity +
one rebuildable structural sidecar (id↔path, links/backlinks, tags, FTS) that retires the three O(n) scans
and the basename-collision bug class; tag browse/rename/merge; move-by-identity. Cmd+K global front door is a
P1 **early-pull candidate** (see Unresolved Decisions). — tech §2/§4/§8/§10

---

## Phased plan (each boundary leaves a working, shippable, byte-clean state)

The two tracks ship **largely in parallel**; the only hard cross-dependency is the editor's link authoring
(E4/E5) depending on backend identity (B2).

```
EDITOR track                                  BACKEND track
─────────────────────────────────────        ─────────────────────────────────────
E0  Slash → real block menu (+ minimal        B0  Widen semantic store to whole vault
    "New note" capture). Day-one Notion            + GET /search also calls semantic +
    feel; zero new deps, zero RT risk.             merges. Day-one semantic search.
         │  ── the PRD "simplest first step", both sides ──
         ▼                                         ▼
E1  BubbleMenu + DragHandle; wire the         B1  notes-index.sqlite + reconciler +
    shared block-transforms; invariants           fs.watch catch-all; rewrite string
    regression suite GREEN first.                  search/backlinks/list to the index.
         │                                         │  O(n) scans GONE.
         ▼                                         ▼
E2  Tables (owned serializer; inline-only     B2  Identity: id frontmatter + id-keyed
    cells; Tab-precedence rule + test).            links + name fallback; simplify /move
         │                                         (delete updateWikiLinksInAll). ◀─ unblocks E4/E5
         ▼                                         ▼
E3  #tag node + freq autocomplete +           B3  Tags table + /tags* endpoints +
    Callout node. Only new serialization —         frontmatter PARSE (tags source; no
    gated behind the round-trip + parity          properties-editing UI).
    corpora.                                       ▼
         │                                     B4  Polish: /index/status, /index/rebuild,
         ▼                                         atomic temp-DB rebuild, ranking tuning.
E4  Obsidian-native [[Title]] / [[folder/
    Title]] link authoring (resolution keyed     ── P1 / early-pull lane (after sign-off) ──
    on target's frontmatter id).                  P1a  Search overlay UI · P1b  Cmd+K front
         │  ── depends on B2 ──                    door (same component) · P1c  Tag browse +
         ▼                                         clickable chips + rename/merge.
E5  Frontmatter strip/reattach wrapper.
```

---

## Deferred to implementation (decisions intentionally left to build-time judgment)

These are **not** scope questions — they are tuning/algorithm choices to finalize against the round-trip
corpus and latency benchmarks (tech §17):

- Exact debounce constants (300 ms in-proc / 1 s fs / 5 s semantic are starting points).
- The FTS `LIKE`-fallback threshold (when to skip straight to `LIKE` for mid-token substring).
- Whether to expose folder-prefix rank weighting after collapsing the old PARA collections.
- The precise `parseFrontmatter` splice algorithm for the id back-write.
- **Highest implementation risk to spike early:** §6.2's ProseMirror step/diff **position-mapping** (no
  off-the-shelf TipTap primitive). "Defer-while-dirty" carries most of the safety; the step-mapping is the
  part most likely to need iteration.

**Logged tech-debt / future hardenings (out of v1):** unify the two renderers (editor `markdown-it` vs viewer
`marked`); an FTS5 `trigram` tokenizer if mid-token substring gets slow at very large scale; drive the
structural FTS update synchronously in the PUT response (close the two-leg consistency window); a
content-derived deterministic note id if the residual two-machine collision rate ever proves non-negligible.

---

## Explicit non-goals (this effort)

- ❌ Canvas / whiteboard, ❌ Graph view, ❌ Real-time multiplayer / collaborative editing.
- ❌ Proprietary storage-as-master — **Markdown on disk stays the source of truth**; every index is a
  rebuildable sidecar.
- ❌ Columns / multi-column blocks, ❌ a frontmatter *editing* node (UI), ❌ synced/toggle blocks, ❌ public
  sharing / comments / version-diff UI, ❌ replacing the embedding engine.
- ⏸ **Relations / context dock** (backlinks + linked tasks + memory neighbors beside the editor) — **deferred
  / post-v1 (P1+)**: a roadmap item, **not** a permanent non-goal, but out of this effort's v1.
- ⏸ **Acknowledged Obsidian-parity recall features, deferred (not oversights):** unlinked mentions,
  hover-preview/peek, nested/path-aware tags (`#project/q3`). Real post-v1 increments; v1 ships resolved
  backlinks + flat tags.

---

## Unresolved decisions — need the human owner

These are product/scope ties the design surfaces rather than silently resolves. Each has a recommended
default the docs already build against (full detail in tech §19).

1. **Cmd+K — pull into P0, or keep P1?** The PRD orders quick-switcher/quick-capture **P1**; the design holds
   that and ships a minimal P0 "New note" front door (#9 above) so the newcomer metric is met without it. The
   full Cmd+K spec is ready. **All three customer personas wanted it day-one; the PRD ordered it P1** — only
   the owner can break this tie. *Recommended: keep P1, pull in early if testing shows it's load-bearing.*
2. **On-disk wiki-link form — Obsidian-native (recommended) vs text-level collision-proof?** v1 defaults to
   **Obsidian-native** `[[Title]]` / `[[folder/Title]]` (fully portable; id in frontmatter; resolution keyed
   on the target's id), because portability is non-negotiable for the Obsidian persona. A bare `[[Title]]` to
   two same-named notes becomes an `ambiguous` edge (handled exactly as Obsidian does). The `[[Title|n_id]]`
   form is **rejected** (it hijacks Obsidian's alias slot, rendering the id as a visible label). *Recommended:
   confirm Obsidian-native; if text-level collision-proofness is ever valued above portability, use a
   non-rendering id carrier — never the `|` slot.*
3. **Conflict policy on a true write-write conflict.** The shipped optimistic-lock policy is
   **agent-writes-win**, losing ≤ one debounce window of un-flushed typing (now surfaced, not silent). The
   design keeps it because it may be load-bearing for butler correctness. *Recommended: confirm
   agent-wins-on-true-conflict (non-conflicting writes already never lose input); flipping to
   user-wins-while-dirty would reverse a long-standing policy.*

---

## Bottom line

An unusually rigorous, root-cause-first design: it extends the existing editor rather than rebuilding it,
keeps Markdown the portable source of truth, fixes three O(n) scans + the rename bug class with one
identity-keyed index, and treats round-trip fidelity + the editor's hard-won invariants as P0 gates. Two
adversarial review rounds and three customer personas hardened it; their findings are resolved or escalated.
What it is **not** at v1: a Notion-with-databases replacement, or a full Obsidian-parity PKM. What it **is**:
a delightful block editor with magic (semantic + exact) search built into your AI butler — and the design is
clear about exactly that line.
