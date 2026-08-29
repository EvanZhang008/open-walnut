# Human Inbox: letters from agents to the human

> **Status**: P1 (web loop) shipped 2026-08-22, commit f3ac873e — store, ops, routes, notification bridge, web reader with one-click actions, 57 unit/route tests + 3 real-UI Playwright scenarios. P3 (wn env-less fallback) landed 2026-08-23 (see "The reach story" below); P2 (phone) in progress. Implementation tracker: [human-inbox-todo.md](./human-inbox-todo.md).

## The experience in one paragraph

Any agent running under Walnut (Claude Code, codex, any provider, on any host with a daemon) can send the human a letter: a well-written, self-contained HTML document with full context, like an email. All letters land in ONE human inbox the human reads from anywhere (web console, phone), each letter can be replied to in place (the reply goes back to the agent that wrote it, and its answer threads under the letter), and letters carry human state: unread, pinned, archived. The human inbox is a new section of the existing notification center, because a letter IS a notification, just one whose body is a document instead of a one-line event. The name is deliberate: "inbox" alone is ambiguous (agent-to-agent inboxes already exist in the peers/teams machinery); THIS inbox has exactly one reader, the human.

## When a letter exists: exactly four reasons

Every letter declares WHY it was sent, and the type drives how the UI treats it:

| type | Meaning | Example |
|---|---|---|
| `completion` | work finished, here is the result | "migration done, 42 files, all tests green" |
| `action_required` | the agent is blocked on a human decision | "option A or B?" with buttons IN the letter |
| `review` | a report/artifact needs human eyes | overnight investigation report, weekly digest |
| `info` | communication worth keeping, no action | "heads up: the EC2 disk is at 70%" |

`action_required` letters also count into the notification center's Needs Action section until answered, because they block work the same way a permission ask does.

## The writing standard: extremely simple, short, self-contained

A letter is NOT a transcript dump and NOT a long report. The bar, enforced by the skill guidance the agent reads before sending:

- Short and concise: the reader gets it in one screen on a phone. Background in one or two sentences, then the point.
- Self-contained: the reader must not need to open the session to understand it. State what task this is, what happened, what (if anything) is needed.
- Clear ask: if the letter needs anything from the human, that need is the most visible thing in it, rendered as clickable actions (below), never buried in prose.
- Long artifacts (full reports, diffs, logs) are links inside the letter, not the letter body.

## Sender is stamped by the system, never written by the agent

The server fills the envelope from the caller's session id: agent/session name, task title, project, host, timestamp. The agent only writes subject and body. This means a letter can never misattribute itself, and the human always sees "who, from which task" without the agent spending words on it.

## Why this is not chat, not a task, and not a plain notification

- **Not chat**: a session transcript is a stream. A finished investigation posted into chat scrolls away under tool noise, and reading it on the phone means scrubbing through a whale transcript. A letter is a curated artifact: the agent writes it once, well, for a human reader.
- **Not a task**: tasks track work (phase, project, sessions). A letter communicates a result or a question. A letter may cite tasks, but archiving a letter changes no work state.
- **Not a plain notification**: today's notification kinds (permission, cron, operation-error, skill, hook) are system events with one-line bodies, and opening the panel marks them all read. A letter has a document body, is read one at a time, and is never auto-marked read by opening the panel.
- **Not a permission card**: permission cards serve the 30-second approve/deny loop. Letters serve the considered async loop: "here is what I found, here are options A and B, what do you want?"

## End-user scenarios (the alignment target)

### 1. Overnight investigation

Evening: the user asks a session on a remote dev box to investigate a gnarly bug, then goes to bed. 3am: the agent finishes and sends a letter: an executive summary, the root cause with code links, and a recommended fix. The phone gets a push ("New letter: root cause of the sync freeze"). Morning: the user opens Walnut on the phone, the inbox badge shows 1, and they read a properly formatted report over coffee, not a transcript. They tap reply: "does this also explain the Tuesday incident?" The origin session (still alive on the daemon, or revived by the normal resume path) answers into the thread minutes later, and the letter flips back to unread with a push.

### 2. Daily digest

A morning routine ends its run with one letter instead of a wall of chat text: yesterday's sessions, tasks that moved, errors that recovered, one thing that needs a decision. The user reads it, replies to the decision point, archives it. The digest letter is pinned by the routine until the next one replaces it.

### 3. Decision fork mid-project

