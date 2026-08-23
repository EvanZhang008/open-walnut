# Plugin development

## Start here

A Walnut Plugin is a normal npm project with a `manifest.json` and one or more built artifacts. A single Plugin can add server logic, native React pages, sidebar navigation, Settings, Dashboard panels, Tools, Skills, Commands, Hooks, Cron actions, Agents, Providers, HTTP routes, WebSocket methods, and task sync.

Use the public packages:

```bash
npx --package @open-walnut/plugin-cli walnut-plugin new my-plugin --template both
cd my-plugin
npm install
npm run build
npm run test
npx walnut-plugin link
```

The complete executable example is [examples/plugins/reference-walnut](../../examples/plugins/reference-walnut).

## Trust model

Installing a Plugin means trusting its code. A server entry runs in the Walnut process with full Node privileges. It can read local files, start processes, use the network, and access anything available to the Walnut user. A native web entry runs in Walnut's browser realm and can access the page like any other trusted browser code.

Walnut does not present a granular permission system that full Node or browser code could bypass. The Plugin Store asks for one explicit trust confirmation before install. Install only code you wrote or reviewed, and never install a source that appeared in untrusted content without human confirmation.

A `webview` is different: it is an optional iframe with a narrow `postMessage` bridge. Use it for an external page or content that specifically needs browser isolation. It does not restrict a server entry in the same Plugin.

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
    my-skill/
      SKILL.md
  dist/
    server.mjs
    web.mjs
```

The Plugin Store loads built files. A published npm Plugin must include `manifest.json`, its `dist/` artifacts, and any `skills/` or Webview files it declares. Installation runs with npm lifecycle scripts disabled, so `postinstall`, `prepare`, and similar scripts cannot build the Plugin on the user's machine.

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds a native page and server automation",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": {
    "walnut": ">=0.3.2"
  },
  "server": "dist/server.mjs",
  "web": "dist/web.mjs",
  "webview": {
    "title": "External Console",
    "entry": "app/index.html"
  },
  "build": {
    "server": "src/server.ts",
    "web": "src/web.tsx"
  }
}
```

- **`id`**: Stable lowercase identity. It namespaces registrations, config, storage, secrets, routes, RPC methods, Agents, Commands, and UI state.
- **`name`**: Human label shown in Walnut.
- **`version`**: Plugin release version.
- **`apiVersion`**: Use `1` for the unified API.
- **`engines.walnut`**: Required for API version 1. Walnut rejects an incompatible Plugin before importing code.
- **`server`**: Optional built ESM server entry.
- **`web`**: Optional single-file ESM native web entry.
- **`webview`**: Optional iframe entry. This is not the default UI path.
- **`build`**: Source entries used by `walnut-plugin build`.
- **`configSchema` and `uiHints`**: Optional generated Settings form for `plugins.<id>`.
- **`taskFields`**: Optional task fields for a sync integration.

`capabilities` is descriptive metadata for API version 1. It does not limit trusted code. Legacy manifests without `apiVersion` keep their old capability gates and registration API.

## Server entry

The server module exports `activate(walnut)`. The object is scoped to the current Plugin. Every registration is owned automatically, even when the Plugin ignores the returned `Disposable`.

```ts compile=server
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.registry.tool({
    name: 'status',
    description: 'Read the current state of this Plugin.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const state = await walnut.storage.readJson('state.json', { runs: 0 })
      return { pluginId: walnut.pluginId, state }
    },
  })

  walnut.http.route('GET', '/status', async () => ({
    json: { pluginId: walnut.pluginId, walnutVersion: walnut.walnutVersion },
  }))
}
```

The route above is available at `/api/plugins/my-plugin/status`. New Plugin routes use the fetch-like handler in the public API, not Express internals.

### Server services

| API | Purpose |
|---|---|
| `walnut.tasks` | Read, query, create, update, complete, and delete tasks. |
| `walnut.config` | Read and patch only `plugins.<id>`. Subscribe to changes. |
| `walnut.notifications` | Create notices and report or recover Plugin errors. |
| `walnut.ops` | Call stable host operations not yet represented by a typed service. |
| `walnut.events` | Subscribe to host events and emit namespaced Plugin events. |
| `walnut.http` | Register Plugin routes and make outbound requests with a deadline. |
| `walnut.storage` | Read and write files in the Plugin data directory and use a private SQLite database. |
| `walnut.secrets` | Store Plugin secrets outside synced config. |
| `walnut.timers` | Register timeouts and intervals that stop on disposal. |
| `walnut.registry` | Add Tools, Hooks, Cron actions, Agents, Providers, Commands, Skills, task sync, and related metadata. |
| `walnut.unsafe` | Access unstable raw host objects when no stable API exists. First access logs a warning. |

