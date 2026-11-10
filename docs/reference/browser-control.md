# Agents in your browser

The Walnut browser extension (see [Passwords](passwords.md), Browser extension) can also let
your Walnut agents use your own browser, the one signed in to your sites: open a page, read
it, find things on it, fill forms, click, type, hover, scroll, upload files, follow downloads,
sign in with your saved logins without seeing them, and take screenshots of the screen or the
whole page. The connect page asks once, as a checkbox on by default ("Let Walnut agents use
this browser"); an extension already connected keeps its own choice. The switch lives in the
extension's Settings, reached from the key's popover in the side panel or the toolbar popup.

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
  click, hover, type, press, scroll (the wheel) or upload, drag (`drag` is always real input),
  read and answer a page's alert, confirm or prompt (`dialog`), and
  run JavaScript in a tab it opened (`evaluate`, never in your own tab). The debugger is
  attached for that one action and detached right after; Chrome shows its "started debugging"
  bar while it is. Off, these answer `trusted_off` and say where to turn it on. The switch is
  its own (`realInput` in the extension's storage), apart from the permission, which live
  pictures (below) may hold alone; an extension that had the permission before keeps real input
  on (`packages/browser-extension/src/trusted-switch.ts`).
- **No test runs.** A request from a test run (`x-walnut-test-run`) is refused before it
  reaches the browser.

- **You see where it works, live.** Walnut's agent window is a normal window behind yours: never
  focused, never minimized (`packages/browser-extension/src/agent-window.ts`). Every `open`,
  `take`, `navigate` and `back` names the window and the tab (id, title, address), and an agent
  says which in its first line to you. While a task's session holds a tab, its session panel
  shows the **Browser view**: a live picture of that tab, its title and address, which window it
  is in, **Take over** and **Stop** (which ends the agent's use of the tab; it stays open). While
  you look at it, the extension streams the tab: it takes the next picture as soon as the browser
  allows one (two a second), at your screen's own pixels, and posts it to Walnut itself
  (`POST /api/v1/browser/view/push`); the view holds one request open for the next picture, so a
  picture shows as soon as it is taken, and a picture the same as the last goes without its bytes.
  Nobody looking, no pictures: a watch nobody renews ends within seconds. On macOS, Chrome draws
  nothing in a window other windows cover entirely, so `captureVisibleTab` has no picture then
  (`covered`). With **live pictures** on (the extension's Settings, "Live pictures while Walnut's
  agent window is covered", on by default once the debugger permission is held), the stream takes
  those pictures with the debugger's `Page.captureScreenshot`, which draws the page off screen and
  never shows, raises or focuses the window: attached only while you watch a covered window, let
  go when you stop watching, the tab goes, or the window shows again (Chrome shows its debugging
  bar meanwhile; `agent-live.ts`, sharing one attach per tab with real input, dialogs and
  recording, `cdp.ts`). Without the permission, the view offers **Show it live**: the extension
  opens its own small page in your window (`POST /api/v1/browser/view/grant`, `grant-open.ts`),
  where Allow, then Allow in Chrome's box, turns live pictures on (an agent may ask for that page
  too: it opens in the background, and the grant is still your clicks; after you close it without
  allowing, an agent's ask opens it again only 10 minutes later). An agent's screenshot of a
  covered window uses the same session only while you watch that tab's Browser view; nobody
  watching, it answers `window_covered` (snapshot and text still read the page). The picture is the
  screenshot path (`captureVisibleTab`), so it works on a window behind yours and takes no focus;
  a tab of yours is pictured only while it is on screen (Walnut never switches your tabs), and a
  picture waits for nothing an agent is doing (`agent-view.ts`, `capture-gate.ts`,
  `src/web/routes/browser-view-stream.ts`). An older extension is asked for one small picture at a
  time instead. Hide folds the view to one line. When the last tab goes, the view says why.
  Pictures are for you only (not masked): an agent takes a screenshot instead, which draws a shown
  password as dots. Routes: `GET /api/v1/browser/view`, `GET /api/v1/browser/view/frame`
  (`after`: the number of the picture the view has), `POST /api/v1/browser/view/stop`,
  `/takeover`, `/handback` (`src/web/routes/browser-view-v1.ts`); the web hears `browser:tabs`
  when a task's tabs change.
- **Take over.** Your click on **Take over** brings that tab up in your browser, its window in
  front, so you use it with your own mouse and keys (sign in, solve a check, look around). It is
  the one time Walnut brings an agent's window forward, and only on your click. While you have the
  tab, every agent command there is refused (`person_driving`), so the agent never fights you; the
  tab's pill says "You have this tab" with **Hand back**, and the view says the same. **Hand
  back**, there or in the view, gives it to the agent again (`agent-takeover.ts`). A tab in your
  own window (one you handed over) is taken over where it is: your window is never switched or
  focused. While you have a tab in the agent window, nothing else is brought up there: another
  task's pictures and screenshots of a tab behind yours wait (`person_driving` for a screenshot).
- **Signing in yourself.** When only you can sign in (no saved login, a code sent to your phone, a
  check, or a page that refuses the agent's browser), the agent calls `request_sign_in`: the view
  asks you over the picture, "The agent asks you to sign in to example.com yourself", with **Take
  over to sign in**; you sign in in the tab and press **Done**, and the agent carries on
  (`src/core/browser-control/sign-in-ask.ts`). The sign-in stays in your browser, so the task's
  later runs are signed in. A page that refuses this browser's sign-in, such as Google's "This
  browser or app may not be secure", is recognized in the act's answer (`hand_off`,
  `src/core/browser-control/sign-in-refusal.ts`), which tells the agent to ask you instead of
  trying again. A saved login is still filled by `fill_login`, which the agent never sees. The
  ask lives on the tab's holding: it ends (`gone`) when the tab is closed, released or given to
  another task, and only its own task's view shows or answers it. An extension older than Take
  over answers `request_sign_in` with `old_extension`, and the agent asks you in its chat instead.
- **One tab group per task, folded.** The tabs a task opens in Walnut's agent window sit in one
  Chrome tab group named `walnut-<task name>` (`agent-groups.ts`). A tab you hand over with Act in
  tab joins that task's group of your window once, when you hand it over (never folded, and never
  put back after you drag it out), and goes back where it was when the agent lets it go, also after
  an extension update or a browser restart (`agent-groups-person.ts`); no other tab of yours is
  moved or grouped. The agent window's group folds to its chip once no command of the task ran for 8 seconds (Chrome opens
  it by itself while one of its tabs is in front). A folded group cannot hold the window's front
  tab, so the agent window keeps a page of its own as its first tab (`agent-window.html`, "Walnut
  agent window"), which comes in front before the fold. A tab leaves its group before it closes,
  since Chrome would keep a closed group as a saved one.
- **Tabs are closed once the task is done with them.** Every minute Walnut closes the tabs of a
  task that completed or was deleted, and those no agent used for 30 minutes, unless the task waits
  for you (Needs you), you took the tab over, you watch it in the Browser view or look at it in
  the agent window, the agent waits for your sign-in there, or a command is on its way to it
  (`src/web/routes/browser-tab-tidy.ts`). A tab of yours is given back, never closed, and an agent's
  tab you dragged into a window of yours is only let go. The extension closes a tab it opened for an
  agent that no agent holds any more and that you did not take (Stop, the side panel and agents off
  make it yours) 10 minutes after it was let go, never one you opened or the one you are looking at
  (`agent-tidy.ts`). Tabs an older extension opened are not known to be its own, so they stay.
- **The view never sits frozen.** A picture of a tab behind the agent's front tab waits only while
  a command there needs the screen (a click, typing, a screenshot); reading a page, navigating or
  filling never blocks it. When the agent works in the front tab, it is put back after the
  picture and the switch happens at most every 2 seconds; a tab no agent works in stays behind the
  pictured one. No tab is switched in a window you are in. A click or a key brings its own tab to
  the front of the agent window first (a folded group leaves the window's page there). While no new picture
  comes the view says why (the agent is clicking in another tab, the page changed, the browser
  answers slowly) and, after 6 seconds, for how long (`noPictureSince` on the frame answer).
- **Never your focus.** No call in the extension brings a window forward or focuses one except your
  own Take over, the toolbar popup, the side panel, Open vault and Connect; the agent window is
  made unfocused. `tests/core/browser-control/extension-agent-window.test.ts` lists every such call
  with its reason and fails on a new one.
  The phone has no Browser view yet: it would need the same frame route polled from the iOS
  session screen.
- **Never a second sign-in behind your back.** An `open` or `navigate` to a site you already have
  open in one of your own tabs (the same registrable domain, the vault's site key) lists those
  tabs in its answer and tells the agent to ask you for that tab ("Act in tab" in the side panel)
  or take it when you are not on it, and not to sign in again. `fill_login` there is refused
  (`site_open_in_person_tab`). An agent's `fresh_sign_in: true` only asks you: an approval on your
  Mac and phone, bound to that task, browser, tab and site, and only your yes lets one fill
  through. When Walnut cannot list your tabs to check, it fills nothing and says to try again.
- **An agent tab is quiet.** Each tab an agent opens is muted before its page loads, and media in
  it that starts by itself is paused (a play right after the agent's own click or key still
  plays). Your own tabs, handed over or taken, keep their sound.
- **Recording a tab's requests and console** (`network`, `network_body`, `network_request_body`,
  `console`; `src/core/browser-control/` and the extension's `agent-net.ts`). An agent can read
  the requests a page makes and their bodies, for scripts that read a site's own data the way
  the page does. It uses the browser's debugger, so it waits for the same "Let agents use real
  mouse and keys" switch as `evaluate`, works only in a tab an agent opened (never yours), and
  Chrome shows its debugging bar on that tab while it records; its Cancel ends the recording
  there. The listing keeps the latest 500 requests and 300 console messages; bodies stay in the
  browser until asked for, 200,000 characters each by default. Each request is judged by every
  address it names (where it went, the page that sent it, each redirect): one that touches a site
  agents may not use, or Walnut itself, is left out and its body is never read. Where one of those
  addresses is a site Walnut signed the agent in on, its request body is not given and every
  address loses its query (filters run on what is shown, so a hidden query cannot be guessed).
  A console message is judged by the page that logged it, so a sign-in page's console stays closed
  after the agent moves on.
- **`upload {selector}`** reaches a file field a page hides behind a button of its own;
  **`resize`** sizes Walnut's agent window (or its page, `viewport`), never yours.

Turning the switch off in the popup ends it at once: Walnut hears that the browser stopped,
every command waiting on it fails, and every agent tab is yours again.

## Walnut beside the page: the side panel

The extension also puts Walnut in the browser's side panel (Chrome's side panel, Firefox's
sidebar; in a browser with neither, the popup's **Quick question** opens the same page in a small
window beside yours). Open it from the popup's **Quick question**, or right-click a page or a
selection, **Quick question about ...**.

- **It knows the page you are on.** The panel shows the page's title and address and what you
  selected, and follows you to another tab or page. Its conversation is an ordinary quick question
  session, and as on Home's Ask it stays until you pick another ask (≡ or Continue) or press
  **New chat**: on another tab or page only the page chip moves, so your next message goes with
  that page. A selection you ask about later leads your next message as a quote.
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
- That frame loads only its own view, never the whole console: a `/popout` address boots
  `web/src/popout/PopoutShell.tsx` and the one view it names (`popout-views.ts`) instead of App,
  the plugins' web modules load once the view has drawn, and the editors, the terminal and the
  Board load the first time one opens. `tests/web/popout-light-entry-guard.test.ts` fails on a
  static import that pulls the console back in. While it loads, the extension draws the view's
  words of last time, which the view sends again whenever what it shows changes (the side panel's
  open conversation under one key, whatever the page; the toolbar popup only the Continue list,
  under a key of its own).
- An ask's row in the drawer and the Continue lists says where it stopped: what it asks you when
  it really needs you, else the latest words of its conversation (read from its newest messages,
  a few rows at a time, kept in the browser for the next open), with the red dot while it needs
  you. An agent's step waiting for your approval shows over the conversation, whole: what, on which
  site, and why it waits.

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
walnut browser scroll e9 down --by 300        # the box at e9 (a list, a panel), not the page
walnut browser click --text "Continue"        # the best match by its words, frames too
walnut browser type --at 320,180 "hi" --slowly   # click the point, then one key at a time
walnut browser screenshot --annotate a.png    # numbers on the elements; prints number, ref, role, name
walnut browser click-label 7                  # the element numbered 7
walnut browser zoom 40 120 300 200 part.png   # that region at full pixel resolution
walnut browser text --all-frames              # each frame's text on its own (--json: frames)
walnut browser drag e3 e9                     # always real input; also drag 100,200 300,240
walnut browser dialog                         # the open alert, confirm or prompt (real input)
walnut browser dialog accept --text "Ana"     # answer it (dismiss: Cancel)
walnut browser wait "Order placed"            # also: --gone TEXT, --url PART or /regex/, --ms N
walnut browser screenshot --full              # the whole page; prints the file it wrote
walnut browser upload e5 ./invoice.pdf        # read here, sent as bytes (10 MB in all)
walnut browser downloads --wait               # the next download it started, when it finished
walnut browser fill-login                     # sign in with the saved login for this page
walnut browser request-sign-in "the code they texted you"   # the person signs in themselves; waits for Done
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
| `scroll` | `direction` (up, down, left, right), `amount` (screens) or `by` (px), or `to` (top, bottom), or `ref` | answers `scrollTop`, `scrollLeft`, `atTop`, `atBottom`; a `ref` (or `x, y`) alone brings it into view, with a direction (or `to`, `by`, `amount`) the box that scrolls at it scrolls (its nearest scrolling ancestor), and the answer names that `box` |
| `click`, `hover` | `text`, `exact?`, `role?` (instead of `ref`) | the element with those words, in the page or any frame agents may use (as `find` reads them), the best match: the words as its whole name, then a control, then on screen; the answer's `matched` names its `ref`, `frame` and how many matched (`of`) |
| `type` | `x, y` (instead of `ref`), `slowly?` | at a point: a click there (judged as a click), then the text into the field it focused (the click and an Enter the text presses are one ask, one yes); `slowly`: a keydown, keypress, input and keyup per character, 50 ms apart, at most 200 characters (`too_long`), a newline is the Enter key and is judged as a submit |
| `click_label` | `label` | clicks the element numbered `label` by the last annotated screenshot of this page (`no_labels`, `stale_ref` once it is gone); the server sends it as `click {label}`, so it waits for the person's yes as any click does |
| `zoom` | `x, y, width, height` (CSS px), `format?` | that region of the screen at the picture's own resolution (device pixels): `{ image, zoom, pixels: { width, height }, scale }`; nothing of it on screen is `bad_request` |
| `drag` | `ref` or `x, y`; `to_ref` or `to_x, to_y`; `steps?` (12) | real input, top frame: press, move in steps, release; a page that uses the browser's own drag and drop gets its drag data dropped on the end (`native: true`, through `Input.setInterceptDrags`). Both ends must be on screen together (`drag_offscreen`; a start given as a point is refused also when bringing the end into view scrolled the page); a drag under 8 px, or one that starts and ends on the same button or link, is a click (`drag_too_short`). Judged as the clicks it may make (the start, the end, and the control both are in): one that buys, sends or deletes waits for the person's yes |
| `wait` | `text`, `textGone`, `url` (a part of the address or `/regex/`), or `ms` | at most 30 s (`wait_timeout`) |
| `screenshot` | `full?`, `format?` (`png`, default `jpeg`), `annotate?` | `full` scrolls through the page and draws one image, cut at 12000 CSS px (`cut: true`), without the agent frame in its own tabs; the scroll is put back. `annotate` (not with `full`): every element a person could act on that is on screen is outlined and numbered top to bottom on the picture (drawn by the extension; the page draws nothing), and `labels: [{ label, ref, role, name }]` maps each number to its ref, at most 150 (`note` says how many more) |
| `upload` | `ref`, `files: [{ name, type?, base64 }]` | sets the file input's files as a pick would (input and change); 10 MB in all (`too_big`) |
| `downloads` | `wait?`, `ms?` | downloads started from this task's tabs (filename, url, state, bytes); `wait` for the next to finish |
| `request_sign_in` | `text?` (what to sign in to), `site?`, `request?`, `wait_ms?` | the person signs in themselves (Take over, Done); answers `needs_ok` with `request` until they hand the tab back, then `done: true` (or `signIn: "stopped"`) |
| `fill_login` | `item?`, `purpose?`, `request?` | signs in with the saved login for the tab's site; several (`which_login`) list `{ id, title, username }`; an approval answers `needs_ok` with `request`: call again with it |
| `tabs` | `all?` | this task's tabs, or with `all` every tab of the browser and whose it is |
| `take` | `tab` | one of the person's tabs becomes this task's (`person_is_here` when they are on it) |
| `dialog` | `read?`, `accept`, `text?` | real input: `read` gives the open dialog (`type`: alert, confirm, prompt or beforeunload, `message`, `default_prompt`); `accept` OK or Cancel, `text` a prompt's answer; the answer names the dialog it `answered`. Only a dialog the debugger saw open: see "Page dialogs" below |
| `evaluate` | `expression` | real input, a tab the agent opened only: the value as JSON, cut at 50 KB |
| any of click, hover, type, press, scroll | `trusted: true` | real input through the debugger (top frame only); `scroll` is the wheel at the element, point or the middle of the page; `type {x, y}` clicks the point first; `slowly` puts 50 ms between keys |
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
choice to make (`site_denied`, `not_your_tab`, `test_run`, `which_tab`, `person_is_here`, `person_driving`,
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

### Page dialogs

Chrome hands an alert, confirm or prompt to the debugger only when its Page domain was on as the
dialog opened (Chromium's `PageHandler` keeps the dialog's answer only then; one that opened
before an attach is "No dialog is showing"). So every real-input step that may open one (`click`,
`press`, `type`, `drag` with `trusted`) runs with Page on, and when a dialog opens meanwhile the
step answers at once with `dialog: { type, message, default_prompt?, url }` and a `note`; the
debugger stays on the tab until the agent answers (`dialog accept|dismiss`), 2 minutes from its
last look at the dialog (`dialog` read), or as long as an accept waits for the person's yes, 11
minutes at most. The step stops where the dialog cut
it: the debugger refuses whatever it would send next (the next key), a drag lets the mouse button
go where the pointer is, and slow typing on the page stops before its next key.
A tab that records (`network`, `console`) has Page on all along, so a page action there answers
with the dialog it opened too. While a dialog is open every action that needs the page answers
`dialog_open` with the dialog (it would only wait for the page and time out). OK on a confirm or
prompt whose words buy, send or delete ("Delete this project?") is judged as the click that would
do it (packages/browser-extension/src/dialog-outward.ts) and waits for the person's yes.

A dialog no debugger holds any more (the 2 minutes ran out, a recording stopped) is the person's
to answer: Chrome never hands it to a debugger again. Walnut keeps it marked, and every action
that needs the page answers `dialog_open` with `only_person` (after a quick look whether the page
answers again, which means the person answered it) until the dialog closes or the tab loads
another page or closes. A page action without trusted in a tab that does not record cannot see
its dialog at all: the page stops answering and the action times out (`page_not_ready`); only the
person can answer that one too, and a retry, with trusted or not, would wait for the page the same
way (packages/browser-extension/src/agent-dialog.ts).

### Older extensions

The act route sends drag, zoom, labels (`click_label`, `label`), a click or hover by its words,
`type` at a point, `slowly`, `dialog {read}`, `all_frames`, `annotate` and a scroll inside a box
(or with the wheel) only to an extension that announces the cap `input-v2`; an older one would do
something else and say it went fine (its `dialog {read}` accepted the dialog). Without the cap the
call answers 409 `extension_outdated`, naming what needs the update
(src/core/browser-control/input-v2.ts).

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
| POST | `/api/v1/browser/act` | an agent | `{ action, tab?, device?, url?, ref?, x?, y?, text?, exact?, role?, limit?, fields?, clear?, submit?, value?, key?, direction?, amount?, by?, to?, textGone?, ms?, full?, files?, paths?, all?, wait?, item?, request?, purpose?, trusted?, accept?, expression?, wait_ms?, to_ref?, to_x?, to_y?, steps?, label?, annotate?, all_frames?, slowly?, read?, width?, height? }` |
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
`downloads` at install, `tabGroups` (Chrome: "View and manage your tab groups", for the task's
group), and `debugger` only as an optional permission when you turn real input on. Tests: `tests/core/browser-control/`, `tests/e2e/browser-control.test.ts`,
`tests/e2e/browser/extension-agent.spec.ts`, `tests/e2e/browser/extension-sidepanel.spec.ts`,
`tests/core/browser-control/cdp.test.ts`, `tests/core/browser-control/extension-outward.test.ts`,
`tests/e2e/browser/extension-agent-outward.spec.ts`,
`tests/web/ext-panel-model.test.ts`.