An agent three hours into a refactor hits a real product fork. Instead of stalling on a permission prompt or guessing, it sends a short `action_required` letter: two sentences of background, options A and B as BUTTONS with one-line trade-offs, a recommendation marked on one of them. The user, on their phone days later if need be, taps one button and is done; the choice lands in the agent's session and it proceeds. The letter now shows "answered: B, Aug 22 09:14" and the decision is a readable record, not a buried chat exchange.

### 4. Any provider, any host

A codex session on the laptop finishes a migration and sends a letter summarizing what changed, with per-file highlights. Same inbox, same reply loop. Nothing about the letter says which provider or host produced it except the sender line.

## What the human sees

### Web console

- The notification center gains an **Inbox** rail section (alongside Needs Action / Errors / Automation / System / All). Each row is an envelope, all of it stamped by the system: sender (agent/session name), task title, host, subject, first text line, time, a type badge (completion / action needed / review / info), pin marker, unread dot.
- Clicking an envelope opens the **reader**: a large overlay (PlanPopup-scale, not the narrow panel) rendering the body (HTML in a sandboxed iframe, or rendered markdown), action buttons on top when the letter asks for a decision, the thread of replies below, and a composer at the bottom.
- Reading marks THAT letter read. Opening the panel does not touch letter unread state (deliberate exception to the panel's mark-all-read behavior).
- Row actions: pin/unpin (pinned letters sort first and never age out), archive (leaves the feed, retrievable from an Archived filter), mark unread.
- The sidebar bell badge includes unread letters; the Inbox rail tab shows its own count.

### Web console, inside a session: the Inbox tab

The notification center is the cross-session view. Inside one session there is a second lens on the same letters: an **Inbox tab** in the session panel, peer to Changed / Files / Terminal / Code.

- The tab lists the letters THIS session wrote (envelope rows, unread dot, type badge, answered chip), and the tab chip carries the session's unread count, coloured as a warning while a decision is still unanswered. The count is live whether the tab is open or not, because that badge is the thing that tells you a letter is waiting.
- Clicking a row opens the letter IN the tab: the same document body, decision buttons, answered record, thread and reply composer the overlay reader shows. It is literally the same component, so the two surfaces cannot drift.
- The tab joins the existing split, so the letter sits beside the live chat in one session column: read the ask on the left, keep talking to the agent on the right. A window too narrow for both opens the letter alone, with the chat one click away.
- A file path inside a letter opens in the panel's own Files view, like every other path click in a session, rather than popping a modal over it.
- "Open session" inside a letter deep-links to that session's Inbox tab with the letter open (`/sessions?id=<sid>&tab=inbox&letter=<id>`), which also works pasted or bookmarked.

The rail and the tab are two lenses on ONE store: read, pinned, archived and answered live with the letter, so answering in the tab updates the rail, the bell badge and the phone with no refresh anywhere.

### Phone (iOS)

- An Inbox list (same envelope rows) and a reader built on the existing WKWebView HTML preview, with the thread and a reply box.
- Push notification on new letter and on agent reply, deep-linking to the letter. Push carries the envelope only: subject plus the short plain-text preview the agent wrote for exactly this purpose (the same string the inbox row shows, <= 300 chars), never the document body, which stays behind `GET /api/v1/human-inbox/:id`. An agent that must not put anything on a lock screen writes a neutral `text` preview.

### Reply loop

- The human replies inside the letter. The reply is delivered to the origin session through the existing message queue (same rail as peer messages), wrapped with attribution and one instruction: answer with `wn tools call human_inbox_reply '{"letter":"<id>", ...}'`.
- The agent's reply threads under the letter, flips it unread, and pushes. If the origin session is dead, the normal resume/respawn path revives it; if the host is unreachable, the reply queues exactly like any other queued send.

## How agents send: ONE thing, `wn`

The agent-facing surface is `wn` and nothing else. It works the same everywhere: inside any managed session on any host (gateway socket), in the human's own terminal on the Walnut machine (local HTTP), and in a hand-started agent on any daemon host (well-known socket fallback). The transport is picked automatically behind the same commands; the caller never chooses. MCP is not a second thing: `wn mcp` runs the same binary as a stdio MCP server over the same op registry, for sessions that mount tools instead of using Bash. `walnut` becomes the server/ops command only (start the server, logs); `walnut tools` is removed, and the skill and all docs teach only `wn`.

The two new ops:

- `human_inbox_send { subject, type, html? | markdown?, actions?, text?, task_refs?, pin? }`: send a letter. Body is `html` (preferred, ready for anything complicated) OR `markdown` (rendered by the reader, for the common simple letter); exactly one required, both bounded, no scripts. `type` is one of completion / action_required / review / info. `actions` (action_required only) is the button list rendered in the letter. `text` is a short plain-text fallback for the envelope preview and push. Returns the letter id.
- `human_inbox_reply { letter, html? | markdown?, text }`: append an agent reply to an existing thread.

So the whole act of sending a letter, from any agent anywhere, is one Bash call:

```
wn tools call human_inbox_send '{"subject": "Refactor done", "type": "completion", "markdown": "..."}'
```

Sender identity comes from the caller's session id (the gateway already authenticates callers by sid) and is stamped server-side, so a letter always knows which session, task, project, and host it came from; the human never has to ask "who sent this".

## Clickable body and one-click actions

Everything in a letter body is live, not decoration:

- **Links work**: task refs render as the same task pills used in chat and deep-link to the task; session references open the session; file paths linkify the same way they do everywhere else in the console; external URLs open normally. Same behavior in the iOS reader.
- **Actions are buttons in the letter**: an `action_required` letter carries `actions: [{ id, label, description? }]` plus an optional free-text field. The reader renders them as buttons at the top of the letter. The human clicks ONE button and is done: the choice is delivered to the origin session (same delivery rail as a reply), the letter flips to an answered state showing which option was picked and when, and it leaves Needs Action. This is the AskUserQuestion shape made asynchronous and durable: the ask survives the session going idle, works from the phone days later, and the decision stays on record in the thread.
- A free-text reply is always available under the buttons, for "option B, but only after the tests pass".

Agents learn WHEN to write a letter the same way they learn everything else: the walnut skill gains a short "when to send a letter" section (long-running result, daily digest, decision fork, anything the human should read later on a phone), and routines/cron templates get a closing hint. No new injection machinery.

## Architecture sketch

```
agent (any provider, any host)
  wn tools call human_inbox_send ── unix socket ── daemon ── gateway relay ──┐
  wn (terminal, local HTTP) / wn mcp (stdio MCP, same registry) ─────────────┤
                                                                             v
                                                        ops registry executor
                                                                       v
                                                     POST /api/v1/human-inbox (new route)
                                                                       v
                                    letter store (WALNUT_HOME/human-inbox/: index + one html file per letter)
                                          │                    │
                                          v                    v
                            notification record          event bus letter.new
                            (kind 'letter', envelope       │           │
                             fields only, no body)         v           v
                                                      web WS feed   push (phone)
```

- **Storage split on purpose**: the notification store is a bounded most-recent-200 feed that drops its tail; letters are durable documents. So the letter body and thread live in their own store (an index JSON plus one HTML file per letter under WALNUT_HOME/human-inbox/), and the notification record is only the envelope pointing at the letter id. Pin/read/archive state lives with the letter, not the notification.
- **Condition-system fit**: every notification declares how it ends; a letter ends only by human action (archive). No recoveryKey, no expiry, and letter unread state is exempt from panel-open mark-all-read.
- **Body safety, both formats**: an HTML body renders in a fully sandboxed iframe (no scripts, no top navigation), same posture as an email client; on iOS, a WKWebView with JavaScript disabled. Both carry a CSP that allows no remote subresource, because a tracker pixel in a letter would otherwise report the exact moment (and IP) the human read it. The MARKDOWN body gets the same floor by construction: the reader renders it through the app's own markdown pipeline with remote image references replaced by a visible "not loaded" note, so the two formats can never have different security floors (local paths still resolve through Walnut's own authenticated media endpoint). Agents are told to write self-contained HTML with inline styles and data-URI images.
- **Size**: markdown bodies, thread text and answer notes are capped at 200KB (prose for one phone screen). An HTML body gets 10MB, because it is the one field that legitimately carries inline media: a daily digest embeds its podcast as a base64 `<audio>`, which is 2-5MB. That cap is only reachable because the gateway request line (one `human_inbox_send` is one NDJSON line) was raised to 12MB alongside it; the two have to move together. Big artifacts that are not media still belong on disk with a path link in the letter.
- **Replica/phone path**: new `/api/v1/human-inbox` endpoints are additive to the frozen v1 contract and relay from a cloud replica to the primary exactly like the existing notification routes.

