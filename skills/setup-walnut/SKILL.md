---
name: setup-walnut
description: One-shot setup for Open Walnut. Paste into your OWN already-authenticated Claude Code session — it copies the exact Bedrock/Anthropic credentials this Claude Code is already using into ~/.open-walnut/config.yaml, installs dependencies, and starts the Walnut server. Use when a user wants to install or set up Open Walnut and already has Claude Code working.
---

# Set up Open Walnut from this Claude Code's working credentials

**Goal:** make Open Walnut's main agent (the "butler") able to talk on first launch by
reusing the *exact* credential this Claude Code session is already authenticated with —
no guessing, no asking the user to paste a key. Then install dependencies and start the server.

Open Walnut's butler calls the model API **directly via the SDK** (it does not need the
`claude` CLI for the butler — the CLI only powers optional coding sessions). So setup =
"put one working credential where Walnut can resolve it."

Walnut resolves Bedrock credentials with this priority:
`~/.open-walnut/config.yaml` → `~/.claude/settings.json` env block → process env → `~/.aws`.
Writing `config.yaml` is the most explicit and portable, so that's what this skill does.

---

## Step 1 — Discover the credential THIS Claude Code is using

Inspect, in order, and pick the first that yields a usable Bedrock (or Anthropic) credential.
**Do not print secret values back to the user** — refer to them by name only.

1. **`~/.claude/settings.json` `env` block** — read it and look for any of:
   - `AWS_BEARER_TOKEN_BEDROCK` (Bedrock bearer token — Identity Center/SSO)
   - `AWS_PROFILE` (+ `AWS_REGION` / `AWS_DEFAULT_REGION`)
   - `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
   - `ANTHROPIC_API_KEY` (direct Anthropic, not Bedrock)
   - `CLAUDE_CODE_USE_BEDROCK` (a hint that Bedrock is the active provider)

   ```bash
   cat ~/.claude/settings.json 2>/dev/null
   ```

2. **The current shell environment** — the same vars may be exported here:

   ```bash
   # Presence check only — never echo the values
   for v in AWS_BEARER_TOKEN_BEDROCK AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION \
            AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK; do
     [ -n "${!v}" ] && echo "$v is set"
   done
   ```

3. **`~/.aws`** — if `~/.aws/credentials` or `~/.aws/config` exists, the AWS default
   credential chain (or a named profile) can be used:

   ```bash
   ls -1 ~/.aws/ 2>/dev/null
   grep -E '^\[' ~/.aws/config ~/.aws/credentials 2>/dev/null   # profile names only
   ```

Choose the **highest-priority** credential found. Prefer, in this order:
**bearer token → access keys → profile → default AWS chain (`~/.aws` present)**.
Resolve the region from `AWS_REGION`/`AWS_DEFAULT_REGION` (or a profile's region), defaulting to `us-west-2`.

> If you find **nothing**, stop and tell the user: they need Bedrock or Anthropic access
> first — point them to the in-app "AI Provider" settings or GETTING_STARTED.md. Do not invent a key.

---

## Step 2 — Locate (or clone) the Open Walnut repo

```bash
# If already cloned, cd into it. Otherwise clone it.
test -d open-walnut || git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
```

Resolve `OPEN_WALNUT_HOME` (defaults to `~/.open-walnut`) and ensure it exists:

```bash
WALNUT_HOME="${OPEN_WALNUT_HOME:-$HOME/.open-walnut}"
mkdir -p "$WALNUT_HOME"
```

---

## Step 3 — Write the credential into `~/.open-walnut/config.yaml`

Write **only** a `providers.bedrock` block (Walnut merges it with its other config keys).
Pick the variant matching what you found in Step 1. **Never commit this file; it holds secrets.**

**Bearer token:**
```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2            # the resolved region
    bearer_token: <the AWS_BEARER_TOKEN_BEDROCK value>
```

**AWS profile** (preferred when SSO/credential_process is in play — keeps secrets out of the file):
```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2
    aws_profile: <profile name>
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

**Important — merge, don't clobber.** If `config.yaml` already exists, read it first and
merge the `providers` (and optional `agent.main_provider`) keys in, preserving everything else.
A safe way is to use Walnut's own config endpoint after the server is up (Step 5), or edit the
YAML carefully by hand. When the credential is an env var or `~/.aws` profile, prefer referencing
it (`${env:...}` / `aws_profile`) over inlining the secret.

---

## Step 4 — Install dependencies

```bash
npm install        # installs backend + frontend deps (runs postinstall patches)
```

---

## Step 5 — Start the server and verify

```bash
npm start          # builds everything, serves http://localhost:3456
```

Then verify the butler can authenticate. Two ways:

- **UI:** open http://localhost:3456 and type "hello" — a reply means the credential works.
- **API (scriptable):**
  ```bash
  curl -s http://localhost:3456/api/system/health | python3 -m json.tool
  ```
  Expect `"hasReadyProvider": true` and a `"credentialSource"` that is **not** `"none"`
  (it will be `"config"` since you wrote config.yaml). If it's `false`, re-check Step 1/3.

If you want a no-token sanity check of the credential before spending tokens, hit the
Settings test endpoint:
```bash
curl -s -X POST http://localhost:3456/api/config/test-connection \
  -H 'content-type: application/json' -d '{}' | python3 -m json.tool
# {"ok": true, "authMethod": "...", "latencyMs": ...}
```

---

## Done

Report to the user:
- which credential **source** + **method** you used (by name, never the secret),
- the resolved region,
- that the server is running at http://localhost:3456,
- and the `hasReadyProvider`/`credentialSource` health result as proof it works.

Remind them: `~/.open-walnut/config.yaml` may contain a secret — keep it private, never commit it.
