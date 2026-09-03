---
name: setup-cloud-companion
description: >-
  Set up the self-hosted cloud companion — provision a small always-on VM, wire
  data sync to it, and get the user's phone working off Wi-Fi. Use when the user
  says "set up my cloud companion", "I want to reach Walnut from my phone
  anywhere / away from home", "set up cloud sync", "deploy the cloud box", or
  asks why their phone only works on the home network.
type: action
---

# Set up the cloud companion

The cloud companion is a small always-on VM the user owns. It receives the Mac's
data repo over git-smart-HTTP, serves the phone over HTTPS from anywhere, and
relays live session traffic. Setting one up means: provision a VM → point a
hostname at it → wait for first boot → claim it → verify sync.

You do **not** re-implement that sequence. A resumable job on this machine owns
it, and you drive that job over REST — the same endpoints the Settings →
Cloud Companion wizard uses. The job survives your session ending, a server
restart, and a long poll; your role is to explain, collect choices, answer the
job's questions, and narrate progress.

**API base:** `$WALNUT_SERVER_URL` (set by the server for its own sessions;
falls back to `http://localhost:3456`). Use
`${WALNUT_SERVER_URL:-http://localhost:3456}` in every curl so a sandbox or demo
server on another port talks to ITSELF, never to the user's real server.

## 0. Money and consent — before anything billable

Provisioning creates **real, recurring, billed cloud resources in the user's own
account**. Say so plainly, in this order, and get an explicit yes before you
POST anything:

1. What gets created: one small VM with a public IP, an encrypted disk that is
   *kept* if the VM is terminated, daily disk snapshots, and (on AWS) a
   CloudFormation stack that owns them.
2. What it costs per month — read the real number from `costHint` in step 1
   below, do not quote a figure from memory.
3. That the bill runs until they tear it down, and that teardown is manual
   (section 9).

Then ask for confirmation in one question ("Ready for me to create this?") and
**wait for a real yes.** If the user is only asking how it works, answer and
stop — do not start a job.

Two hard rules:

- **Never invent credentials, tokens, domains, or hostnames.** The user supplies
  the domain and any provider API token. If something is missing, ask.
- **Never echo a secret back.** Provider tokens go into one POST body and
  nowhere else — not into your reply, not into a file, not into a task note.
  The pairing code that authorizes the claim is generated server-side and
  redacted from every response you can see (`redactCloudSetupJob`), so you will
  never hold it; the one place it appears is the boot-script blob in section 7.

## 1. Check what this machine can provision

```bash
curl -s ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/providers
```

Returns `{ providers: [{ id, label, costHint, canProvision, detect }] }`:

| Field | Meaning for the user |
|---|---|
| `label` | Human name, e.g. "AWS (EC2 + CDK)" |
| `costHint` | Rough monthly cost — quote this verbatim in section 0 |
| `canProvision` | `true` = Walnut creates the VM itself. `false` = manual path (section 7) |
| `detect.available` | `true` = credentials are already usable, nothing to collect |
| `detect.detail` | One sentence to relay as-is — it says exactly what is missing |
| `detect.needs` | `nothing` / `cli-login` (user fixes their own CLI) / `api-token` (you collect it) |

Report readiness in plain language, e.g. "AWS is ready (credentials found), and
'Any VM (paste a script)' always works if you'd rather use a host you already
have." If a provider is `available: false` with `needs: 'cli-login'`, relay
`detail` — that is the fix — and do not try to log them in yourself.

Do not read `needs: 'cli-login'` as "this provider is unavailable". Azure and
Google Cloud provision through the user's own `az` / `gcloud` login, so they
report `cli-login` until that CLI is installed and signed in — and they become
one-click the moment it is. Relay the one-line fix from `detail`, and offer the
manual path as the alternative rather than the only option.

## 2. Collect the two choices

**Provider** — one of the `id` values from step 1.

**Domain mode** — this is the choice users get wrong, so present the trade-off:

- `own-domain` — they own a hostname (e.g. `wn.example.com`) and add one DNS
  A record. **Recommended for anything long-term**: the address is theirs, it
  survives rebuilds, and certificate issuance is not shared with strangers.
  Requires access to their DNS registrar during setup.
- `sslip` — free automatic address derived from the VM's IP
  (`<dashed-ip>.sslip.io`). **Fastest start**, zero DNS work. Caveat worth
  stating: `sslip.io` shares one certificate rate-limit bucket across all its
  users, so issuance can occasionally be slow or throttled, and the address
  changes if the IP ever changes.

If they pick `own-domain`, get the exact hostname. Optionally collect `region`
and `instanceType` if they care; otherwise omit them and let the defaults win.