## The reach story (idea 1: `wn` everywhere)

Mostly already true, verified in source: the shared ops registry (26 ops) renders into the `walnut` CLI, the MCP server, and the `wn` shim the daemon injects into every managed session's PATH on every host; remote agents need zero installation, and the gateway socket truncation bug that used to break large replies is fixed (buffered writes with drain).

The last gap is closed (2026-08-23). `wn` used to require WALNUT_AGENT_SOCKET and WALNUT_SESSION_ID in the environment, which only Walnut-spawned sessions have, so an agent the user started by hand on a daemon host (a bare `claude` in a terminal) could not call Walnut at all. Now, with either variable absent, `wn` falls back to the host daemon's well-known socket and identifies as caller `external`: verified live from a shell with both variables unset, `wn tools list`, `wn peers list` (no self row) and `wn tools call` all work, and a letter from such a caller is stamped sender `external`. The env was only half the gap: the daemon's `wn` shim lives in its own dir, which is on the PATH of sessions the daemon spawns and nowhere else, so a plain terminal answered `wn: command not found` and never reached the fallback at all. The daemon now also installs a `wn` in the user's own bin dir (`~/.local/bin`, plus `~/bin` when that already exists). That copy resolves the daemon's shim at call time, so a daemon upgrade can never strand it; it is written only by a production daemon (never a test or sandbox one), it never overwrites a `wn` it did not write, and with no daemon on the host it exits 6 with the same meaning `wn` itself gives that case.

