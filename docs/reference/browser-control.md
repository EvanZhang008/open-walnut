# Agents in your browser

The Walnut browser extension (see [Passwords](passwords.md), Browser extension) can also let
your Walnut agents use your own browser, the one signed in to your sites: open a page, read
it, find things on it, fill forms, click, type, hover, scroll, upload files, follow downloads,
sign in with your saved logins without seeing them, and take screenshots of the screen or the
whole page. It is off until you turn it on in the extension's popup (Settings, "Let Walnut
agents use this browser").

## What an agent can reach

- **Tabs it opened, and the tabs those open.** An agent's tabs open in a separate Walnut agent
  window, behind your own windows. A tab or window one of them opens (a link to a new tab, a
  popup window, which Chrome reports with no opener: the extension matches it to the agent tab
  it was acting in by the new page's opener and referrer) is the same agent's, and the action
  that opened it says so (`opened: { tab, url }`).
  Each agent tab wears a brown frame and a pill, "Walnut agent is using this tab", with
  **Stop**: Stop gives the tab back to you, and the agent can no longer use it. Only your own
  click counts (a click a page or an agent makes is not trusted and does nothing).
- **Your own tabs, listed but not read.** `tabs` with `all` lists every tab of the browser by
  title and address, and whose it is (`mine`, `other task`, `person`), never what is in it. An
  agent acts in one of your tabs only when you hand it over from the side panel, or when it
  takes it (`take`): never the tab you are on right now in the window you used last
  (`person_is_here`), never Walnut's or the browser's own pages. A taken tab wears the same
  frame and Stop as a handed one, keeps the normal site rules, and `close` gives it back
  instead of closing it.
- **Frames too.** A snapshot, the page text, `find`, `form_values` and `wait` for text also read
  the frames in the page, of the same origin or another, each under its own heading; a ref inside a frame carries
  the frame (`f3:e12`) and an action on it goes there. Each frame's own site is checked: a frame
  on a site agents may not use is left out and named.
- **Tabs belong to the task that opened them.** Another task's commands are refused there, and
  no list says whose a tab is. Walnut tells tasks apart by the session id each one's requests
  carry, as it does for every agent request; a process that is not a Walnut task (a script, an
  agent outside a task) shares one set of tabs of its own, apart from the person's.
- **Any site, or only sites you allowed.** Turning agents on in the extension is the permission:
  by default agents may open any web page (Settings, Browser extension, "Allow any site"). Pick
  "Ask me first" there and the first time an agent opens a site Walnut asks you (a notification
  in Walnut, and on your iPhone when it signs approvals, like any Walnut approval). Approve, and agents may use that site until
  you remove it; deny, and that task is refused there and not asked again for an hour. A page
  that moves to another site (a link, a redirect) asks the same way, and so does taking one of
  your tabs on a new site. A tab you hand over from the
  side panel may go on in its own site with no ask. Each password they use is yours to approve.
- **A step that buys, sends or deletes waits for your yes**, also on a site agents may use
  freely: an agent's click, Enter or other key on Buy, Pay, Place order, Send, Post, Publish,
  Delete, Remove or close an account, Cancel a subscription, on the submit of a form with card
  details, on the submit of a form holding a message (a textarea or an editable box with text), or
  Enter in a box holding a message (also Control+Enter or Meta+Enter, and a chat box with no form).
  Enter or Space on a focused button or link counts as clicking it, and typed text that submits or
  holds a newline counts as Enter. Walnut asks you as for a site (open 10 minutes); the card says
  who asks (the task's name, else "a Walnut agent"), the button, the site, for a send the message
  it sends and for an order the total the page shows, and the step runs once you approve, only
  that step on that page with that message or total. An agent cannot answer for you: approving
  needs Face ID on your iPhone or Touch ID in the Mac app when you have one that signs approvals,
  or Passwords unlocked in the window you approve from (a plain Approve from this machine is
  refused, `proof_needed`). With Passwords locked there, the card offers **Unlock to approve**:
  your master password in place, then Approve (also on a Needs you row and in the side panel).
  The card and the words an agent reads name only the devices you have. Opening, reading, typing, searching, filtering, Next, signing in and Add to cart
  never ask (Add to cart: nothing leaves your hands until the order is placed, and that step asks).
  The rules are in `packages/browser-extension/src/page-agent-outward.ts`.
  **What this does not cover:** the ask judges only an agent's own click, key or typed text. It
  does not see `evaluate` (a page script an agent runs), the page's own scripts, a request the
  page sends by itself (`fetch`), or a link that acts on a plain visit (a GET that deletes or
  buys). `evaluate` works only after you turn on "Let agents use real mouse and keys" in the
  extension's Settings, which also lets agents run page scripts in tabs they opened; leave it off
  unless an agent needs it.
- **Never Walnut's own pages, nor the browser's** (settings, extension pages, `file:`). Walnut at
  any address (its tunnel, the cloud companion, another machine) is known by the mark its page
  carries; such a tab is closed at once.
- **Passwords stay yours.** What an agent types is page input, never yours: the password menu
  and the save bar ignore it. A snapshot or `form_values` never shows the value of a password
  field (also one a page's "show" button turned to text), a one-time code, or anything Walnut
  filled. An agent signs in with `fill_login`: Walnut's vault decides exactly as for
  `password_use` (the agents switch, the item's agent access, sensitive items, task grants, your
  approval), and then the extension fills the saved login for the tab's site the way its own
  autofill does. The agent hears only `{ filled, fields, item: { id, title } }`; the password is
  never in its result, the route's logs or its transcript. Each fill is in the vault's agent
  activity as a fill. A login saved for another site is never filled there: after your approval
  the tab must still be on the origin the ask named (scheme, host and port), and right before the
  fill the item's own sites must still match the page. A page an agent ran `evaluate` or any real
  input (the debugger) in since it loaded is refused (`page_tampered`: reload it first), since a
  script it left could read the password; a navigation or reload is a new page.
- **Real mouse and keys only when you turn them on.** Agents' input is page events by default.
  "Let agents use real mouse and keys" in the extension's Settings (Chrome only) grants the
  browser's optional `debugger` permission; then an agent may ask for `trusted` input on a
  click, hover, type, press or upload, answer a page's alert, confirm or prompt (`dialog`), and
  run JavaScript in a tab it opened (`evaluate`, never in your own tab). The debugger is
  attached for that one action and detached right after; Chrome shows its "started debugging"
  bar while it is. Off, these answer `trusted_off` and say where to turn it on.
- **No test runs.** A request from a test run (`x-walnut-test-run`) is refused before it
  reaches the browser.

Turning the switch off in the popup ends it at once: Walnut hears that the browser stopped,
every command waiting on it fails, and every agent tab is yours again.

## Walnut beside the page: the side panel

The extension also puts Walnut in the browser's side panel (Chrome's side panel, Firefox's
sidebar; in a browser with neither, the popup's **Ask Walnut** opens the same page in a small
window beside yours). Open it from the popup's **Ask Walnut**, or right-click a page or a
selection, **Ask Walnut about ...**.

- **It knows the page you are on.** The panel shows the page's title and address and what you
  selected, and follows you to another tab or page. Each page has a conversation of its own,
  an ordinary Ask Walnut session, and it is there again when you come back to the page; **New
  chat** starts over. A selection you ask about later leads your next message as a quote.
- **The page's text goes to Walnut only when you ask.** The panel is told a page's address,
  title and selection (never a selection in a password or code field); its text is read from the
  tab only when you send a question. With **Include this page** on, your
  first question saves the page's visible text (never a field's value) into a file in Walnut's
  cache on your machine (`WALNUT_HOME/cache/browser-pages`, readable by you alone, removed after
  7 days), and the question names that file, so the chat shows your question and the agent
  reads the page when it needs it. Off, Walnut gets the title and address only.
- **"Let Walnut act in this tab"** is your click: that tab becomes the conversation's agent tab,
  with the brown frame and Stop, like a tab an agent opens itself. Its site is allowed in that tab
  alone: no agent may open that site elsewhere on that click. Only that conversation's task may
  use it; it never closes it (closing gives it back) and never brings it forward for a screenshot.
  Untick the box, press Stop, or **Take it back** (shown when another conversation holds the tab)
  and it is yours again. It lets agents into that tab only: the browser-wide "Let Walnut agents
  use this browser" stays as you set it, and with it off no agent may open a new tab, take
  another or list your tabs (`agents_tab_only`); giving the last such tab back ends it. A window
  the page in that tab opens counts as that tab (also one it opens in turn); a window from a tab an
  agent took (`take`) does not (`packages/browser-extension/src/agent-tab-kind.ts`).
- An ask that runs on another machine gets the page's text in its first message (cut at 30,000
  characters), since it cannot read this machine's file. A Walnut too old for the panel is named
  in the panel ("Update Walnut").
