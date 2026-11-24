# The Codex engine: your own endpoint, default model

Walnut runs Codex by starting `codex app-server` itself and talking to it directly (see
"How it reaches Codex"; the codex-acp adapter shipped with Walnut is the way back). Two settings in
`config.yaml` under `engines.codex` shape every Codex session Walnut starts. Both are off
until you write them; with neither set, Codex reads its own `~/.codex/config.toml` exactly
as in a terminal.

```yaml
engines:
  codex:
    provider:                      # route Codex through your own OpenAI-compatible endpoint
      base_url: http://127.0.0.1:9000/v1
      name: my-proxy               # optional; the provider id Codex knows it by
      wire_api: responses          # optional; responses (default) or chat
      env_key: MY_PROXY_KEY        # optional; the variable that holds its API key
      model_prefix: vendor.        # optional; see "Model ids on your endpoint"
    model: gpt-example             # optional; default model for a new Codex session
    effort: high                   # optional; default reasoning effort
    transport: app-server          # optional; app-server (default) or acp, see "How it reaches Codex"
```

## Your own endpoint (`provider`)

With `provider` set, every Codex process Walnut starts sends its requests to `base_url`:
sessions on this machine, sessions on your other hosts, and the probe that fills the model
menu (a loopback `base_url` is the exception for other hosts: see "A provider per host"). The provider is handed to Codex as configuration overrides on its command line and in
each thread's configuration (on Windows, in the thread configuration only). Codex ranks both
above `~/.codex/config.toml`, so a host whose
`config.toml` names another provider (for example one that a tool rewrites at every start)
still sends Walnut's sessions to your endpoint.

| Key | Meaning |
|---|---|
| `base_url` | Required. The endpoint, `http://` or `https://`, usually ending in `/v1`. |
| `name` | The provider id, letters, digits, `-` and `_` only. Default `walnut-provider`. Codex's built-in ids (`openai`, `ollama`, `lmstudio`, `oss`) are refused, because Codex would use its own provider of that name instead. |
| `wire_api` | `responses` (default) or `chat`, the API shape the endpoint speaks. |
| `env_key` | The name of the environment variable that holds the endpoint's API key, never the key itself. Without it the endpoint is used with no sign-in. |
| `model_prefix` | A prefix your endpoint's model ids carry that Codex's own model list does not. |

The key named by `env_key` must be in the Codex process's environment on the host where the
session runs. Put it under `engines.codex.env` to have Walnut send it with every start,
including starts on other hosts:

```yaml
engines:
  codex:
    provider:
      base_url: https://llm.example.com/v1
      env_key: MY_PROXY_KEY
    env:
      MY_PROXY_KEY: <your key>
```

A wrong setting (no `base_url`, a name with spaces, an unknown `wire_api`) stops the session
from starting and says which key is wrong, rather than sending the session to another
provider.

## A provider per host (`hosts.<name>.engines.codex.provider`)

A `base_url` on `127.0.0.1`, `localhost` or `::1` names the machine that reads it. Set in this
machine's `config.yaml`, it reaches your proxy only for sessions on this machine; on another host
the same address reaches nothing there. So Walnut decides the provider per host, for every Codex
start, resume, restart and engine switch, on this machine and on the host's own service:

1. the host's own `hosts.<name>.engines.codex.provider`, when you set one (same keys as above);
2. else the global `engines.codex.provider`, except a loopback one on any machine but this one:
   there Walnut passes no provider, and Codex reads that host's own `~/.codex/config.toml`. The
   server log says once per host that the global provider was not used there, and why.

```yaml
engines:
  codex:
    provider:
      name: local-proxy
      base_url: http://127.0.0.1:8402/openai/v1    # this machine's proxy
hosts:
  devbox:
    hostname: devbox.example.com
    engines:
      codex:
        provider:
          name: devbox-proxy
          base_url: http://127.0.0.1:18402/v1    # the proxy on devbox itself
          wire_api: responses
```

A global provider on a non-loopback address (`https://llm.example.com/v1`) still reaches every
host. The host's provider is written in `config.yaml` (or through `PUT /api/config`, like the
global one); the copy a host's own service keeps carries it as its own row, so an older host
reads the rest of its copy as before. An older host's service gets the global provider without a
loopback one, and so uses its own `~/.codex/config.toml`; it does not read a host provider until it
is updated.

