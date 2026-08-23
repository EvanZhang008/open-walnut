# @open-walnut/plugin-cli

The `walnut-plugin` command: scaffold, build, live-link, and pre-flight an [Open Walnut](https://github.com/EvanZhang008/open-walnut) plugin. Types and runtime shims come from [`@open-walnut/plugin-api`](https://www.npmjs.com/package/@open-walnut/plugin-api).

Full guide: [Plugin development](https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md).

## Start a plugin

```bash
npx @open-walnut/plugin-cli new my-plugin
cd my-plugin && npm install
npx walnut-plugin dev
```

`dev` builds the plugin, links the directory into `~/.open-walnut/plugins/<id>`, then rebuilds and asks Walnut to reload on every save. Walnut may be offline while you work; the link loads on its next start.

Needs Node 22 or newer.

## Templates

`new` takes `--template server | web | both` (default `both`).

| Template | You get |
| --- | --- |
| `server` | `src/server.ts` only: tools, ops, cron actions, hooks, storage |
| `web` | `src/web.tsx` only: nav item, page, and panel in the web console, plus React dev dependencies and the JSX config |
| `both` | one project with both entries |

A `server` project pulls in no React and no JSX config, so a plugin with no UI stays small.

## Commands

| Command | What it does |
| --- | --- |
| `new <id>` | scaffold a project (`--template`, `--directory`) |
| `build` | bundle the manifest's entries into `dist/` (`--watch`) |
| `validate` | check `manifest.json` and its source entry paths |
| `link` | symlink the project into `~/.open-walnut/plugins/`, then reload it |
| `dev` | build, link, watch, and reload on change |
| `status` | print what the running Walnut thinks of this plugin |
| `test` | validate, build, then run the project's `plugin:test` script |
| `publish-check` | production build plus inspection of the real npm file list |

Every command except `new` takes `--root <path>` and defaults to the current directory.

## License

MIT. See [LICENSE](./LICENSE).
