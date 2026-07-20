# Codex-via-ACP UI Test Plan — Real-Usage Simulation

This plan verifies the Codex engine end to end through the REAL browser UI the way a user actually works: pick a folder, flip the engine to Codex, build a real project over multiple turns, approve permissions, interrupt, survive restarts, and keep working. It covers three environments (mock-agent automation, live-codex ephemeral, prod smoke), ten scenario groups (A–J, 46 cases), and marks each case as automated (existing spec), live-executed, or manual-deferred. The Homepage panel is the PRIMARY surface for every scenario; the /sessions page is verified for parity as the secondary pass.

## Environments

| Env | What | When to use |
|---|---|---|
| E1 — Playwright test-server (:3457, mock ACP agent) | Real server + real acp-worker + scripted mock agent (tests/e2e/browser/test-server.ts) | Deterministic automation; every UI behavior that doesn't need real model output |
| E2 — Ephemeral server + REAL codex | `node dist/cli.js web --ephemeral` (random port, temp data, isolated daemon) + system codex via resolveSystemCodexPath | The real-usage simulation runs (this document's live pass) |
| E3 — Prod (:3456) | The user's daily server | Final smoke only: one codex quick-start, one follow-up. NEVER kill/restart it |

Conventions for the live pass: every screenshot goes to `/tmp/codex-ui-test/<case>.png` (never deleted); a case passes only when the on-screen result AND the on-disk/journal evidence agree; any UI interaction is a real click/keystroke — `page.goto()` only for the initial load.

## A. Launch & engine selection (Quick Start picker)

| # | Case | Steps | Expected |
|---|---|---|---|
| A1 | Engine toggle renders, Claude default | Homepage → "Quick session" pill → picker opens | `Claude \| Codex` segmented control in footer; Claude active; model select visible |
| A2 | Codex hides the Claude model select | Click Codex in full footer AND in compact (edit-mode) footer | Model select disappears in both layouts; no dead space; toggle stays active on reopen |
| A3 | Remote host pins engine to Claude | Switch to a remote host tab (if configured) | Codex button disabled with "local-only" tooltip; selecting a local tab re-enables |
| A4 | Collapsed bar shows the engine | Pick Codex → confirm a path (⇧Enter) | Quick Start bar chip reads "Codex" (not a model name); clicking the chip reopens the picker with Codex still selected |
| A5 | Create-folder & start with Codex | Type a nonexistent leaf → create row → confirm → send | Folder is created on disk, session starts in it with engine=codex |
| A6 | Engine survives picker edit-reopen | A4 → reopen picker → switch star/priority → confirm again | Engine stays Codex; other meta preserved (initialMeta round-trip) |

Automated today: A1, A2, A4 (tests/e2e/browser/codex-engine.spec.ts). Live pass: A1–A6.

## B. First conversation (send message → stream → turn end)

| # | Case | Steps | Expected |
|---|---|---|---|
| B1 | First prompt streams | Quick-start codex with "introduce yourself in one sentence" | Pending panel → live panel; assistant text streams incrementally (not one blob) |
| B2 | Thinking renders | Prompt that triggers reasoning | Thinking/reasoning block renders distinct from answer text (agent_thought_chunk → thinking-delta) |
| B3 | Turn end → Idle | Wait for stop | Status dot goes Idle; no stuck spinner; input re-enabled |
| B4 | Badges on all three surfaces | Inspect Homepage session panel, SessionRow in list, /sessions detail page | "Codex" badge/pill on ALL of: SessionRow, SessionPanel pill (inert — no model picker popup on click), SessionDetailPanel |
| B5 | Task creation + title | Check the task list after B1 | Task created under Quick Start, later renamed by the main agent; engine session bound to it |
| B6 | Model discovery evidence | Any codex session start | No hard-coded model list anywhere; models came from session/new (23 on this machine); no catalog "flash" |

Automated today: B1 happy-path via mock (codex-engine.spec.ts test 3). Live pass: B1–B6.

## C. Real project build — the core simulation

One session builds an actual small project across multiple turns. This is the closest thing to a day of real use.

| # | Case | Steps | Expected |
|---|---|---|---|
| C1 | Multi-file scaffold | "Create a Python CLI tool `wordcount.py` that counts words in a file, plus a README.md, in this folder" | Tool-call rows appear while codex writes files; on turn end, both files exist on disk with sensible content |
| C2 | Run something | "Run the tool on the README and show me the output" | Exec tool-call row + result rendered; output matches a manual run |
| C3 | Warm iteration | "Add a --top N flag that prints the N most common words" | SAME worker (no cold resume; journal has no session-loaded); file updated on disk; diff is coherent with the request |
| C4 | Bug-fix loop | "There's a bug: it crashes on empty files. Fix it and prove it with a quick test" | Codex reproduces, edits, re-runs; UI shows the full tool timeline in order |
| C5 | Long output | Ask for a verbose listing / long explanation | Stream stays smooth; no block truncation or panel freeze |
| C6 | Changed-files tab | Open the Changed tab after C1–C4 | KNOWN GAP: ACP sessions have no CLI JSONL for changed-file replay — tab may be empty. Record actual behavior; must not crash |

Live pass: C1–C6 (the heart of this plan).

## D. Permissions

| # | Case | Steps | Expected |
|---|---|---|---|
| D1 | Approve | Trigger a permission-gated action (mode-dependent) | Urgent permission card renders with the provider's real options; Approve → tool proceeds; card resolves |
| D2 | Deny | Same, choose Deny | ACP reject/cancelled outcome; codex continues gracefully (no wedged turn) |
| D3 | Auto-cancel on interrupt | Pending permission → interrupt the turn | Permission card clears (permission-auto-cancelled), no orphaned card |
| D4 | Pending survives panel close | Pending permission → close panel → reopen | Card re-renders from journal/meta state, still answerable |

Automated today: D1 approve + D2 deny over HTTP (acp-session-server-e2e), D3 (worker tests). Live pass: D1 if codex's mode surfaces one (default sandbox may auto-approve; record which mode was active), else mark N/A-live and rely on mock automation.

## E. Mid-turn behavior & queueing

| # | Case | Steps | Expected |
|---|---|---|---|
| E1 | Send while running → queued → drains | Start a long turn, immediately send another message | Second message shows as queued (NOT lost, NOT injected); when the turn ends it drains automatically as the next turn (one-prompt-per-turn contract) |
| E2 | Interrupt-and-replace | Long turn → send with the interrupt affordance (stop+send) | Running turn ends as cancelled; replacement message becomes the next turn; both visible in transcript |
| E3 | Rapid multi-send | Queue 3 messages during one turn | All 3 drain as ONE combined prompt at turn end (\n\n-joined); none lost; optimistic bubbles reconcile |
| E4 | Stop button alone | Long turn → Stop | Turn ends (cancelled stopReason); status Idle; next send works warm |

Automated today: E1/E2 equivalents in acp-session-server-e2e. Live pass: E1, E2, E4.

## F. Session lifecycle

| # | Case | Steps | Expected |
|---|---|---|---|
| F1 | Terminate | Session menu → Terminate | Worker shut down gracefully; status Stopped; record status_reason user_stopped |
| F2 | Follow-up to idle session hours later (simulated) | Send to an idle codex session | Warm if worker alive; lazy resume via session/load if reaped — either way the reply lands and history is intact |
| F3 | Archive | Archive the task/session | Session hidden; no permission spam; no zombie workers |

Live pass: F1, F2.

## G. Resilience (crash / restart)

| # | Case | Steps | Expected |
|---|---|---|---|
| G1 | Web server restart mid-conversation | Restart the (ephemeral) server process; reopen UI; send | maybeAttachAcpSession re-attaches from the record; stream resumes gap-free (journal replay from watermark); worker never died |
| G2 | Daemon/worker death → lazy resume | SIGKILL the acp worker (or daemon); send the next message | "Turn interrupted" honesty marker if mid-turn; next send auto-resumes the SAME provider thread (session/load); model still remembers earlier turns (ask it) |
| G3 | Unresumable thread → visible fallback | Corrupt/lose the provider thread; send | Explicit warning bubble "Could not resume… starting fresh"; NEVER a silent history loss |

Automated today: all three at the server/daemon layer (acp-session-server-e2e + acp-daemon-e2e + live suite G2 flavor). Live pass: G2 through the browser.

## H. Coexistence & parity

| # | Case | Steps | Expected |
|---|---|---|---|
| H1 | Claude + Codex side by side | Open one native Claude session and one Codex session in two Homepage columns; drive both | Streams never cross panels; badges distinguish them; interrupt in one doesn't touch the other |
| H2 | /sessions page parity | Repeat B4/C-transcript checks on /sessions | Same transcript, badges, permission cards render on the detail page |
| H3 | Native regression | Full native Claude flows (existing Playwright suites) | Unchanged green (session-transport 35, path-selector, etc.) |

Live pass: H1, H2. H3 = re-run existing suites.

## I. Cross-cutting UI

| # | Case | Steps | Expected |
|---|---|---|---|
| I1 | Model pill inertness | Click the Codex pill on both surfaces | No ModelPicker popup (Claude-only control); tooltip explains |
| I2 | Multi-panel behavior | Codex panel + Files view + Terminal chip | All secondary views open/close normally |
| I3 | Recap/summary after turns | Let a session idle after several turns | Recap line appears like native sessions (summary path is engine-agnostic) — record actual behavior |

## J. Edge cases

| # | Case | Steps | Expected |
|---|---|---|---|
| J1 | Empty message | Try to send empty | Blocked or no-op, consistent with native behavior |
| J2 | Very long prompt | Paste a many-KB prompt | Spill-to-file path or clean delivery; no UI freeze |
| J3 | CJK + special chars | Send Chinese + emoji + backticks | Round-trips intact in transcript and to the model |
| J4 | Image attachment | Attach an image to a codex send | MVP expectation: images are Claude-path only; must degrade gracefully (no crash, clear behavior) — record actual |
| J5 | Two codex quick-starts in parallel | Fire two quick-starts back to back | Two independent workers/journals; no sid cross-talk |

## Execution order (live pass, E2)

1. Boot: ephemeral server, screenshot baseline. 2. A1→A6. 3. B1→B6. 4. C1→C6 (project arc). 5. E1, E2, E4 mid-turn. 6. D as available. 7. F1→F2. 8. G2. 9. H1→H2. 10. J1, J3, J5. Each case: screenshot + on-disk evidence noted in the results log below.

## Results log

Filled in during execution — see `/tmp/codex-ui-test/RESULTS.md` for the run-by-run log with screenshots; summary lands back here after each full pass.

### Pass 1 — 2026-07-18, E2 (ephemeral + real codex): PASS

All executed cases green (A1–A6, B1/B3–B6, C1–C6, E1/E2/E4, F1/F2, G2, H1–H3, I1, J1/J3/J5). B2 and D1–D4 were N/A live (this codex config emitted no thought chunks and auto-approved all execs in its default sandbox) — both remain covered by the mock-agent automation. C6 confirmed the known Changed-tab gap without crashing.

The pass caught and fixed two real product bugs the automated suites could not see:

1. **Bundled-dist artifact resolution** — `resolveAcpArtifacts()` hardcoded `../..` from the module URL, which is wrong inside the flattened `dist/cli.js` bundle; every real-UI codex quick-start spawned a nonexistent worker path and died with `worker died: worker-exit`. Tests never hit it because they inject artifacts. Fixed by walking up to the first ancestor containing `dist/daemon-binaries/acp-worker.js`.
2. **`host: '__local__'` sentinel in codex records** — record convention stores local host as `undefined`; the truthy sentinel made the health monitor treat codex sessions as remote (`error/remote_unreachable`) and turn-end status flip to `stopped`. Fixed in acp-session.ts (drop sentinel), session-liveness.ts (engine='codex' → provider-managed liveness), session-health-monitor.ts (codex excluded from the pid==null orphan sweep).

Plus one UI hardening from A3: a stale Codex selection on a remote host tab now visually falls back to Claude (which is what the launch does) instead of showing a disabled-but-active Codex.

Post-fix regression: worker 14 + daemon 11 + daemon-E2E 4 + server-E2E 7 + Playwright 3 + live 5 — all green.

## Known gaps (accepted for MVP, do not "fix" silently)

- Changed-files tab: ACP journals aren't CLI JSONL; changed-file replay not wired (C6 records behavior).
- Images on codex sends: not implemented (J4 records degradation).
- Remote hosts: engine pinned to Claude by design (A3).
- Mid-turn injection: impossible by ACP contract — queue-then-drain is the CORRECT behavior, not a bug (E1).
