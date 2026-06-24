# Session "Changed" View — Implementation & Progress

A GitHub-style file-diff review for a single session, shown full-screen with the
session's own chat relocated to the right so you can ask the **main agent** about
any line directly.

> Plan: `~/.claude/plans/plan-session-changed-review-tab.md`

## What it does (user-facing)

- A **Changed** chip on the session panel (both places sessions render).
- Click it → the panel goes **full-screen** (≈96vw/96vh — the normal 1400px cap is
  dropped for this view) and splits into **File Diff (left) + the existing session
  chat (right)**.
- The diff shows every file the session edited (GitHub before/after, split or
  unified, word-level highlight), grouped by repo (cwd repo / other repos /
  submodules). A file edited OUTSIDE any repo (e.g. a `/tmp` scratch file) gets
  its own group anchored to its own directory — never `../../..`-escaped into the
  cwd repo.
- Markdown files have a **Rendered** toggle: the after-content rendered as HTML
  with a **source line-number gutter** (each top-level block tagged with the line
  it begins on), so you can still locate a block in the file while reading it
  rendered.
- **Select any code in the diff → "Ask about this" pill → it pre-fills the existing
  chat input** with `About <file>:<line> \`code\`: `. You add a question and hit the
  normal Send — it goes to the **same main agent** (full context, hot prompt cache).
  No fork, no new agent, no side-question.
- **Click a line (gutter or code cell) → a comment box** with TWO send options
  (the GitHub PR-review model):
  - **Add comment** (default) — *records* the comment to a pending review batch.
    It stays inline under the line as a read-only card (with **Copy** + **Remove**),
    and accumulates **across files** as you keep reviewing. A sticky **review bar**
    at the bottom shows the count with **Copy all** (copies the whole composed
    review to the clipboard) and **Submit review** (sends the entire batch to the
    main agent as one message). Nothing is sent until you submit.
  - **Send now** — fires *that one* comment to the main agent immediately
    (`Re: <file>:L<n> \`code\`\n\n<note>`), bypassing the batch.
  - Both options send through the **same main agent** (no fork). Keyboard:
    ⌘/Ctrl+Enter = Add, ⌘/Ctrl+Shift+Enter = Send now, Esc = cancel.
  - The batch is per-session and lives in the panel (not persisted); switching
    sessions clears it.

## How detection works (the important part)

- **Source of truth = the session's own JSONL**, never `git status`. With many
  agents editing the same repo concurrently, git can't attribute a change to one
  session; the JSONL is per-session isolated and records exactly what IT did.
- Ops extracted per file: `Edit{old_string,new_string,replace_all}`,
  `Write{content}`, `MultiEdit{edits[]}`, `NotebookEdit{new_source}`.
- **Subagent edits included**: subagents that edit write Edit/Write into their own
  `subagents/agent-*.jsonl` (verified — NOT inline under `parent_tool_use_id`), so
  the engine scans those files too.
- **before/after reconstruction (no git, no diff process):**
  - `after`  = the file's **current content on disk** (read via the same
    local/remote reader the Messages tab uses).
  - `before` = `after` with every recorded op **reverse-applied** newest→oldest.
  - Identical local + remote behavior — it's all string manipulation.
- The actual unified-diff synthesis + rendering is **frontend-only**
  (`diff.createPatch` → `react-diff-view`). The backend ships only `{before, after}`.
- **.claude filter:** files whose path is `.claude/plans/**` or `.claude/projects/**`
  (Claude/Walnut bookkeeping) are excluded; other `.claude` files are kept.
- **Performance:** live parse (~31ms typical / ~64ms worst measured) + mtime cache
  on the canonical JSONL. `?refresh=1` bypasses the cache (current file content can
  change while the JSONL mtime stays the same).

## Files

