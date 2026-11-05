# The pi engine and "Import from Claude Code"

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is a coding agent Walnut runs
through its ACP adapter (pi-acp, shipped with Walnut), like Codex. A pi session streams, runs tools,
asks permission through Walnut's prompt, survives a server restart, and uses the `walnut` CLI and
skills the same way a Claude Code session does.

## Starting or switching a task on pi

- New work: pick **Pi** in the launcher's engine toggle, or make it the default in Settings →
  Sessions → Default engine.
- An existing task: pick **Pi** on the engine rail of the composer's model picker and close the
  picker; the switch runs at once, stopping a running turn first (op `task_switch_engine`, engine
  `pi`). The new pi session gets the earlier conversation as context, so it carries on where Claude
  Code stopped.
- pi must be installed on the host the task runs on: `npm install -g @earendil-works/pi-coding-agent`.
  MCP servers need pi 0.99 or newer.

## Import from Claude Code

Settings → Sessions → **Pi** → *Import from Claude Code* → **Review…** shows, for the chosen host,
what pi gets from that host's Claude Code setup, then **Import** writes it. Claude Code's files are
only read. The import writes these files in pi's agent folder (`~/.pi/agent`, or
`$PI_CODING_AGENT_DIR`):

| File | What |
|---|---|
| `extensions/walnut-claude-code.ts` | A pi extension that reads Claude Code's files each time pi starts (source: `src/data/pi/walnut-claude-code.ts`) |
| `models.json` | Only when Claude Code uses a gateway (below): the one provider entry `claude-code-gateway`, which Walnut owns and rewrites on every import. Every other provider in the file stays as you wrote it |
| `settings.json` | Only the keys the import names: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `quietStartup` when unset; every other key stays |

Because the extension reads Claude Code's files at every start, nothing is copied: a skill, an MCP
server or a credential change in Claude Code reaches the next pi session with no second import, and
no secret is written into pi's files or Walnut's config.

What the extension brings over:

| Claude Code | In pi |
|---|---|
| `env` in `~/.claude/settings.json` (Bedrock region, endpoint, keys, profile; an Anthropic API key; proxy and CA variables) | The same variables in pi's process, filled only where pi's own environment has none. `ANTHROPIC_BEDROCK_BASE_URL` becomes `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, and an `http://` endpoint (a local proxy) also sets `AWS_BEDROCK_FORCE_HTTP1=1`. An empty inherited `AWS_BEARER_TOKEN_BEDROCK` is removed |
| `model`, `effortLevel` | `defaultProvider` (`claude-code-gateway` when Claude Code uses a gateway, else `amazon-bedrock` or `anthropic`), `defaultModel` (the `[1m]` suffix dropped; `opus`/`sonnet`/`haiku` resolved through `ANTHROPIC_DEFAULT_*_MODEL`), `defaultThinkingLevel` |
| MCP servers: local (`~/.claude.json` projects), approved project `.mcp.json`, user, enabled plugins | Registered with pi as deferred tools. Servers turned off in Claude Code stay off; SSE servers and ones that need a `headersHelper` are listed as left out |
| Skills and commands: `~/.claude/skills`, `~/.claude/commands`, project `.claude/skills` and `.claude/commands`, enabled plugins | pi skills and prompts. `~/.claude/skills` is skipped when `~/.agents/skills` (which pi reads itself) is the same folder |
| `~/.claude/CLAUDE.md`, `~/.claude/rules`, and per folder `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules` | Context files, with `@path` imports followed (5 levels). Rules limited to certain paths are left out. pi reads `AGENTS.md` and `CLAUDE.md` in the working folder on its own |

### When Claude Code goes through a gateway

When Claude Code reaches models through a gateway or proxy of your own, pi goes through the same
gateway and never calls the cloud provider behind it. Claude Code names a gateway with
`ANTHROPIC_BEDROCK_BASE_URL` when it uses Bedrock (`CLAUDE_CODE_USE_BEDROCK`), and with
`ANTHROPIC_BASE_URL` otherwise, in the `env` of `~/.claude/settings.json` or in the host's own
environment. The import then adds this provider to `models.json` and makes it pi's default:

