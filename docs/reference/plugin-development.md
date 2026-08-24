# Plugin development

## One command

```bash
npx @open-walnut/plugin-cli new my-plugin --dev
```

That single command is the whole first loop: it scaffolds the project, installs dependencies, validates the manifest, builds the entries, links the directory into `~/.open-walnut/plugins/my-plugin`, asks the running Walnut to discover and load the new plugin, reads the runtime state back, prints the App URL, and then keeps watching so every save rebuilds and reloads. A first link needs no server restart. Walnut may be offline while you work, in which case the link loads on Walnut's next start.

After that first run, the project's own script continues the same loop:

```bash
cd my-plugin
npm run dev
```

Two flags matter: `--no-install` skips `npm install` unconditionally, and `--open` opens the App in a browser once Walnut reports the plugin active (interactive terminals only).

The packages in this repository are not published to the npm registry yet, so the `npx` form above is the post-release author flow rather than something you can install today. Inside this repository, build the packages and skip registry installation while the local CLI owns the watcher:

```bash
npm run build:plugins
node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install
```

For another local-checkout loop, run `node packages/plugin-cli/dist/cli.js dev --root my-plugin`. After the packages are published and installed in the generated project, its own `npm run dev` script is the normal loop.

The complete executable example is [examples/plugins/walnut-demo](../../examples/plugins/walnut-demo), the Walnut Plugin Demo. It registers one Demo App and exercises every public server and web capability, and it is the fastest way to see a working shape before you write your own.

## What a plugin can add

One plugin can contribute any mix of: a native React App in the console, Settings sections, owner-scoped CSS, Tools for the Personal AI, Skills, slash Commands, Hooks, Cron actions, Agents, model Providers, HTTP routes, WebSocket methods, task sync with its display metadata, and its own storage, secrets, and timers.

There is no fixed dashboard, no dashboard page, and no panel grid. The unit of plugin UI is an App.

## Trust model

Installing a plugin means trusting its code. A server entry runs inside the Walnut server process as full Node: it can read local files, start processes, use the network, and reach anything the Walnut user can reach. A native web entry runs inside Walnut's own browser realm and shares the console's React tree, so it can touch the page like any other trusted browser code.

Trust is granted once, at install, through one explicit confirmation. After that the plugin is trusted code, and Walnut does not pretend to hold it back. `server`, `web`, and `webview` are entry points, not permission levels, and `capabilities` in an `apiVersion: 1` manifest is descriptive metadata rather than a gate.

