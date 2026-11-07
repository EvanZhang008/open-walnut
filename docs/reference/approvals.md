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
| 130 | the script was stopped (Ctrl-C); the request is withdrawn on every device |

Options: `--biometric` (Approve needs Face ID or Touch ID, below), `--timeout 90s|10m|2h`
(10 seconds to 24 hours), `--detail <file>` (`-` reads stdin; up to 32,000 characters),
`--from <label>` (a short name for the asking script), `--json` (prints the decided record on
stdout). It works on every machine with the `walnut` CLI: on a remote host the call goes through
that host's daemon to your Mac, so the request shows which host asked.

## Where the ask shows up

- **The web console and the Mac app**, in three places that answer together:
  - **Needs you**: one line first in Home's Needs you section (counted there), in the
    notification center, and in the Org page's Needs you, on Main for every approval and on a
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

The first device that signs is your iPhone: the app sets itself up the first time it opens while
it reaches your computer directly (the same network or your tailnet; a request through the cloud
companion does not carry the phone's own sign-in, so it cannot be the first). A request from the
computer itself is never the first device, because any program on it can call the console's
routes. Every later device, the Mac app included, waits until an existing one approves it: Walnut
asks "Let <device> sign your approvals" as a biometric approval on the devices that already sign.
`walnut approvals list` shows the devices. Removing one is done from a device while another
remains. Walnut never removes the last one, since the next device would then be trusted on first
use; if that phone is lost, delete `approvals/keys.json` in the Walnut data folder by hand.

What each strength guards:

- **Tap** guards against an agent or a script answering through Walnut's tools (sessions and
  `walnut tools call` are refused) and against an answer you did not give. It is a click in
  Walnut's own screens, so a program running as you on this computer that calls the console's
  route directly can answer it too.
- **Biometric** also holds against that program: Approve needs a signature that only Face ID or
  Touch ID on an enrolled device unlocks, the first device comes only from the paired phone, and
  each new device needs an existing one's Face ID. The Mac app signs only for the console page
  itself, never for a frame inside it. What no check on this computer can stop is a program that
  rewrites Walnut's own files or code on disk; Walnut's data lives in your home directory, like
  every tool you run.

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

`approval_request` also accepts `single_use: true` and `signing_key_id`, with biometric mode,
operation context in `detail`, and a timeout of at most five minutes. It requires a task session
and an active signing device. No device means refusal, never a tap fallback. The server wraps the
context in a signed JSON detail: `{version:"walnut-single-use-v1", sessionId, taskId, host,
signingKeyId, nonce, context}`. Identity comes from the caller, nonce is 32 random bytes, and the
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
