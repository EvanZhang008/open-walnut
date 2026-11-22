# Notification Lifecycle (the condition system)

Who sees a record (the person, or Walnut Health only) is one rule of its own:
[notice-audience.md](./notice-audience.md).

Every notification is a projection of a CONDITION, and a condition has a state
machine — never fire-and-forget:

```
FIRING ──(matching success signal)──▶ RECOVERED   (green "Recovered ✓", leaves Errors rail)
   │
   ├──(owning entity dies)──────────▶ EXPIRED     ("Session ended" / "Stale")
   └──(one-shot, 48h sweep)─────────▶ EXPIRED     ("Stale")
```

Permissions got this first (allowed / denied / expired, commit 0d9c7783);
errors joined in 29eee93d + this change. The state lives on the notification
record (`resolved`), the identity of the condition is `recoveryKey`.

## The four lifecycle contracts

| Contract | Meaning | Recovery / terminal signal | recoveryKey shape |
|---|---|---|---|
| edge | a retried operation; success = recovered | failure→success transition (recovery-transition tracker) | `route:<METHOD> <path>`, `plugin:<id>`, `plugin:<id>:push` (a task change's push; retired by the next push that succeeds, or by the plugin's pull recovery), `git`, `git:compaction`, `backup`, `disk`, `bus:<subscriber>:<event>`, `task-db-writers`, `local-daemon` (any start that ends with the daemon serving) |
| liveness | bound to an entity with a lifespan | entity's next clean result = recovered; entity death = expired | `session:<sid>`, `task:<taskId>` |
| boot | a process-lifetime fact | server startup IS the recovery | `server-lifecycle` |
| one-shot | a completed past event; nothing can recover | 48h keyless debris sweep → Stale | none + `// lifecycle: one-shot` comment |

## Invariants (each is load-bearing)

- `recoveryKey` identifies the CONDITION; `dedupScope` identifies the CARD.
  Several cards may share one condition (a plugin's http/sync/reconciler cards
  all retire on one sync success).
- Recovery fires on transitions only, never on healthy ticks (a 30s poll must
  not become a permanent store scan). `createRecoveryTransitionTracker` +
  `isFailing()` pre-checks keep the healthy hot path allocation-free.
- Recovery clears the error-TTL absorber for its scopes: a re-failure right
  after recovery must notify fresh, not inherit suppression.
- Recovery never re-badges (`read` untouched) — it is good news.
- Expiry never fabricates an outcome: an expired permission reads "Session
  ended", an expired error reads "Stale", neither claims Approved/Recovered.
- Marking failing and keying the card must be one move
  (`publishSessionErrorNotification`) — a card keyed but never marked failing
  can never be retired; that class of bug is why the helper exists.

## Enforcement

`tests/core/notifications/lifecycle-ratchet.test.ts` fails CI on any
`publishErrorNotification` call site that neither passes `recoveryKey` nor
carries a `// lifecycle: one-shot` declaration. The log-error bridge derives
keys automatically (`meta.recoveryKey` > `meta.pluginId` > session/obs root +
sessionId/taskId > non-core subsystem root), so ad-hoc `log.error` calls join
the system without ceremony; core-subsystem logs without ids stay keyless and
fall to the debris sweep.

## "Ask AI to fix" (repair from the card)

Every error card offers "Ask AI to fix". It calls `POST /api/notifications/fix { dedupKey }`, which starts a Claude Code session in Walnut's own source with the record (title, message, Details line, occurrence count, `recoveryKey`, session/host context) as the brief, files the task under the `Walnut` project with title `Fix: <card title>`, and stores the session on the record (`fix`), so the card then shows "Open fix session" instead of starting a second one. The record keeps `fix` across folds.

Where the session runs depends on how Walnut was installed (`src/core/self-repair/walnut-source.ts`):

| Install | Source the session edits | Notes |
|---|---|---|
| git checkout run in place | that checkout (`WALNUT_INSTALL_DIR`) | the brief says the running server was built from this tree; the repo's CLAUDE.md workflow applies |
| npm install, with your own clone | `self_repair.source_dir` in config.yaml (or env `WALNUT_SOURCE_DIR`) | must be a checkout: package.json named `open-walnut` next to `.git` |
| npm install, nothing else | `~/open-walnut`, cloned from upstream on the first click (minutes) | the brief warns that the running Walnut is the npm package, not this tree, and gives `bun run web:build && npm install -g .` as the apply path; it must not run `dev:prod` or restart the running server |
| cloud replica | not offered | repairs start on the primary console |

