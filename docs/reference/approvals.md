# Approvals

Put one line in a script, a git hook, a CI step or an agent's plan, and it stops until you say
yes on your Mac or your phone:

```bash
walnut approve "Deploy web to prod" --detail release-notes.md && ./deploy.sh
walnut approve "Publish v2.3.0 to npm" --biometric --timeout 30m || exit 1
```

| Exit code | Meaning |
|---|---|
| 0 | approved |
| 1 | denied, or its answer was already used |
| 2 | nobody answered before `--timeout` (default 10 minutes), or it was withdrawn |
| 3 | it could not ask (bad usage, Walnut not reachable) |
| 4 | `--request-only`: asked, not answered yet (below) |
| 130 | the script was stopped (Ctrl-C); the request is withdrawn on every device |

Options: `--biometric` (Approve needs Face ID or Touch ID, below), `--timeout 90s|10m|2h`
(10 seconds to 24 hours), `--detail <file>` (`-` reads stdin; up to 32,000 characters),
`--from <label>` (a short name for the asking script), `--json` (prints the decided record on
stdout). It works on every machine with the `walnut` CLI: on a remote host the call goes through
that host's daemon to your Mac, so the request shows which host asked. `--why "<one line>"` is the
sentence the person reads first (without it, the asking session's last words before it asked).

### Two ways to wait

| Mode | How | Exit codes |
|---|---|---|
| Wait in place (the default, and the better one) | `walnut approve "<what>" && ./step.sh`: the script pauses until a person answers | as above |
| Ask and end | `walnut approve "<what>" --request-only` asks, prints the approval id and exits **4**; the session ends its turn; once it is answered, Walnut tells the session to run the same command again with `--approval <id>` added, which waits for (or reads) that answer and goes on only on Approve | 4 = asked, not answered yet; then as above |

`--request-only` saves what it asked (the wait token, the detail, for a single-use one the signed
envelope) in `${XDG_STATE_HOME:-~/.local/state}/open-walnut/approvals/<id>.json` (mode 0600).
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

What the switch never turns off: a signed single-use approval (only its device can sign it; a script
that wants one reads the switch itself), a new signing device without its app's proof, a password the
person marked never or sensitive, the Browser extension's approved-sites list when the person chose it,
a change to a calendar event other people are in (the native helper's own confirmation), an OS dialog,
the person's own doors (Settings, answering), and an engine's own tool permission prompts (a session's
permission mode, which is not a Walnut approval). A draft whose last send may have landed (`unknown`)
is still shown to the person before another try. A host grant the switch made counts only while it
stays off, and a Passwords use it released is logged `via: approvals-off`. Only a person moves the switch: a session gets
`403 human_only` and a test run `409 test_run`. On, every gate asks as before.
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
  - **A card** at the bottom left of every window, on every page (the corner every Walnut notice
    shares, beside the sidebar), three short lines: "Approve?" with how many wait ("3 waiting", the
    count the Needs you line gives, which opens the list of them) and the time left, what is asked, then who asked (the task,
    or the script and its host) with Deny and Approve. It shows the request that came first and
    stays until that one is answered; the answer shows a moment over the next one. Its title
    opens the whole request (the folder and the detail too) in a dialog that lists every request
    waiting by its title, the one shown marked, and shows another at a click. Its "–" puts it down to two short lines (what is
    asked; how many, the time left and the buttons) until another request comes, and its "+"
    shows it whole again; above a chat's composer, over a page's work (a note, a task list, a
    calendar) and beside Home's Needs you line it is those two lines by itself. There its "–"
    puts it down once more, to one line that opens the request, until another request comes. On
    a phone it is those two lines at the bottom of the screen, and a tap opens the dialog. It
    pops up on every page, Home and the Org page included; while the notification center is
    open, which lists the approvals itself, the card steps aside, and while the dialog is open
    the whole corner does.
  The web side is `web/src/components/approvals/` (one store, `approvals-store.ts`, for all of
  them); the Mac app's notification is `desktop/NotificationBridge.swift`.
- **The iPhone app**: a push with Approve and Deny on the banner for a plain
  approval; a tap opens the full request. The app also opens it when you bring it forward.
  Pushes need an APNs key on your Mac (see [iOS push notifications](ios-push-notifications.md)).

## Two strengths

- **Tap** (default): any Approve from a device you use.
- **Biometric** (`--biometric`): Approve needs a signature from a device key that signs only after
  Face ID or Touch ID. The iPhone app makes its key in the phone's Secure Enclave, the Mac app in
  the Mac's; Walnut keeps only the public half. The device rebuilds the request's digest from
  what it shows you and signs that, so a signature fits one request and only what you read.
  Deny never needs a signature.

If no device can sign yet, a `--biometric` request asks for a tap and says why, on the card and
on the script's stderr. A Mac without Touch ID, or without the Mac app, answers biometric
requests on the phone; a user without the phone app gets tap approvals.

## Rules

- **Only a person answers.** The answer route refuses any Walnut session, any `walnut tools call`
  automation and any session on another host (`403 human_only`); there is no op that answers an
  approval. This is one of the team charter's approval gates
  (`tests/core/agent-parity-ratchet.test.ts`).
- **At most 20 waiting at once.** A script in a loop cannot flood your phone: past 20 pending
  approvals a new ask is refused (`429 too_many_pending`) until some are answered or withdrawn.
- **Bound and used once.** A request's digest covers its id, strength, times, host, task, what and
  detail. The first answer wins; the asking process (holding the wait token only it got) reads
  the decision once, and a second read is refused.
- **Recorded.** Every decision keeps who asked, who answered, when, on which device and how
  (`walnut approvals list --all`, kept 30 days).

## Signing devices

Every device you set up signs at once, with nothing for you to do and nothing to approve on
another device: the Walnut Mac app adds its Touch ID key when it opens, and the iPhone app its Face
ID key the first time it opens while it reaches your computer directly (the same network or your
tailnet; a request through the cloud companion does not carry the phone's own sign-in). Face ID or
Touch ID is still asked at every approval, by the device itself. So your first
approval of an agent's step on the Mac is one touch, never the Passwords master password. The Mac
app's key counts only when the app's own process sends it: Walnut checks that the process holding
the request runs the signed Mac app's code: its bundle identifier, a certificate Apple issued to a
team (never ad-hoc, which anyone can make), the hardened runtime with no entitlement that lets
another program load code into it or attach a debugger, and the same code hash as the signed
bundle on disk. The app also makes a new key for this enrollment rather than using a key file it
finds on disk. A Mac app built without a developer certificate cannot be the first device; its
approvals then take the iPhone's Face ID, or an unlock in Passwords as before. A key from any other request (no
paired device's sign-in, no Mac app proof) is never the first device, because any program on the
computer can call the console's routes; a later one waits until an existing device approves it:
Walnut asks "Let <device> sign your approvals" as a biometric approval on the devices that
already sign. Known limit: a program running as you can make a device sign-in, and so add a key
of its own; before 2026-11-12 only the first key had that limit. A single-use approval bound to
pinned keys (below) still takes only those keys' signatures.
`walnut approvals list` shows the devices. Removing one is done from a device while another
remains. Walnut never removes the last one, since the next device would then be trusted on first
use; if that phone is lost, delete `approvals/keys.json` in the Walnut data folder by hand.

What each strength guards:

- **Tap** guards against an agent or a script answering through Walnut's tools (sessions and
  `walnut tools call` are refused) and against an answer you did not give. It is a click in
  Walnut's own screens, so a program running as you on this computer that calls the console's
  route directly can answer it too.
- **Biometric** also holds against that program: Approve needs a signature that only Face ID or
  Touch ID on an enrolled device unlocks, the first device comes only from the paired phone or the
  signed Mac app's own process, and each new device needs an existing one's Face ID. The Mac app signs only for the console page
  itself, never for a frame inside it. What no check on this computer can stop is a program that
  rewrites Walnut's own files or code on disk, or that builds and signs a look-alike Mac app with
  your own developer certificate before the first device exists; Walnut's data lives in your home
  directory, like every tool you run.

## API

| Route | Who | |
|---|---|---|
| `POST /api/v1/approvals` | anyone | `{ what, detail?, mode?, timeout_ms?, cwd?, command? }` → `{ approval, waitToken, downgraded? }` |
| `GET /api/v1/approvals[?status=all]` | anyone | pending (or all) approvals and the signing devices |
| `GET /api/v1/approvals/:id` | anyone | one approval |
| `POST /api/v1/approvals/:id/wait` | the asker | `{ token, wait_ms? }` → `{ approval, used }`, holds at most 12 s |
| `POST /api/v1/approvals/:id/cancel` | the asker | `{ token, reason? }` |
| `POST /api/v1/approvals/:id/answer` | a person | `{ decision, keyId?, signature?, device? }` |
| `GET /api/v1/approvals/keys` | anyone | the signing devices (public halves) |
| `POST /api/v1/approvals/keys` | a person | `{ publicKey, name, kind }` (base64 DER P-256 SPKI) |
| `DELETE /api/v1/approvals/keys/:id` | a person | removes one (never the last) |

Ops for agents: `approval_request`, `approval_wait`, `approval_consume`, `approval_cancel`, `approval_list`.

### Strict single-use steps

`approval_request` also accepts `single_use: true` and `signing_key_id` (or `signing_key_ids`, two
or more keys any one of which may sign; `walnut approve --signing-key` given more than once), with biometric mode,
operation context in `detail`, and a timeout of at most five minutes. It requires a task session
and an active signing device. No device means refusal, never a tap fallback. The server wraps the
context in a signed JSON detail: `{version:"walnut-single-use-v1", sessionId, taskId, host,
signingKeyId, nonce, context}`, or with a set `signingKeyIds` (sorted, distinct) in place of
`signingKeyId`, so the set is signed and cannot be widened later; the answer's `keyId` names the
key that signed. Identity comes from the caller, nonce is 32 random bytes, and the
existing approval digest signs the entire envelope and its expiry. Existing clients can still
show and sign the detail without a new digest format.

For these requests, `approval_wait` reads the answer without spending it (`used: false`). The
asker rebuilds the original operation context from the current state and verifies the record's
digest and signature against its pinned public key. Then `approval_consume` calls
`POST /api/v1/approvals/:id/consume` with `{token, digest, detail}`, where `detail` is that rebuilt
context, not the envelope. The store checks the same task session and host, context, signature,
required signing device and expiry under its file lock. Success returns `{approval, used:true}`
and durably spends the nonce. Every later consume is `409 approval_used`, including a retry
within a second. A lost response is not permission to run: ask again. Deny, timeout, unsigned or
forged answers, removed signing devices and mismatches never grant a use.

This step guards scripts that call it. It does not prevent a process from deleting the call,
rewriting user-owned code or using credentials it already holds. Strong enforcement of a Git
push additionally needs credentials isolated from the agent and an executor that verifies and
pushes only the approved SHA to the approved remote and ref.

The asking session hears the answer (`src/core/approvals/tell-asker.ts`). A `walnut approve` still waiting reads the decision itself; when nothing of the asker read it within 15 seconds of an Approve, a Deny or the deadline (a session that asked with `approval_request` and ended its turn, a command stopped meanwhile), Walnut sends that session one Walnut note with the decision, which wakes it when idle. Every way of answering ends in the store's `announce()`, so the web notice, the phone, Touch ID, Face ID and expiry all tell it; a withdrawal tells no one. `tests/core/approvals/tell-asker.test.ts` fails on a store path that ends an approval without announcing it.

The digest is the SHA-256 hex of these lines joined with `\n` (base64 of UTF-8 where marked):
`walnut-approval-v1`, `id=<id>`, `mode=<tap|biometric>`, `created=<iso>`, `expires=<iso>`,
`host=<b64>`, `task=<task id or empty>`, `what=<b64>`, `detail=<b64 or empty>`. A device signs
`walnut-approval-answer-v1\n<digest>\n<approve|deny>` with ECDSA P-256 / SHA-256, DER encoded.
Implementations: `src/core/approvals/digest.ts`, `desktop/ApprovalBridge.swift`,
`ios-native/Walnut/Core/ApprovalSigning.swift` (kept equal by
`tests/core/approvals/approval-signing-parity.test.ts`).
