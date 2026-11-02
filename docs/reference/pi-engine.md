# The pi engine and "Import from Claude Code"

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is a coding agent Walnut runs
through its ACP adapter (pi-acp, shipped with Walnut), like Codex. A pi session streams, runs tools,
asks permission through Walnut's prompt, survives a server restart, and uses the `walnut` CLI and
skills the same way a Claude Code session does.

## Starting or switching a task on pi

- New work: pick **Pi** in the launcher's engine toggle, or make it the default in Settings →
  Sessions → Default engine.
- An existing task: the session menu's engine switch (op `task_switch_engine`, engine `pi`). The new
  pi session gets the earlier conversation as context, so it carries on where Claude Code stopped.
- pi must be installed on the host the task runs on: `npm install -g @earendil-works/pi-coding-agent`.
  MCP servers need pi 0.99 or newer.

## Import from Claude Code

Settings → Sessions → **Pi** → *Import from Claude Code* → **Review…** shows, for the chosen host,
what pi gets from that host's Claude Code setup, then **Import** writes it. Claude Code's files are
only read. The import writes two files in pi's agent folder (`~/.pi/agent`, or
`$PI_CODING_AGENT_DIR`):

| File | What |
|---|---|
| `extensions/walnut-claude-code.ts` | A pi extension that reads Claude Code's files each time pi starts (source: `src/data/pi/walnut-claude-code.ts`) |
| `settings.json` | Only the keys the import names: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `quietStartup` when unset; every other key stays |

Because the extension reads Claude Code's files at every start, nothing is copied: a skill, an MCP
server or a credential change in Claude Code reaches the next pi session with no second import, and
no secret is written into pi's files or Walnut's config.

What the extension brings over:

| Claude Code | In pi |
|---|---|
| `env` in `~/.claude/settings.json` (Bedrock region, endpoint, keys, profile; an Anthropic API key; proxy and CA variables) | The same variables in pi's process, filled only where pi's own environment has none. `ANTHROPIC_BEDROCK_BASE_URL` becomes `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, and an `http://` endpoint (a local proxy) also sets `AWS_BEDROCK_FORCE_HTTP1=1`. An empty inherited `AWS_BEARER_TOKEN_BEDROCK` is removed |
| `model`, `effortLevel` | `defaultProvider` (`amazon-bedrock` or `anthropic`), `defaultModel` (the `[1m]` suffix dropped; `opus`/`sonnet`/`haiku` resolved through `ANTHROPIC_DEFAULT_*_MODEL`), `defaultThinkingLevel` |
| MCP servers: local (`~/.claude.json` projects), approved project `.mcp.json`, user, enabled plugins | Registered with pi as deferred tools. Servers turned off in Claude Code stay off; SSE servers and ones that need a `headersHelper` are listed as left out |
| Skills and commands: `~/.claude/skills`, `~/.claude/commands`, project `.claude/skills` and `.claude/commands`, enabled plugins | pi skills and prompts. `~/.claude/skills` is skipped when `~/.agents/skills` (which pi reads itself) is the same folder |
| `~/.claude/CLAUDE.md`, `~/.claude/rules`, and per folder `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules` | Context files, with `@path` imports followed (5 levels). Rules limited to certain paths are left out. pi reads `AGENTS.md` and `CLAUDE.md` in the working folder on its own |

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