## Model ids on your endpoint (`model_prefix`)

Codex lists the models it knows by their plain ids. Some endpoints name the same models with a
prefix, and on such an endpoint the plain id can start a session that has no tools. With
`model_prefix` set, Walnut starts sessions on the prefixed id: the launcher's model menu lists
it, a session started with a plain id (from the menu, `task_create`, `task_start` or an engine
switch) is started on the prefixed one, and the default `model` may be written either way. A
`model` in your own `CODEX_CONFIG` gets the prefix too when it goes to this provider; when your
`CODEX_CONFIG` names another provider, no prefix is added. Which provider a session goes to is
read once from the merged configuration (these settings with your `CODEX_CONFIG` over them, the
one in `engines.codex.env` or, for a session on this machine, the one in the server's own
environment), and the model menu, the start, an engine switch and a resumed session all follow
that one answer.

**The model menu lists only what the endpoint serves.** Codex lists the models it knows, and a
newer Codex knows models your endpoint may not serve yet (2026-11-18: a Codex update listed
`gpt-6.2-sol`, and the endpoint answered every turn 404). With a provider that has a `base_url`,
Walnut reads the endpoint's own `GET <base_url>/models` (a short deadline, cached a minute) and
keeps only the models on it, in the launcher's menu and in a running session's
(src/providers/codex-endpoint-models.ts). An endpoint that does not answer the list, or names
none of Codex's models, leaves the menu as Codex listed it. An engine switch that names a model
the menu does not offer is refused at the switch with the models it does offer (409
`model_not_offered`), instead of starting a session whose first message fails.

With `model_prefix` set, a session always starts on a named, prefixed model, never on whatever
plain id the host's Codex would pick by itself. The model is, in this order: the one the start
names, `engines.codex.model`, the `model` in the host's `~/.codex/config.toml` (prefixed when it
is a plain id), or the first model of the host's Codex list (see the next section). When none of
these exists, the session does not start, and the error names `engines.codex.model` as the
setting to write.

The model a session starts on is given to Codex when the session's thread starts, so it applies
even though Codex's own list does not name it. A session that is already running cannot move to
another model on such an endpoint: Codex's list inside the session holds only the plain ids, so
Walnut refuses the switch rather than moving the session onto an id with no tools. Start a new
session on the model instead.

### Model metadata for those ids

Codex keeps metadata for each model it knows (reasoning levels, context window, instructions,
and how it sends tools). A prefixed id is not one it knows, so on its own Codex would use
fallback metadata and start every reply with "Warning: Model metadata for `<id>` not found". And
the plain id it does know may send its tools in a form only OpenAI's own service reads, which is
how a session on it ends up with no tools on another endpoint.

With `model_prefix` set, Walnut's Codex adapter reads the host's own Codex model list
(`codex debug models`, through your provider), writes it as a catalog under the prefixed ids, and
starts Codex with it (`-c model_catalog_json=<file>`, in the system temp folder). Each entry keeps
the model's metadata, with tools sent as ordinary tools. The adapter first checks that this Codex
loads the file, and starts Codex without it when it does not, so a Codex version with another
catalog format still starts (with the warning). Codex reads `model_catalog_json` only from its
command line, never from a thread's configuration, so a `model_catalog_json` of your own in
`CODEX_CONFIG` is put on the command line the same way and replaces this one.

## Default model and effort (`model`, `effort`)

`model` and `effort` set what a new Codex session starts on when its start names no model.
`model` is a model id as the model menu shows it, without the reasoning level; a
`model: gpt-example[high]` form also works and sets the effort. `effort` is a reasoning level
such as `low`, `medium`, `high` or `xhigh`. The model menu shows this default as the current
choice.

A model picked in the launcher, given to `task_create` or `task_start`, or chosen by an engine
switch always wins over the default.

## Older setups: `CODEX_CONFIG`

Before these settings, the only way was a raw Codex configuration in the adapter's environment:

```yaml
engines:
  codex:
    env:
      CODEX_CONFIG: '{"model_provider":"my-proxy","model_providers":{"my-proxy":{"name":"my-proxy","base_url":"http://127.0.0.1:9000/v1","wire_api":"responses","requires_openai_auth":false}}}'
```

