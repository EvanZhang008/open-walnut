# @open-walnut/plugin-api

Type contracts and small runtime shims for writing [Open Walnut](https://github.com/EvanZhang008/open-walnut) plugins. A plugin can add server code (tools, ops, cron actions, hooks, storage, task sync), a native React App in the console, or both.

Full guide: [Plugin development](https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md). To start a project, use [`@open-walnut/plugin-cli`](https://github.com/EvanZhang008/open-walnut/tree/main/packages/plugin-cli).

## Install

```bash
npm install --save-dev @open-walnut/plugin-api
```

The package is ESM only and needs Node 22 or newer. `react` is an optional peer: install it (matching the host's major version, 19) only if your plugin ships web UI.

This package lives in the Open Walnut repository and is not on the npm registry yet, so the install line above is the shape a release will use. Inside a checkout, run `npm run build:plugins`, then `node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install`; the local CLI can build and watch that project without fetching the unpublished package.

## Entry points

| Import | Use |
| --- | --- |
| `@open-walnut/plugin-api` | everything below, re-exported |
| `@open-walnut/plugin-api/server` | `WalnutServerApi` and the server-side contracts |
| `@open-walnut/plugin-api/web` | `WalnutWebApi`, `AppProps`, UI contribution types, `defineWebPlugin` |
| `@open-walnut/plugin-api/testing` | `createFakeWalnut()` for testing a plugin without a running Walnut |
| `@open-walnut/plugin-api/react` | React shim: resolves to the host's React at runtime |
| `@open-walnut/plugin-api/react-dom` | React DOM shim |
| `@open-walnut/plugin-api/jsx-runtime` | JSX runtime shim |
| `@open-walnut/plugin-api/jsx-dev-runtime` | JSX dev runtime shim |

The four shims exist so a web plugin shares ONE React instance with the host instead of bundling its own (two Reacts break hooks and context). Write ordinary `import { useState } from 'react'`, and `walnut-plugin build` rewrites it to the shim for you.

## Server plugin

```ts
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.registry.tool({
    name: 'ping',
    description: 'Answer with pong.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { reply: 'pong' }
    },
  })

  walnut.registry.wsMethod('run', async (payload) => ({ ok: true, payload }))
  walnut.http.route('GET', '/status', async () => ({ json: { pluginId: walnut.pluginId } }))
}
```

Walnut exposes that local `ping` registration to the model as `my_plugin_ping`. Tool local names must match `/^[a-z0-9_]+$/`; the host normalizes and prefixes the Plugin id automatically.

### Server API

| Member | Purpose |
| --- | --- |
| `walnut.tasks` | read, query, create, update, complete, delete tasks |
| `walnut.config` | read and patch `plugins.<id>`, subscribe to changes |
| `walnut.notifications` | raise notices, report plugin errors, recover |
| `walnut.ops` | call stable host operations with no typed service yet |
| `walnut.events` | subscribe to host events, emit namespaced plugin events |
| `walnut.http` | `route(method, path, handler)` and `fetch(url, init)` with a deadline |
| `walnut.storage` | JSON and text files in the plugin data directory, plus a private SQLite `database` |
| `walnut.secrets` | credentials, kept out of synced config |
| `walnut.timers` | timeouts and intervals that stop on disposal |
| `walnut.registry` | `tool`, `hook`, `cronAction`, `wsMethod`, `agent`, `provider`, `command`, `skill`, `agentContext`, `sync`, `sourceClaim`, `display`, `migration`, `extIndex` |
| `walnut.log` | structured logger, with `child(name)` |
| `walnut.unsafe` | unstable raw host objects; first access logs a warning |

## Web plugin

One `ui.app` call is the whole browser surface. The host derives the route `/apps/<pluginId>~<appId>`, the Sidebar entry, deep links into every subpath, the App Command Palette entry, and the badge channel.

```tsx
import { useState } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function MyApp({ subpath, navigate }: AppProps) {
    const [count, setCount] = useState(0)
    return (
      <main>
        <p>Section {subpath || '/'}</p>
        <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
        <button onClick={() => navigate('history')}>History</button>
      </main>
    )
  }

  const app = walnut.ui.app({ id: 'main', title: 'My Plugin', component: MyApp })
  app.setBadge('dot')
}
```

### Web API

| Member | Purpose |
| --- | --- |
| `walnut.ui.app(contribution)` | register an App; returns a handle with `path`, `setBadge(value)`, `dispose()` |
| `walnut.ui.settings(contribution)` | add a section to the Settings page |
| `walnut.ui.injectCss(css)` | add an owner-tagged stylesheet, removed on unload |
| `walnut.ui.page(contribution)` | a standalone console route that is not an App |
| `walnut.ui.views` | `CalendarView`, `FileView`, `NoteView`, `TerminalView`, `SessionView`, `TaskView`, `ChatView` |
| `walnut.ws.call(id, payload)` | call the plugin's own `registry.wsMethod` |
| `walnut.http.fetch(url, init)` | same-origin requests carry this browser's credentials |
| `walnut.events` | subscribe to host events, emit namespaced plugin events |
| `walnut.ops` | call stable host operations |
| `walnut.unsafe` | the host's React, registries, and `document` |

`AppContribution` takes `{ id, title, icon, component, badge, order, fullBleed }`, and the component receives `AppProps` (`basePath`, `subpath`, `search`, `navigate`). A badge is a non-negative integer, `'dot'`, or `null`.

Everything a plugin receives is scoped to that plugin and torn down when it unloads, so a reload leaves no stray listeners, routes, Apps, or Settings sections behind.

## License

MIT. See [LICENSE](./LICENSE).