The button is hidden when `GET /api/config` reports `selfRepair.available: false` (replica, no `git` on PATH, or `~/open-walnut` exists but is not a Walnut checkout; `selfRepair.reason` says which).

## A toast's whole message

The notice stack sits at the bottom left of the window, 16px above the bottom edge and 16px right of the sidebar's icon rail, 440px wide (less only in a window narrower than 472px), floating over the page (`web/src/components/common/corner-stack.tsx`, 2026-11-16). Its width never follows a panel, a chat's composer, a column or a full-screen sheet. It overlaps the page like a system notification, and nothing on the page moves when a notice comes or goes. What it covers can still be scrolled out from under it: it measures how much of the window's bottom it covers now (from its own box, kept current by a ResizeObserver that asks for the next frame, never inside its callback, so turning `is-overfull` on or off never logs a ResizeObserver loop error; 0 while it covers nothing), and every scroller beside the rail whose CSS rule asks for it (`var(--corner-stack-room, 0px)` in its `padding-bottom` or its last grid row) gets that much extra room at its end. The property is registered as not inherited (`@property`, `web/src/styles/corner-stack.css`), and `web/src/components/common/corner-stack-room.ts` sets it inline on the asking boxes alone (`ROOM_BOXES`, which `tests/web/corner-stack-guard.test.ts` holds to the CSS both ways). Each page's own cascade stays as it is. A spacer after a box's last row (an `::after`) reads `var(--corner-stack-spacer, 0px)` instead, an ordinary inherited variable set on its box (`SPACER_BOXES`): WebKit 26 gives a pseudo-element nothing of a registered property that is not inherited, `inherit` included (measured 2026-11-17: the spacer stayed 0px in WebKit and took the value in Chromium), so those few boxes restyle what is inside them too.

Why on the boxes and not in a stylesheet, measured 2026-11-17 on the Tasks table grown to 55,000 elements, per change of the room (median; Linux Chromium and Linux WebKit 26 in Playwright, `tests/e2e/browser` probes, not committed):

| How the room is given | Chromium | WebKit |
|---|---|---|
| The padding written inline on the box (no var) | 6ms | 180ms |
| The registered property inline on the box (this) | 70ms | 180ms |
| A stylesheet copying each asking rule with the value | 20ms | 1,300ms |
| One rule setting the registered property on the boxes | 87ms | 1,300ms |
| An inherited variable on `<html>` or the scroller | 250ms to 300ms | 1,000ms |

