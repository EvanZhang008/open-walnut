# Notes / PKM Redesign — Review Log (audit trail)

> **Status:** Design-phase audit trail. This document records the two adversarial Bar-Raiser rounds and the
> three-persona customer walkthrough that hardened the design, with **how each finding was resolved or why it
> was rejected**. It is the provenance record for `02-technical-design.md` (the integration authority),
> `01-product-design.md` (PRD), and `ux-decision.md` (frozen UX).
>
> **Reading order / authority:** see `00-executive-summary.md`. Where docs overlap,
> `02-technical-design.md` is the reconciling authority.

---

## How to read this log

- **Round 1** hardened five "assumed-solved" contracts into owned, tested ones (table serializer,
  external/AI-write merge, undo/redo, semantic-path normalization, the QMD hot-path trap) and corrected scope
  honesty (Cmd+K / sidecar / tag-browse → P1). Round 1's detail lives inline in `02-technical-design.md`'s
  "What changed in Round 1" Executive-Summary bullet and the §-level "(addresses Round 1)" annotations; it is
  summarized here for completeness.
- **Round 2** was an adversarial *verification* pass: re-grounding Round 1's fixes against shipped source, and
  hunting fresh holes (markdown round-trip edge cases, migration data-loss, editor failure modes, scope
  contradictions). Round 2 is the focus of this log.
- **Customer walkthrough** role-played three personas end-to-end against the frozen specs and reported felt
  friction + delighters.

Every Round-2 / customer item below is tagged **[Resolved]**, **[Resolved — honest bound]**, or
**[Acknowledged / deferred]**, with the section of `02-technical-design.md` that now carries the fix.

---

## Round 1 (Bar Raiser) — summary of what hardened

| # | Finding | Resolution |
|---|---|---|
| R1-1 | The shipped `tiptap-markdown` table serializer emits **no alignment**, **doesn't escape `\|`**, and **HTML-blobs** header-less / multi-child tables → silent data loss on every save. | **Own a custom GFM table serializer** + **constrain the schema/UI** (first row always header, inline+hard-break cells, no merged cells) so the pipe path is always takeable. Two-level round-trip gate + "no table ever serializes to `<table>` HTML" assertion. (§6, §6.1) |
| R1-2 | External/AI writes mid-edit did a full-document `setContent` + absolute-offset caret restore → caret teleport, possible lost input. | **Defer-while-dirty + position-MAPPING (not offset restore)** contract. (§6.2 — *further reconciled in Round 2, see R2-2*) |
| R1-3 | No undo/redo contract; today's Tab is already 2+ transactions. | **One user action = one `Cmd+Z`**; fold Tab logic into a single transaction. (§6.3) |
| R1-4 | Semantic leg returns **absolute** paths while the structural index stores **vault-relative** → every both-leg hit duplicated + mislabeled. | `idFromQmdPath` normalization owns the conversion; test asserts a both-leg note merges to one `◐ both` row. (§9.2) |
| R1-5 | Widening QMD via `store.update()` runs a **synchronous whole-vault `readFileSync`+hash** on the save hot path (~456 ms @1.5k files) → event-loop starvation (a class this project was burned by twice). | Drive the semantic store **per changed file** (the `qmd-task-sync.ts` pattern); reserve `store.update()` for cold rebuild only. (§5.1, §8.2) |
| R1-scope | Cmd+K, the structural sidecar, and tag browse/rename were drifting toward silent P0. | Reconciled to **P1** (early-pull candidates); v1 inline `#tag` precisely scoped; relations dock explicitly out of v1. (§9.3, §15, §18) — *Round 2 found this was applied to only one doc; see R2-4.* |
| R1-nb | Doc-numbering collision (two `02-` files); large-note benchmark undefined; IME guard only at nav layer; slash papercut; ambiguous-edge UX; per-path coalescing; tree virtualization; sanitize ordering. | Each addressed inline in `02-technical-design.md` (§3.2, §3.3, §4.3, §7, §8.1, §13.2). Doc-numbering carried to Round 2 (R2-nb). |

---

## Round 2 (Bar Raiser) — verification + fresh holes

### Blocking findings

**R2-1 — Tag P0 contradiction was only half-fixed (PRD not updated). [Resolved]**
Round 1 reconciled the tag scope split in the tech + UX docs, but `01-product-design.md` line 136 still
listed browse/rename/index as first-class P0, so the PRD (the doc the user signs off on) still promised them.
**Fix:** PRD P0 #4 split into "chip + frequency autocomplete (P0)" with browse/rename/index moved into the §6
P1 list; Scenario A/E annotated with the v1 cut. All three docs now state the split identically. (PRD §6;
tech §15; ux table.)

