# Agents in your browser

The Walnut browser extension (see [Passwords](passwords.md), Browser extension) can also let
your Walnut agents use your own browser, the one signed in to your sites: open a page, read
it, click, type, pick from a list, scroll and take a screenshot. It is off until you turn it
on in the extension's popup (Settings, "Let Walnut agents use this browser").

## What an agent can reach

- **Only tabs it opened.** An agent's tabs open in a separate Walnut agent window, behind your
  own windows. Your tabs are never listed, read or touched. Each agent tab wears a brown frame
  and a pill, "Walnut agent is using this tab", with **Stop**: Stop gives the tab back to you,
  and the agent can no longer use it. Only your own click counts (a click a page or an agent
  makes is not trusted and does nothing).
- **Tabs belong to the task that opened them.** Another task's commands are refused there, and
  no list says whose a tab is. Walnut tells tasks apart by the session id each one's requests
  carry, as it does for every agent request; a process that is not a Walnut task (a script, an
  agent outside a task) shares one set of tabs of its own, apart from the person's.
- **Any site, or only sites you allowed.** Turning agents on in the extension is the permission:
  by default agents may open any web page (Settings, Browser extension, "Allow any site"). Pick
  "Ask me first" there and the first time an agent opens a site Walnut asks you (a notification
  on your Mac and phone, like any Walnut approval). Approve, and agents may use that site until
  you remove it; deny, and that task is refused there and not asked again for an hour. A page
  that moves to another site (a link, a redirect) asks the same way. A tab you hand over from the
  side panel may go on in its own site with no ask. Agents still ask you before a step that
  sends, buys, posts or deletes in your name, and each password they use is yours to approve.
- **Never Walnut's own pages, nor the browser's** (settings, extension pages, `file:`). Walnut at
  any address (its tunnel, the cloud companion, another machine) is known by the mark its page
  carries; such a tab is closed at once.
- **Passwords stay yours.** What an agent types is page input, never yours: the password menu
  and the save bar ignore it. A snapshot never shows the value of a password field (also one a
  page's "show" button turned to text), a one-time code, or anything Walnut filled. An agent that
  needs a sign-in asks for that one login with `password_use` (each use approved by you).
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
  and it is yours again. Turning it on also turns on Walnut agents in this browser.
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
walnut browser type e7 "a search" --submit
walnut browser click e12
walnut browser select e9 "Rye"
walnut browser press Escape
walnut browser scroll down --amount 2
walnut browser wait "Order placed"
walnut browser screenshot                     # prints the file it wrote
walnut browser close
```

`tab` may be left out once a task has used one. A snapshot lists headings, then each element a
person could act on with its ref, role, name and state (`[e12] button "Place order"`,
`[e7] textbox "Search" value="rye"`), then the page's visible text; a ref holds while the
element is on the page, so snapshot again after the page changes. A click on an element that
something else covers (a cookie banner, a dialog) is refused with `covered`, naming what is on
top, rather than clicking through it.

Every page action is checked again inside the page, against the document there now, so a page
that moved to another site in between is refused rather than read. A call answers within 70
seconds; `browser_timeout` means the browser did not answer in time and may still have done it,
so snapshot before you try again.

A site waiting for your approval answers `needs_ok` (HTTP 202): call the same action again;
`wait_ms` (up to 25000) holds the call for your answer. The shell command waits by itself, up
to 10 minutes. Exit codes: 0 done, 1 refused (`site_denied`, `not_your_tab`, `test_run`,
`which_tab`), 2 no answer in time (`browser_timeout`, or no approval in 10 minutes), 3 any other
error.

Input is the page's own DOM events (`isTrusted` false). Nearly every site takes them; a page
that insists on trusted input (some games, some anti-bot checks) will not respond.

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
`src/ops/browser.ts`, `packages/browser-extension/src/agent.ts` and `page-agent.ts`; the side
panel is `packages/browser-extension/src/sidepanel.ts` and `web/src/popout/PopoutExtPanel.tsx`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/v1/browser/act` | an agent | `{ action, tab?, device?, url?, ref?, x?, y?, text?, clear?, submit?, value?, key?, direction?, amount?, ms?, wait_ms? }` |
| GET | `/api/v1/browser/status` | anyone | `{ browsers, mode, sites }` |
| GET | `/api/v1/browser/panel` | anyone | `{ panel: 1 }`: this Walnut has the side panel |
| PUT | `/api/v1/browser/settings` | the person only | `{ mode?: "ask" \| "any", removeSite? }` |
| POST | `/api/v1/browser/poll` | the extension | `{ browser, version, caps, tabs, waitMs }` → `{ commands }` |
| POST | `/api/v1/browser/result` | the extension | `{ id, ok, result?, error? }` |
| POST | `/api/v1/browser/off` | the extension | agents turned off |
| POST | `/api/v1/browser/page` | anyone | `{ url, title?, text }` → `{ file }` (the side panel) |
| POST | `/api/v1/browser/adopt` | the extension | `{ tab, task, url }`: the person let that task act in the tab |

Screenshots need the extension's site access (`<all_urls>`, asked at install in Chrome; in
Firefox the person grants it from the extension's page), and capture only the visible part of
the tab. Tests: `tests/core/browser-control/`, `tests/e2e/browser-control.test.ts`,
`tests/e2e/browser/extension-agent.spec.ts`, `tests/e2e/browser/extension-sidepanel.spec.ts`,
`tests/web/ext-panel-model.test.ts`.