- The panel is Walnut's own page (`/popout?view=ext-panel`) framed by the extension's panel page,
  which hears only that frame, on your Walnut's address. It reaches a Walnut on this machine
  directly; a Walnut on another machine needs that browser signed in to it.

## For agents

The `browser` op (one tool with an `action`) and `walnut browser <action>` in a shell do the
same thing; the shell command saves a screenshot as a file
(`$WALNUT_TASK_DIR/shots/browser-<time>.jpg`, or the file you name).

```bash
walnut browser status                         # browsers that let agents in, the sites
walnut browser open https://example.com/      # a new tab in the agent window
walnut browser snapshot                       # the page as text, with element refs
walnut browser find "Place order" --role button
walnut browser form-values                    # every field: label, name, type, value
walnut browser fill-form "Full name=Test Person" "Size=Large" e14=true
walnut browser type e7 "a search" --submit
walnut browser click e12
walnut browser hover e3
walnut browser select e9 "Rye"
walnut browser press Escape
walnut browser scroll down --amount 2         # also: up, left, right, top, bottom, --by PX
walnut browser wait "Order placed"            # also: --gone TEXT, --url PART or /regex/, --ms N
walnut browser screenshot --full              # the whole page; prints the file it wrote
walnut browser upload e5 ./invoice.pdf        # read here, sent as bytes (10 MB in all)
walnut browser downloads --wait               # the next download it started, when it finished
walnut browser fill-login                     # sign in with the saved login for this page
walnut browser tabs --all                     # every tab of the browser, title and address
walnut browser take 812                       # act in one of the person's tabs
walnut browser close                          # closes a tab it opened, gives back one it took
```