## 3. Start the job

```bash
curl -s -X POST ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/start \
  -H 'Content-Type: application/json' \
  -d '{"provider":"aws","domainMode":"own-domain","domain":"wn.example.com"}'
```

Body fields: `provider` (required), `domainMode` (required, `own-domain` or
`sslip`), `domain` (required when `own-domain`), `region`, `instanceType`,
`credentials` (only when step 1 said `needs: 'api-token'`), `force`.

- **202** `{ job }` — started. Go to section 4.
- **400** `{ error }` — bad input, or preflight refused. The most common one:
  cloud sync is **already configured on this machine**. Do not pass `force`
  reflexively — tell the user they already have a companion wired up, and only
  start over (with `"force": true`) if they explicitly say they want to replace
  it.
- **409** `{ error }` — a job is already in flight. Fetch it and describe it
  before doing anything:

```bash
curl -s ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/job
```

Then act on that job's `status`: `awaiting-input` → answer it (section 6);
`running` → just resume narrating (section 5); `failed` → section 8;
`done` → it already finished (section 9). Offer
`POST /api/cloud-setup/job/cancel` if the user wants to abandon it, and
`DELETE /api/cloud-setup/job` to clear a finished/failed/cancelled record
(409 while one is still in flight — cancel first).

## 4. Read the job shape once

Every job response is `{ job: {...} }` with:

- `status` — `running` | `awaiting-input` | `failed` | `done` | `cancelled`
- `currentStep` — where it is now
- `steps` — every step id → `{ status: pending|running|done|error|skipped }`
- `awaitingInput` — `{ kind, prompt }` when blocked (section 6)
- `logTail` — recent operator-visible lines (ring-capped)
- `domain`, `ip`, `error`

Step order, with what to tell the user each means:

| Step | Plain language | Rough ETA |
|---|---|---|
| `preflight` | checking credentials and that sync isn't already set up | seconds |
| `generate` | writing the first-boot script | seconds |
| `provision` | creating the VM | ~5 min (AWS: 3-6 min, longer on a first-ever deploy that installs CDK deps) |
| `await-vm` | waiting for the IP of a VM you created | manual path only |
| `dns` | waiting for the A record to point at the VM | minutes to ~30 min; skipped in sslip mode |
| `await-server` | first boot: clone, build, certificate | ~10 min (budget 20 min) |
| `claim-and-wire` | claiming the box and configuring the git remote | seconds |
| `verify-sync` | first push + independent auth check | seconds |
| `done` | ready | — |

A `skipped` step is normal, not a failure (`dns` in sslip mode, `await-vm`
whenever Walnut provisioned the VM itself).

## 5. Poll — one short command per poll

```bash
curl -s ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/job
```

**Each poll must be its own separate short command, roughly 30s apart.** Do
not write a `sleep`/`while` loop inside a single call: `shell_exec` is capped at
600s (default 120s), so a loop that waits out a 10-minute first boot gets killed
mid-wait and you lose the thread — while the job itself keeps running fine.
Polling is cheap and the job is authoritative, so a dropped poll costs nothing.

Between polls, narrate transitions in the user's language, not step ids: "the VM
is up, now waiting for it to finish building Walnut — usually about ten
minutes." Only surface `logTail` lines when something is slow or wrong; a
healthy provision does not need its CDK output pasted at the user.

If `GET /job` returns **404**, no job exists — it was deleted, or you never
started one.

## 6. Answer the job's questions (`status: awaiting-input`)

`awaitingInput.kind` tells you what to ask. Relay `awaitingInput.prompt` too —
it is written for the user. All three answers go to the same endpoint:

```bash
curl -s -X POST ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/job/input \
  -H 'Content-Type: application/json' -d '<one of the bodies below>'
```

**`dns-confirm`** — the A record still doesn't resolve to the VM's IP after the
patience window. Show the user the exact record to create, built from the job's
own fields:

```
Type: A    Name: <job.domain>    Value: <job.ip>    Proxy/CDN: OFF (DNS-only)
```

The CDN-proxy warning matters: an orange-cloud/proxied record breaks both the
certificate challenge and TLS termination. Then tell them Walnut **keeps
checking in the background**, so if they add the record now it will continue on
its own with no further action. Only POST the override once they confirm they
either added it or want to proceed regardless:

```json
{"confirmDnsSkip": true}
```

(Anything else on a `dns-confirm` job is rejected — the field name is exact.)

**`vm-ip`** — manual path: ask for the VM's public IPv4 address and post it.
Must be a plain dotted IPv4; a hostname is rejected.

```json
{"ip": "203.0.113.10"}
```

