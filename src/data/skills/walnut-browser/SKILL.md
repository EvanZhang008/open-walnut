---
name: walnut-browser
description: >-
  Use the user's own browser (Chrome or Firefox with the Walnut extension, signed in to their
  sites) for a step of your task: open a page, read it, find things, fill a form, click, hover,
  scroll, upload a file, follow a download, sign in with a saved login, take a screenshot. Use it when the work needs a site as the user sees it (their accounts, a page
  behind their sign-in, a web app with no API), instead of asking them to do it or to paste
  what is on the page. `walnut browser <action>` in a shell, or the `browser` op.
---

# The user's browser for agents

## Quick start

```bash
walnut browser open https://example.com/issues --read   # a tab in Walnut's agent window, and its main text
walnut browser click --text "Login fails" --read         # click by its words; says what changed, then the new page's text
walnut browser close                                     # when you are done with the tab
```

```bash
walnut browser open https://example.com/pricing --read --max 800   # one fact: the first 800 characters
walnut browser find search box            # refs of the best few matches: [e17] textbox "Search GitHub"
walnut browser type e17 "order 1234" --submit --read   # "typed ...; Enter: went to <url>", then its text
walnut browser snapshot                   # the controls on screen, a ref each (--max N more, --all the page)
walnut browser text e31                   # one element's text (--selector css; --max 20000 for more)
walnut browser wait "Order details"       # 10 s unless --ms; or --gone "Loading", --url /orders\/\d+/
walnut browser fill-login                 # a sign-in page: fills the saved login, you never see it
walnut browser screenshot                 # a JPEG path: Read it to look
```

Every acting step says what it changed: `went to <url>`, `opened a new tab N`, `the page content
changed`, `a field's value changed`, or `nothing changed on the page` (then snapshot and act
again; do not wait). `walnut browser --help` lists every command; `walnut browser guide more`
(op: `api` GET `/api/v1/skills/walnut-browser/references/more.md`) prints the rest of this guide:
frames, real input, dialogs, recording a tab's requests, uploads, taking a tab of the user's.

## Rules

- **Two or more tabs, or subagents in the browser at once: every command names its tab with
  `--tab N`** (`open` prints N). A command with no tab then is refused with the tabs listed
  (`which_tab`, exit 1). Subagents share the task's tabs and approvals.
- **Say where you are.** `open`, `take`, `navigate` and `back` name the window and tab ("In
  Walnut's agent window (behind theirs, not minimized), tab 812 ..."): your first line to the user
  when you start says it. Never minimize the agent window or bring it to the front.
- **Never sign in again on a site the user has open.** An `open` that lists their tabs on the
  site (`person_tabs`): ask them to hand that tab over ("Act in tab" in Walnut's side panel), or
  `take <tab>` when they are not on it. `fill-login` there answers `site_open_in_person_tab`;
  `--fresh-sign-in` only when they asked for a new sign-in (they approve it).
- **Sign in with `fill-login`, then `fill-code`** where a one-time code is asked; you never see
  the password or the code. `which_login`: run again with `--item <id>`. `no_code`: ask the user
  to enter it. `page_tampered`: navigate to the page again, then fill. Never type a password you
  read from elsewhere. A sign-in only the user can do (no saved login, a code to their phone, a
  check): `request-sign-in "<what>"` and wait for it.
- **A code to the user's phone or mail is announced first, and never at night.** Before a step
  that sends one (Send code, Text me, a sign-in that texts a code), say in one line where they
  read it (your chat, or a `request-sign-in`) which task, which site and why the code is needed;
  only then trigger it. Never between 22:00 and 08:00 their local time: schedule it for the
  morning (`wait_until` or a trigger).
- **Buying, paying, sending, posting or deleting waits for the user's yes** (Place order, Pay,
  Send, Post, Publish, Delete, a form with card details or a message): `needs_ok`. The shell
  command waits by itself; with the op, call the same action again with `request` and `wait_ms:
  25000`. `denied`: stop. Search, Add to cart, sign in, Next, filters and opening pages never ask.
  The ask does not see `evaluate`, the page's own scripts or a link that acts on a plain visit:
  never use those to take a step the user has not approved.
- Refs (`e12`, `f3:e12` in a frame) hold while the element is on the page: after a change,
  `stale_ref` says to find it again. `covered`: close what sits on top (snapshot names it).
- Close the tabs you opened when done (a tab the user handed you stays open: `close` gives it back).

## Refusals

| Answer | Do |
|---|---|
| `browser_not_connected` | Tell the user in one line: the extension's popup, "Let Walnut agents use this browser". |
| `browser_disconnected` | Ask them to connect the extension again; do not retry. |
| `not_your_tab` | The user took it back, or it was closed (the answer says which): do not reopen it without saying why. |
| `site_denied` | They said no to that site: do not reach it another way. |
| `person_driving` | They have the tab now: work elsewhere or wait. |
| `trusted_off`, `extension_outdated` | Pass the message on as it is; do the step without that feature. |
| `window_hidden`, `input_dropped` | Run it again without `--trusted`. |

Exit codes: 0 done; 1 refused or a choice to make (the message lists the choices); 2 Walnut or the
browser did not answer in time (run it again); 3 an error, or a `wait` whose text or address did
not come (look at the page: `text` or `snapshot`). A `--read` whose read failed exits with the
read's code, though the step was done.