**R2-2 — Relations dock cross-doc disagreement (got semantically worse). [Resolved]**
Tech §18 classified the dock a hard non-goal (canvas-class), while `ux-decision.md` still listed it as a
roadmap **P1** in three places — a stronger contradiction than Round 1's mere silence. **Fix:** picked one
word — the dock is **"deferred / post-v1 (P1+)"**, a roadmap item but out of v1, **not** a permanent non-goal.
`ux-decision.md` (table row, graft #13, shipping Step 5) and tech §18 now say the same thing.

**R2-3 — §6.2 external/AI-write contract contradicted the shipped behavior it claimed to keep. [Resolved — honest bound]**
Round 2 read the *real* state owner `useNoteContent.ts` (not `NotesEditor.tsx`): (a) the WS/AI `notes:updated`
path calls `reloadContent()` with **no dirty check** (blows away the live doc); (b) the visibility path
**already** has the `if (dirtyRef.current) return` guard; (c) the 409 path has a deliberate comment that it
**drops ~one debounce window** of typing (agent-wins). The prior §6.2 promised both "zero lost characters"
**and** "keep the 409 path" — mutually exclusive. **Fix:** replaced the impossible absolute with an **honest,
surfaced bound** — non-conflicting external writes defer-while-dirty and never lose input; a true write-write
conflict loses ≤ one debounce window and is **surfaced, never silent**. Mandated the WS path gain the
dirty-guard. Conflict policy (agent-wins vs user-wins) logged as **Unresolved Decision #3**. (§6.2)

**R2-4 — Lazy id assignment races across git-synced machines → divergent ids. [Resolved]**
`git-sync` auto-commits the vault (`git add -A`) on a ~30 s loop; an un-id'd note can be pushed before its
reconciler stamps an id; another machine assigns a **different** random id → merge conflict on the `id:` line
+ split backlinks. The doc had shipped "lazy id on first reconcile" as if single-process. **Fix (defense in
depth):** (1) **create-time stamping** as the primary path; (2) **pause `git add -A`** for an id-pending note;
(3) deterministic **earliest-created-wins merge rule** that re-points inbound links. Content-derived
deterministic id considered and logged as a future hardening. New multi-machine test. (§8.3, §12, §16, §17)

**R2-5 — Cmd+K P0/P1 self-contradiction inside the authority doc. [Resolved]**
§9.3 correctly said P1, but §14 (build sequence, "P0, app-level") and §15 (scope ledger, "(UX-pulled P0)")
still voted P0 — and the build plan is what teams execute against. **Fix:** Cmd+K is **P1 everywhere**, moved
into an explicit P1/early-pull lane in §14, relabeled in §15; logged as **Unresolved Decision #1**.
`ux-decision.md` (table row, §4 preamble, graft #8, §9 header, shipping order) reconciled to match.

**R2-6 — ux-decision.md left un-updated, so it openly disagreed with the authority on three scope items. [Resolved]**
Cmd+K (still P0 in three places), the dock (still P1 in three places), and table header-toggle/soft-break
(still listed). **Fix:** added a **supersession banner** at the top of `ux-decision.md` AND corrected each
specific line (Cmd+K → P1; dock → deferred; "toggle header" dropped, soft→hard break, owned serializer noted)
so an implementer reading either doc builds the same scope.

### Non-blocking findings

**R2-7 — §8.2 pseudocode misstated the QMD API. [Resolved]**
The shown `insertContent('notes', path, body, {hashSkip})` shape doesn't exist. Verified against
`qmd-task-sync.ts:62-86` + `@tobilu/qmd` `store.js`: the real shape is `insertContent(hash, content,
createdAt)` (content-addressable, no collection/path/hashSkip) + a **separate** `insertDocument` /
`updateDocument`, with hash-skip done by the caller via `findActiveDocument(...).hash`. **Fix:** §8.2
pseudocode rewritten to the real two-call shape with an explicit API note.

**R2-8 — §6.1 inline-code pipe claim was factually wrong. [Resolved]**
Empirically re-ran `markdown-it@14.1.1`: a **raw** `|` inside an inline-code span in a cell is consumed as a
delimiter and **truncates the cell** (``` `x|y` ``` → `<td>`x</td>`, losing `y`); the escaped ``` `x\|y` ```
round-trips intact. **Fix:** deleted the wrong parenthetical; serializer must emit `\|` **inside code marks
too**; corpus asserts the code span survives intact, plus a user-authored-`\|` idempotency fixture.

**R2-9 — External-content FTS5 maintenance under-specified (silent search staleness on edit). [Resolved]**
A bare re-insert into an external-content FTS5 table leaves a stale, still-matchable entry; there is **no**
per-row "rebuild" (`'rebuild'` is whole-table, O(vault)). **Fix:** pinned the **three standard AFTER
INSERT/UPDATE/DELETE triggers** (delete-OLD-values then insert-new); reserved `'rebuild'` for cold rebuild.
New FTS edit-coherence test ("edit out a word, re-search old text → no match"). (§4.1, §8.2, §16)

**R2-10 — Tag/search two-leg consistency window unstated. [Resolved]**
The structural (FTS) and semantic (embed) legs are independently debounced; after an edit the FTS row is
fresh in ~300 ms–1 s but the embedding lags. The de-dupe-by-id assumes both legs see the same version. **Fix:**
§9.2 states the window explicitly — the string leg is authoritative + always fresh; the §16 hybrid test must
**not** assert `◐ both` within the embed-lag window. Optional synchronous-FTS hardening logged in §17.

**R2-11 — User-authored escaped `\|` round-trip direction untested. [Resolved]**
Added to the table corpus a fixture whose on-disk source already contains `\|` (plain + in inline code),
asserting idempotency (no double-escape to `\\|`, no unescape to a truncating raw `|`). (§6)

**R2-12 — Slash trigger tightening silently removed a shipped capability. [Resolved]**
"`/` only at start of an empty block" would make it impossible to insert a Task reference / Link to note
**inline, mid-sentence**, which works today. **Fix:** trigger policy **split by command class** — block-level
inserts require an empty block; **inline Reference entries still fire mid-block**. New test: `/[task-ref]`
mid-sentence still works AND `/table` mid-paragraph must not split. (§3.3)

**R2-13 — IME composing guard too blunt. [Resolved]**
A blanket `if (view.composing) return` at the top of `update` freezes an open menu's filter and can swallow
the first post-`compositionend` update. **Fix:** guard only the trigger/open path; persist an open menu;
refilter on the first non-composing update after commit. Test asserts (a) no open mid-composition and (b)
immediate filter on committed text. (§13.2)

**R2-14 — Doc-numbering collision unfixed (two `02-` files, no index). [Resolved — via 00-doc]**
**Fix:** rather than renumber (which would break the existing by-name cross-references inside the docs),
`00-executive-summary.md` now states the reading order and which doc is authoritative. Recorded here so the
choice is explicit.

**R2-15 — Positive verification (no action). [Recorded]**
Round 2 re-grounded all five Round-1 contracts against shipped source and confirmed each targets a real
defect: the table serializer (`table.js` `isMarkdownSerializable` + hardcoded `---`), the `setContent`+offset
caret code (`NotesEditor.tsx:494-532`), one-Tab-multiple-transactions (`tryJoinPreviousListAndSink` +
`sinkListItem`), the absolute-vs-relative semantic path (`memory-search.ts:132,142`), and the synchronous
`readFileSync`-per-file in `reindexCollection` (`store.js`) with the real vault at 1,566 `.md` files. Also
verified the §0 inventory (bubble-menu present at 3.20.1; table + drag-handle absent), the missing IME guard,
the slash papercut, and the migration tolerance of `[[name|id]]`. **The highest remaining implementation risk
is §6.2's ProseMirror step/diff position-mapping** (no off-the-shelf TipTap primitive) — flagged for an early
spike in §17.

---

## Customer walkthrough — three personas

Personas: **Riya** (Obsidian power-user, ~2k-note vault, keyboard-first, portability non-negotiable);
**Marco** (Notion power-user, blocks/slash/drag/databases-lite, "it just works" polish bar); **Sam** (newcomer
/ butler-only, wants 2-second capture + "search just finds it", never a wall of options).

### Friction points and how they were addressed

| Persona(s) | Friction | Severity | Disposition |
|---|---|---|---|
| Riya | **`[[Title\|n_id]]` collides with Obsidian's alias syntax** — opened in real Obsidian, links render the id as their label and resolve by title. Breaks the "portable, hers forever" promise. | high | **[Resolved]** On-disk form changed to **Obsidian-native** `[[Title]]` / `[[folder/Title]]`; id in frontmatter only; resolution keyed on the target's id (§2.2). Logged as **Unresolved Decision #2**. |
| Riya, Marco, Sam | **Cmd+K / quick-switcher demoted to P1** strands keyboard-first navigation (Riya) and the PRD's headline capture scenario (Marco/Sam). | high | **[Acknowledged + partially resolved]** Cmd+K stays **P1** (PRD's own ordering; spec ready, §9.3) but v1 now ships a **minimal P0 "New note" capture front door** (§3.6½) so the newcomer metric is met without it. Whether to pull Cmd+K into P0 is **Unresolved Decision #1** for the owner. |
| Sam | **Semantic search silently incomplete during first-run background embed** → "search doesn't find my stuff" (the PRD's named top risk). | high | **[Resolved]** Added a non-blocking **"still indexing — semantic results may be incomplete"** state driven by `GET /index/status.embedProgress`; string/exact always work immediately. New §16 test. |
| Riya, Marco, Sam | **`/` mid-sentence does nothing** (tightened trigger) — reads as broken. | medium | **[Resolved]** Trigger split by command class; inline Reference entries still fire mid-block (§3.3, R2-12). |
| Riya | **No unlinked mentions, no hover-preview, no nested tags** — Obsidian table-stakes, not even listed as deferred. | medium | **[Acknowledged / deferred]** Now explicitly listed as post-v1 increments toward Obsidian-class recall (§18). Nested tags are PRD P1. |
| Marco | **No databases-lite** (board/gallery/table-as-db, editable properties, filters). | high | **[Acknowledged — out of scope]** A defensible v1 cut; surfaced as an explicit expectation-set. Frontmatter *editing* node remains a non-goal (§18); v1 = chips + flat tags. |
| Marco, Riya | **Tables are "Notion minus"** (forced header, no merged cells, inline-only cells). | low–med | **[Acknowledged]** Conscious round-trip-safety constraint (§6.1); documented as a v1 limitation in the tech doc and ux-decision. |
| Marco | **Drag grip may be disabled in the narrow home/popup surface.** | medium | **[Acknowledged — covered by the §3.2 gutter-room spike]** Fallback is grip-inside-padding, else disabled with Markdown-shortcuts/slash-menu as the insert path. (Note: a non-drag reorder affordance for that surface is a reasonable follow-up; the block-actions menu's Move up/down already provides one.) |
| Riya, Marco | **Day-one tags are cosmetic** (autocomplete + clickable-browse gated behind B3/P1). | medium | **[Acknowledged — sequencing]** v1 P0 = chip + frequency autocomplete (§3.4); browse/rename = P1 (R2-1). Reuse-steering autocomplete lands with B3. |
| Marco, Sam | **`●◐○` legend opaque on first contact.** | low | **[Resolved]** Word badges ("exact match"/"related") always shown, not training-wheels-only; calm-default acceptance check (§16). |
| Marco | **Read-only viewer (`marked`) vs editor (`markdown-it`) two-parser drift.** | low | **[Acknowledged — named tech-debt]** Parser-parity corpus in CI (§7); single-renderer unification logged in §17. |
| Riya | **id-less transition window** (legacy basename links fragile until stamped). | low | **[Acknowledged — bounded]** Honest handling (ambiguous edge UX §4.3); create-time stamping (R2-4) shrinks the window; opt-in "stamp all ids" admin action. |

### Delighters (consistent across personas — recorded so they are preserved)

- **Hybrid search with the `●/◐/○` trust legend + word badges + matched-span highlight + the frozen
  "exact-never-below-semantic" rule** — judged **better than Obsidian/Notion core search** (neither has
  semantic recall). The standout conversion moment for all three personas.
- **Source-of-truth discipline** — Markdown stays master; every index is a DELETE-and-rebuild sidecar; the
  only file artifact is one additive `id:` frontmatter line; `DELETE both sidecars + rebuild === identical
  behavior` as a global invariant. The anti-lock-in posture Riya requires.
- **Root-cause framing** — rename becomes a one-row update with `updateWikiLinksInAll()` **deleted**; three
  O(n) full-vault scans collapse to one identity-keyed index.
- **Engineering honesty** — re-reading the shipped table serializer, the QMD hot-path trap, the
  absolute-vs-relative path bug; owning a custom serializer with a byte-level + node-level round-trip corpus.
- **"One user action = one `Cmd+Z`"** — explicitly folding the multi-dispatch Tab into a single transaction.
- **External/AI-write "defer-while-dirty + position-mapping"** — the butler can edit a note you have open
  without stealing your caret; a genuinely novel capability handled with care.

### Persona verdicts (verbatim gist)

- **Riya (Obsidian):** *"Not yet a replacement at v1, but on a credible path."* Blockers were the link
  portability collision (now resolved) and the missing quick-switcher (now P1 + a P0 "New note" floor).
- **Marco (Notion):** *"Would replace Notion for notes that live inside my butler; better on semantic search
  + portable Markdown."* Gated by no databases-lite (out of scope), Cmd+K demotion (resolved to P1 + floor),
  and the popup drag grip.
- **Sam (newcomer):** *"Not yet my daily quick-jot tool, but close — the search is the reason I'd switch."*
  Blocked on the capture front door (now §3.6½) and "still indexing" honesty (now added).

---

## Net outcome

All Round-2 **blocking** findings are resolved or converted to an explicit, surfaced bound; the three
genuine product/scope ties are escalated to the human owner (`02-technical-design.md` §19). The three docs
(PRD / UX / tech) now agree on every contested P-level and contract. The design is approved-with-changes by
both Bar-Raiser rounds; the changes are applied. Remaining customer gaps (databases-lite, Obsidian-parity
recall) are explicit, deferred scope — not defects.