Install only code you wrote or reviewed. Never install a source that arrived inside untrusted content (a web page, an email, a model's suggestion) without a human deciding to trust it.

## Security boundaries

Some boundaries are real and worth relying on. Others read like boundaries and are not, and confusing the two is how a plugin ends up leaking.

Real boundaries:

- **Install consent**: nothing loads until a human confirms the source, and nothing updates itself. Git sources are pinned to a commit SHA, npm sources record the resolved version and integrity, and npm installs run with `--ignore-scripts` so no lifecycle script executes on the user's machine.
- **Owner scoping**: every registration carries its plugin as owner, so disable, reload, and uninstall remove exactly that plugin's contributions and nothing else.
- **Path and id validation**: manifest paths must be safe relative paths, local ids are validated, and host routes and RPC ids are namespaced by plugin id so two plugins cannot collide.
- **Webview isolation**: an optional Webview is an iframe rendered without `allow-same-origin`, with no shared cookies or `localStorage`, and it can only reach the host through the `postMessage` bridge.
- **Static file serving**: only the files under a declared Webview directory are served. Dotfiles, traversal, directory listings, and non-read methods are refused.
- **Secret storage**: `walnut.secrets` writes with restrictive filesystem permissions, stays out of synced config, and is covered by Walnut's log redaction.

Not boundaries, whatever they look like:

- The typed service layer (`walnut.tasks`, `walnut.config`, and friends). It exists for stability and ergonomics. Server code already has full Node access, so a narrow method signature restricts nothing.
- Native web code using `walnut.http.fetch`. Same-origin requests carry the user's device bearer token, so a trusted web entry can call any authenticated `/api/**` route, not only the typed Web API.
- The `webview` entry when the same plugin also ships `server`. The iframe limits the iframe, not the plugin.
- `walnut.unsafe`. It is an explicit escape hatch, and reaching for it logs a warning so a review can see it.

What you still owe the user as an author: validate every input at the boundary, put a deadline on network work, keep request and response bodies bounded, and never block the event loop. Trusted code shares one process with every route, so a synchronous multi-second call in a plugin freezes the whole console.

## Project layout

```text
my-plugin/
  manifest.json
  package.json
  tsconfig.json
  src/
    server.ts
    web.tsx
  skills/
    my-plugin/
      SKILL.md
  dist/
    server.mjs
    web.mjs
```

Walnut loads built files, never your TypeScript sources. A published plugin package must therefore contain `manifest.json`, its `dist/` artifacts, and any `skills/` or Webview files it declares.

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds a native App and server automation",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": {
    "walnut": ">=0.3.2"
  },
  "server": "dist/server.mjs",
  "web": "dist/web.mjs",
  "build": {
    "server": "src/server.ts",
    "web": "src/web.tsx"
  }
}
```

- **`id`**: stable lowercase identity matching `/^[a-z0-9][a-z0-9._-]{0,63}$/`. It namespaces registrations, config, storage, secrets, routes, RPC methods, Agents, Commands, App routes, and UI state.
- **`name`**: the human label Walnut shows.
- **`version`**: the plugin's release version. `publish-check` requires it to equal `package.json`'s version.
- **`apiVersion`**: `1` for the unified API. Anything else is rejected by validation.
- **`engines.walnut`**: required. Walnut checks the range before importing any plugin code.
- **`server`**: optional built ESM server entry.
- **`web`**: optional single-file ESM native web entry.
- **`webview`**: optional iframe entry (`{ "title": "...", "entry": "app/index.html" }`). This is a compatibility path, not the default UI.
- **`build`**: the source entries `walnut-plugin build` compiles, plus an optional `external` list for the server bundle.
- **`configSchema`** and **`uiHints`**: optional generated Settings form for `plugins.<id>`.
- **`taskFields`**: optional task fields for a sync integration.

Legacy manifests without `apiVersion` keep their old capability gates and registration API. New work should use `apiVersion: 1`.

## Server entry

The server module exports `activate(walnut)`. The object it receives is scoped to this plugin, and every registration is owned automatically even when you ignore the returned `Disposable`.

```ts compile=server
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.registry.tool({
    name: 'status',
    description: 'Read the current state of this plugin.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const state = await walnut.storage.readJson('state.json', { runs: 0 })
      return { pluginId: walnut.pluginId, state }
    },
  })

  walnut.http.route('GET', '/status', async () => ({
    json: { pluginId: walnut.pluginId, walnutVersion: walnut.walnutVersion },
  }))

  walnut.registry.wsMethod('run', async (payload) => {
    const input = (payload ?? {}) as { action?: string }
    return { ok: true, action: input.action ?? 'status' }
  })
}
```

That route answers at `/api/plugins/my-plugin/status`. That WebSocket method is namespaced `my-plugin:run` on the wire, and the web API reaches it as `walnut.ws.call('run', payload)`. Plugin routes use the fetch-like handler in the public API, never Express internals.

### Server services

| API | Purpose |
|---|---|
| `walnut.tasks` | Read, query, create, update, complete, and delete tasks. |
| `walnut.config` | Read and patch only `plugins.<id>`, and subscribe to changes. |
| `walnut.notifications` | Raise notices, report plugin errors, and recover from them. |
| `walnut.ops` | Call stable host operations that no typed service covers yet. |
| `walnut.events` | Subscribe to host events and emit namespaced plugin events. |
| `walnut.http` | Register plugin routes and make outbound requests with a deadline. |
| `walnut.storage` | Files in the plugin data directory, plus a private SQLite database. |
| `walnut.secrets` | Credentials, stored outside synced config. |
| `walnut.timers` | Timeouts and intervals that stop on disposal. |
| `walnut.registry` | Tools, Hooks, Cron actions, Agents, Providers, Commands, Skills, task sync, and their metadata. |
| `walnut.log` | The plugin's structured logger, with `child(name)` for subsystems. |
| `walnut.unsafe` | Unstable raw host objects, for when no stable API exists. First access logs a warning. |

There is no supported way to import Walnut's private `src/**` modules. Those paths change without notice. Use a typed service, `ops`, events, HTTP, a registry, or `unsafe`.

### Registrations

Every local id is validated and namespaced by the host. Register a Tool with a local name matching `/^[a-z0-9_]+$/`, such as `status`; Walnut exposes it to the model as `<normalized_plugin_id>_<local_name>`, such as `my_plugin_status`. The host folds punctuation in the Plugin id to underscores and does not add the prefix twice. Other ids surface as `<pluginId>:<localId>`.

- `tool`: a Personal AI tool with a JSON input schema.
- `hook`: one or more typed session or task hook points.
- `cronAction`: an action a routine can invoke.
- `wsMethod`: a namespaced browser RPC method.
- `agent`: a runtime plugin Agent, optionally visible in the console.
- `provider`: a runtime model provider adapter.
- `command`: a namespaced slash command whose `content` is sent to the Personal AI.
- `skill`: an extra absolute directory holding one or more `SKILL.md` files.
- `agentContext`: a short, stable prompt addition. Keep this rare, because it rides every turn.
- `sync`, `sourceClaim`, `display`, `migration`, `extIndex`: task integration registration.

A plugin can also ship a conventional `skills/` directory with no `registry.skill` call at all. Those skills join discovery below workspace, user, and shipped Walnut skills, so a local copy of the same name still wins.

### Hooks

`onSessionWillReap` runs once per idle episode, shortly before Walnut reaps an idle session. It is not a turn-complete event.

```ts compile=hooks
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export function activate(walnut: WalnutServerApi) {
  walnut.registry.hook({
    id: 'idle-warning',
    point: 'onSessionWillReap',
    timeoutMs: 2000,
    filter: { requiresSession: true },
    async handler(context) {
      walnut.log.info('session will be reaped', { context })
    },
  })
}
```

The other points cover session start, message send, turn start, tool use and result, plan completion, mode change, turn completion and error, task created, updated, phase changed and completed, and cron fired. A handler can declare `priority`, a `timeoutMs` deadline, and a `filter` on modes, projects, phases, sources, or a predicate. One failing hook does not stop the others.

## Storage and secrets

```ts compile=storage
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

interface PluginState {
  runs: number
}

export async function activate(walnut: WalnutServerApi) {
  const state = await walnut.storage.updateJson<PluginState>('state.json', { runs: 0 }, (current) => ({
    runs: current.runs + 1,
  }))

  await walnut.storage.database.migrate([
    { version: 1, sql: 'CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL)' },
  ])
  await walnut.storage.database.run('INSERT INTO runs (at) VALUES (:at)', { at: new Date().toISOString() })

  const token = await walnut.secrets.get('api-token')
  if (!token) walnut.log.warn('no api token yet', { keys: await walnut.secrets.keys() })

  const response = await walnut.http.fetch('https://example.com/health', { timeoutMs: 5000 })
  walnut.log.info('probe finished', { ok: response.ok, runs: state.runs })
}
```

Plugin files live under `~/.open-walnut/plugin-data/<id>/`. That directory is machine-local and excluded from git sync. File methods reject traversal and write atomically. The private database runs in a worker, so a synchronous native SQLite call cannot block Walnut's event loop.

Credentials belong in `walnut.secrets`, never in `walnut.storage`, `manifest.json`, source code, synced config, logs, notifications, or task fields. Report key names when you need to show state, never values.

## Native web entry: the App

A native web entry runs inside Walnut's React tree and shares the host's React, ReactDOM, JSX runtime, and theme. Import React normally: `walnut-plugin build` rewrites React, ReactDOM, and JSX runtime imports to host shims, so the built module uses Walnut's exact runtime instead of bundling a second React (two Reacts break hooks and context).

`walnut.ui.app` is the atom. One call gives you a screen and everything around it:

```tsx compile=web-app
import { useState } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function MyIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    )
  }

  function MyApp({ subpath }: AppProps) {
    const [count, setCount] = useState(0)
    return (
      <main className="my-plugin-app">
        <h1>My Plugin</h1>
        <p>Section: {subpath || '/'}</p>
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Clicked {count} times
        </button>
      </main>
    )
  }

  const app = walnut.ui.app({
    id: 'main',
    title: 'My Plugin',
    icon: MyIcon,
    component: MyApp,
    badge: null,
    order: 500,
    fullBleed: true,
  })

  walnut.ui.injectCss('.my-plugin-app { display: grid; gap: 12px; padding: 24px; }')
  walnut.log.info('App mounted', { path: app.path })
}
```

Contribution fields:

- **`id`**: local App id, validated and unique within the plugin. Most plugins register one App and call it `main`.
- **`title`**: the label used in the Sidebar, the window chrome, and the Command Palette entry.
- **`icon`**: optional React component receiving `{ size }`. Walnut falls back to a generic icon, and renders yours inside an error boundary so a broken icon cannot break the Sidebar.
- **`component`**: the App itself, receiving `AppProps`.
- **`badge`**: initial badge, either a non-negative integer, `'dot'`, or `null`.
- **`order`**: sort weight in the Sidebar. Core Apps occupy 10 to 1000, and plugin Apps default to 500.
- **`fullBleed`**: whether the App paints its own full surface. Plugin Apps default to `true`.

What the host derives for you, with no second registration:

- **The route**: `/apps/<pluginId>~<appId>`, plus every subpath under it. You never declare a path, and you cannot collide with a Walnut route or another plugin.
- **The Sidebar entry**: icon, title, badge, and pin state, in the same list as Core Apps.
- **Deep links**: `/apps/my-plugin~main/history?tab=recent` opens your App with the rest of the URL handed to your component.
- **A Command Palette entry**: `Open <title>`, refreshed whenever the App list changes.
- **The badge channel**: `handle.setBadge(...)` updates the Sidebar live.
- **Owner lifecycle**: disable, reload, or uninstall the plugin and the App, its route, its Sidebar entry, and its palette entry all disappear together.

The returned handle is small and complete: `handle.path` is where the host mounted the App, `handle.setBadge(value)` updates the badge, and `handle.dispose()` removes the App early if you want to own that yourself.

### AppProps and deep links

`AppProps` gives your component the route context and nothing else to configure:

| Prop | Meaning |
|---|---|
| `basePath` | Where the host mounted the App, for example `/apps/my-plugin~main`. |
| `subpath` | Everything after `basePath`, starting with `/`, or an empty string at the root. |
| `search` | The raw query string, including the leading `?` when present. |
| `navigate` | Navigate within the console. Relative targets resolve against `basePath`. |

```tsx compile=web-routing
import { useEffect, useState } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function MyApp({ subpath, search, navigate }: AppProps) {
    const [status, setStatus] = useState('loading')
    const tab = subpath.replace(/^\//, '') || 'overview'
    const selected = new URLSearchParams(search).get('id')

    useEffect(() => {
      let live = true
      void walnut.ws
        .call<{ ok: boolean }>('run', { action: 'status' })
        .then((answer) => { if (live) setStatus(answer.ok ? 'ready' : 'error') })
        .catch(() => { if (live) setStatus('offline') })
      return () => { live = false }
    }, [])

    return (
      <main>
        <button type="button" onClick={() => navigate('history')}>History</button>
        <button type="button" onClick={() => navigate('/apps/my-plugin~main')}>Overview</button>
        <p>Tab {tab}, selected {selected ?? 'none'}, server {status}</p>
      </main>
    )
  }

  const app = walnut.ui.app({ id: 'main', title: 'My Plugin', component: MyApp })
  app.setBadge('dot')
}
```

Treat `subpath` as your own router input. Keep it a plain string comparison for a few tabs, and reach for a small switch only when the App really has several screens.

### Badges

A badge is a number, `'dot'`, or `null`. A non-integer or negative number is refused at the call. Set an initial value on the contribution, then move it with the handle as state changes, and clear it with `null` when the user has seen whatever it was counting.

### Settings, CSS, and pages

`walnut.ui.settings` adds a section to the Settings page. `walnut.ui.injectCss` adds an owner-tagged stylesheet that Walnut removes when the plugin unloads. Scope your selectors to a class you own, because the stylesheet is global while it is mounted.

```tsx compile=web-settings
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function MyPluginSettings() {
    return <p>Nothing to configure yet.</p>
  }

  walnut.ui.settings({ id: 'general', label: 'My Plugin', component: MyPluginSettings })
}
```

`walnut.ui.page` still exists for a standalone console route that is not an App, for example a detail page a link points at. It takes an explicit `path`, refuses paths that collide with a Walnut route, and does not appear in the Sidebar or the Command Palette. Prefer an App and its subpaths.

### One App Registry for everything

Core Walnut screens, native plugin Apps, and legacy Webviews are all rows in the same App Registry, so they share one order, one visibility model, one badge shape, and one navigation path. The registry is what the Sidebar, the App host route, the Command Palette, and the Apps section of Settings all read.

The consequences worth knowing as an author: a user can pin, unpin, or hide your App like the hideable Core Apps; your App is reachable by URL, palette, and Sidebar without you wiring any of the three; and your App renders inside its own error boundary, so a render failure names your plugin instead of blanking the console. Home and Settings are recovery surfaces, so Walnut locks their visibility.

Home, Tasks, Notes, Calendar, Routines, and Settings are the Core Apps. Home's Chat, Todo, and Agenda are Dock controls inside Home rather than separate Apps, which is why you will not find them in the App list.

### Stable Views

`walnut.ui.views` hands you host-owned React facades: `CalendarView`, `FileView`, `NoteView`, `TerminalView`, `SessionView`, `TaskView`, and `ChatView`. These are stable contracts, unlike private component imports.

```tsx compile=web-views
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  const { TaskView } = walnut.ui.views

  function TasksApp(_props: AppProps) {
    return (
      <TaskView
        project="My Project"
        query={{ completion: ['todo', 'in_progress'], phases: ['TODO', 'IN_PROGRESS'] }}
        toolbar
        storageKey="my-plugin:tasks"
        onOpenTask={(taskId) => walnut.log.info('open task', { taskId })}
      />
    )
  }

  walnut.ui.app({ id: 'tasks', title: 'My Tasks', component: TasksApp })
}
```

`TaskView` accepts the shared task query model plus optional instance-scoped persistence. `ChatView` keeps append-only streaming and binds drafts to the plugin owner. Give every stateful View instance its own `storageKey` or `draftKey`, otherwise two instances fight over the same local state.

## Optional Webview

A Webview is served from the plugin's declared static directory and rendered without `allow-same-origin`. It has no shared cookies or `localStorage`, and a direct authenticated `/api` call from inside it does not work. Use `/walnut-app-sdk.js` and its `postMessage` bridge for host API calls, events, theme changes, and navigation.

Webviews appear in the same App Registry as native Apps, so they get the same Sidebar entry, route, and palette treatment. Reach for one when you are embedding an external page or content that specifically needs a separate iframe document. The iframe limits that document, but it is not a security boundary for other trusted code in the Plugin and never limits a server entry. Everything else is better as a native App, which shares Walnut's React and theme and needs no bridge.

## Lifecycle and cleanup

Discovery first checks API and Walnut version compatibility, then required config, quarantine, and the user's disabled state. A Plugin that can run moves through `activating` to `active`; an activation error becomes `failed`, and unloading moves through `disposing`. Repeated activation crashes become `quarantined`.

Every host-created resource enters a reverse-order disposable store. Disable and reload remove contributions before the module activates again, and a stale `Disposable` cannot remove a newer registration with the same key. Walnut gives asynchronous cleanup a five-second total budget, still invokes the remaining owned disposables when that budget expires, and reports the failure without blocking later plugin changes.

Anything you create outside `walnut.*` stays your responsibility. Do not assume unloading frees Node's ESM module memory.

Set `WALNUT_PLUGIN_SAFE_MODE=1` or start Walnut with `--plugin-safe-mode` to disable external plugins while recovering. Clear a quarantine only after fixing or updating the plugin.

## The author CLI

| Command | Purpose |
|---|---|
| `walnut-plugin new <id> [--dev] [--no-install] [--open]` | Create a project, and with `--dev` take it live in the same command. |
| `walnut-plugin dev [--open]` | Build, link, load, then rebuild and reload on every change. |
| `walnut-plugin build [--watch]` | Bundle the manifest's entries into `dist/`. |
| `walnut-plugin link` | Symlink the project into `~/.open-walnut/plugins/`, then discover and load it. |
| `walnut-plugin validate` | Check `manifest.json` and its entry paths. |
| `walnut-plugin status` | Print what the running Walnut knows about this plugin. |
| `walnut-plugin test` | Validate, build, then run the project's `plugin:test` script. |
| `walnut-plugin publish-check` | Production build plus the checks a release must pass. |

`new` takes `--template server | web | both`, defaulting to `both`, and `--directory` to place the project somewhere other than a folder named after the id. Every other command takes `--root <path>` and defaults to the current directory.

Server builds bundle ordinary npm dependencies and leave Node built-ins external, so a native dependency needs your own testing. Web builds are single-file ESM and keep React external through the host shims.

`OPEN_WALNUT_API_URL` points the CLI at a local Walnut other than `http://127.0.0.1:3456`, which is what you want against an isolated test server. The CLI does not carry a remote authentication credential, so an authenticated remote deployment rejects these management calls. Every call is bounded, and a miss is reported as `offline` rather than hanging your terminal.

### What the dev loop prints

The loop reports exactly one of three outcomes after each sync, so you never have to guess:

- **`active`**: Walnut loaded the plugin and the App URL is live.
- **`offline`**: nothing answered at the API URL, so the link loads on Walnut's next start.
- **`failed`**: Walnut answered and refused, or the plugin never reached `active`. The line carries the reason.

`active` is read back from `/api/plugin-runtime` rather than inferred from a successful reload call, because a reload can return 200 while the plugin lands in `quarantined`.

## Tests and publish-check

```bash
npm run build
npm test
npx walnut-plugin validate
npx walnut-plugin publish-check
```

`@open-walnut/plugin-api/testing` exports `createFakeWalnut()`, which builds a server API backed by in-memory tasks, config, storage, and secrets, and records the notices, errors, and events your plugin produced. Use it to test `activate` and your handlers without a running Walnut.

Test disposal as carefully as activation. Reload the plugin at least three times and assert that routes, Tools, timers, event listeners, Hooks, Commands, Skills, Agents, Providers, RPC methods, Apps, and Settings sections each end at a count of one.

For native UI, drive real clicks against an isolated Walnut server, never the user's production server. Cover the main path, the error boundary, reload, disable, deep-link entry, badge updates, and two instances of any stateful View.

`publish-check` is a pre-release inspection, not a publish. It runs a production build, requires `manifest.json` and `package.json` to agree on the version, refuses a package marked `private`, then reads the real `npm pack --dry-run --json` file list with lifecycle scripts disabled and fails when a required artifact is missing (`manifest.json`, every build output, declared Webview files, everything under `skills/`) or when the package carries something it should not (`node_modules`, `.env` files, `.npmrc`, `credentials.json`, `secrets.json`, source maps, keys, certificates). The checked-in Demo is intentionally private, so use a scaffolded release package rather than treating the Demo itself as publishable.

`npm pack --dry-run` and `publish-check` both only inspect. Publishing is a separate, deliberate `npm publish` you run when the package is ready.

## Install and update

The Settings Plugin Store accepts three source forms: a Git URL with an optional branch or tag, a Walnut Git share snippet, and an npm registry spec such as `my-plugin@1.2.3` or `@scope/my-plugin@stable`.

Git sources record their commit SHA. npm sources record the exact version and integrity from npm's installed-tree receipt. npm installation rejects URLs, filesystem paths, aliases, option-like values, complex ranges, insecure or changed tarball origins, and dependencies installed outside the plugin root, and it always runs with `--ignore-scripts`. New code is never installed automatically.

The REST API accepts `{ "url": "...", "ref": "..." }`, a `walnut_plugin_source` share snippet, or `{ "spec": "@scope/my-plugin@1.2.3" }` at `POST /api/plugin-sources`. List, explicit update, check, and remove operations use `/api/plugin-sources/<slug>`.

Because Walnut installs with lifecycle scripts disabled, your published package must already contain its built artifacts. A plugin that expects `postinstall` or `prepare` to build it will install and then fail to load.

## Troubleshooting

| State | Meaning | Action |
|---|---|---|
| `active` | The plugin is running. | None. |
| `disabled` | The user disabled the plugin. | Enable it when its code is trusted and ready. |
| `needs-config` | A required config field is missing. | Fill the generated Settings form. |
| `unsupported` | The API version or Walnut engine range is incompatible. | Update Walnut, or install a compatible plugin version. |
| `failed` | Activation threw or timed out. | Read the `plugin/<id>` logs and fix the first error. |
| `quarantined` | Activation failed or crashed repeatedly. | Fix the code, then clear the quarantine. |

The Plugin Store source list has separate source states. `duplicate` means a higher-priority source owns the same id, and `pending-restart` means changed legacy code cannot be replaced live. Neither is a `walnut-plugin status` lifecycle state.

Common author mistakes, and what each one looks like:

- **Two React copies**: hooks throw or context is empty. Build the web entry with the CLI and let it alias React to the host shims.
- **A contribution multiplies across reloads**: it was created outside `walnut.*`. Register through the API, or dispose it yourself.
- **A route 404s**: plugin routes live under `/api/plugins/<plugin-id>/`, and the path you registered is appended to that prefix.
- **A tool never gets called**: register a lowercase local name such as `status`, then describe the host-exposed `<normalized_plugin_id>_status` Tool in one plain sentence.
- **An App does not appear**: the plugin is not `active`. Run `walnut-plugin status` and read the state before touching the UI code.
- **A brand-new link needs a restart**: the running Walnut predates the discover route. Update Walnut, and the first link loads live.
- **The whole console freezes**: something in the server entry blocked the event loop. Move blocking work into real asynchronous I/O, a worker, or a child process, and put a deadline on every network call.

## Legacy compatibility

Legacy manifests and the older `PluginApi` still load, and existing Webview App routes, Git sources, sync integrations, and API response shapes remain supported. New work should use `apiVersion: 1`, `activate(walnut)`, the public packages, and a native App.