There is no supported `requireCore(path)`. Private source paths change without notice. Use a typed service, `ops`, events, HTTP, a registry, or `unsafe` instead.

### Registrations

All local ids are validated and namespaced by the host. Tool names use the existing underscore convention because model tool names cannot contain a colon. Other ids normally appear as `<pluginId>:<localId>`.

Common registrations include:

- `tool`: A Personal AI tool with a JSON input schema.
- `hook`: One or more typed session or task hook points.
- `cronAction`: An action that a routine can invoke.
- `wsMethod`: A namespaced browser RPC method.
- `agent`: A runtime Plugin Agent.
- `provider`: A runtime model provider adapter.
- `command`: A namespaced slash command whose content is sent to the Personal AI.
- `skill`: An additional absolute directory containing one or more `SKILL.md` files.
- `agentContext`: A short stable prompt addition. Keep this rare because it is present on every turn.
- `sync`, `sourceClaim`, `display`, `migration`, and `extIndex`: Task integration registration.

A Plugin can also ship a conventional `skills/` directory without calling `registry.skill`. Those skills are discovered after workspace, user, and shipped Walnut skills, so higher-priority local copies can override them.

### Hooks and the idle warning

`onSessionWillReap` runs once per idle episode shortly before Walnut reaps an idle session. It is not a turn-complete event.

```ts
walnut.registry.hook({
  id: 'idle-warning',
  point: 'onSessionWillReap',
  async handler(context) {
    walnut.log.info('session will be reaped', { context })
  },
})
```

Other hook points cover session start, message send, turn start, tool use and result, plan completion, mode changes, turn completion and errors, task changes, and Cron runs. A handler can define filters, priority, and a deadline. One failing Plugin hook does not stop other hooks.

### Storage and secrets

Plugin files live under `~/.open-walnut/plugin-data/<id>/`. This storage is machine-local and excluded from git sync. File methods reject traversal and use atomic writes. The private database runs in a worker so synchronous native SQLite calls do not block Walnut's event loop. Credentials still belong in `walnut.secrets`, not `walnut.storage`.

Secrets are stored separately with restrictive filesystem permissions and are included in Walnut's redaction paths. Do not put tokens in `manifest.json`, source code, synced config, logs, notifications, or task fields.

## Native web entry

A native web entry runs in Walnut's React tree. Import React normally. `walnut-plugin build` rewrites React, ReactDOM, and JSX runtime imports to host shims, so the final module uses Walnut's exact runtime instead of bundling a second React.

```tsx compile=web
import { useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function PluginPage() {
    const [count, setCount] = useState(0)
    return (
      <main>
        <h1>My Plugin</h1>
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Count: {count}
        </button>
      </main>
    )
  }

  walnut.ui.nav({
    id: 'main',
    label: 'My Plugin',
    path: '/plugins/my-plugin',
  })
  walnut.ui.page({
    id: 'main',
    title: 'My Plugin',
    path: '/plugins/my-plugin',
    component: PluginPage,
  })
}
```

Native web contributions include `nav`, `page`, `panel`, `settings`, and owner-scoped CSS. Walnut removes all of them when the Plugin unloads. Each Plugin subtree has an error boundary, so a render failure identifies the Plugin without taking down the host page.

### Stable Views

`walnut.ui.views` provides host-owned React facades:

- `CalendarView`
- `FileView`
- `NoteView`
- `TerminalView`
- `SessionView`
- `TaskView`
- `ChatView`

These are stable contracts, unlike private component imports. `TaskView` accepts the shared task query model and optional instance-scoped persistence. `ChatView` keeps append-only streaming and binds drafts to the Plugin owner, so two instances do not share local state.

### Dashboard panels

Register panels with `walnut.ui.panel`. The built-in Plugin Dashboard persists move and resize state. If a Plugin is missing, Walnut keeps a named placeholder in the saved layout instead of deleting the user's arrangement.

## Optional Webview

A Webview is served from the Plugin's declared static directory and rendered without `allow-same-origin`. It has no shared cookies or `localStorage`, and direct authenticated `/api` calls do not work. Use `/walnut-app-sdk.js` and its `postMessage` bridge for host API calls, events, theme changes, and navigation.

