# Plugin AI: one call for plugins and Apps to use the user's AI

## Executive summary

A plugin (server code) or an App (its web entry in the console) calls AI the way it calls any other host API: `walnut.ai.run({ prompt })`. It names no provider, no key, no engine. Walnut runs the request on what the user already set up and decides HOW to run it from what the request says it needs:

- **Direct**: everything the model needs is in the request (a ticket already loaded, an answer to grade). One model call on the user's main provider: on a Claude Code login the existing slim, pre-booted "minimum Claude Code" child (`micro-claude.ts`, about 2 s warm), on a Bedrock or API key the same `sendMessage` call every background helper in Walnut makes.
- **Agent**: the model has to go look or do something (read the ticket's comments, run the tests). A hidden Claude Code session with only the tools the request names, one turn, then it stops.
- **Conversation**: the caller passes a `conversation` key; the next call with the same key continues the same conversation (direct: Walnut replays the history; agent: the same session keeps going, cold-resumed after an idle reap).

The caller can give hints (`needs`, `conversation`, `effort`) but none is required. Engine-native behaviour is untouched: Walnut only picks a route, frames the prompt, sets the engine's own permission controls, and keeps the ledger.

## Architecture

```
 plugin server code          App web code (console)
 walnut.ai.run(req)          walnut.ai.run(req)
        │                           │ POST /api/plugin-runtime/<id>/ai/run
        │                           │ ◀── NDJSON lines: text deltas, then the result
        ▼                           ▼
 ┌──────────────────────── src/core/ai/ai-run.ts (server) ────────────────────┐
 │ gate: plugin AI switch on? monthly budget left? per-plugin concurrency     │
 │ route(req):                                                                │
 │   needs tools / ops / commands / cwd ──▶ AGENT                              │
 │   otherwise                         ──▶ DIRECT                             │
 │ ledger: usage source 'plugin', pluginId, cost                              │
 └───────────────┬───────────────────────────────────────┬────────────────────┘
                 │ DIRECT                                │ AGENT
                 ▼                                       ▼
   claude_cli → runMicroClaude (slim, warm)   runLaneTurn on lane ai:<caller>:<key>|<grant>
   else sendMessageStream (bedrock /          SESSION_START {engine: claude-code, slim,
   anthropic / openai / google / ollama)        mode dontAsk, profile.tools/allowedTools,
   conversation: history kept per caller        cwd, system prompt replaced}
   under local/ai/, replayed                  one-shot: archived after the turn
                                              conversation: lane stays, idle reap, resume
```

## The caller's interface

Same shape on the server (`WalnutServerApi.ai`) and the web (`WalnutWebApi.ai`):

```ts
const result = await walnut.ai.run({
  prompt: 'Summarize this ticket in three bullets.',
  context: ticket,                 // optional: data in hand, framed as data, never as instructions
  system: 'You are a support lead.', // optional
  format: { schema },              // optional: JSON Schema; result.json is parsed and validated
  needs: {                         // optional hints; any of them means "agent"
    ops: ['tickets_get'],          //   Walnut or plugin ops the agent may call
    files: 'read' | 'edit',        //   file access, inside `cwd`
    commands: ['python3 -m pytest'], // command prefixes the agent may run
    cwd: '/abs/folder',
  },
  conversation: 'ticket:T-123',    // optional: same key continues the conversation
  effort: 'quick' | 'normal' | 'deep', // optional: quick = the fast model, deep = the strongest one
  onText: (delta) => {},           // optional: streamed text
  signal,                          // optional: AbortSignal (an App passes its unmount signal)
  timeoutMs,                       // optional: lowers the deadline, never raises it
})
// result: { text, json?, route: 'direct' | 'agent', engine, model?, costUsd?, conversation?, durationMs }
await walnut.ai.end('ticket:T-123') // forget a conversation, stop its session
```

Rule of thumb for authors: if the request carries everything the model needs, send it bare. If the model must go look or act, say what it needs. If it is a back and forth, pass a conversation key.

### Worked example: a ticket summary in a ticket App

| Situation | Call | What Walnut does |
| --- | --- | --- |
| The App already shows the ticket | `run({ prompt: 'Summarize', context: ticket })` | Direct call, a few seconds, no session |
| The App only has an id; comments and linked tickets must be read | `run({ prompt: 'Summarize T-123 with its comments and linked tickets', needs: { ops: ['tickets_get', 'tickets_search'] } })` | Hidden Claude Code session, which calls `walnut tools call tickets.tickets_get …`, answers, stops |
| The user keeps asking about the ticket ("what is blocking it?") | same call plus `conversation: 'ticket:T-123'` | The same session continues with its context; `ai.end` when the ticket closes |

## Permissions and cost

Plugins are trusted code (see the plugin trust model), so there is no per-call approval. What the user gets is visibility and limits:

- **One row per plugin in Settings, Plugins**, once it has used AI: spend this month against its monthly budget (default $10) and an on/off switch. Off or over budget, calls reject with `ai_disabled` / `ai_budget`. Settings live in `config.yaml` under `plugin_ai.<id>`, outside `plugins.<id>`, so a plugin cannot raise its own budget. Spend is this machine's (`local/ai/spend.json`), counted from what each call reports, failed and cancelled runs included.
- **Per call**: 60 s for a direct answer, 10 min for an agent run; a caller may lower these, never raise them. There is no per-turn dollar cap: the budget is checked before each call, and the clock bounds a run.
- **Concurrency**: at most 2 agent runs and 4 direct calls per plugin at once, more wait in line (a cancelled waiter leaves the line). One turn at a time per conversation session. An App's call counts as interactive (a person waits), a server call as background.
- **Tools**: none unless asked; never bypass mode. An agent session is slim: none of the user's or the project's Claude Code settings (`--setting-sources ''`, `--strict-mcp-config`, so their allow rules, hooks and MCP servers do not apply; their env and model aliases do), no Walnut session prompt, the plugin's system prompt replacing the CLI's, mode `dontAsk` (anything not allowed is denied, never asked), and only the tools `needs` names: the named ops (as `walnut tools call <op>`), file reads (and edits for `files: 'edit'`) under `cwd`, the named command prefixes. A conversation keeps one session per grant: a call with other `needs` gets a session of its own, which reads the conversation's turns once.
- **Ledger**: direct calls land in the usage tracker as source `plugin` with agent id `plugin:<id>`; agent turns land as the session's own rows.
- **Phone**: an `ai.run` session never pushes a notification; it answers the app.

## Where the work shows

Hidden: an `ai.run` session is a lane (no task, kept out of the default session lists and the host's session limit, no board row). The plugin's row shows its spend. A plugin that wants the user to see and steer a session keeps using `task_create` + `task_send` (what Interview Practice's AI partner does today); a `show` option that files such a task from `ai.run` is the planned next step, not part of v1.

## Engines

| Route | Uses | Engine-specific part |
| --- | --- | --- |
| Direct | the main provider (`agent.main_provider`, else the Claude Code login, else Bedrock) and its model tier (`agent.fast_model` for quick) | none: `sendMessage` already abstracts the providers |
| Agent | Claude Code, the only engine that can be told "exactly these tools, deny the rest" today; a machine whose default engine is Codex still runs agent jobs on Claude Code when it is installed, else `ai_no_engine` | mapping `needs` onto Codex's sandbox is the next step |

## What already exists, and what this builds on

Walnut already has three ways to make a quick model call. Two of them are the "minimum Claude Code" pattern, and the direct route reuses it.

| Existing piece | What it is | Used by | Speed and cost |
| --- | --- | --- | --- |
| `src/providers/micro-claude.ts` (`runMicroClaude`) | One slim `claude -p` turn: the system prompt REPLACED, `--bare`, `--setting-sources ''`, a neutral tmp cwd, no tools unless named, auth from the CLI's own login plus the env in the user's `settings.json` | the ✦ AI task search | prefix about 133 tokens with no tools, against about 32.5k for a stock child |
| `src/providers/micro-claude-warm.ts` | A pool of ONE pre-booted stream-json child per spec (model, system, tools, effort), single use, replaced right after takeout, reaped after 15 min idle | same, `warm: true` | 4.6 s cold to 2.0 s warm, send to result (2026-08-30 measurement) |
| `src/providers/inline-subagent.ts` | The runner under micro-Claude, also the Personal AI's `create_subagent` tool; at most 3 at once | as named | cold path only |
| `src/model/providers/adapter-claude-cli.ts` | The `claude_cli` provider behind `sendMessage`: `--tools ''`, but NOT slim (the user's settings and context apply), conversations via `--resume`, 3 slots, 120 s per turn | every background helper, `model.fastText` | cold boot every call |

What this changes in the design:

- **Direct route on a Claude Code login runs on micro-Claude, warm.** The plugin's system prompt is the slim child's whole prompt, there are no tools, and one warm child per plugin spec is kept ready, so a repeat call (Grade, then Grade again) answers in about 2 s instead of about 5 s. Other providers (Bedrock, an API key) keep `sendMessage`, which is already the right call there.
- **The agent route stays a real session**, not micro-Claude with tools. micro-Claude runs in bypass mode with only its tool list as the fence: no permission mode, no transcript the user can open, no resume. A lane session has those, and it starts slim (see Permissions), so it does not carry the user's whole coding setup.
- **Every Claude Code process goes through the daemon** (the user's rule, 2026-10-26). Agent sessions already do. micro-Claude, the inline subagent and the `claude_cli` adapter still spawn from the server process; moving them into a lightweight one-shot mode of the daemon is its own task, and `ai.run` follows without changes because it only calls `runMicroClaude`.
- **A direct conversation replays its history** in the prompt (bounded) rather than resuming a CLI session, so it works the same on every provider and a warm child can take it.

## Whose credentials: Walnut has no key of its own

Walnut ships no API key and no model account. Every call goes out on what the user already set up, the same way Walnut's own background work (titles, summaries) does today. Which provider a direct call uses is `resolveMainProviderName` (`src/model/providers/default-provider.ts`): the provider picked in Settings, AI Provider, else the Claude Code login when `claude` is installed, else Bedrock. An agent session is always Claude Code today (see Engines).

| The user has | Direct call runs as | Agent / conversation session runs as | Who is billed |
| --- | --- | --- | --- |
| Claude Code logged in (the common case) | a slim, warm `claude -p` (micro-Claude) with the CLI's own login | a hidden `claude` session, same login | the user's Claude plan or whatever the CLI is set to (it may itself point at Bedrock) |
| Only Codex logged in | `ai_unconfigured` (a Codex route is a later step) | `ai_no_engine` | nobody |
| Bedrock picked in Settings | the Bedrock API with the saved AWS credentials | a hidden `claude` session with the CLI's own login; no `claude` → `ai_no_engine` | the user's AWS account (direct); the engine's account (session) |
| An Anthropic or OpenAI key picked in Settings | that API with the saved key | as above | the user's API account (direct); the engine's account (session) |
| Nothing set up | `ai_unconfigured` | `ai_unconfigured` | nobody: no call leaves the machine |

Every row also lands in Walnut's usage ledger as source `plugin` with the plugin id. That is Walnut's record for the per-plugin budget, not a bill: the money goes to the account in the last column. Subscription logins report a nominal cost, which still counts against the plugin's budget.

`ai_unconfigured` and `ai_no_engine` carry a plain message for the App to show ("No AI is set up in Walnut yet. Open Settings, AI Provider.") and the console already shows its own setup banner in that state. A plugin never sees a credential, only the answer.

## First user: Interview Practice

- **Grade**: direct, `format` with a rubric schema (correctness, complexity, code quality, testing), context = the problem statement, the code and the last test run.
- **Hint**: direct with `conversation: <attempt id>`, so the second hint knows the first.
- **Review with tests**: agent, `needs: { files: 'read', commands: ['python3 -m pytest'], cwd: workspace }`.

## Plan

1. `src/core/ai/`: gate, router, direct route (with history), agent route on a hidden lane via `runLaneTurn`, spend, caps. Server api `ai`; web api `ai` over the plugin runtime's NDJSON route.
2. The plugin's AI row in Settings, Plugins (spend, budget, switch).
3. Tests: router and caps (unit), a real server with a mocked CLI for the agent route, the web route.
4. Interview Practice: Grade, Hint, Review; demo on the live console.
5. Later: a Codex route (direct and agent), a per-turn dollar cap.
