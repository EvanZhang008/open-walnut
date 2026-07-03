---
name: setup-walnut
description: Hands-on setup agent for Open Walnut. Paste into your OWN Claude Code session — it makes Walnut's butler able to talk on first launch. It mirrors however THIS Claude Code is already authenticated (SSO profile, bearer token, or access keys) into Walnut, installs, starts the server, and proves it works with a real model call — fixing auth errors itself and asking you only when it truly can't proceed. Use when a user wants to install or set up Open Walnut.
---

# Set up Open Walnut — we do it for you

**Goal:** make Open Walnut's main agent (the "butler") able to talk on first launch.
You are doing the setup *for* the user. Be **proactive**: do everything you can yourself,
write the config yourself, verify with a real model call yourself, and fix errors yourself.
Ask the user a question **only** when you genuinely cannot proceed without an answer they alone have.

## Two truths that shape this skill

1. **The butler needs a real model credential.** Walnut's main agent calls the model API
   **directly via the SDK** (Bedrock / Anthropic / OpenAI / Google / Ollama). It does **not**
   go through the `claude` CLI and has no OAuth path. So the butler (home-page chat, triage,
   memory, cron) only works once one real credential is resolvable.

2. **Coding sessions already work with zero config.** The `/sessions` Claude Code sessions
   spawn the user's **own logged-in `claude` binary** and use its login — they need *nothing*
   from Walnut's config. So even before the butler has a credential, the user can clone, start,
   and open coding sessions. Tell them this so they're never blocked: *"You can start using
   coding sessions right now; let's also wire up the butler so home-page chat works."*

Walnut resolves the butler's Bedrock credential with this priority:
`~/.open-walnut/config.yaml` → `~/.claude/settings.json` env block → process env → `~/.aws`.
Writing `config.yaml` is the most explicit and portable, so that's what this skill writes.

## Guiding principle: **mirror, don't manufacture**

The cleanest, most reliable credential is **whatever this Claude Code is already using
successfully**. Copy *that exact method* into Walnut. Do **not** mint new IAM users or keys
unless mirroring is impossible — in many managed/corporate accounts `iam:CreateUser` is
blocked by org policy and will just fail. Provisioning is the **last** resort, and even then
you *guide* rather than force.

---

## Step 1 — Detect HOW this Claude Code authenticates, and mirror it

Figure out the method first; the method dictates everything downstream.
**Refer to secrets by name only — never echo their values.**

1. **`~/.claude/settings.json` `env` block** — this is the most likely place a working setup
   lives. Read it and identify the method:

   ```bash
   cat ~/.claude/settings.json 2>/dev/null
   ```

   - `AWS_PROFILE` present → **method = profile** (very common in SSO / corporate setups).
   - `AWS_BEARER_TOKEN_BEDROCK` present → **method = bearer token**.
   - `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` → **method = access keys**.
   - `ANTHROPIC_API_KEY` → **method = Anthropic direct** (not Bedrock).
   - `CLAUDE_CODE_USE_BEDROCK=1` is a strong hint Bedrock is the active provider.

2. **The current shell environment** — same vars may be exported here:

   ```bash
   for v in AWS_PROFILE AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_DEFAULT_REGION \
            AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK; do
     [ -n "${!v}" ] && echo "$v is set"
   done
   ```

3. **`~/.aws`** — enumerate the profiles (names only). If a profile is in play, that's almost
   always the right thing to mirror — it keeps secrets out of Walnut's config and respects SSO:

   ```bash
   grep -E '^\[' ~/.aws/config ~/.aws/credentials 2>/dev/null
   aws sts get-caller-identity 2>/dev/null   # confirms the default/active creds actually work
   ```