That still works unchanged. When both are set, every key you wrote in `CODEX_CONFIG` wins over
the one these settings build (a provider of the same id is taken from `CODEX_CONFIG` whole), so
`CODEX_CONFIG` is also the place for Codex keys these settings do not cover, such as
`model_context_window`. If you also set `MODEL_PROVIDER` under `env`, it must name the same
provider id.

## How it reaches Codex

```text
config.yaml engines.codex ──► resolveCodexEngine (src/providers/codex-engine-config.ts)
                                   │  merged under engines.codex.env.CODEX_CONFIG
                                   ▼
             adapter env CODEX_CONFIG, built by the server for every start
               │                                           │
   this machine: local daemon                another host: sent with the start (acpStart);
               │                             that host's daemon passes it to the worker as is
               ▼                                           ▼
   the session's worker: `codex -c model_providers.<id>=… -c model_provider=… app-server`
              and the same keys in each thread/start and thread/resume config
```

The model probe builds its configuration through the same function and starts Codex with the
same provider overrides.

### The direct client and the way back

By default the session's worker (src/providers/acp-worker/worker.ts) runs Walnut's own client
for `codex app-server` (src/providers/codex-app-server/). It writes the same journal the
codex-acp adapter's sessions write, so the web and phone apps read both alike. What it does:

