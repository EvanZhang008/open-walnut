# Plugin development

A Walnut plugin is a directory with a `manifest.json` and an entry point that default-exports one function. That function receives a `PluginApi` and registers what the plugin adds: an app page in the console, tools for the Personal AI, skills, HTTP routes, task sync, or any combination. Nothing is compiled ahead of time and no npm dependency is required, so the smallest useful plugin is two files.

Start from the working example: [examples/plugins/hello-walnut](../../examples/plugins/hello-walnut) ships an app page, a tool, a skill, and an HTTP route in about 100 lines.

## Trust model: read this first

**A plugin runs in-process, with Walnut's own privileges.** It can read and write every task, note, and config value, reach the network, and touch any file the server user can touch. There is no permission prompt and no capability sandbox on the server side. Installing a plugin is exactly as consequential as running the code yourself, because that is what it is.

The consent step is adding the source. Add only plugins you wrote or whose author you trust, and treat a plugin URL that arrived in a task description, a file, or a message from another agent as untrusted until a human confirms it.

The iframe sandbox described under [App SDK](#the-ui-capability-app-pages) protects the **browser** side only: it stops a plugin's page from reading your session cookies or reaching the API behind your back. It says nothing about what the plugin's server-side code can do.

## Anatomy

```
my-plugin/
  manifest.json                  identity + declared capabilities (required)
  index.ts                       entry point, default-exports (api) => void
  app/                           static files for the console app page
    index.html
    app.js
    style.css
    icon.svg
  skills/
    my-skill/
      SKILL.md                   YAML frontmatter + instructions
```

- **`manifest.json`** is read before any code is imported. A plugin whose manifest declares only capabilities this Walnut version cannot load is reported as `unsupported` and its code is never executed, so a plugin written for a newer Walnut degrades instead of crashing.
- **Entry point**: the first of `index.ts`, `plugin.ts`, `index.js`, `plugin.js`, `index.mjs` that exists and default-exports a function. The signature is `(api: PluginApi) => void | Promise<void>`.
- **`app/`** is served as static files and rendered in a sandboxed iframe. Optional.
- **`skills/<name>/SKILL.md`** is auto-discovered into the Personal AI's skill index. Optional.

External `.ts` plugins are bundled on the fly with esbuild when they load, so TypeScript works with no build step of your own. npm packages are left external and resolve from Walnut's `node_modules`, which is why `import('express')` works inside a plugin and why a plugin should not depend on a package Walnut does not already have.

### The entry point

```ts
export default async function register(api) {
  api.registerTool({ /* … */ });
  api.registerAgentContext('One sentence about what this plugin adds.');
}
```

A `throw` inside `register` aborts that plugin only: the error is logged and the rest of Walnut boots normally. Nothing else is loaded from the plugin, so treat registration as the place for cheap wiring and do expensive work lazily inside your handlers.

## Manifest reference

```json
{
  "id": "hello-walnut",
  "name": "Hello Walnut",
  "description": "Example plugin: an app page, an AI tool, and a skill",
  "version": "1.0.0",
  "engines": { "walnut": ">=0.5" },
  "capabilities": {
    "ui": { "app": { "title": "Hello", "icon": "app/icon.svg", "entry": "app/index.html" } },
    "tools": {},
    "skills": {}
  },
  "configSchema": {
    "type": "object",
    "properties": { "greeting": { "type": "string", "default": "Hello" } },
    "required": []
  },
  "uiHints": { "greeting": { "label": "Greeting", "help": "Text the hello tool responds with." } }
}
```

- **`id`** (required): the plugin's identity everywhere. It keys `config.yaml` (`plugins.<id>`), prefixes tool names and HTTP routes, and is the value written into `Task.source` by a sync plugin. Lowercase with hyphens. The directory name is irrelevant.
- **`name`** (required): human label in Settings and the console.
- **`description`**: one line, shown in Settings and the Plugin Store.
- **`version`**: informational string, shown in the UI. Not compared against anything.
- **`engines.walnut`**: advisory in v1. It is parsed and kept but never enforced, so do not rely on it to gate a plugin; declare capabilities instead, which the loader does enforce.
- **`capabilities`**: what the plugin implements (next section).
- **`configSchema`**: a small JSON-Schema subset (`type`, `properties`, `required`, `items`, `enum`) validating `plugins.<id>` from `config.yaml`. Type mismatches are logged as warnings and do not block loading; a **missing `required` field does** block it, and the plugin is reported as `needs-config` with the exact missing keys.
- **`uiHints.<key>.label` / `.help`**: labels and help text for the generated Settings form. Write `help` as the answer to "where do I find this value", because that string is what a human or an agent reads when a required field is empty.
- **`taskFields`**: extra per-task fields the console renders generically, for sync plugins. Each entry is `{ key, label, type: 'enum', optionsRoute, clearable?, coreField? }`. `optionsRoute` is one of your own plugin routes (relative to `/api/plugins/<id>`) returning `{ options: [{ value, label?, hint? }], current?: string | null }`, fetched lazily when the picker opens and never cached. Values are stored at `task.ext.<id>.<key>` unless `coreField: 'sprint'` binds the existing core column. Invalid entries are dropped with a warning rather than unloading the plugin.

### Capabilities

`capabilities` declares what the plugin does, so Walnut knows what to expect from it and can refuse cleanly what it cannot support.

| Capability | Status | Meaning |
|---|---|---|
| `sync` | implemented | Task sync with an external system. Requires `registerSync`. |
| `ui` | implemented | An app page in the console (`ui.app`). |
| `tools` | implemented | Tools for the Personal AI, via `registerTool`. |
| `skills` | implemented | Skills under `skills/`, auto-discovered. |
| `hooks` | reserved | Not implemented. |
| `routines` | reserved | Not implemented. |

Four rules matter:

- **Absent `capabilities` means `{ sync: {} }`.** Every manifest written before capabilities existed is a sync plugin, and keeps loading unchanged.
- **A plugin that declares only `ui`, `tools`, or `skills` must NOT call `registerSync`.** It loads normally with status `loaded`, never participates in task sync, and is never asked to push or pull anything. Only a plugin declaring `sync` (explicitly, or by omitting `capabilities`) has to provide a sync implementation.
- **`unsupported` means the manifest declares ONLY reserved capabilities** (today `hooks` and/or `routines`). A manifest mixing a reserved capability with an implemented one loads, and the reserved key is ignored.
- **A capability you do not declare is inert.** Declaring `tools` is what makes `registerTool` work: without it the calls are logged and ignored. Same for `ui` and `skills`.

`ui.app` fields: `title` (sidebar label), `icon` (path inside the plugin directory), `entry` (the HTML file to load). `entry` defaults to `index.html`, and may be written either `index.html` or `app/index.html`: both resolve to the same file, since everything is served out of `app/`. `icon` follows the same rule.

## PluginApi reference

Every method is called during registration. The exact types live in [`src/core/integration-types.ts`](../../src/core/integration-types.ts).

| Member | Signature | Consumed by |
|---|---|---|
| `id` | `string` | The manifest id. Use it to build your own route paths and ext keys. |
| `name` | `string` | The manifest name. |
| `config` | `Record<string, unknown>` | `plugins.<id>` from `config.yaml`, minus `enabled`. Read at load time: a config change triggers a reload rather than mutating this object. |
| `logger` | `SubsystemLogger` | Structured logs tagged `plugin/<id>`, landing in the normal server log. |
| `registerTool(tool)` | `{ name, description, input_schema, execute }` | The Personal AI's tool set (next section). |
| `registerAgentContext(snippet)` | `(snippet: string) => void` | Injected into the Personal AI's system prompt. One or two sentences: this text is present on every turn, so it costs context every single time. |
| `registerHttpRoute(route)` | `{ method, path, handler }` | Mounted at `/api/plugins/<id><path>` (see [HTTP routes](#http-routes)). |
| `registerSync(sync)` | `IntegrationSync` | The task sync framework. Sync plugins only, and at most once. |
| `registerSourceClaim(fn, opts?)` | `(project: string) => boolean \| Promise<boolean>` | Decides which projects this plugin owns. Never called for the Inbox (`''`), which is structurally unclaimable. `opts.priority` breaks ties. |
| `registerDisplay(meta)` | `DisplayMeta` | Task-card badge, badge color, external link label and URL, synced state, tooltip, optional `languageHint`. |
| `registerMigration(fn)` | `(tasks: Task[]) => Task[] \| Promise<Task[]>` | Run once after load, over the whole task store. For moving legacy fields into `task.ext.<id>`. |
| `registerExtIndex(spec)` | `{ source, paths: [{ key, json }] }` | Opens SQLite indexes over `task.ext` so sync ticks look up by remote id in O(log N). `spec.source` must equal the plugin id; `key` matches `[a-z0-9_]+`; `json` is a `json_extract` path starting `$.` or `$[`. At most once. |

`IntegrationSync` (the sync capability) is a wide, strictly-required interface: task lifecycle, per-field updates, `pushTask` returning the remote's own timestamp for echo detection, `syncPoll`, plus optional `fullPull`/`extractRemoteId` for reconciliation and `renameProjectRemote`/`deleteProjectRemote` for container operations. It is documented in place in `src/core/integration-types.ts`, which is the source of truth. If you are writing a sync plugin, read that file and the built-in plugins under `src/integrations/` before designing anything.

## The tools capability

```ts
api.registerTool({
  name: 'hello',
  description:
    'Greet someone by name using the configured greeting. Use it when the user asks for a greeting demo.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Who to greet. Defaults to "world".' } },
  },
  execute(params) {
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'world';
    return `Hello, ${name}!`;
  },
});
```

- **Declare `capabilities.tools`** or every `registerTool` call is logged and ignored.
- **`name` must match `/^[a-z0-9_]+$/`.** Anything else fails the plugin's load, so no hyphens and no capitals in a tool name.
- **Naming**: the tool reaches the model as `<pluginId>_<name>`, with the plugin id lowercased and every character outside `[a-z0-9_]` folded to `_`. Plugin `hello-walnut` plus tool `hello` becomes `hello_walnut_hello`. A name that already carries the prefix is left alone rather than doubled. The prefix is not optional and not yours to change: it is what keeps two plugins from colliding, and what lets a human reading a transcript tell where a tool came from.
- **`description` is the routing logic.** It is the only thing the model sees when deciding whether to call the tool. Say what it does and when to use it, in that order. A vague description means the tool is never called; an over-eager one means it is called constantly. Truncated at 1024 characters.
- **`input_schema`** is JSON Schema, the same shape Walnut's built-in tools use. Keep it small and describe each property: the model reads those descriptions too.
- **`execute(params, meta?)`** receives the parsed params and returns what the model sees. Returning a **string is the normal case**. For an image or several blocks, return the block-array form instead: `[{ type: 'text', text }]` and `[{ type: 'image', source: { type: 'base64', media_type, data } }]`. `meta` carries `{ toolUseId?, source? }`, where `source` is the invoking turn's origin, so a call made by an unattended background turn is distinguishable from one the user asked for.
- **Return a useful error string rather than throwing** when the failure is expected (a missing record, a remote that said no). A throw is caught and reported to the model as an error, which is right for a genuine bug and noisy for anything else.
- **At most 24 tools per plugin.** If you need more, the plugin is really several plugins, or one tool with a mode parameter.
- **Read-only paths do not get plugin tools.** Notification-only agent turns (triage and similar) run against a fixed read-only allowlist of built-in tools, so a plugin tool is never called from those paths. Design for the interactive Personal AI.
- **Keep `execute` honest about time.** It runs on the server's single event loop like everything else, so a synchronous multi-second call there stalls every route. Await real async work, and put a deadline on anything reaching the network.

## The ui capability: app pages

Static files under `<pluginDir>/app/` are served at `/plugin-apps/<pluginId>/app/…` and rendered in the console in a **sandboxed iframe with no same-origin access**. The frame is created as:

```html
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals"
        allow="clipboard-read; clipboard-write" src="…"></iframe>
```

The absence of `allow-same-origin` is the whole point. Concretely, inside the page:

- there are no Walnut cookies and no `localStorage` shared with the console,
- `fetch('/api/v1/tasks')` does not work,
- and the ONLY channel to Walnut is the app SDK.

A plugin page is untrusted browser code from the console's point of view, so it asks the host to make calls on its behalf instead of making them itself.

**Only `app/` is ever served.** Plugin code, `manifest.json`, and config files are unreachable over HTTP, there are no directory listings, dotfiles inside `app/` are refused, and only GET and HEAD are answered (anything else is a 405). So `app/` is the plugin's public surface and nothing else is.

To list the installed apps, read `GET /api/apps` → `[{ id, pluginId, title, icon, url }]`. The `url` is server-owned and opaque: use it as given, never assemble the path yourself.

```
┌───────────────────────────────┐        ┌──────────────────────┐        ┌─────────────┐
│ plugin app (sandboxed iframe) │        │ host console (SPA)   │        │ Walnut REST │
│  /plugin-apps/<id>/app/…      │        │  same-origin, authed │        │  /api/…     │
│                               │        │                      │        │             │
│  Walnut.api('GET', path) ─────┼──post──┤─ bridge: validate ───┼──fetch─┤─▶ response  │
│  Walnut.on('task:', cb)  ◀────┼─message┤◀ bus events forwarded│        │             │
│  Walnut.open('/tasks')   ─────┼──post──┤─ SPA navigation      │        │             │
└───────────────────────────────┘        └──────────────────────┘        └─────────────┘
```

### SDK

Load it from the host (never from a CDN, so the page keeps working offline):

```html
<script src="/walnut-app-sdk.js"></script>
```

| Call | Purpose |
|---|---|
| `Walnut.ready(cb)` | Runs `cb({ appId, pluginId, theme })` once the bridge is live. Do all setup here, not on `DOMContentLoaded`: before this fires there is no channel. `theme` is `'light'` or `'dark'`, so mirror it instead of guessing from `prefers-color-scheme`. |
| `Walnut.api(method, path, body?)` | Promise resolving to the parsed response body, for example `Walnut.api('GET', '/api/v1/tasks')` or `Walnut.api('POST', '/api/v1/conversations/<conv-id>/messages', { text: 'hi' })`. Non-2xx rejects, so wrap calls in `try`/`catch` and show something useful. Validated, not unrestricted: see below. |
| `Walnut.on(prefix, cb)` | Subscribes to live event-bus frames whose name starts with `prefix`, a SINGLE string. `'task:'` covers `task:created`, `task:updated`, `task:completed`, `task:deleted`, `task:phase-changed`. `cb` receives `{ name, data }`. Returns an unsubscribe function. To watch several prefixes, call it several times. |
| `Walnut.open(path)` | Navigates the HOST console (`Walnut.open('/tasks')`). This is how an app hands the user back to the real UI instead of rebuilding it. |

**What `Walnut.api` will and will not do.** The host validates every call before making it: the path must be a string starting with `/api/`, must contain no `..` segments, and the method must be one of GET, POST, PUT, PATCH, DELETE. One carve-out on top of that: **non-GET requests to `/api/config` and `/api/config/*` are refused** ("config writes are not available to plugin apps, use Settings"). Reading config is allowed.

Calls ride the **host's own credential**, so they carry whatever auth the user's session has and an app never sees or holds a token. That is also why the rules above are the real boundary: within them, an app acts as the signed-in user.

Pick real endpoints out of the [frozen API v1 contract](api-v1.md), which documents every path, body, and status code. Two shapes that bite people:

- **Sending a message needs a real conversation id.** v1 conversation ids match `conv-…`; there is no `main` alias on that path. Read `GET /api/v1/conversations?limit=1` and use the first id, or `POST /api/v1/conversations` when the box has none yet. Then `POST /api/v1/conversations/<id>/messages { text }` answers `202 { turnId }`, and `409 turn_active` when a turn is already running on that conversation.
- **The task list is a projection.** `GET /api/v1/tasks` answers `{ tasks, syncedAt }` where each task is the slim `ProjectedTask` shape (no `description`), scoped to open tasks plus the last 14 days of completions.

### The postMessage protocol underneath

The SDK is a thin wrapper over `window.postMessage`. An author who would rather not load it can speak the protocol directly. Frames from the app to the host:

| Type | Payload | Meaning |
|---|---|---|
| `walnut:ready` | none | "I am listening." Send it once, on load. |
| `walnut:api` | `{ id, method, path, body? }` | Ask the host to make a REST call. `id` is yours to mint and correlate. |
| `walnut:subscribe` | `{ prefixes: string[] }` | Start receiving bus events matching any of the prefixes. Note the plural: the WIRE format takes an array, even though `Walnut.on` takes one prefix per call. |
| `walnut:open` | `{ path }` | Navigate the host console. |

Frames from the host to the app:

| Type | Payload | Meaning |
|---|---|---|
| `walnut:init` | `{ payload: { appId, pluginId, theme } }` | The bridge is live. This is what `Walnut.ready` waits for. Note the nested `payload`. |
| `walnut:api-result` | `{ id, ok, status?, data?, error? }` | The answer to one `walnut:api`. Match on `id`: results can arrive out of order. |
| `walnut:event` | `{ name, data }` | A bus event matching one of your subscriptions. |

There is **no theme-change frame**: `theme` arrives once, in `walnut:init`.

`walnut:subscribe` is a full replacement, not an addition: the SDK keeps its own listener list and resends every registered prefix in ONE frame whenever a listener is added or removed. So the cap of 16 applies to **distinct prefixes across the whole app**, not per call, and it is the complete set that gets truncated when you go over.

Validate the origin of every frame you receive and ignore anything unexpected, exactly as you would for any `postMessage` listener. The SDK does this for you, which is the main reason to use it.

## The skills capability

Drop a skill at `<pluginDir>/skills/<skill-name>/SKILL.md`:

```markdown
---
name: hello-greetings
description: Greet someone using the Hello Walnut plugin's tool. Use when the user asks for a greeting demo.
---

# Hello greetings

When the user asks for a greeting, call the `hello_walnut_hello` tool with the person's name and report what it returns verbatim.
```

`name` and `description` are required frontmatter; the body is instructions. Declare `capabilities.skills` or the directory is not scanned. Plugin skills join the Personal AI's skill index at the **lowest priority**, so a workspace skill or a user skill in `~/.open-walnut/skills/` with the same directory name wins. That ordering is the point: a plugin ships a sensible default, and the user can override it without editing the plugin.

The most useful thing a plugin skill does is explain **when** to reach for the plugin's tools, which a tool description alone cannot always carry.

## HTTP routes

```ts
const { Router } = await import('express');
const stats = Router();
stats.get('/', (_req, res) => res.json({ greetings }));
api.registerHttpRoute({ method: 'get', path: '/stats', handler: stats });
```

- `handler` is an **express Router**, not a bare handler function. It is mounted with `router.use()`, so a router path of `/` serves the registered path exactly.
- The mount point is `/api/plugins/<pluginId><path>`. The example above answers `GET /api/plugins/hello-walnut/stats`.
- Routes are mounted after all plugins load, and re-mounting is idempotent per plugin id, so the Plugin Store's soft reload does not stack duplicate routes.
- Your routes sit behind the same auth as the rest of `/api`, but they are **your** responsibility for everything else: validate input, bound your work, and never block the event loop. A synchronous multi-second call in a plugin route freezes every route in the server, not just yours.
- `taskFields.optionsRoute` is served by exactly this mechanism.

## Config and the Settings form

Config lives in `config.yaml` under `plugins.<id>`:

```yaml
plugins:
  hello-walnut:
    enabled: true
    greeting: Hey
```

- **`enabled: false` skips the plugin entirely.** Everything else is passed to your `register` function as `api.config` (minus `enabled`).
- The **Settings form is generated** from `configSchema` plus `uiHints`: one field per property, labeled and explained by the hints. There is no plugin-authored form UI, which is why the hints are worth writing carefully.
- Saving config triggers a soft reload, so a `needs-config` plugin becomes `loaded` without a restart once its required fields are filled.
- Anything secret (an API token, a password) belongs in config, never in the plugin's source. A plugin repo is shared; a config file is not.

## Lifecycle

Discovery order, first plugin with a given id wins:

1. **Built-in**: `src/integrations/` in dev, `dist/integrations/` in production. The `local` plugin loads first and can never be disabled.
2. **User-installed**: `~/.open-walnut/plugins/<id>/`.
3. **Plugin Store clones**: `~/.open-walnut/plugin-stores/<slug>/`.

So a hand-installed plugin shadows a store copy of the same id, and a built-in shadows both. The shadowed copy is reported as `duplicate` rather than silently ignored.

Load sequence per plugin: read `manifest.json` → check `enabled` → check capabilities (unsupported ones stop here, before any code is imported) → validate config against `configSchema` (missing required fields stop here) → import the entry point (bundling `.ts` on the fly) → call the default export → validate what it registered → register into the registry. After all plugins load: mount HTTP routes, open declared ext indexes, run migrations.

**Soft reload adds NEW plugins live; it never replaces loaded code.** Adding a source, updating a source, or saving config re-runs discovery additively. An already-loaded plugin keeps running its in-memory code until the server restarts, so editing a loaded plugin's `index.ts` shows up as `pending-restart` and the responses that caused it carry `restartRequired: true`. App files and `SKILL.md` are read on demand and are not subject to this.

## Distribution

Any git repo works as a plugin source. Two layouts are recognized:

- `manifest.json` at the repo **root**: the repo is one plugin.
- `manifest.json` in each **top-level subdirectory**: the repo ships several plugins.

Install through Settings → Plugin Store by pasting the repo URL, optionally with a branch or tag as `ref`. Cloning uses the machine's own git, so ssh keys, credential helpers, and proxies all apply, and any remote your shell can clone works. There is no auto-pull: updates are an explicit action and the current commit SHA is shown in the UI, so remote code changes stay visible and attributable.

To hand a source to a teammate, copy the **share snippet**, a one-line JSON blob they paste into the same input:

```json
{"walnut_plugin_source": "https://githost.example.com/team/acme-plugins.git"}
```

```json
{"walnut_plugin_source": {"url": "https://githost.example.com/team/acme-plugins.git", "ref": "main"}}
```

Both forms are accepted (a bare string, or an object with `url` and optional `ref`). A URL that embeds credentials gets **no** share snippet, because sharing it would leak the credential. The Personal AI can drive all of this through the REST API rather than the UI: see the shipped `install-plugin` skill.

## Troubleshooting

Plugin status comes from `GET /api/plugin-sources` (and the Plugin Store panel):

| Status | Meaning | Fix |
|---|---|---|
| `loaded` | Active now. | Nothing. |
| `needs-config` | Valid, but `configSchema.required` fields are empty. | Fill them in Settings; the `missing` array names them and `uiHints.<key>.help` says where to find each value. Saving reloads automatically. |
| `unsupported` | The manifest declares only capabilities this Walnut cannot load (today: `hooks`, `routines`). | Update Walnut, or declare a capability that exists. The plugin's code was never imported. |
| `duplicate` | Another plugin with the same id loaded first. | Remove one copy, or change the id. Discovery order decides the winner: built-in, then `~/.open-walnut/plugins/`, then store clones. |
| `error` | `manifest.json` is unreadable, invalid JSON, or missing `id`. | Read the `error` field; it names the parse failure. |
| `pending-restart` | The plugin is on disk but absent from every load outcome, meaning its code changed after it was loaded. | Restart the server. |

Failures that are NOT a status, and where to look:

- **Loaded, but nothing happens**: the entry point had no default export, or the default export was not a function. The loader logs which candidate filenames it tried.
- **A sync plugin loads and then disappears from the registry**: it declared `sync` (explicitly or by omitting `capabilities`) but never called `registerSync`. Either implement sync or declare only the capabilities you actually provide.
- **`registerSync` or `registerExtIndex` called twice**: both throw. One call each, per plugin.
- **The plugin loads but its tools, app, or skills are missing**: the matching capability is not declared. `registerTool` without `capabilities.tools` is logged and ignored, and `skills/` is not scanned without `capabilities.skills`.
- **The plugin fails to load right after adding a tool**: a tool `name` outside `/^[a-z0-9_]+$/` (a hyphen or a capital is the usual culprit), or more than 24 tools.
- **The tool never gets called**: check the name the model sees (`<pluginId>_<name>`, non-`[a-z0-9_]` folded to `_`) and rewrite the description to say when to use it. Also confirm you are testing the interactive Personal AI, not a notification-only path, which uses a read-only built-in allowlist.
- **The app page is blank or its calls fail**: the page has no same-origin access, so a direct `fetch('/api/…')` or a `localStorage` read fails by design. Move everything to `Walnut.api`, and put setup inside `Walnut.ready` rather than on `DOMContentLoaded`.
- **One specific app call is refused while others work**: the bridge validated it away. A path not starting with `/api/`, a `..` segment, an exotic method, or a **write to `/api/config`** (Settings only). Reads of config are fine.
- **A file in the plugin returns 404 to the app**: only `app/` is served. Move the asset under `app/`, and note that dotfiles there are refused and only GET/HEAD are answered.
- **Everything in the server got slow when the plugin loaded**: a plugin route or a registration path is blocking the event loop. All routes share one loop; do work in a child process or behind a deadline.

All plugin logs are tagged `plugin/<id>` in the normal server log, and loader decisions (skipped, unsupported, missing config, duplicate) are logged with the reason, so the log is usually faster than guessing.
