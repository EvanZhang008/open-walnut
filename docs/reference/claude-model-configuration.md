# Claude Model Configuration

Status: verified against Claude Code CLI 2.1.199 and 2.1.205 Bedrock builds
using isolated configuration probes and wire-level captures.

Read this before changing model switching, the model picker, session spawn
models, or organization model restrictions. The current CLI uses a data-driven
model registry; older fork source does not describe this pipeline accurately.

## Model Catalog Pipeline

The `/model` menu, CLI `initialize.models[]`, and Walnut catalog use the same
five layers:

```text
L1 hardcoded model registry
L2 picker-row generation
L3 settings.modelOverrides
L4 settings.availableModels
L5 menu rows / initialize models[] / list_models
```

The registry stores provider IDs, context flags, and capabilities per model
family. Picker-row generation creates rows from that registry;
`supports_1m_suffix` controls whether separate "(1M context)" rows appear.

`settings.modelOverrides` rewrites row values. Its key must exactly match the
canonical model ID or the override is silently ignored.

`settings.availableModels` is only a filter. It can remove generated rows but
cannot add a model.

Menu generation and `set_model` / `--model` validation are separate code paths.
A model missing from the menu can still be switchable.

## Model Identifier Namespaces

| Form | Example | Valid use |
|---|---|---|
| Family alias | `fable`, `haiku` | `--model`, `set_model`, allowlist workaround |
| Canonical ID | `claude-fable-5`, `claude-haiku-4-5-20251001` | Override key |
| Full provider ID | `global.anthropic.claude-fable-5[1m]` | Override value, direct model input, `settings.model` |

Canonical IDs can be dated. A `[1m]`-suffixed canonical ID is not a valid
override key and is silently ignored.

## The `model` Field Trap

When `availableModels` is present, `settings.model` must use a full provider
ID. An alias is resolved to a full provider ID before the allowlist check, but
full IDs do not prefix-match canonical `claude-*` entries. The CLI then silently
falls back to its hardcoded default, observed as Sonnet 4.5, without reporting
an error.

- With an allowlist, use a full provider ID in `settings.model`.
- Without an allowlist, an alias works.
- The Default catalog row's `resolvedModel` is the CLI fallback. It does not
  describe what a session will spawn with when `settings.model` is valid.

A canonical short ID used as model input can pass the allowlist, acknowledge
`set_model`, and appear in `get_settings`, then fail at the provider wire and
silently fall back. The ground truth is the `model` field on assistant messages
or a provider wire capture, never the control acknowledgement alone.

## One-Million-Token Context Flags

Context behavior is registry-level and family-specific:

- `native_1m` means native one-million-token context on the first-party API.
- `native_1m_3p` records third-party support. Sonnet 5 has Bedrock support, so
  its plain provider ID is one million tokens there.
- Fable 5 lacks `native_1m_3p`; its plain Bedrock ID is 200K and the `[1m]`
  suffix is required.
- `supports_1m_suffix` is present on Opus 4.x and Sonnet 4.x families. Fable 5
  and Sonnet 5 lack it, so the CLI menu does not generate a separate 1M row.

For a family whose menu row is missing but whose provider supports the suffix,
map the base canonical key to the full suffixed value:

```json
{
  "modelOverrides": {
    "claude-fable-5": "global.anthropic.claude-fable-5[1m]"
  }
}
```

## Known CLI Problems

1. **Allowlist prefix matching:** alias-valued rows, including the Haiku row,
   resolve to full IDs that do not match canonical allowlist entries. Include
   the bare alias such as `haiku` in `availableModels`.
2. **Silent override-key mismatch:** undated keys for dated models and
   `[1m]`-suffixed keys are ignored without warning.
3. **`enforceAvailableModels`:** every mismatch becomes a hard rejection. Avoid
   it on personal machines unless strict enforcement is required.

These are upstream behaviors to work around, not Walnut validation bugs.

## Settings Rewrites

`~/.claude/settings.json` is not stable. Two independent writers have been
observed replacing it with a stale model template:

1. Distribution wrappers or launchers can write an embedded template on every
   invocation.
2. The CLI's remote flag-settings push can write model configuration after
   startup. Its debug log reports `Programmatic settings change notification
   for flagSettings`.

Every running CLI watches this file and hot-reloads it. One rewrite can change
all live session pickers immediately. The reliable defense is a file watcher
that identifies the clobber signature, such as an enforcement flag or stale
families, and restores the curated configuration.

`ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` override settings and
produce "Custom model" rows. These variables can remain in a long-running
server's process ancestry and propagate to every child CLI. Remove them before
restarting the server. Running CLIs do not reread spawn defaults after a
configuration repair, so respawn affected sessions.

## Walnut Integration

- `ClaudeCodeSession.getModelCatalog()` asks the live CLI through the
  `list_models` control request and falls back to `initialize.models[]`. The
  result is already filtered and override-mapped.
- Catalogs are cached per session and invalidated on teardown, respawn,
  settings read-back mismatch, or an explicit `?refresh=1`.
- `GET /api/sessions/:id/models` returns
  `{source: 'cli' | 'fallback', live, models[]}`. An old or dead CLI uses the
  static `SESSION_MODELS` fallback rather than returning a 5xx response.
- A catalog row's `value`, normally a full provider ID, is the only switch
  string valid across all configuration combinations. Send it unchanged.
- `resolveModelSwitchValue()` is Walnut's shared validator.
- The model picker includes catalog rows and a custom provider-ID input for
  parity with terminal `/model`.
- Verify a switch with settings read-back and the next assistant message's
  `model` field, never only the acknowledgement.

## Debugging

- Probe configuration with an isolated `CLAUDE_CONFIG_DIR` and home directory.
  Run stream-json `initialize`, inspect `models[]`, call `set_model`, and check
  the next assistant message's `model` field.
- CLI debug logs at `~/.claude/debug/<session-id>.txt` show settings reloads,
  flag pushes, and the Bedrock invoke path. Walnut enables `--debug` by
  default.
- If every session's picker breaks at once, compare `settings.json` with the
  curated configuration first. Check `enforceAvailableModels`, stale model
  families, and `ANTHROPIC_*MODEL` variables in the server process.

## References

- [Claude session provider](../../src/providers/claude-code-session.ts)
- [Host model catalog](../../src/core/host-model-catalog.ts)
- [Shared model types](../../src/core/types.ts)
- [Session model routes](../../src/web/routes/sessions.ts)
- [Model picker](../../web/src/components/sessions/ModelPicker.tsx)