- **Steering.** A message sent while Codex works goes to `turn/steer` with the running turn's id.
  If the turn has just ended, the message goes back to the session's queue and is sent once as
  the next turn, with the same message id and no error row. The client never starts a turn of
  its own for a steer. Codex reports each steer it takes as a user message of the turn, and that
  report, not the answer to the steer request, decides that it was taken (and records the
  person's line then, ahead of what answers it), so a late or lost answer never sends the words
  twice. Each input carries its own client id (`clientUserMessageId`, which Codex reports back
  as the item's `clientId`), so another input with the same words is never taken for it; a Codex
  that reports no id is read by the words. A steer Codex takes after the model's last word, and then ends the turn without
  answering, is answered in the same Walnut turn: the client starts one more Codex turn with
  those words (at most two such follow-ups per turn; past that the chat names the words Codex
  left unanswered).
- **Stop.** `turn/interrupt`, and the turn's own end answers it, within 10 seconds. A turn that
  ends as the stop arrives ends there, with no follow-up turn and no plan question, and the chat
  names a steer Codex took but did not answer. A message sent while the stop is on its way goes
  into the next turn. The worker
  and its app-server stay, so the next message starts at once. A turn Codex does not end in
  time, and every restart, tear the worker down as before.
- **Resume.** After a restart of Walnut or of the session daemon, the worker rejoins the thread
  with `thread/resume` by its id, without reading its history back. When Codex says it has no
  copy of the thread ("no rollout found", "thread not found"), the transcript says so and why,
  and a new thread starts. Any other failure (a copy it cannot read, a provider no longer
  configured, a timeout) fails the start with Codex's reason and keeps the thread id, so the next
  message tries again; the error says how many tries are left. Only the third such failure in a row for the same reason starts a new
  thread, and the transcript names the reason and the old thread's id.
- **Failures.** An app-server that exits is seen at once: its turn ends with a runtime error, and
  the next message starts a new one. A failed turn's row is named from Codex's error code:
  usage limit, rate limit (429), overloaded (503), server error, lost connection, context window
  full, or sign-in needed. The rate limit, overload, server error and lost connection rows are
  retried; the usage limit row waits for its reset. Every request has a deadline, and a turn
  that sends nothing for 15 minutes (90 while a command runs; `WALNUT_TURN_STALL_MS` and
  `WALNUT_TURN_STALL_ITEM_MS`, or the older `WALNUT_CODEX_STALL_MS` and
  `WALNUT_CODEX_STALL_ITEM_MS`, change them) is stopped. Codex's own retry notices ("Reconnecting...
  waiting for network", an `error` with `willRetry`) do not count as getting anywhere: a turn that
  keeps retrying for 30 minutes with nothing else (`WALNUT_ENGINE_RETRY_LIMIT_MS`) is stopped too,
  and its row says so in Walnut's words ("Codex could not reach its model at <base_url> for 30
  minutes and Walnut stopped the turn (network error; 28 retries)", the URL left out when it would
  read as a final failure); the session record keeps those words, so the task's status says why. Codex is then asked to end it too, and
  the next message waits for that; a turn Codex does not end in 10 seconds is ended with its
  process. A stop that had to end the process says so in the transcript. The same bound, one policy
  (`src/providers/engine-turn-watch.ts`), covers a turn through any ACP adapter (the worker's
  `acp-worker/adapter-turn-watch.ts`: it cancels the adapter's turn, ends an adapter that does not
  stop with SIGTERM then SIGKILL and waits until it is gone; a message sent meanwhile is refused
  before anything is journaled and goes to a fresh worker). A tool reported by `tool_call` or only by
  `tool_call_update` (pending, in progress) gets the 90-minute limit; thought chunks are progress.
  The retry frames each adapter sends are listed per engine (`ACP_RETRY_SHAPES`, read from the
  adapters' source: codex-acp's `_meta.codex.error.willRetry`, pi-acp's "Retrying (attempt n/m,
  waiting Ns)..." text); Gemini, OpenCode, Goose and DeepSeek Harness have no known retry frame, so
  only the silence limit holds for them. Claude Code's unattended retry mode is bounded by the daemon
  passing `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` (a value the host or the user's Claude Code
  settings set wins). That, like `CLAUDE_CODE_MAX_RETRIES` beside it, is a deliberate exception to
  "Walnut never sets an engine's own defaults": both are safety ceilings on an engine that would
  otherwise retry without end, never a model or behaviour choice.
  `tests/providers/engine-retry-bound.test.ts` fails on an engine, an ACP adapter or a retry signal
  with no bound.
- **Commands left running.** Codex can end its turn while a command it started goes on (a build
  or test run in one of its background terminals), and nothing of Codex's wakes it when that
  command ends. The client asks Codex what still runs at each turn's end
  (`thread/backgroundTerminals/list`) and reports it ahead of the turn's end, so the task stays
  in progress and reads Working ("Its own work goes on after its turn"), and Walnut's idle reap
  leaves the session alone. When such a command ends (Codex sends its `item/completed` late; the
  list is read every 30 seconds in case it does not, `WALNUT_CODEX_BG_POLL_MS`), Walnut sends the
  session a message naming the command, its exit code and the end of its output, and the model
  carries on. A command that ends during a later turn is told at that turn's end, unless that turn
  read the command after it ended. A stop ends these commands too, and a stop (or a stopped
  session) withdraws a wake still on its way. A session
  stopped or a worker gone while one ran hands the task back. src/providers/codex-app-server/background.ts.
- **Plan mode and commands.** The session's Collaboration mode menu (Plan / Default) rides each
  turn as Codex's `collaborationMode`. When a turn in plan mode ends with a plan, the chat asks
  "Implement this plan?"; yes leaves plan mode and Codex implements it in the same turn. A
  mode Codex changes itself (that yes, `/plan`) reaches the menu in every open window and the
  session's stored pick (`config_option_update`, read by `AcpSession`). These
  messages are commands, as they were under the adapter: `/plan` (plan mode on or off),
  `/compact` (Codex's own compaction), `/review [instructions]`, `/review-branch <branch>`,
  `/review-commit <sha>`, `/status`, `/mcp`, `/skills` and `/goal`. `/goal <objective>` replaces
  the thread's goal with that one and runs it: Codex starts one turn after another until the
  model marks it complete, and here they are one turn, so the chat shows them and Stop pauses
  the goal before it interrupts (Codex would start the next turn behind the stop). `/goal
  resume` goes on, `/goal pause` and `/goal clear` answer at once, a bare `/goal` shows it. A
  goal turn Codex starts with no turn open here (a resumed thread goes on with an active goal
  by itself) is paused and interrupted rather than run unseen, and three goal turns in a row
  with the same answer pause it (src/providers/codex-app-server/goal.ts). `/logout` answers how
  to sign out; any other message, `$skill` names included, goes to Codex as written. The
  composer's `/` menu in a Codex session lists these commands (`CODEX_COMMANDS`), never the
  Claude Code skills of its folder. A warning Codex repeats on every turn (a model it has no
  metadata for) is shown once while the session's app-server runs; after a restart it can show
  once more.
- **Versions.** The worker reads `codex --version` at start and refuses a Codex older than the
  oldest supported one (`MIN_CODEX_VERSION` in launch.ts), naming the way back below.
  tests/providers/codex-app-server-schema.test.ts checks the client against the protocol of each
  supported version, kept in tests/fixtures/codex-app-server/; to add one, run
  `codex app-server -c model_provider=<id> generate-ts --experimental --out <dir>`, then
  `bun scripts/codex-protocol-snapshot.mjs <dir> <version>`, then the test.

**Your own Codex config.** The app-server reads the host's own `~/.codex/config.toml` (or
`$CODEX_HOME/config.toml`) as the codex CLI does: the provider and its settings, model, effort,
reasoning summary, approvals reviewer, MCP servers and sign-in. Walnut adds only what you set for
Walnut or picked for the session:

- `engines.codex` (provider, model, effort) and `CODEX_CONFIG`;
- a model or effort picked in the session's menu, from the next turn on;
- the session's MCP mounts, beside yours (a mount with the name of one of yours is left out);
- the session folder marked trusted, so its `AGENTS.md` loads;
- the approval and sandbox policy of the session's permission mode. A start that names no mode
  takes it from `approval_policy` and `sandbox_mode` in `~/.codex/config.toml` on this machine.
  In the Agent mode (workspace write), your `[sandbox_workspace_write]` table (writable roots,
  network access, the temp directory switches) is kept in the sandbox each turn sends.

Codex profiles are a flag of Codex's own commands (`codex --profile <name>`), which
`codex app-server` does not take, so a direct session runs on the base config, as the codex-acp
adapter's did.

To run Codex through the codex-acp adapter instead, set `engines.codex.transport: acp` (copied
to a companion like `model`), or `WALNUT_CODEX_TRANSPORT=acp` in the server's environment, which
wins. Sessions started after the change use it; a running session keeps its worker until it
restarts. A host whose session daemon predates the direct client runs the adapter whatever the
setting says. Only Codex has this setting: every other engine runs its own ACP adapter.

## Sessions started by the companion or a host's server

A Walnut companion (or a host's own server) keeps a copy of this machine's configuration. That
copy carries `engines.<id>.provider` (left out when it is a loopback address, which names this
machine only), `model` and `effort`, and each host's own provider (`host_engines`), never `env`
(it holds API keys) and never `adapter_cmd`. A Codex session the companion starts while it leads uses your provider,
model and effort from that copy, with its own `env`, so the API key named by `env_key` must be
set on the companion (or on the host) as well.

When the companion cannot tell what you set, the session does not start, and the error says why,
rather than letting Codex use the host's own provider:

- the companion holds no copy of this machine's configuration yet;
- this machine runs a Walnut older than copying engine settings;
- the provider was not copied because it holds a credential (a password in `base_url`). Put the
  key under `env_key` instead, so the provider itself carries none.

## Telling Walnut's requests apart (`session.tag_requests`)

A proxy in front of your provider sees every request on the machine, from Walnut's sessions and
from anything else you run. To let it tell them apart, turn on:

```yaml
session:
  tag_requests: true
```

Every session Walnut starts then sends the header `x-walnut-session: <task id>` with each model
request, and `x-walnut-project: <the task's project>` when the task has a project, so a proxy can
route by project too. The project header names the task's project at each start or resume of its
session (a task moved to another project names the new one from its next start). Its value is the
project's name percent-encoded as UTF-8 (JavaScript's `encodeURIComponent`): `Walnut` stays
`Walnut`, `Home Lab` is `Home%20Lab`, and a non-ASCII name arrives as its `%XX` bytes. Decode it
with `decodeURIComponent` or Python's `urllib.parse.unquote`. A task in the Inbox sends no project
header. Both headers go out wherever the session works:

- Claude Code sessions send it through `ANTHROPIC_CUSTOM_HEADERS`. Header lines you set in this
  Mac's `~/.claude/settings.json` are kept beside it. On another host, a value set there in that
  host's own settings is not known to Walnut and is replaced for Walnut's sessions.
- Codex sessions send it through the `http_headers` of the provider their threads use
  (`engines.codex.provider`, or a provider your own `CODEX_CONFIG` defines). Codex's built-in
  providers get no header.
- Other ACP engines (dsh, and any engine on the Anthropic SDK) get the same
  `ANTHROPIC_CUSTOM_HEADERS`, beside any header lines their `engines.<id>.env` sets.
- Walnut's own one-shot calls (titles, summaries, placement, quick answers, inline subagents)
  and the server's own model calls send `x-walnut-session: walnut` and no project header, since
  they belong to no one task.

It is off by default, so nothing extra leaves the machine unless you ask for it.
