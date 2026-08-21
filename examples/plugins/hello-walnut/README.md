# Hello Walnut: example plugin

A complete, minimal Walnut plugin that exercises three of the four implemented capabilities: an **app page** in the console, a **tool** for the Personal AI, and a **skill** that teaches the AI when to use that tool. It also mounts one plugin HTTP route. It does no task sync at all, which is the point: a plugin only implements what it declares.

Full authoring reference: [docs/reference/plugin-development.md](../../../docs/reference/plugin-development.md).

## What it demonstrates

- **`capabilities` without `sync`**: the manifest declares `ui`, `tools`, and `skills`, so the plugin never calls `registerSync` and the task-sync framework never asks it for anything.
- **`registerTool`**: a `hello` tool that reaches the Personal AI as `hello_walnut_hello` (plugin id + tool name, hyphens become underscores).
- **`registerAgentContext`**: one sentence injected into the AI's system prompt so it knows the tool exists before anyone asks.
- **`registerHttpRoute`**: an express Router serving `GET /api/plugins/hello-walnut/stats`, which reports how many greetings the tool has handed out since the server started.
- **A skill**: `skills/hello-greetings/SKILL.md`, auto-discovered into the AI's skill index.
- **An app page**: `app/` renders in the console inside a sandboxed iframe and talks to Walnut only through the app SDK (server status, five recent tasks, sending a message to the Personal AI, and a live counter of `task:` bus events).
- **Config plus a Settings form**: `configSchema` declares a `greeting` string, `uiHints` gives it a label and help text, and the Settings form is generated from those two.

## Install

The plugin runs **in-process with full privileges**, exactly like Walnut's own code. Installing one is a trust decision, so only install plugins you or someone you trust wrote.

### Option A: Plugin Store (any git repo)

1. Put this directory in a git repo. A manifest at the repo root means "this repo is one plugin"; a manifest in each top-level subdirectory means "this repo ships several".
2. Open **Settings → Plugin Store**, paste the repo URL (or a teammate's share snippet, `{"walnut_plugin_source": "<url>"}`), and add it.
3. Walnut clones the repo with the machine's own git (ssh keys, credential helpers, proxies all apply) and soft-reloads, so a **new** plugin becomes active with no restart.

### Option B: copy the folder

```bash
cp -R examples/plugins/hello-walnut ~/.open-walnut/plugins/hello-walnut
```

Then reload plugins (Settings → Plugin Store → refresh) or restart the server. The directory name does not matter; `manifest.json`'s `id` does.

Nothing else is needed: `greeting` has a default and is not in `configSchema.required`, so the plugin loads immediately with `Hello`. To change it, edit the field in **Settings** or set it by hand:

```yaml
plugins:
  hello-walnut:
    enabled: true
    greeting: Hey
```

## Verify it works

- **Tool**: ask the Personal AI "greet Sam with the hello plugin". It should answer `Hello, Sam!`.
- **Route**: `curl -s http://localhost:3456/api/plugins/hello-walnut/stats` → `{"greetings":1}`.
- **App**: open the plugin's page from the console sidebar; the Server card should show mode and version.
- **Skill**: the skill appears in the console's skill list as `hello-greetings`.

## File tour

| Path | Role |
|---|---|
| `manifest.json` | Identity (`id`, `name`, `version`), declared `capabilities`, `configSchema`, `uiHints`. Read before any code is imported. |
| `index.ts` | Entry point. Default-exports `(api) => …` and registers the tool, agent context, and HTTP route. Zero top-level imports, so it needs no `package.json` and no build step. |
| `app/index.html` | The app page. Loads `/walnut-app-sdk.js` from the host, never a CDN. |
| `app/app.js` | All host interaction: `Walnut.ready`, `Walnut.api`, `Walnut.on`, `Walnut.open`. |
| `app/style.css` | Light and dark styling, switched by `[data-theme]` which `app.js` sets from the theme the host reports. |
| `app/icon.svg` | Sidebar icon, referenced by `capabilities.ui.app.icon`. |
| `skills/hello-greetings/SKILL.md` | Skill with YAML frontmatter (`name`, `description`) plus instructions. |

## Notes worth copying into your own plugin

- **The manifest is the contract.** A plugin declaring only capabilities this Walnut version cannot load is reported as `unsupported` and its code is never imported, so a plugin written for a newer Walnut degrades instead of crashing.
- **Keep `registerAgentContext` to a sentence or two.** It sits in the system prompt on every single turn.
- **Write tool descriptions for the model, not for people.** The description is the only thing deciding whether the tool ever gets called.
- **The app page has no same-origin access.** No cookies, no `localStorage`, no direct `fetch('/api/...')`. Anything the page needs goes through `Walnut.api`, which is also why the example resolves a real `conv-…` conversation id before sending a message instead of assuming an alias.
- **Adding a NEW plugin is live; changing a loaded plugin's code is not.** Editing `index.ts` of an already-loaded plugin needs a server restart (the status becomes `pending-restart`). Editing app files or `SKILL.md` does not need a rebuild of the plugin itself.