| Action | Arguments | What it does |
|---|---|---|
| `find` | `text`, `exact?`, `role?`, `limit?` (20) | elements whose name or text holds the words: `{ matches: [{ ref, role, name, text }] }` |
| `form_values` | | every field with its label, name, type, value (secrets as `(hidden)`), options of a list |
| `fill_form` | `fields: [{ ref or label, value }]` | fills each like `type` does (a checkbox takes true or false, a list its label or value); a field it cannot find fills nothing (`no_field`) |
| `hover` | `ref` or `x, y` | pointer over, enter and move events (menus that open on hover) |
| `scroll` | `direction` (up, down, left, right), `amount` (screens) or `by` (px), or `to` (top, bottom), or `ref` | answers `scrollTop`, `scrollLeft`, `atTop`, `atBottom` |
| `wait` | `text`, `textGone`, `url` (a part of the address or `/regex/`), or `ms` | at most 30 s (`wait_timeout`) |
| `screenshot` | `full?`, `format?` (`png`, default `jpeg`) | `full` scrolls through the page and draws one image, cut at 12000 CSS px (`cut: true`), without the agent frame in its own tabs; the scroll is put back |
| `upload` | `ref`, `files: [{ name, type?, base64 }]` | sets the file input's files as a pick would (input and change); 10 MB in all (`too_big`) |
| `downloads` | `wait?`, `ms?` | downloads started from this task's tabs (filename, url, state, bytes); `wait` for the next to finish |
| `fill_login` | `item?`, `purpose?`, `request?` | signs in with the saved login for the tab's site; several (`which_login`) list `{ id, title, username }`; an approval answers `needs_ok` with `request`: call again with it |
| `tabs` | `all?` | this task's tabs, or with `all` every tab of the browser and whose it is |
| `take` | `tab` | one of the person's tabs becomes this task's (`person_is_here` when they are on it) |
| `dialog` | `accept`, `text?` | real input: OK or Cancel on an alert, confirm or prompt |
| `evaluate` | `expression` | real input, a tab the agent opened only: the value as JSON, cut at 50 KB |
| any of click, hover, type, press | `trusted: true` | real input through the debugger (top frame only) |
| `upload` | `trusted: true, paths` | real input: files already on the browser's machine (a download, say) |