In sslip mode the hostname is derived from this IP automatically — nothing else
to collect.

**`credentials`** — the provider needs an API token (also happens after a server
restart mid-setup, since tokens are held in memory only and never persisted).
Ask the user to paste it, post it, and then **forget it**: do not repeat it, do
not save it anywhere, do not put it in a summary.

```json
{"credentials": "<token the user pasted>"}
```

Each of these returns **200** `{ job }` and the job continues. **409** means the
job is not actually waiting for input (someone else answered, or it moved on) —
re-read `GET /job` before trying again. **400** means the value was rejected
(bad IPv4, missing field); relay the `error` and ask again.

## 7. Manual path — the user brings their own VM

When `canProvision` is `false` (provider `manual`), or the user prefers a host
they already have: **start the job first** (section 3), then fetch the boot
script, which needs the job's pairing code to exist.

```bash
curl -s "${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/user-data?provider=manual"
```

Optional query params `domainMode` and `domain` default to the job's own values,
so normally you pass neither. Returns `{ userData, steps, consoleUrl }`.
**409** means no job with a pairing code exists yet — start the job first.

Print `steps` as the checklist and `userData` verbatim in a fenced code block,
telling the user to paste it as the VM's cloud-init / user-data (or run it as
root on the box). This blob is the one thing you handle that contains the
pairing code by design — it has to, that is what lets the box be claimed. Say
that plainly: it is a one-time secret, so it belongs in the VM's user-data
field, not in a chat, a gist, or a ticket.

Then continue from `await-vm`: the job will ask for the VM's public IP
(section 6, `vm-ip`), and from there polling is identical to section 5.

## 8. When it fails (`status: failed`)

Show two things: `job.error` (the actual cause) and the last few `job.logTail`
lines (the evidence). Do not paraphrase the error into something vaguer.

Common causes worth translating: a provider CLI that isn't signed in; a
CloudFormation/quota rejection (the log names it); the box not answering within
its 20-minute budget — for which the log itself points at
`/var/log/walnut-setup.log` on the VM; or a box that is already claimed by
another device, which needs its auth wiped or a redeploy before the code works.

Retry re-runs from the failed step and keeps everything already done:

```bash
curl -s -X POST ${WALNUT_SERVER_URL:-http://localhost:3456}/api/cloud-setup/job/retry
```

**200** `{ job }` → resume polling. **409** means it can't be retried right now
(already running, or already finished). If the user wants to stop instead, use
`POST /api/cloud-setup/job/cancel` (**200**, or **404** if no job exists).

Retry is safe to offer for infrastructure hiccups — steps are idempotent and an
AWS re-deploy converges on the same stack rather than creating a second one. If
the same step fails twice for the same reason, stop retrying and fix the cause.

## 9. Done — and the one step you cannot do

At `status: done`, data sync is live: the Mac's data repo now pushes to the
companion, so tasks and notes appear there automatically. Tell the user the
address (`job.domain`).

**The last step is human-only: pairing the phone requires scanning a QR code.**
Point them at **Settings → Cloud Companion → "Connect your phone"**, which mints
a device credential and shows the QR for the Walnut iOS app. You cannot scan it
for them, and you should not try to mint a device token as a substitute — say
this clearly instead of implying setup is 100% complete.

Then, briefly:

- Costs are running now and are the user's, not Walnut's.
- **Teardown, if they ever want out: revoke the device tokens FIRST**
  (Settings → Phones & Cloud, or `DELETE /api/devices/<name>?target=cloud`), then
  destroy the infrastructure — on AWS `cd infra && npx cdk destroy
  WalnutCloudStack`; on Azure `az group delete -n walnut-cloud` (one command,
  because everything Walnut made lives in that group); on Google Cloud
  `gcloud compute instances delete walnut-cloud --zone <zone>` **plus**
  `gcloud compute addresses delete walnut-cloud-ip --region <region>` — the
  reserved address starts charging once it is no longer attached, so deleting
  only the instance leaves a small ongoing cost; otherwise delete the VM in the
  provider console. Order
  matters: destroying the box first leaves live credentials pointing at an
  address someone else may later be handed. Note the root volume is deliberately
  retained on termination, so it may need deleting separately, and it holds
  their data.
- Reference docs: `docs/reference/cloud-sync.md` (sync + troubleshooting) and
  `infra/README.md` (what the stack contains).

## Reporting back

Be honest about state. Good report: which provider and address, which steps
completed, that sync is verified live, that phone pairing is still pending on
them, and the monthly cost they've taken on. Never claim "fully set up" while
the QR hasn't been scanned, and never report success from a `start` 202 alone —
202 means the job began, not that it worked.