**Pick the method to mirror, in this order of preference:**
**profile → bearer token → access keys → Anthropic API key.**
Profile is preferred because it works with SSO, holds no secret in Walnut's file, and refreshes
itself. Resolve the region from `AWS_REGION`/`AWS_DEFAULT_REGION` (or the profile's region),
defaulting to `us-west-2`. Then go to **Step 3**.

If Step 1 finds a usable method → mirror it, skip Step 2.
If it finds **nothing usable** → go to **Step 2**.

---

## Step 2 — Nothing to mirror? Guide the user to a credential (don't manufacture one)

Reaching here means there's no working method on the machine to copy. **Do not silently create
IAM users/keys** — in many accounts that's blocked and it's not your call to make. Instead,
figure out what the user *can* use and guide the smallest path. Ask one short question:

> "I couldn't find an existing credential to reuse. Which do you have access to —
> (a) an AWS account with Bedrock, or (b) an Anthropic API key?"

### (a) AWS Bedrock

- **First check if the default chain already works** (they may have creds without env vars):
  ```bash
  aws sts get-caller-identity        # if this works, you can mirror the default chain / a profile
  ```
  If it works, use a **profile** or the default chain (Step 3) — no new resources needed.

- **If they need a key**, prefer guiding them to **generate one themselves** rather than you
  creating IAM resources:
  - **Bedrock console → API keys** → *Generate short-term* (≤12h, inherits their permissions,
    no IAM user) or *Generate long-term* (stable, but creates an IAM user — may be blocked in
    corporate accounts). Have them paste the resulting key; use it as a **bearer token** in Step 3.
  - Only if the user explicitly asks you to create a long-term key *and* has the rights, you may
    run the AWS CLI to do it — but **stop immediately on `AccessDenied`** and fall back to the
    console-self-serve path above. (Long-term keys are "exploration only" per AWS; a personal
    local butler is an acceptable use, and it can be rotated/revoked later.)

- **Model access is a common real blocker.** Bedrock requires the account to have **model
  access** enabled for Claude models before any call succeeds. If Step 5's test returns
  `AccessDeniedException`, send them to Bedrock console → **Model access** → enable the Claude
  models, then retry. This can't be automated — guide them.

### (b) Anthropic API key

Have them grab a key from the Anthropic console and either export `ANTHROPIC_API_KEY` or paste it;
write the Anthropic variant in Step 3.

> Meanwhile, remind them coding sessions already work with their logged-in `claude` — they're
> not blocked while sorting out the butler credential.

---

## Step 3 — Locate (or clone) the Open Walnut repo

```bash
test -d open-walnut || git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
WALNUT_HOME="${OPEN_WALNUT_HOME:-$HOME/.open-walnut}"
mkdir -p "$WALNUT_HOME"
```

---

## Step 4 — Write the mirrored credential into `~/.open-walnut/config.yaml`

Write **only** a `providers.bedrock` block (Walnut merges it with its other keys). Pick the
variant matching the method you chose. **Merge, don't clobber** an existing file. **Never commit it.**

**Profile (preferred — SSO-safe, no secret in the file):**
```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2          # the resolved region
    aws_profile: <profile name>
```

**Bearer token** (mirrored `AWS_BEARER_TOKEN_BEDROCK`, or a key the user generated):
```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2
    bearer_token: <the token value>
```

**Access keys:**
```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2
    aws_access_key_id: <AWS_ACCESS_KEY_ID>
    aws_secret_access_key: <AWS_SECRET_ACCESS_KEY>
```

**Anthropic direct (no Bedrock):**
```yaml
providers:
  anthropic:
    api: anthropic-messages
    api_key: ${env:ANTHROPIC_API_KEY}   # reference the env var instead of inlining the secret
agent:
  main_provider: anthropic
```

When the credential is an env var or `~/.aws` profile, prefer **referencing** it (`${env:...}` /
`aws_profile`) over inlining a secret.

---

## Step 5 — Install, start, and PROVE it works (real model call)

```bash
npm install        # backend + frontend deps (runs postinstall patches)
npm start          # builds everything, serves http://localhost:3456
```

**The proof is a real round-trip, not just "a credential exists."** Use Walnut's own
test endpoint — it actually calls the model (Haiku, 1 token) with the config you wrote:

```bash
curl -s -X POST http://localhost:3456/api/config/test-connection \
  -H 'content-type: application/json' -d '{}' | python3 -m json.tool
# success → {"ok": true, "authMethod": "...", "latencyMs": ...}
# failure → {"ok": false, "error": "<the real AWS/Anthropic error>"}
```

Cross-check overall health:
```bash
curl -s http://localhost:3456/api/system/health | python3 -m json.tool
# expect "hasReadyProvider": true and "credentialSource": "config"
```

Final confirmation — actually talk to the butler in the UI: open http://localhost:3456 and
type "hello". A real reply is the ground truth that onboarding succeeded.

---

## Step 6 — If it fails, fix it yourself and re-test (the proactive loop)

Don't stop at the first error. Read `error` from `test-connection`, map it, fix it, **edit
`config.yaml` yourself, and call `test-connection` again** — loop until `ok: true`.

| `test-connection` error | Cause | Your fix |
|---|---|---|
| `AccessDeniedException` (on a model) | Model access not enabled in Bedrock | Guide user: Bedrock console → **Model access** → enable Claude → retry |
| `hasReadyProvider:false`, source `none` | Walnut didn't resolve the credential | Re-check `providers.bedrock` exists + valid YAML + region set; re-test |
| `ExpiredTokenException` / `UnrecognizedClientException` | Short-term/SSO token expired, or wrong key | Refresh SSO (`aws sso login`) / regenerate the key; re-test |
| `ValidationException` / model not found | Model not available in that region | Switch `region` (e.g. `us-east-1`/`us-west-2`) where the model is enabled; re-test |
| profile not found / `CredentialsProviderError` | Wrong `aws_profile` name | Re-list `~/.aws/config` profiles, correct the name; re-test |
| Server won't start / build fails | Node version or deps | Node ≥ 22; re-run `npm install`; read and fix the named build error |

Only when a fix needs a value/action solely the user controls (which profile, which region,
enabling model access, refreshing SSO) do you ask **one targeted question** — then apply the
answer and re-test yourself.

---

## Done — report back

- the credential **method + source** you mirrored (by name, never the secret),
- the resolved region,
- that the server is running at http://localhost:3456,
- the `test-connection` `ok:true` + `hasReadyProvider:true` results as proof, and
- the reminder that coding sessions also work (they use their own logged-in `claude`).

Remind them: `~/.open-walnut/config.yaml` may contain a secret — keep it private, never commit it.