| Field | Value |
|---|---|
| Provider name | `claude-code-gateway` |
| `baseUrl` | The gateway address exactly as Claude Code has it, without a trailing `/` (for example `http://127.0.0.1:9000`) |
| `api` | `bedrock-converse-stream` for `ANTHROPIC_BEDROCK_BASE_URL`: pi calls the Bedrock runtime paths (`/model/<id>/converse-stream`) on the gateway. `anthropic-messages` for `ANTHROPIC_BASE_URL`: pi calls `<baseUrl>/v1/messages`, the same address convention Claude Code uses |
| `apiKey` | The name of the variable Claude Code authenticates with, never its value: `$AWS_BEARER_TOKEN_BEDROCK`, `$ANTHROPIC_API_KEY`, or `$ANTHROPIC_AUTH_TOKEN` (then also `"authHeader": true`, so it goes out as `Authorization: Bearer`). pi reads it from its own environment, which the extension fills from Claude Code's settings. When Claude Code sends the gateway no key (or sets `CLAUDE_CODE_SKIP_BEDROCK_AUTH`), it is the placeholder `claude-code-gateway`, because pi only lists a custom provider that has a key |
| `models` | The model ids Claude Code uses, once each, in this order: its `model` setting or `ANTHROPIC_MODEL` (an alias resolved), `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`. Each has `reasoning: true`, `input: ["text", "image"]`, `maxTokens: 32000`, and `contextWindow` 1,000,000 when Claude Code asks for its `[1m]` variant (the suffix is dropped from the id), else 200,000. A `_NAME` variable (such as `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME`) becomes the model's name. On `anthropic-messages`, current Claude models (Opus 4.6 and later, Sonnet 4.6 and later, Haiku 5, Fable 5) also get `"compat": { "forceAdaptiveThinking": true }` |

pi starts on Claude Code's own model, or on its Sonnet id when Claude Code names none. A gateway
address that is not `http` or `https`, or a gateway with no model id at all, leaves pi's provider
alone, and the preview says why. With no gateway set, nothing changes: pi uses its built-in
`amazon-bedrock` or `anthropic` provider and `models.json` is not touched.

To set up the same thing on another machine by hand, write this into `~/.pi/agent/models.json`
(keep any providers already there) and set `"defaultProvider": "claude-code-gateway"` and a
`defaultModel` from the list in `~/.pi/agent/settings.json`:

```json
{
  "providers": {
    "claude-code-gateway": {
      "name": "Claude Code gateway",
      "baseUrl": "http://127.0.0.1:9000",
      "api": "bedrock-converse-stream",
      "apiKey": "$AWS_BEARER_TOKEN_BEDROCK",
      "models": [
        { "id": "global.anthropic.claude-opus-5-5", "reasoning": true, "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 32000 }
      ]
    }
  }
}
```

Two limits. pi signs requests with AWS keys only on its built-in Bedrock provider, so a gateway
that checks AWS signatures gets a bearer token from pi instead (the preview lists this); give
Claude Code an `AWS_BEARER_TOKEN_BEDROCK` for the gateway, or `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`
when the gateway signs requests itself. And `ANTHROPIC_CUSTOM_MODEL_OPTION` is not carried over:
Claude Code reaches it through the gateway's invoke paths, which a gateway may not serve through
the Converse paths pi uses.

What cannot carry over, and the nearest thing:

| Claude Code | Why | Nearest |
|---|---|---|
| Hooks | pi does not run Claude Code hook commands | A pi extension acts on the same moments |
| Subagents (Task tool, agent definitions) | pi has no subagent tool | A separate Walnut task |
| Permission mode and rules | pi has no allow or deny lists | Walnut's permission prompt, or a pi extension that asks |
| `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` | pi does not run credential helper commands | Static keys or an AWS profile in the environment |
| Status line, output style | Terminal display only | None needed in Walnut |
| An account sign-in (no API key or Bedrock) | pi cannot share Claude Code's sign-in | An Anthropic API key, or `pi /login` |

Turn the extension off for one run with `WALNUT_PI_CLAUDE_CODE=0`.

## Code map

- `src/core/agents/claude-code-import.ts`: the preview and the write (pure collectors run against a
  file transport, so a remote host is read through its daemon).
- `src/core/agents/pi-gateway.ts`: the `claude-code-gateway` provider entry and its `models.json` edit.
- `src/data/pi/walnut-claude-code.ts`: the extension (Node built-ins only; shipped in `dist/data/pi`).
- `src/web/routes/engines.ts`: `GET` and `POST /api/engines/pi/claude-code-import?host=`.
- `src/core/agents/engine-settings/pi.ts`: pi's own settings rows in a session's Engine settings.
- `web/src/components/settings/sections/ClaudeCodeImportGroup.tsx`: the Settings group.

## A caller's identity in an ACP session

An ACP session's `walnut` CLI carries its worker's runtime id (`acp-...`) in `WALNUT_SESSION_ID`,
while the session record is keyed by the engine's own session id. The server maps one to the other
where a caller id enters (`src/core/sessions/acp-caller-sid.ts`: the `/api` middleware and the agent
gateway relay), so a `task_send` from pi names its task, and a task it files is its subtask.
Ratchet: `tests/web/routes/acp-caller-sid.test.ts`.