In WebKit, the Mac app's engine, any stylesheet change (new text, one rule's declaration, a sheet switched off) restyles the whole document, about 1.1s on that table even for a rule that matches nothing, so the room never goes through a stylesheet. A whole toast appearing and leaving (the longest frame while it does, median of 5), before the room and with it: on that Tasks table, Chromium 100ms and 50ms, then 183ms and 117ms; WebKit 332ms and 231ms, then 599ms and 412ms (most of it the table's own layout for its new padding; with the stylesheet copy it was 2,052ms and 1,850ms in WebKit). On Home with its list grown to 20,000 elements, Chromium 50ms and 67ms, then 83ms and 83ms; WebKit 62ms and 50ms, then 82ms and 57ms. On the fixture's own pages (600 to 3,400 elements) nothing changes measurably in either engine.

A spacer instead of padding where padding would move something: a control stuck to the scroller's bottom edge (the notes editor's mic dock), a box whose own size padding would change (the welcome card, and Home's task list below it while the card shows: they share the task panel, and padding floors a box's size; a plugin App's box). The spacer's variable restyles everything inside its box, so the task list takes it only under the welcome card, when it is empty. Each asking scroller keeps its scrollbar's gutter (`scrollbar-gutter: stable`), so a list that starts to scroll when the room comes keeps its width with classic scrollbars. Settings' page list and pane take that gutter out of their own right padding (`--settings-gutter`, measured by `web/src/components/settings/useSettingsGutter.ts` inside a hidden Settings container, since Settings styles its scrollbar 8px wide): on top of the padding it took 8px from every row at rest and wrapped six descriptions at 660px (2026-11-17). Known gap: WebKit 26 reserves no gutter beside the app's `::-webkit-scrollbar` styles (it reports the property as supported), so there, with classic scrollbars (a mouse set to always show them), a short list that starts to scroll when a notice comes narrows by the scrollbar's width (6px) until it goes. Overlay scrollbars, the Mac's default, take no width.

The scrollers that ask today: Home's task list and its welcome card, the page area, Notes' tree, start page and editor, the scratchpad, the Calendar's rail and grid, the Tasks rail and table, Apps, Settings and its Memory tree, the Org list, the Passwords lock screen, the unlocked vault's side and item list (and the whole page in a narrow window), Mail's folders and message list, and a plugin App's box; so a list's last row scrolls clear. Each box takes the room once: the Memory pane gives none of its own, since the note editor inside it already ends with a spacer. A control that must stay reachable never sits in a footer under a list at the bottom left: Home's found computers (Connect, Not now), the welcome card and the multi-select bar sit right under the task panel's toolbar, the Tasks rail's New Project sits under its title above the list, the vault's Generator, Import, Lock and recovery kit warning follow its sections in a side that scrolls, and Mail's last-checked line and + Add account sit under its pane's head. The multi-select bar takes its height from the top of the list's scroller, so the scroller scrolls by the same amount while it comes and goes (`useRowsStillUnderBar.ts`) and no row moves between two Cmd/Ctrl-clicks; a list shorter than its box has nothing to scroll by. Mail's answer strips (one line about the folder or message just asked about) stay at their pane's foot, as before: they are not controls a page needs, the next selection clears them, and moving them above the list would move its rows. `tests/web/corner-stack-guard.test.ts` reads every built-in page's own stylesheets (each app in `core-app-list.ts` names them) and fails on a scroller or footer there that neither takes the room nor says why it is never under the stack. Home's taskbar of minimized sessions runs along the bottom; while it shows the stack stands on it (`--corner-stack-lift`, the stack's own `bottom`), so its chips stay in reach. A notice opened to its whole text scrolls its words inside it past a quarter of the window, and a stack still taller than the window scrolls itself from its top (`is-overfull`), so every x takes a real click. What does not scroll is overlapped by design: a hint line, the chats beside the task panel (a session column and Home's Ask Walnut slot, both session panels; the user's call, 2026-11-16, named in the tests as `CHAT_SURFACES`), and a full-screen sheet, which the stack sits over. With the stack empty the room is gone, so no list ends in a gap. `tests/e2e/browser/corner-stack-room.spec.ts` walks every page and side bar of the rail, a note, the Org page, every Settings page, the unlocked vault (a fake vault answered at the transport, so the fixture's real one is never touched), Home picking tasks, Home with an approval card in the stack as well, a session minimized to the taskbar and an empty list with the welcome card, with a notice up and with classic scrollbars in Chromium, names any scroller whose end stays under it or any control nothing can bring out, and fails when anything moved; `tests/e2e/browser/corner-stack-room-plugin.spec.ts` does the same for a plugin's App, and `tests/e2e/browser/mail-sync-line.spec.ts` for Mail on its dense fixture. A board scrolls a card its own toast covers up and out from under the stack (`keepClearOfCorner`). The most important kind sits nearest the bottom corner (an approval card, then a host's background connect, then toasts), and more notices stack upward. While the notification center is open the stack sits 16px right of it (same width), its toasts and approval card stepping aside since the center lists them; a window with no room for it there hides it until the center closes. It takes its short forms only when crowded (three kinds at once, or two in a window shorter than 720px). On a phone it spans the top of the screen 8px in from each side, under the safe area, and a swipe up dismisses a toast. An approval's asking task is a link on its card and in its dialog that opens the task on Home; the title opens the whole request. Every notice in the corner lets the person read all of it (`web/src/components/common/NoticeText.tsx`). A toast's title shows two lines and its body three; when either is cut, or the record keeps a `detail`, a Details button opens the whole text in place and keeps the toast up until it is closed (a board toast stops its clocks the same way). The log-error bridge cuts a title at 120 characters, so it puts the whole log line first in `detail` (`withWholeLine`), and the toast shows that line as its title, leaving the raw meta under Details. A `backticked` command reads as code with its own Copy, and a toast naming one command also offers "Copy command" beside Details, so it is one click away even while the words are cut. A permission prompt's command shows two lines, with Details and Copy. On a phone a closed toast is one row (its title, Details and the ×); opened, its words and Copy come before the log. Details and Copy keep their place when the toast opens. A known error reads in plain words first (`src/core/notifications/humanize.ts`): a deferred daemon update names the host, what to fill in, and the command to run there. The approval card stays a summary: a click opens its dialog with the whole request. `tests/web/notice-full-text-guard.test.ts` lists every kind the corner has, read from `CORNER_ORDER` and its callers, and fails on a new one until it says how its whole message shows.

