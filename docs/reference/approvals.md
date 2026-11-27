# Approvals

Put one line in a script, a git hook, a CI step or an agent's plan, and it stops until you say
yes on your Mac or your phone:

```bash
walnut approve "Deploy web to prod" --detail release-notes.md && ./deploy.sh
walnut approve "Publish v2.3.0 to npm" --timeout 30m || exit 1
```

| Exit code | Meaning |
|---|---|
| 0 | approved |
| 1 | denied, or its answer was already used |
| 2 | nobody answered before `--timeout` (default 10 minutes), or it was withdrawn |
| 3 | it could not ask (bad usage, Walnut not reachable) |
| 4 | `--request-only`: asked, not answered yet (below); or a single-use ask Walnut holds until the person is back ("Walnut holds this ask", on stderr; its session is told when to take the step again, below) |
| 130 | the script was stopped (Ctrl-C); the request is withdrawn on every device (a `--approval` rerun of an ask open until answered leaves it open and exits 4) |

Options: `--timeout 90s|10m|2h` (10 seconds to 24 hours), `--detail <file>` (`-` reads stdin; up
to 32,000 characters), `--from <label>` (a short name for the asking script), `--json` (prints the
decided record on stdout). An older script's `--biometric`, `--face-id`, `--touch-id` and
`--signing-key` are taken and have no effect: every approval is one tap on any device you are
signed in on (below). It works on every machine with the `walnut` CLI: on a remote host the call goes through
that host's daemon to your Mac, so the request shows which host asked. `--why "<one line>"` is the
sentence the person reads first (without it, the asking session's last words before it asked).

### Two ways to wait

| Mode | How | Exit codes |
|---|---|---|
| Wait in place (the default, and the better one) | `walnut approve "<what>" && ./step.sh`: the script pauses until a person answers | as above |
| Ask and end | `walnut approve "<what>" --request-only` asks, prints the approval id and exits **4**; the session ends its turn; once it is answered, Walnut tells the session to run the same command again with `--approval <id>` added, which waits for (or reads) that answer and goes on only on Approve | 4 = asked, not answered yet; then as above |

Waiting in place survives a Walnut restart (a deploy restarts it many times a day): the
approval is in `approvals.json`, and a poll that gets no answer is made again with a growing pause
(1 s up to 10 s) until the deadline, with one line on stderr, "lost Walnut for a moment; still
waiting". A definite refusal (used, unknown id, bad token) still ends it at once. The same helper
waits for `walnut pass`, `walnut browser` and `walnut wait` (`src/lib/wait-through-restart.ts`).

`--request-only` saves what it asked (the wait token, the detail, for a single-use one the
envelope Walnut built) in `${XDG_STATE_HOME:-~/.local/state}/open-walnut/approvals/<id>.json` (mode 0600).
The rerun refuses when `what`, the detail or the mode changed since: ask again.

From Python, one line in each mode:

```python
import subprocess
# Wait in place: blocks until a person answers; True only on Approve.
ok = subprocess.run(["walnut", "approve", "Publish 1.2 to the store", "--why", "Tests pass on main"]).returncode == 0
# Ask and end: 4 means asked; the session reruns this script, which passes --approval <id> through.
code = subprocess.run(["walnut", "approve", "Publish 1.2 to the store", "--request-only"]).returncode
```

### What the person sees, and who asked

The card and its dialog read the request in plain words: **Why** (the `--why` line, else the
session's last words before it asked), **Task** (a link that opens the task and its chat),
**Goal** (the task description's first sentence), **Just before** (the session's last three
steps: commands run, files edited, words said, the approval call itself left out), **Runs** (the
command and its folder) and **Session**. A part Walnut does not know says so (`Session: unknown`,
`Task: unknown`, `Why: not given`); it is never left blank and never guessed
(`src/core/approvals/asker-context.ts`, `web/src/components/approvals/approval-context.tsx`).

A session id is a name: any process of the account could put one in `WALNUT_SESSION_ID`. So
Walnut checks the process on the other end of the request itself
(`src/core/approvals/caller-proof.ts`): `lsof` (macOS) or `ss`, else `lsof` (Linux) names the process holding
the connection. Whether that process runs inside the session is the word of the daemon that runs
the session, which holds its processes in memory: the Claude Code CLI, an ACP worker (Codex and
every other ACP engine), each with the start time it read when it started it (`caller.check`,
caller-proof-v1). Walnut never takes them from a file, since any process of the account can write
one. A local task terminal's shell is the one exception (`WALNUT_TERMINAL_SESSION_ID`): its dtach
master records its pid and start time in a pid file, which only ever names a task for a plain ask,
never a session, so it cannot get a single-use approval. A person's own commands there never count
as a session's. The result is the requester's `identity`:

| identity | When | The screen says |
|---|---|---|
| `verified` | the asking process descends from that session's process | "seen inside this task's session" |
| `unverified`, `check: outside` | Walnut looked, and the asking process is not inside that session (another session's id, a forged one) | "unverified: the asking process is not inside this session" |
| `unverified`, `check: unchecked` | Walnut could not look: no `lsof`/`ss`, a timeout, the session has no live process the daemon recorded, a daemon too old to say (below) | "not checked: Walnut could not look at the asking process" |
| `none` | no session named: a cron job, a hand-started script | "Session: unknown", with the host, folder, command, the process that started it and the user |

The match is on the whole connection (both addresses, both ports), so a process that binds the
same port number on another loopback address is not taken for the caller; a stopped session's
recorded pid, this server and the processes above it, and the local daemon never count as a
session's process.

A pid is checked as the process it was, never only as a number, since the kernel gives a pid out
again once its process ends (`src/providers/caller-proof-core.ts`). One `ps` snapshot names each
process's parent and start time. A session's process counts only while it is the one recorded: the
CLI under the start time the daemon read at spawn (and this boot's, for a host's system service),
the ACP worker under the start time read after starting it (a worker with none read yet does not
count), each read again by the reader that recorded it, so a locale never makes them differ; the
terminal's dtach master under the start time it recorded. The asking process must have started
before Walnut looked (the HTTP check) or before the daemon's socket connection opened (the gateway
check): a process given the asker's pid after it exited started later. `ps` gives start times in
whole seconds and Linux's may drift by one with the clock, so only a pid given out again within
about two seconds would pass, and both systems hand pids out in turn.

A request that claims a host's relay (`x-walnut-origin: host:<name>`) and is not
the server's own self-call is read as the sending process's own ask on this machine, with no
session.

A call through a host daemon's gateway socket (a remote host, the gateway `walnut` on a session's
PATH, a session's Walnut tools) is checked by that daemon (`caller-proof-v1`,
`src/providers/socket-peer-pid.ts`): it reads the process on the other end of its socket from the
kernel (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux), walks its parents to the CLI or ACP
worker it runs for that session (each checked by its start time, above), and puts its answer on the relayed call as `callerProof`. Only the
daemon writes it: both daemon builds drop one the caller sent, the server reads it only from a daemon
that advertises the capability, and the approvals route reads it only by a token the relay made in
the server's own memory (`src/core/approvals/relay-proof.ts`), never from a header another process
can send. A daemon too old for it, or one that cannot load libc (the JS build), reads "not checked".

A plain approval asks in every case, the screen saying which. A single-use approval (below) fails
closed: creating it and spending it (`approval_consume`) each need the asking process seen inside
its session, checked again on each call, else `403 unverified_session`, so a check Walnut could not
make refuses too.

## Off by default: one switch

Settings › General › **Ask me before agents act** (`config.approvals.ask_me`, `src/core/approvals/ask-me.ts`)
decides whether an agent's step waits for the person. It is off unless the person turns it on.

The switch changes only what Walnut stops, never whose decision a step is (2026-11-17, after an
agent signed the user up for a colleague's office hour and replied in his name with the switch
off). Anything that involves other people or takes their time, speaks or publishes in the user's
name, or cannot be undone waits for the user's own explicit yes either way: the charter says so in
every session's prompt (`USERS_OWN_YES_RULE`, `src/core/approval-kinds.ts`), and `answers_ask` on
an ask of any approval kind needs `user_words` with the switch on or off (`SWITCH_OFF_SETTLES` is
empty). Guard: `tests/core/users-own-yes-guard.test.ts`.

Off, these go ahead at once with no card, letter or wait, and each is recorded (an approved approval
marked `unasked` with its gate, or the plugin's own sent log, or a host grant `via: approvals-off`):

| Gate | Where |
|---|---|
| `walnut approve` / `approval_request` | `src/web/routes/approvals-v1.ts` |
| A browser step that sends, buys or deletes | `src/web/routes/browser-v1.ts` (askIfHeld) |
| A fresh sign-in on a site open in the person's own tab | `src/web/routes/browser-v1.ts`, `src/core/browser-control/fresh-sign-in.ts` |
| An agent using a saved password | `src/core/vault/agent.ts` |
| A mail send, a mailing-list unsubscribe | `src/integrations/mail/approvals.ts`, `unsubscribe.ts` |
| A task's first command on another host | `src/core/hosts/host-exec-grant.ts` |
| A plugin's own ask (a Slack post) | the plugin reads `walnut.letters.asksPerson()` |

What the switch never turns off: a single-use approval (a script that wants one reads the switch
itself), a password the person marked never or sensitive, the Browser extension's approved-sites list when the person chose it,
a change to a calendar event other people are in (the native helper's own confirmation), an OS dialog,
the person's own doors (Settings, answering), and an engine's own tool permission prompts (a session's
permission mode, which is not a Walnut approval). A draft whose last send may have landed (`unknown`)
is still shown to the person before another try. A host grant the switch made counts only while it
stays off, and a Passwords use it released is logged `via: approvals-off`. Only a person moves the switch, on any device they are
signed in on (the same check as answering, `src/web/routes/person-caller.ts`): a session or a
`walnut tools call` gets `403 human_only` and a test run `409 test_run`. On, every gate asks as before.
`tests/core/approvals/ask-me-gates-guard.test.ts` lists every ask from the source and fails on a new one
that does not read the switch or say why it stays.

## Where the ask shows up

- **The web console and the Mac app**, in three places that answer together:
  - **Needs you**: one line first in Home's Needs you section (counted there), in the
    notification center, and in the Org page's Needs you, on the CEO (Main) for every approval and on a
    project's lead for one its own work asked for. It says how many wait; a click opens them,
    in the order they came. The title and the buttons are on the card.
  - **A system notification**, `Approve? <what>`: in the Mac app a macOS notification (allow it
    once when macOS asks; System Settings, Notifications, Walnut turns it back on), in a browser a
    web notification once you allowed those ("Notify me on this computer" in the opened request). It shows
    whether or not Walnut is in front, and a click brings Walnut forward with the request open.
    Quiet mode holds it back unless quiet lets permission prompts through, and an answer anywhere
    takes it back.
  - **A card** at the bottom left of every window, on every page (the one stack every Walnut
    notice shares, just right of the sidebar's icon rail, the card nearest the corner), three short lines: "Approve?" with how many wait ("3 waiting", the
    count the Needs you line gives, which opens the list of them) and the time left, what is asked, then who asked (the task,
    or the script and its host) with Deny and Approve. It shows the request that came first and
    stays until that one is answered; the answer shows a moment over the next one. Its title
    opens the whole request (the folder and the detail too) in a dialog that lists every request
    waiting by its title, the one shown marked, and shows another at a click. Its "–" puts it down to two short lines (what is
    asked; how many, the time left and the buttons) until another request comes, and its "+"
    shows it whole again; in a crowded stack and beside Home's Needs you line it is those two
    lines by itself. There its "–"
    puts it down once more, to one line that opens the request, until another request comes. On
    a phone it is those two lines at the top of the screen, and a tap opens the dialog. It
    pops up on every page, Home and the Org page included; while the notification center is
    open, which lists the approvals itself, the card steps aside, and while the dialog is open
    the whole stack does.
  The web side is `web/src/components/approvals/` (one store, `approvals-store.ts`, for all of
  them); the Mac app's notification is `desktop/NotificationBridge.swift`.
- **The iPhone app**: a push with Approve and Deny on the banner, for every
  approval; a tap opens the full request, with Approve and Deny live at its foot. The app also opens it when you bring it forward.
  Pushes need an APNs key on your Mac (see [iOS push notifications](ios-push-notifications.md)).

## One tap, on any device you are signed in on

Every approval is answered the same way: Approve or Deny, one tap, on any device you are signed in
on (the web console, the Mac app, the iPhone app, through the cloud companion too). There is no
device key, no device an approval is bound to, and Approve is never greyed out for want of one
(2026-11-21, the user: "只要我这个手机连到了这里面，或者其他的 device ... 就可以签"). The phone's
banner asks for its own passcode or Face ID before it answers, as iOS does for any banner action;
Walnut asks for nothing more.

Until 2026-11-21 a `--biometric` or single-use approval needed a signature from a device key
(Secure Enclave on the phone, Touch ID in the Mac app), and the Git gate pinned the keys it took.
A phone re-paired after its key was pinned could then never approve again: its new key was not the
pinned one, and its Approve stayed grey. All of that is gone: on upgrade, an ask still waiting to
add or remove a device key, or to turn approvals off with a signature, is withdrawn
(`store.ts withdrawDeviceKeyAsks`), and `approvals/keys.json` is no longer read. A record an older
Walnut wrote with `mode: "biometric"` or pinned keys is answered with a tap like any other.

## Rules

- **Only a person answers.** The answer route refuses any Walnut session, any `walnut tools call`
  automation and any session on another host (`403 human_only`); there is no op that answers an
  approval. This is one of the team charter's approval gates
  (`tests/core/agent-parity-ratchet.test.ts`).
- **At most 20 waiting at once.** A script in a loop cannot flood your phone: past 20 pending
  approvals a new ask is refused (`429 too_many_pending`) until some are answered or withdrawn.
- **An agent never approves itself.** The session or script that asks holds only the wait token;
  it can read the answer, never give it. Its own calls carry its session (or the CLI's automation
  mark), and the answer route refuses them, as it refuses a browser under automation on the
  person's own install (Playwright, headless Chromium: routes/person-caller.ts
  `isPersonNotAutomation`). The Approvals switch takes the same check. A session's Bash that sends
  an answer or the switch through a web client (curl, a script's HTTP call) is refused by the
  sessions' hook (`providers/approvals-guard-hook.ts`).
- **Bound and used once.** A request's digest covers its id, mode, times, host, task, what and
  detail. An answer names the digest of the request its screen showed (the web console, the Mac app
  and the current iPhone app always do; an older iPhone app sends none, and a record never changes
  after it is made), and one that does not match is refused (`409 changed`), so a request changed
  after you read it is never approved unseen. The
  first answer wins; the asking process (holding the wait token only it got) reads the decision
  once, and a second read is refused.
- **An agent's ask stays open until you answer.** An ask a task's agent waits on (a browser step
  that buys, sends or deletes, a new site, a new sign-in, an upload, a password, a locked note, an
  `approval_request` with no `timeout_ms`, or `walnut approve --request-only`) is not on a 10-minute
  clock: it stays on your devices until you answer, while you are away too, for at most 72 hours
  (`untilBack` on the record, `store.ts`). The agent ends its turn and Walnut tells its session your
  answer; the same browser step asked again (a new ref after a reload, the same page at the same
  address in another of the task's tabs) is the same ask, so you are asked once, and one yes lets
  one step through, within an hour of your tap. A task has at most 3 such asks open at a time, and
  all tasks 10; past that an ask gets its own short clock. `walnut approve --approval <id>` on one
  still open gives up after its own `--timeout` with exit 4 and keeps the saved request (4 days).
  A script blocking on its own `--timeout` and a
  single-use ask (five minutes to use) keep their clocks. One that runs out tells the agent not to
  ask again by itself (2026-11-26: a $30 payment's ask expired twice in 10 minutes while the person
  was away). Guard: `tests/core/approvals/until-back.test.ts`.
- **Expired is not approved.** An answer after the deadline is refused (`409 already_expired`), and a
  single-use approval spent after it is refused too.
- **Recorded.** Every decision keeps who asked, who answered, when and on which device
  (`walnut approvals list --all`, kept 30 days).

What this guards: an agent or a script answering through Walnut's tools (its sessions and
`walnut tools call` are refused), and an answer you did not give. Known limit, the same as every
person-only route: an answer is a click in Walnut's own screens, so a program running as you on
this computer that calls the console's route directly without Walnut's session headers can answer
too, and so can a holder of a paired device's token. A Git gate that runs a `walnut` found on
`PATH` trusts that program.

## API

| Route | Who | |
|---|---|---|
| `POST /api/v1/approvals` | anyone | `{ what, detail?, timeout_ms?, cwd?, command?, why?, single_use?, request_only? }` → `{ approval, waitToken }` (an older asker's `mode` and `signing_key_id(s)` are ignored; a task's ask with `request_only` or no `timeout_ms` stays open until answered, `approval.untilBack`) |
| `GET /api/v1/approvals[?status=all]` | anyone | `{ approvals, keys: [], askMe }`: `keys` is always empty, kept for older iPhone apps that read it |
| `GET /api/v1/approvals/:id` | anyone | one approval |
| `POST /api/v1/approvals/:id/wait` | the asker | `{ token, wait_ms? }` → `{ approval, used }`, holds at most 12 s |
| `POST /api/v1/approvals/:id/consume` | the asker's session | `{ token, digest, detail }` → `{ approval, used: true }` (single-use, below) |
| `POST /api/v1/approvals/:id/cancel` | the asker | `{ token, reason? }` |
| `POST /api/v1/approvals/:id/answer` | a person | `{ decision, digest?, device? }` (an older app's `keyId` and `signature` are ignored) |

The routes `/api/v1/approvals/keys` are gone: an older iPhone app that still sends its key there
gets a 404 it ignores, and its Approve works as a tap.

Ops for agents: `approval_request`, `approval_wait`, `approval_consume`, `approval_cancel`, `approval_list`.

### Strict single-use steps

`approval_request` also accepts `single_use: true`, with the operation context in `detail` and a
timeout of at most five minutes. It requires a task session, with the asking process seen inside
it. The server wraps the context in a JSON detail: `{version:"walnut-single-use-v1", sessionId,
taskId, host, nonce, context}` (and `why`, `context_summary` when given). Identity comes from the
caller, the nonce is 32 random bytes, and the approval digest covers the entire envelope and its
expiry. The person answers it with a tap like any other.

For these requests, `approval_wait` reads the answer without spending it (`used: false`). The
asker rebuilds the original operation context from the current state and checks the record: its
digest, the envelope's fields, that a person approved it (`decision: approve`, not marked
`unasked`), and its expiry. Then `approval_consume` calls `POST /api/v1/approvals/:id/consume`
with `{token, digest, detail}`, where `detail` is that rebuilt context, not the envelope. The
store checks the same task session and host, the context, that it was approved by a person and its
expiry under its file lock. Success returns `{approval, used:true}` and durably spends the nonce.
Every later consume is `409 approval_used`, including a retry within a second. A lost response is
not permission to run: ask again. Deny, timeout, an answer the switch gave instead of a person, and
mismatches never grant a use.

#### Only to a person who is there, and held until he is back

A single-use ask rings every device the person is signed in on, so only one is out at a time and
only while he is there: he did something in Walnut in the last 10 minutes (typed in a chat, or a
window or the phone app reported attention, on any screen, the phone's Inbox tab too) or a phone
streams a session; after one ended unanswered, he must have done something since
(`src/core/approvals/single-use-fence.ts`). An ask that fails that, or finds 20 asks already
waiting, is refused with nothing sent (`user_away`, `presence_unknown`, `unanswered_retry`,
`biometric_pending`, `too_many_pending`), and since 2026-11-25 it is not dropped: Walnut holds it
(`src/core/approvals/held-asks.ts`, `held.json` beside the approvals) and the refusal says
"Walnut holds this ask (held-…)"; a newer `walnut approve` exits 4 on it, with no approval id
(`--json` prints `{"status":"held","held":"held-…"}`; an older one exits 3 and prints the same
words). Once a fresh ask of it would be let through (the sweep makes createApproval's own checks:
he is back, the other ask ended, the cap has room), the oldest held ask is released: its task's
session gets one notice (`ask_again`) to take the step again, and for 10 minutes the fence keeps
his devices for that ask, so it goes to him, one tap. One at a time; one held ask per step of a
task (the command and folder it runs, else its line: asking again finds it, a new commit's line
takes its place); at most 3 per task and 20 in all; a release whose ask is refused again waits
again, and after 3 releases it ends. A held ask lapses after 72 hours
(`WALNUT_APPROVAL_HOLD_HOURS`): it is void, its task is told (`lapsed`) to report that the step
waits for his approval, and the same step is not held again for another 72 hours (unless it was
released: he did come back). A task told nothing is a closed one, so an asker keeps its task open
while its ask is held. Never held, and dropped when held: a step the person denied, or one that
reached him twice and got no answer, within 72 hours and since he last approved that step; a
second ask of a step already on his devices.

This step guards scripts that call it. It does not prevent a process from deleting the call,
rewriting user-owned code or using credentials it already holds. Strong enforcement of a Git
push additionally needs credentials isolated from the agent and an executor that verifies and
pushes only the approved SHA to the approved remote and ref.

The asking session hears the answer (`src/core/approvals/tell-asker.ts`). A `walnut approve` still waiting reads the decision itself; when nothing of the asker read it within 15 seconds of an Approve, a Deny or the deadline (a session that asked with `approval_request` and ended its turn, a command stopped meanwhile), Walnut sends that session one Walnut note with the decision, which wakes it when idle. Every way of answering ends in the store's `announce()`, so the web notice, the Mac app, the phone and expiry all tell it; a withdrawal tells no one. `tests/core/approvals/tell-asker.test.ts` fails on a store path that ends an approval without announcing it.

The digest is the SHA-256 hex of these lines joined with `\n` (base64 of UTF-8 where marked):
`walnut-approval-v1`, `id=<id>`, `mode=<tap|biometric>`, `created=<iso>`, `expires=<iso>`,
`host=<b64>`, `task=<task id or empty>`, `what=<b64>`, `detail=<b64 or empty>`
(`src/core/approvals/digest.ts`). Every new approval is `mode=tap`; a record an older Walnut wrote
keeps the mode it was made with, so its digest still matches. A device's answer names the digest it
read from the record it showed; it never computes one.

`tests/core/approvals/no-device-keys-ratchet.test.ts` fails when a device key, a signature check or
an Approve that a signed-in device cannot press comes back anywhere in the server, the web console,
the Mac app or the iPhone app.