`tab` may be left out once a task has used one. A snapshot lists headings, then each element a
person could act on with its ref, role, name and state (`[e12] button "Place order"`,
`[e7] textbox "Search" value="rye"`), then the page's visible text, then each frame's own
elements and text (`[f3:e2] button "Pay"`); a ref holds while the
element is on the page, so snapshot again after the page changes. Refs follow the page's own
order, not the order actions read it: snapshot, `form_values`, `find` and `fill_form` name a
field the same way, and the same page loaded again gets the same refs. `open` and `navigate`
take an address as you would type it (`example.com` opens `https://example.com`, `localhost:3000`
`http://localhost:3000`); a word that is no address is refused with `not_a_web_page`. A click on an element that
something else covers (a cookie banner, a dialog) is refused with `covered`, naming what is on
top, rather than clicking through it.

Every page action is checked again inside the page, against the document there now, so a page
that moved to another site in between is refused rather than read. A call answers within 70
seconds; `browser_timeout` means the browser did not answer in time and may still have done it,
so snapshot before you try again.

A site waiting for your approval answers `needs_ok` (HTTP 202): call the same action again;
`wait_ms` (up to 25000) holds the call for your answer. A step that buys, sends or deletes
answers `needs_ok` with `code: "outward_needs_ok"`, `request`, `what` and `waitsMinutes`: call
the same action with the same arguments and `request`; approved, it runs (once), denied answers
`denied`, unanswered `outward_expired`. The shell command waits by itself, up to 10 minutes, and
says what it waits for. After you disconnect the extension (its popup, Settings, Disconnect this
browser), `walnut browser status` says so at once and every command fails at once with
`browser_disconnected` ("the person disconnected this browser from Walnut"); turning agents off
answers `browser_off`. `walnut browser --help` prints the usage. Exit codes: 0 done, 1 refused or a
choice to make (`site_denied`, `not_your_tab`, `test_run`, `which_tab`, `person_is_here`,
`trusted_off`, `which_login`, `denied`, `agents_tab_only`; a choice lists its options), 2 no
answer in time (`browser_timeout`, `outward_expired`, or no approval in 10 minutes), 3 any other
error. `walnut browser screenshot x.png` asks for a PNG; a JPEG an older extension sends is saved
under `.jpg`, and it says so.

Input is the page's own DOM events (`isTrusted` false). Nearly every site takes them; a page
that insists on trusted input (bank-style keystroke checks, some games, some anti-bot checks)
needs `trusted: true`, which works once you turned real input on. A link that opens a new tab
is opened by the extension as the agent's own tab (the browser blocks a page's new tab from an
input that is not trusted); a page's own `window.open` from a click opens only with trusted
input. A download is the agent's when it starts from its tab's site while it acts there (or
right after), or from the very page an agent tab shows: the browser does not say which tab a
download came from. One with no referrer at all counts only while one agent tab is being acted in
and only when the file's own address is on the origin of one of that task's agent tabs, so your
own download from elsewhere at that moment is never the agent's.

## How it works