## Reminders, buttons and quiet mode

A `reminder` is a plugin's timed prompt (a stand-up nudge, a focus block ending). It is persistent, it toasts for 120s (one of its buttons or the × closes it sooner), it plays a short WebAudio chime once per committed toast (`localStorage['open-walnut-reminder-sound'] = 'off'` mutes it), and it raises a browser notification when the tab is hidden. A reminder re-fired under the same dedupKey REPLACES the old record (`replaceNotification`, broadcast as `notification:removed` then `notification:new`), so a recurring prompt alerts again. `walnut.notifications.dismiss(key)` removes the plugin's own record and broadcasts `notification:removed`.

A record may carry `actions`: up to three buttons, primary first. When present they win over the older single `action`. A `{ kind: 'op', pluginId, op, args }` button POSTs `args` to `/api/plugin-runtime/<pluginId>/ops/<op>`. On success the toast closes and the record is marked read. On failure the toast stays and shows the error inline. The plugin API builds `pluginId` and the op name itself (`pluginOpName`), so a notice can only run its own plugin's ops. A button may carry `expiresAt` (epoch ms): it means something only until then (Rhythm's End break and Another block end with the break). Past it no surface offers it (`displayActionsOf`), and a notice whose every button expired reads as history with none; an older record without it keeps its buttons (2026-11-21: a break notice still offered End break 23 hours later). A card or toast left open redraws itself when its next button expires (`useDisplayActions`), the op call carries the button's expiry in `x-walnut-action-expires-at` and the op route answers 410 past it (`src/core/plugins/notice-action-expiry.ts`), and a plugin whose moment moved revises the reminder in place with `update: true` (`reviseNotification`, announced as `notification:updated`, no new alert).

Quiet mode (`src/core/quiet/quiet-state.ts`, `GET`/`PUT /api/quiet`, persisted to `quiet.json`, which git-sync ignores) is a set of holds, one per source (`user`, `plugin:<id>`). While any hold is live, no toast, chime, system notification or push goes out. The feed and the badge still count. Inside the window, a permission ask still toasts while `allowPermissions` is true (the default): an agent is blocked on it. Ephemeral toasts (a sort hint, a voice-capture error) also still show: they answer the human's own action and have no feed copy to fall back on. Nothing goes outside the window, asks included: a system notification has one exit in the web app (`web/src/contexts/notifications/system-notice.ts`) and a push one gate on the server (`src/core/push/quiet-hold.ts`), and both hold everything while quiet lasts and send ONE notice when it ends (the item itself when only one waited). A page holds its notices until it has heard the state (`unknown`), and a plugin's hold outlives a server restart (`keepQuietThroughShutdown`; a plugin that does not set it again within a minute of loading lets it go), so a deploy in the middle of a focus block stays quiet (2026-11-17, the user: "why it even send me notification even I am in focus mode"). `quiet:changed` carries the state to the web and to plugins.

## Where things live

- Repair: `src/core/self-repair/` (source resolution + clone, briefing text),
  route in `src/web/routes/notifications.ts`, card action in
  `web/src/components/common/NotificationFeedCards.tsx` (the center's rows, each a NoticeCard)
- State + stamps: `src/core/notifications/store.ts` (`recoverNotifications`,
  `expireErrorNotifications`, `expireKeylessErrorNotifications`)
- Key derivation: `src/core/notifications/log-error-bridge.ts`
- Transition gating: `src/core/notifications/recovery-transition.ts`
- Route normalization: `src/core/notifications/route-condition.ts`
- Death expiry + boot reconcile: `src/core/notifications/permission-expiry.ts`
  wired beside `healStalePendingPermissions` in `src/web/server.ts`
- Signal seams: request-logger middleware (routes), event-bus (subscriber
  pairs), instance-lock watchdog (db writers), session:result handler
  (session/task), plugin sync poll, git tick, backup scheduler,
  disk-watermark `onRecovered`