### New
| File | Role |
|---|---|
| `src/core/session-changes.ts` | Detect engine: JSONL → ops → before/after → repo groups → .claude filter → mtime cache. **Zero new backend deps.** |
| `web/src/api/session-changes.ts` | Frontend fetch wrapper + shared types. |
| `web/src/components/sessions/SessionDiffView.tsx` | The File Diff panel (react-diff-view, split/unified, repo groups, selection → "Ask about this"). The ONLY new UI component. |
| `web/src/components/sessions/diffPatch.ts` | **React-free** diff construction (`toGitStylePatch` + `buildFileData`) — the crash-prone createPatch→parseDiff pipeline, split out so it's unit-testable with the real libs. |
| `web/src/components/sessions/diffPrefill.ts` | Shared `buildSelectionPrefill()` so both panels prefill identically. |
| `tests/core/session-changes.test.ts` | Engine unit tests (10). |
| `tests/web/routes/sessions-changes.test.ts` | Route test (4). |
| `tests/e2e/session-changed-tab.test.ts` | E2E through a real server (3). |
| `tests/web/diff-view/diff-patch.test.ts` | **FRONTEND diff-pipeline gate** (12) — real `diff`/`react-diff-view`; catches the blank-page bug the others missed. |
| `vitest.diff-view.config.ts` | Web-rooted config for the above (aliases into `web/node_modules`); wired into `npm test`. |

### Modified
| File | Change |
|---|---|
| `src/web/routes/sessions.ts` | `GET /api/sessions/:id/changes` (+ `?refresh=1`). |
| `web/src/components/sessions/SessionPanel.tsx` | Changed chip + split layout + prefill (home slide-out). |
| `web/src/components/sessions/SessionDetailPanel.tsx` | Changed chip + `changedOpen`/`onToggleChanged` props (/sessions). |
| `web/src/pages/SessionsPage.tsx` | Owns the /sessions Changed orchestration (fullscreen + diff column + prefill, since it holds the ChatInput). |
| `web/src/styles/globals.css` | `.is-changed-open` no-max-width fullscreen + split layout + SessionDiffView styling. |
| `web/package.json` | `react-diff-view` + `diff` (only new deps, frontend-only). |

## Dependencies added
- `react-diff-view@^3.3.3` (MIT, React ≥16.14 → 19 OK) — diff rendering.
- `diff@^9.0.0` — `createPatch` synthesizes the unified diff in memory.

## Progress

- [x] **M1.1** Backend detect engine (`session-changes.ts`)
- [x] **M1.2** `GET /api/sessions/:id/changes` route + frontend API wrapper
- [x] **M1.3** `SessionDiffView` panel (react-diff-view, split/unified, groups, selection)
- [x] **M1.4** Changed chip + fullscreen split layout in BOTH panels + prefill + CSS
- [x] **M1.5** Tests: unit (10) + route (4) + E2E (3) all green; `npm run build` + `vite build` pass
- [x] **M1.6** `/test-and-verify-walnut` + button-by-button UI verification (screenshots) — **found & fixed 3 real bugs** (below); added frontend diff-pipeline test tier (12 tests)

### Test results (M1.5)
- `tests/core/session-changes.test.ts` — 10 passed (Edit/Write/MultiEdit reconstruct, multi-edit accumulate, replace_all, partial detection, subagent recursion, cross-repo + submodule grouping, .claude filter, empty).
- `tests/web/routes/sessions-changes.test.ts` — 4 passed (404, before/after, empty, ?refresh cache bypass).
- `tests/e2e/session-changed-tab.test.ts` — 3 passed (live server GET /changes, refresh, 404).
- Server `npm run build` (tsup) + `web` `vite build` both OK; `SessionDiffView` confirmed in the bundle.
- Note: the E2E stages the JSONL on disk (the exact shape the capture pipeline writes) rather than spawning the mock CLI — the stdout→JSONL capture is non-deterministic when a single E2E runs standalone (same reason plan-mode fails standalone). The route + engine path is fully exercised live.

