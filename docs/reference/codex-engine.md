# The Codex engine: your own endpoint, default model

Walnut runs Codex through the codex-acp adapter (shipped with Walnut). Two settings in
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
```

## Your own endpoint (`provider`)

With `provider` set, every Codex process Walnut starts sends its requests to `base_url`:
sessions on this machine, sessions on your other hosts, and the probe that fills the model
menu. The provider is handed to Codex as configuration overrides on its command line and in
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
   codex-acp: `codex -c model_providers.<id>=… -c model_provider=… app-server`
              and the same keys in each thread/start and thread/resume config
```

The model probe builds its configuration through the same function and starts Codex with the
same provider overrides.

## Sessions started by the companion or a host's server

A Walnut companion (or a host's own server) keeps a copy of this machine's configuration. That
copy carries `engines.<id>.provider`, `model` and `effort`, never `env` (it holds API keys) and
never `adapter_cmd`. A Codex session the companion starts while it leads uses your provider,
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
request, wherever the session works:

- Claude Code sessions send it through `ANTHROPIC_CUSTOM_HEADERS`. Header lines you set in this
  Mac's `~/.claude/settings.json` are kept beside it. On another host, a value set there in that
  host's own settings is not known to Walnut and is replaced for Walnut's sessions.
- Codex sessions send it through the `http_headers` of the provider their threads use
  (`engines.codex.provider`, or a provider your own `CODEX_CONFIG` defines). Codex's built-in
  providers get no header.

It is off by default, so nothing extra leaves the machine unless you ask for it.