Only the declared static files are served. Dotfiles, traversal, directory listings, and non-read methods are refused. This browser boundary does not apply to a server entry in the same Plugin.

## Lifecycle and cleanup

The lifecycle is `discovered`, `disabled` or `needs-config`, compatibility checks, `activating`, `active`, then `disposing`. Failures become `failed`; repeated activation crashes become `quarantined`.

Every host-created resource enters a reverse-order `DisposableStore`. Disable and reload remove contributions before the module is activated again. A stale `Disposable` cannot remove a newer registration with the same key. Walnut gives asynchronous cleanup a five-second total budget, still invokes remaining owned disposables when that budget expires, and reports the failure without blocking later Plugin mutations. Resources that a Plugin creates outside `walnut.*` remain the author's responsibility.

Set `WALNUT_PLUGIN_SAFE_MODE=1` or start Walnut with `--plugin-safe-mode` to disable external Plugins during recovery. Clear a quarantine only after fixing or updating the Plugin.

## Build and author CLI

| Command | Purpose |
|---|---|
| `walnut-plugin new <id> --template server\|web\|both` | Create a Plugin project. Default: `both`. |
| `walnut-plugin build [--watch]` | Build declared server and web entries. |
| `walnut-plugin dev` | Build, link, and watch during local development. |
| `walnut-plugin link` | Symlink the project into `~/.open-walnut/plugins/`. |
| `walnut-plugin validate` | Validate the manifest and source entry paths. |
| `walnut-plugin status` | Read runtime state for the Plugin. |
| `walnut-plugin test` | Run TypeScript and Plugin validation checks. |
| `walnut-plugin publish-check` | Build, inspect the real npm file list, and reject missing artifacts, common secret files, unresolved imports, and sourcemaps. |

Server builds bundle normal npm dependencies. Node built-ins stay external. Native dependencies require explicit author testing. Web builds are single-file ESM and keep React external through the host shims.

## Install and update

The Settings Plugin Store accepts three source forms:

- A Git URL, with an optional branch or tag.
- A Walnut Git share snippet.
- An npm registry spec such as `my-plugin@1.2.3` or `@scope/my-plugin@stable`.

Git sources record their commit SHA. npm sources record the exact version and integrity from npm's installed-tree receipt. npm installation rejects URLs, filesystem paths, aliases, option-like values, complex ranges, insecure or changed tarball origins, and dependencies installed outside the Plugin root. It installs with `--ignore-scripts`. New code is never updated automatically.

The REST API accepts `{ "url": "...", "ref": "..." }`, a `walnut_plugin_source` share snippet, or `{ "spec": "@scope/my-plugin@1.2.3" }` at `POST /api/plugin-sources`. List, explicit update, check, and remove operations use `/api/plugin-sources/<slug>`.

## Testing before release

Run all author checks before publishing:

```bash
npm run build
npm run test
npx walnut-plugin validate
npx walnut-plugin publish-check
npm pack --dry-run --json
```

Test both activation and disposal. Reload the Plugin several times and confirm that routes, Tools, timers, event listeners, Hooks, Commands, Skills, Agents, Providers, RPC methods, pages, panels, and Settings do not multiply.

For native UI, test real clicks in an isolated Walnut server. Verify the main path, failure boundary, reload, disable, state persistence, and multiple instances of stateful Views.

## Troubleshooting

| State | Meaning | Action |
|---|---|---|
| `active` | The Plugin is running. | None. |
| `needs-config` | A required config field is absent. | Fill the generated Settings form. |
| `unsupported` | API or Walnut engine range is incompatible. | Update Walnut or install a compatible Plugin version. |
| `failed` | Activation threw or timed out. | Read `plugin/<id>` logs and fix the first error. |
| `quarantined` | Repeated activation failed or crashed. | Fix the code, then clear quarantine. |
| `duplicate` | A higher-priority source already owns the id. | Remove one copy or change the id. |
| `pending-restart` | Legacy code changed but cannot be replaced live. | Restart when safe. |

A Plugin that blocks the event loop can freeze every route because trusted code shares the process. Use real asynchronous I/O, workers or child processes for blocking libraries, and deadlines for network calls.

## Legacy compatibility

Legacy manifests and the old `PluginApi` continue to load. Existing iframe APP routes, Git sources, sync integrations, and API response shapes remain supported. New work should use `apiVersion: 1`, `activate(walnut)`, the public SDK, and native web entries.
