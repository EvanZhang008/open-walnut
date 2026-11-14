# Incident replays (developer test utilities)

Internal tools for turning a real CLI stream into a test fixture. Not a Walnut feature and not
part of any shipped CLI.

A raw stream (Claude Code `-p --output-format stream-json` stdout plus the daemon's marker
lines) holds the user's real words. It stays on the developer's machine in
`~/.local/state/open-walnut/incident-replays/` (not `~/.open-walnut`, which can be a git data
repo that syncs itself). Only its **shape** (event order, types, control enums,
built-in tool names, id correlations, counters) is committed, as
`tests/fixtures/incident-replays/<name>.shape.jsonl`.

| File | What it does |
|---|---|
| `schema.mjs` | Every event type, system subtype, key and enum value a fixture may hold, and the canonical texts. |
| `shape.mjs` | Convert and validate (imports only `schema.mjs`, loads under node or bun): `toCanonicalShape`, `convertStream`, `createStreamConverter`, `validateStream`, `assertShapeOnly`, `findDuplicateFixtures`, `usageLimitVariant`. |
| `production.ts` | The same conversion with the production readers of an error's words (`DETECTORS`: usage limit, retryable, CLI phrasing, full context, lost conversation, whose failure): `convertRawStream`, `toShapeOnly`, `productionClassifyText`, `replayParity` (fold and line-fate read the converted stream the same, line by line). Use this for raw input. |
| `record.ts` | Copy a recorded stream, or a pipe, into the private directory. Never starts a CLI. |
| `convert.ts` | Raw file to fixture. Refuses to write unless the result validates and `replayParity` holds. |
| `validate.ts` | Check every `*.jsonl` under the fixture directory, at any depth, plus duplicates, symlinks and stray files. |

## Commands

```bash
# 1. Keep a private copy of a stream the daemon already wrote (file 0600, directory 0700).
bun scripts/incident-replay/record.ts --from ~/.open-walnut/tmp/streams/<session-id>.jsonl --name <name>
#    or record what is piped in, passing it through:
<producer> | bun scripts/incident-replay/record.ts --stdin --tee --name <name>

# 2. Convert it to a fixture (add --skip-partials to drop stream_event deltas, --tail <n> for the
#    last n lines, --usage-limit five_hour for the synthetic usage-limit variant, --force to replace).
bun scripts/incident-replay/convert.ts ~/.local/state/open-walnut/incident-replays/<name>.jsonl \
  --out tests/fixtures/incident-replays/<name>.shape.jsonl

# 3. Check every fixture.
bun scripts/incident-replay/validate.ts

# 4. The guard tests (synthetic data; the local tier reads your raw copies in memory, skipped
#    when there are none). In a test container that cannot see that directory, point
#    WALNUT_LOCAL_REPLAYS_DIR at a copy outside the repo.
bun --bun vitest run --config vitest.focus.config.ts tests/core/incident-replay-privacy.test.ts
WALNUT_LOCAL_REPLAYS_DIR=<dir outside the repo> \
  bun --bun vitest run --config vitest.focus.config.ts tests/core/incident-replay-privacy.test.ts
```

## Rules the tools enforce

- The recorder refuses a destination inside any git worktree (checked before it creates
  anything), a symlinked or foreign-owned directory, an existing file and a planted symlink
  (`O_EXCL | O_NOFOLLOW`). It creates the directories on the way one at a time, checking each.
- Conversion is an allowlist. Unlisted keys and enum values are dropped (an enum whose presence
  the code reads falls back to a listed value instead); a line of an unlisted type or subtype, or
  one that is not JSON, becomes a stand-in line with no words. The report counts them, never names
  them. Every free text becomes a placeholder; an empty
  text stays empty. Ids map through one map per file in first-seen order, so correlations hold
  and a converted file converts to the same bytes.
- An error result keeps its meaning as a canonical text: a usage limit per window
  (`USAGE_LIMIT_TEXT`), else the `ERROR_TEXT` every detector reads the same way. The reset time a
  usage-limit text names is not kept.
- Validation never prints the text it rejects: line, masked path and reason only.
- Numbers survive only in listed numeric fields. ISO timestamps move to 2026-01-01 keeping their
  spacing; epoch fields (`scheduledFor`, `resetsAt`) are kept, since the code compares them with now.

To keep a new field, add it to `schema.mjs` with the narrowest kind, then run the guard tests.
