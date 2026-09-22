# Jev decisions: a System One backend for Walnut's small judgments

Walnut makes a handful of small structured decisions in the background: which
project a new quick-start session belongs to, which pinned tier a quick-add
note implies. Historically each one was a strict-JSON one-shot on the "fast
model", and on a machine whose only provider is the Claude Code CLI every such
call spawns a whole `claude -p` process (measured 2026-09-17: all 144
quick-parse calls blew their 10s abort, so the feature burned ten seconds per
keystroke and returned nothing; see `agent.quick_parse` in
`src/core/types.ts`).

[Jev](https://docs.typesafe.ai/introduction) (TypeSafe AI) is a decision-only
model: one POST carries a text `state` plus typed questions and returns every
answer in a single forward pass (a choice with per-option probabilities, a
rubric score, or a 0-1 truth value, each with calibrated confidence). No text
generation, no JSON parsing. Measured through a gateway: ~240ms p50 and about
$0.00002 per call ($0.042 per million input tokens; output is free).

Configuring it is optional. Without a `jev:` section every call site keeps its
existing fast-model path, byte for byte.

## Configuration

**Settings > Jev Decisions is the front door.** It stores the key, points the
client at a first-party or gateway endpoint, turns each decision on or off
independently, and round-trips the endpoint with a Test button. Saving a key
there writes the literal to `<walnut-home>/secrets/jev-api.key` (0600) and puts
only a `${file:}` reference in config, so the key never enters the synced file.
Routes: `POST /api/jev/key`, `DELETE /api/jev/key`, `POST /api/jev/test`
(`src/web/routes/jev.ts`); the Test route answers `ok:false` with the status
text rather than an error, because a settings page must always answer.

The same shape is editable by hand:

```yaml
# ~/.open-walnut/config.yaml
jev:
  # Literal, ${env:VAR}, bare ENV_VAR_NAME, or ${file:path}. A ${file:} path
  # MUST live under <walnut-home>/secrets/ (that directory is excluded from
  # git-sync, so the key never rides the synced config; any other path is
  # rejected with a logged warning, because config.yaml is API-writable and an
  # unconfined file reference would be an arbitrary-file read).
  api_key: "${file:~/.open-walnut/secrets/typesafe.key}"

  # Optional. Default is the first-party endpoint. Gateways mirror the
  # request/response shape; set both fields for OpenRouter:
  endpoint: "https://openrouter.ai/api/alpha/decisions"
  model: "typesafe/jev-1.13"          # default: jev-latest (first-party)

  # Optional per-decision opt-outs. Configuring Jev IS the opt-in, so an unset
  # (or absent) toggle means on; `false` returns that ONE call site to its
  # pre-Jev path and the client is never even built for it.
  decisions:
    quick_parse: true                 # quick-add classification
    session_organize: true            # quick-start session auto-filing
```

First-party keys come from the TypeSafe console (early-access waitlist at the
time of writing); OpenRouter resells the model at the same token price with a
few hundred ms of gateway latency on top. `api_key` is masked by config
redaction (bug-report bundles, cloud-mode `GET /api/config`) like every other
provider secret.

## What rides Jev when configured

| Decision | Call site | Question shape | Confidence floor |
|---|---|---|---|
| Quick-start session to project | `src/core/session-organize.ts` | one Choice over existing projects plus an Inbox sentinel | 0.6 (unattended move: "a wrong move is worse than no move") |
| Quick-add note to pinTier / priority / project | `src/core/quick-task-parse.ts` | three Choices (policy tiers, custom tiers, none) in ONE call | 0.5 for tier/priority; 0.4 for project (about 50 options thin the probability mass; benchmarked on 53 real tasks, the lower floor recovered 9 correct picks at the cost of 1 wrong one, and changed nothing on errand-style notes whose confidence is bimodal) |

Rules both sites share:

- **A Jev answer is final; errors fall back.** "Nothing fits" (the
  `none`/Inbox sentinel) and below-the-floor confidence are answers. A
  transport error, a malformed answer, or an answer without a numeric
  confidence field is NOT an answer: those fall back to the old fast-model
  path, with a logged warning, so schema drift can never silently turn a
  feature off.
- **An explicit `modelOverride` bypasses Jev entirely.** A caller that pins a
  model (evals, A/B runs) gets exactly that model's judgment.
- **Jev never generates text.** Task titles, cleaned-up wording, dates, and
  new-project name proposals stay with the LLM parse (or with deterministic
  code). In quick-parse the two run in parallel and Jev's confident answers
  overwrite the LLM's classification fields, including clearing a field the
  LLM claimed when Jev is confident the field does not apply (the LLM
  measurably over-claims `focus`/`wait`).
- **CLI main provider plus Jev configured:** the quick-parse LLM leg is
  skipped outright. The transport is chosen by provider name, so any
  `fast_model` value under a `claude_cli` provider still spawns `claude -p`;
  the spawn never answered in time and only starved the browser's
  six-connection pool. Title stays the raw note, no dates, Jev supplies the
  classification.
- **Tight budgets.** The quick-parse Jev call runs under its own 2.5s ceiling
  (or the caller's `timeoutMs` when tighter), so a degraded endpoint cannot
  pin a browser connection slot behind an already-finished parse.
- **Every call is accounted**: usage source `jev`, priced at $0.042/M input
  and $0 output (`src/core/usage/pricing.ts`), attributed to the task where
  the call site knows it, and visible in the usage dashboard like any other
  spend.
- `agent.quick_parse` remains the opt-in gate for composer parsing; Jev makes
  the feature affordable, it does not turn it on behind your back.

## Adding a new Jev decision

Use `getJevClient(config)` from `src/core/decision/jev-client.ts` (undefined
means not configured: always keep a non-Jev path). Ask one atomic question per
field, put the context in `state` and the option meanings in `criteria`, and
validate answers with `readChoice` (it fails closed on a missing confidence)
against an explicit confidence floor. Let a thrown error or a malformed answer
mean "use the fallback". Do not route generation (titles, summaries, names)
through it, and do not add a Jev opinion to gates with a written decision
record against model judgment (`docs/decision/summarizer-self-report.md`).