## Bugs found & fixed during M1.6 UI verification

The route/E2E tests asserted only the backend `/changes` JSON, so three bugs that
lived entirely in the browser shipped undetected until button-by-button testing:

1. **Blank page on every diff (P0).** `diff`'s `createPatch` emits an
   `Index:/===/--- name` unidiff preamble. react-diff-view's parser only
   normalizes `diff --git` headers; on anything else it throws `Cannot read
   properties of undefined (reading 'changes')` **synchronously** inside
   `parseDiff`. That throw escaped a `useMemo` with no error boundary →
   **the entire React tree unmounted to a white page.** Fix: `toGitStylePatch()`
   strips the preamble and prepends a real `diff --git` header
   (`web/src/components/sessions/diffPatch.ts`); `buildFileData()` also wraps the
   parse in try/catch so a single bad diff degrades to "empty diff", never a crash.
2. **"Ask about this" never prefilled on a real click.** The pill lives inside
   `.session-diff-view`, which has `onMouseUp={handleMouseUp}`. A real click's
   `mouseup` **bubbled to the container**, which recomputed the now-collapsing
   selection and `setSelection(null)` → React unmounted the pill *before* the
   `click` fired, so `commitSelection` never ran. Fix: `onMouseUp` on the pill
   `stopPropagation()`s (SessionDiffView.tsx). (A synthetic same-tick click hid
   the bug — only a genuine mouse drag-then-click reproduced it.)
3. **Home slide-out fullscreen stayed capped at 1400px.** The CSS rule
   `.open-walnut-fullscreen.is-changed-open` requires both classes on one element.
   `SessionsPage` puts both on `.sessions-detail-pane` (worked), but `SessionPanel`
   had `open-walnut-fullscreen` on `.session-panel` and `is-changed-open` on the
   child `.session-panel-split` → rule never matched, gutter stayed. Fix: also put
   `is-changed-open` on the `.session-panel` root (SessionPanel.tsx).

**New test tier to close the gap:** `tests/web/diff-view/diff-patch.test.ts` runs
the exact frontend pipeline (`buildFileData` → createPatch → parseDiff → tokenize)
with the real `diff`/`react-diff-view` libs, plus `buildSelectionPrefill`. It runs
under `vitest.diff-view.config.ts` (aliases into `web/node_modules`) and is wired
into `npm test` via `scripts/test-parallel.mjs`. Reverting bug #1's fix fails 7/8
of these loudly instead of in the browser. (12 tests.)

## Verification checklist (M1.6)

Verified live on the isolated server (port 3470, seeded session) with real UI
clicks + DOM/measurement assertions + screenshots:

- [x] Changed chip appears on `/sessions` detail panel AND home slide-out
- [x] Clicking it goes full-screen filling **96vw × 96vh** (measured; `max-width:none`, no 1400px gutter) — **both** panels (after fixing bug #3)
- [x] Diff renders before/after, color-coded, with real line numbers (after fixing bug #1)
- [x] Split ⇄ Unified toggle works (all 5 tables switch `diff-split`↔`diff-unified`) and persists to localStorage
- [x] Repo groups expand/collapse (caret + files removed from DOM); cwd repo first
- [x] Cross-repo + submodule changes appear in separate groups (walnut cwd / vendor/widget submodule / other-lib)
- [x] `.claude/plans` excluded; `.claude/settings.json` kept
- [x] Select code → "Ask about this" → prefills the existing input (`About <file>:<line> \`code\`: `) — verified with a **real mouse drag + real click** in both panels (after fixing bug #2); composed message + enabled Send confirmed
- [x] ESC / re-click Changed closes the view; split collapses to `display:contents` so the chat subtree never changes shape (**no remount**)
- [ ] Works for a remote (SSH) session too (not yet exercised — engine is host-agnostic string manipulation; reader path shared with Messages tab)

### Screenshots (`web/changed-step*.png`, `web/home-step*.png`)
- `changed-step3-fullscreen.png` — the blank-page crash (bug #1, pre-fix)
- `changed-step4-fullscreen-fixed.png` — /sessions Changed view rendering correctly
- `changed-step5-prefill-composed.png` — prefilled prompt + question in the chat input
- `home-step3-changed-fullscreen-fixed.png` — home slide-out at 96vw (bug #3 fixed)

---

## Phase 4 — Comparison-base modes (git diff selector)

The default Changed view shows only **this session's own edits** (JSONL replay,
per-session isolated). But that misses real-world needs: "show me everything
uncommitted in the repo (including random scratch files)", or "diff against the
commit before the latest", or "what have I not pushed yet". Phase 4 adds a
**Compare:** selector to the diff toolbar with four bases:

Every base is scoped to the repos THIS session edited — the base only changes
the baseline `before` is read from, never which repo is shown. A session that
edited nothing is empty in all bases. `scope` then picks files WITHIN those
touched repos: `session` (default) = only the session's files; `all` = every
change in those repos.

| Base | Source | git command | What's shown |
|---|---|---|---|
| **Session changes** (default) | JSONL replay | — | files THIS session edited, reconstructed before/after (no git) |
| **vs last commit** | git | `git diff HEAD` + untracked | the session's files, vs the last commit |
| **vs previous commit** | git | `git diff HEAD~1` | the session's files, vs the commit before HEAD |
| **vs remote (unpushed)** | git | `git diff @{upstream}` (→ `origin/<branch>` fallback) | the session's files, vs the pushed branch |

### Architecture

```
SessionDiffView toolbar  ──base──▶  fetchSessionChanges(sid, {base})
                                       │
GET /api/sessions/:id/changes?base=    ▼
   base ∈ {uncommitted,previous,remote} ─▶ computeSessionGitDiff()  (src/core/session-git-diff.ts)
   else (session/absent)               ─▶ computeSessionChanges()   (JSONL, unchanged)
                                       │
                       ┌───────────────┴───────────────┐
                  LocalRunner (execFile)      RemoteRunner (DaemonConnection.execCommand
                  git in session.cwd          → git over the existing SSH ControlMaster)
                                       │
                       returns the SAME SessionChangesResult shape
                       {groups,files,before,after,status} → frontend renders identically
```

- **Scoped to the repos the session TOUCHED, never the cwd wholesale** — the
  repo universe (and, for scope=session, the file set) comes from the session's
  own edits via `computeSessionChanges`, which walks up from each edited file to
  its `.git` (so it spans multiple repos / submodules / a non-cwd repo). git is
  run per touched repo. A session that edited nothing → empty in every base/scope.
  (Earlier this anchored on the cwd repo and dumped its whole diff, surfacing
  unrelated changes the session never made — that was the bug this fixed.)
- **`before`** = `git show <baseRev>:<path>`, **`after`** = current working-tree
  content (`cat`); 'added'/'deleted' short-circuit to empty.
- **Untracked files** are unioned in via `git ls-files --others --exclude-standard`
  (read-only, NO index mutation) so "local has random files" actually shows them —
  `git diff` alone never reports untracked paths.
- **Remote**: no daemon-protocol change. Added public `DaemonConnection.execCommand(argv, {cwd})`
  that multiplexes an arbitrary command over the SSH ControlMaster (the daemon's
  WS protocol only exposes `fs.*`, never `cmd.exec`). `RemoteRunner` mirrors
  `DaemonFileReader.resolve()` for host→ssh-target lookup.
- **Errors** (e.g. `HEAD~1` on a single-commit repo, no upstream) → throw → route
  maps to **502 + error string**; the toolbar shows the existing error box + Retry.

### Files

- `src/core/session-git-diff.ts` (NEW) — `computeSessionGitDiff(sid, base, cwd, host)`, the `CmdRunner` abstraction (Local/Remote), name-status parsing, untracked union.
- `src/providers/daemon-connection.ts` — added public `execCommand()`.
- `src/web/routes/sessions.ts` — `?base=` param; `GIT_BASES` set routes to the git engine, else JSONL.
- `web/src/api/session-changes.ts` — `SessionDiffBase` type + `base` arg on `fetchSessionChanges`.
- `web/src/components/sessions/SessionDiffView.tsx` — `BASE_OPTIONS`, `base` state, selector in toolbar, base-aware empty-state copy, `base` in `load` deps so a switch refetches.
- `web/src/styles/globals.css` — `.session-diff-base-select` styles.

### Tests

- `tests/web/routes/sessions-git-diff.test.ts` (NEW, 6 tests) — real local git repo with real commits + a real bare remote. Asserts git-specific content the JSONL engine could never produce: `uncommitted` surfaces an **unstaged** edit + an **untracked** file; `previous` uses HEAD~1 content as `before` and current worktree as `after`; `remote` shows only the unpushed commit (upstream content as `before`); clean tree → empty; single-commit repo (`HEAD~1` missing) → 502; unknown base → falls back to JSONL.
- All 21 `vitest.diff-view` unit tests still green; existing `sessions-changes` + core `session-changes` green.

### Verification (live on prod :3456, real clicks)

Built SPA (`vite build`) + server (`tsup`), gracefully restarted prod, then via Playwright on a real walnut-repo session:

- [x] **Compare:** selector renders in the toolbar with all 4 options, "Session changes" default.
- [x] Switching **Session changes → Uncommitted** refetched and changed the header **"No file changes" → "53 files changed"** (real `git diff HEAD`), tree populated under the `walnut` repo root, a real red/green diff rendered in the center pane.
- [x] Switching **Uncommitted → vs remote (unpushed)** refetched to **70 files changed** (includes unpushed commits on top of the working tree — distinct count proves a real, different backend query, not a cached/no-op).
- [x] Git-mode empty state shows base-aware copy ("No changes for this comparison." + the mode's git-command hint) instead of the session-specific "hasn't edited" copy.
- [x] Backend curl smoke on the same session: session=0, uncommitted=53, previous=54, remote=70 — all four bases distinct and matching working `git status`.
- [x] **Remote (SSH) session verified live** on a real monorepo (cwd on the remote host). Switching to Uncommitted in the browser changed the header to **"50 files changed"** and rendered a real split diff (deep submodule tree, line-level +/− with correct line numbers, SSH-host badge). Backend curl on the same remote session: uncommitted=50, previous=54, remote=227 — distinct, matching remote `git status`. Content verified byte-exact (the repo's 914 KB `.gitmodules` with 2,510 submodules came back at exactly 914082 bytes, no separator leakage).

### Rearchitected to run through the daemon (NOT raw SSH) — the correct design

**The journey (recorded so we don't regress to it):**

1. *First remote attempt* used a raw-SSH `execCommand` doing **2 sequential SSH hops per file** (`git show` + `cat`). 50 files = ~100 hops; the unbounded `Promise.all` also blew past the remote `sshd MaxSessions` (default 10). Result: **hung past the 60s timeout** (48s/68s).
2. *Stopgap* batched the reads into 2 `sh -c` programs over SSH -> 11-18s. Better, but **still raw SSH** — architecturally wrong.

**Root cause of the wrongness:** every OTHER remote operation in Walnut (file reads, ls, find, stat, session lifecycle) goes through the **daemon's WebSocket RPC**. Git-diff was the one operation reaching over raw SSH. The daemon runs *on the host where the repo lives*, so it should do the git work locally and return one payload — no reason to involve SSH.

**Final design — `git.diff` is now the daemon's 22nd RPC command:**

```
computeSessionGitDiff(sid, base, cwd, host)
   |- host?  -> conn.send('git.diff', {base, cwd})  -- daemon runs the core ON the host --+
   |- local? -> computeGitDiff(...) in-process (node child_process + fs) -----------------+
                                                                                          v
                                            src/providers/git-diff-core.ts (SHARED algorithm)
                                            git rev-parse / diff --name-status / show / ls-files,
                                            parameterized by injected exec + readText primitives
```

- **`git-diff-core.ts`** holds the whole algorithm, dependency-free, parameterized by `exec`/`readText`. Local injects node `child_process`/`fs`; the compiled daemon (`daemon-standalone.ts`) imports it; the embedded-string daemon (`daemon-source.ts`) inlines an equivalent (it can't import — and must contain **no backticks**, since it is itself a template literal).
- Because git now runs host-local in every path, there are **no per-file round trips** — a plain per-file loop is fine; all the `sh -c`/NUL-separator/concurrency machinery was **deleted**.
- `DaemonConnection.execCommand` (the raw-SSH method added in the first attempt) was **removed** — git-diff was its only caller. Raw SSH now remains only for what genuinely needs it: daemon bootstrap/lifecycle (`sshExec`), the WebSocket tunnel, and the interactive terminal PTY.
- `git.diff` added to `daemon-capabilities.ts` (forces redeploy if a stale daemon lacks it). Editing the daemon sources bumped the version hash -> auto-redeploy on next connect (verified: remote upgraded to `walnut-daemon-080ae010c7b0`).

**Result: 48s/68s (SSH) -> 4-6s (daemon RPC)** — uncommitted 4.1s, previous 4.4s, remote 5.9s on the same 50/54/227-file remote monorepo. Local unchanged (in-process). Verified live in the browser on the remote session: "50 files changed", real split diff rendered, served by the daemon.

**Tests:** `tests/providers/git-diff-core.test.ts` (10 tests) drives the shared core with mock exec/readText primitives — proving base-rev resolution, name-status parsing, untracked union, rename/added/deleted handling, and the {repoRoot,files} contract the daemon returns. The 6 route tests still pass (local path now runs the in-process core).

### Scope toggle — within the repos the session touched

`base` ('Compare:') picks the baseline; `scope` picks which files within the
**touched repos** to show. Both are always bounded to repos the session edited
(never the cwd wholesale):

| | This session (default) | All in repo |
|---|---|---|
| **Session changes** base | n/a (already session-scoped; toggle hidden) | — |
| **vs last / previous / remote** | git diff ∩ this session's edits | every change in the touched repos |

- `computeSessionGitDiff` first calls `computeSessionChanges` to get the session's
  edits → the repo set (and, for scope=session, the file set). It diffs each
  touched repo against the base, then (scope=session) intersects with the edited
  files. No edits → empty, regardless of base/scope.
- **Intersection is on `relPath`, NOT absolute path.** git resolves the repo root
  through symlinks (macOS `/var` → `/private/var`), so the git engine's absolute
  paths can differ from the JSONL engine's for the same file; repo-relative paths
  are computed against each engine's own root and match reliably. (Caught by a
  route test — absolute-path intersection returned 0.)
- The result keeps the **git** before/after (vs the chosen base), not the JSONL
  diff — it's the git diff filtered, not a different diff.
- Frontend: scope toggle ("This session" / "All in repo") renders only for git
  bases; base=session hides it. Default is `session`; the API sends `scope=all`
  explicitly (server defaults to session). Switching refetches.

**Tests:** `tests/web/routes/sessions-git-diff.test.ts` — incl. the key
regression: a session that edited nothing → empty even when the cwd repo is dirty;
scope=session keeps only edited files (with git before/after); scope=all widens to
the touched repo but never an untouched one. **UI verified live** on prod: real
session "This session" (30) ↔ "All in repo" (51) round-trips with a real refetch
(`?base=uncommitted&scope=all`); a no-edit stub session is empty in all four bases.