Two rules keep that from being a new door. First, the socket's owner-only 0600 mode IS the credential, so the fallback adds no socket and changes no mode, and it refuses a well-known path that is not a socket owned by this user with no group or other bits (the daemon dir lives under a world-writable /tmp, where anyone could otherwise plant one). Second, `external` is ANONYMOUS provenance, never authorization or identity. Any program the user's account can run on the host can send it, a managed session that clears its own WALNUT_* env included (the well-known socket is the same socket it was handed), so nothing may be granted on the strength of the label. The hub gives it no capability a tracked session lacks: same op catalog, same local-only refusals, the same refusal to disturb a session parked on a permission prompt or to write to an archived one, and a per-HOST rate bucket instead of one global bucket (so a runaway caller on one machine cannot throttle the user's own terminal on another). The two places a caller's identity would have been used degrade honestly instead of guessing: `peers list` marks no row as self, and a peer note from an anonymous caller says an unidentified process on that host sent it, never a session title and never the user. The one guard that genuinely cannot apply is `self_send`, which needs an identity to compare against; that is not a privilege boundary in Walnut anyway (the `session_send` op has no self guard either, so any caller can already queue a message into its own session), and an anonymous caller cannot make the mistake the guard catches because it never learns its own sid.

## Decisions to align (each with a recommendation)

1. **Reader surface**: Inbox section inside the notification center with a large overlay reader (recommended, matches "a letter is a special notification") vs a separate top-level Inbox page. The overlay keeps one notification home; a page adds a nav item for something that may start low-volume.
2. **Reply routing**: reply goes to the origin session, reviving it if dead (recommended) vs routing replies to the Personal AI main agent. Origin session has the context; the main agent would have to reconstruct it.
3. **HTML policy**: strict no-script sandbox, email-client model (recommended) vs allowing scripts for interactive reports. Interactive reports can stay file-based artifacts opened via the existing file preview; letters should be safe to open blind on a phone.
4. ~~Naming~~ SETTLED: "Human Inbox" for the surface ("inbox" alone is ambiguous, agent-to-agent inboxes exist), "letter" for the item, ops `human_inbox_send` / `human_inbox_reply`. Also settled: the agent surface is `wn` + `wn mcp` only; `walnut tools` is removed.
5. **Who else can send**: v1 agents only, or also the system itself (e.g. weekly usage report as a letter)? Recommended: design the store so kind 'letter' with a system sender works, but ship agent-send first.

## Phasing

| Phase | Contents | Done means |
|---|---|---|
| P1 web loop | letter store + `human_inbox_send`/`human_inbox_reply` ops (type + html/markdown + actions) + `/api/v1/human-inbox` routes + Inbox rail section + reader with action buttons + read/pin/archive + reply/action-to-origin-session + push on new letter | an agent on a remote host sends an `action_required` letter via `wn`, the user reads it in the web reader, clicks an action button, the choice lands in the origin session and its answer threads back, all verified in a real-UI Playwright run |
| P2 phone | iOS inbox list + WKWebView reader + reply + push deep-link | the overnight-investigation scenario works end to end from the phone |
| P3 reach | `wn` env-less fallback (external caller identity) + skill/routine guidance for when to write a letter | a hand-started `claude` in a plain terminal on a daemon host sends a letter with zero setup — DONE 2026-08-23: `wn` with no env reaches the host daemon's well-known socket as caller `external` |