The Walnut server is the relay. The extension's background asks for work with a long poll
(`POST /api/v1/browser/poll`, 25 s, its own device token only), runs each command in its agent
tabs, and posts the result (`POST /api/v1/browser/result`); a poll whose client went away hands
its commands to the next one. With several browsers connected, a tab's commands go to the one
that holds it. Only the extension's own pairing makes a device named `extension-<hex>`. The server holds the queue, the
tab owners (restored from the extension's own report after a server restart), the site list
(`WALNUT_HOME/browser-control.json`) and the approvals; the extension checks every command's
tab against its own agent-tab list and the page's real address against the allowed sites the
command carries, so a server mistake cannot reach your tabs either. Code:
`src/core/browser-control/` (hub, sites, the CLI), `src/web/routes/browser-v1.ts`,
`src/ops/browser.ts`, `packages/browser-extension/src/agent.ts` (commands and tabs),
`agent-page.ts` (page actions, frames, new tabs), `agent-shot.ts`, `agent-downloads.ts`,
`agent-trusted.ts` with `cdp.ts` (real input), `page-agent.ts`, `page-agent-forms.ts` and
`page-ops.ts` (in the page), `page-agent-outward.ts` with `src/core/browser-control/outward-asks.ts` (steps
that wait for the person), and `src/core/browser-control/fill-login.ts`; the side
panel is `packages/browser-extension/src/sidepanel.ts` and `web/src/popout/PopoutExtPanel.tsx`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/v1/browser/act` | an agent | `{ action, tab?, device?, url?, ref?, x?, y?, text?, exact?, role?, limit?, fields?, clear?, submit?, value?, key?, direction?, amount?, by?, to?, textGone?, ms?, full?, files?, paths?, all?, wait?, item?, request?, purpose?, trusted?, accept?, expression?, wait_ms? }` |
| GET | `/api/v1/browser/status` | anyone | `{ browsers, mode, sites }` |
| GET | `/api/v1/browser/panel` | anyone | `{ panel: 1, extension?: { version, build, folder? } }`: this Walnut has the side panel, the extension build it ships, and its folder's id |
| PUT | `/api/v1/browser/settings` | the person only | `{ mode?: "ask" \| "any", removeSite? }` |
| POST | `/api/v1/browser/poll` | the extension | `{ browser, version, caps, tabs, waitMs }` → `{ commands }` |
| POST | `/api/v1/browser/result` | the extension | `{ id, ok, result?, error? }` |
| POST | `/api/v1/browser/off` | the extension | agents turned off |
| POST | `/api/v1/browser/page` | anyone | `{ url, title?, text }` → `{ file }` (the side panel) |
| POST | `/api/v1/browser/adopt` | the extension | `{ tab, task, url }`: the person let that task act in the tab |

The extension Walnut set up in a folder (Settings, Browser extension, Set up in Chrome;
`src/core/browser-control/extension-install.ts`) reloads itself when Walnut ships a newer build
(`self-update.ts`), and only that copy: the folder holds Walnut's marker, `walnut-folder.json`
`{ folder, browser, serverUrl? }`, whose `folder` id the panel route reports, and the folder must
already hold the new build. A copy loaded from anywhere else (a developer's build, an unpacked
zip, a browser started with `--load-extension`) never reloads, because Chrome turns off a
command-line unpacked extension after a reload when Developer mode is off.

Screenshots need the extension's site access (`<all_urls>`, asked at install in Chrome; in
Firefox the person grants it from the extension's page). The extension also asks for
`downloads` at install, and `debugger` only as an optional permission when you turn real input
on. Tests: `tests/core/browser-control/`, `tests/e2e/browser-control.test.ts`,
`tests/e2e/browser/extension-agent.spec.ts`, `tests/e2e/browser/extension-sidepanel.spec.ts`,
`tests/core/browser-control/cdp.test.ts`, `tests/core/browser-control/extension-outward.test.ts`,
`tests/e2e/browser/extension-agent-outward.spec.ts`,
`tests/web/ext-panel-model.test.ts`.
