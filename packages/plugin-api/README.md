# @open-walnut/plugin-api

Type contracts and small runtime shims for writing [Open Walnut](https://github.com/EvanZhang008/open-walnut) plugins. A plugin can add server code (tools, ops, cron actions, hooks, storage), native web UI (nav items, pages, panels, settings), or both.

Full guide: [Plugin development](https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md). To start a project, use [`@open-walnut/plugin-cli`](https://www.npmjs.com/package/@open-walnut/plugin-cli) (`npx @open-walnut/plugin-cli new my-plugin`).

## Install

```bash
npm install --save-dev @open-walnut/plugin-api
```

The package is ESM only and needs Node 22 or newer. `react` is an optional peer: install it (with the host's major version, 19) only if your plugin ships web UI.

## Entry points

| Import | Use |
| --- | --- |
| `@open-walnut/plugin-api` | everything below, re-exported |
| `@open-walnut/plugin-api/server` | `WalnutServerApi` and the server-side contracts |
| `@open-walnut/plugin-api/web` | `WalnutWebApi`, UI contribution types, `defineWebPlugin` |
| `@open-walnut/plugin-api/testing` | helpers for testing a plugin without a running Walnut |
| `@open-walnut/plugin-api/react` | React shim: resolves to the host's React at runtime |
| `@open-walnut/plugin-api/react-dom` | React DOM shim |
| `@open-walnut/plugin-api/jsx-runtime` | JSX runtime shim |
| `@open-walnut/plugin-api/jsx-dev-runtime` | JSX dev runtime shim |

The four shims exist so a web plugin shares ONE React instance with the host instead of bundling its own (two Reacts break hooks and context). Write ordinary `import { useState } from 'react'`, and `walnut-plugin build` rewrites it to the shim for you.

## Server plugin

```ts
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.log.info('activated')

  walnut.registry.tool({
    name: 'ping',
    description: 'Answer with pong.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { reply: 'pong' }
    },
  })
}
```

## Web plugin

```tsx
import { useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function Page() {
    const [count, setCount] = useState(0)
    return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
  }

  walnut.ui.page({ id: 'main', path: '/plugins/my-plugin', title: 'My Plugin', component: Page })
  walnut.ui.nav({ id: 'main', label: 'My Plugin', path: '/plugins/my-plugin' })
}
```

Everything a plugin receives is scoped to that plugin and torn down when it unloads, so a reload leaves no stray listeners, routes, or panels behind.

## License

MIT. See [LICENSE](./LICENSE).
