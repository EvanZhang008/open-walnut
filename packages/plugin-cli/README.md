# @open-walnut/plugin-cli

The `walnut-plugin` command: scaffold, build, live-link, and pre-flight an [Open Walnut](https://github.com/EvanZhang008/open-walnut) plugin. Types and runtime shims come from [`@open-walnut/plugin-api`](https://github.com/EvanZhang008/open-walnut/tree/main/packages/plugin-api).

Full guide: [Plugin development](https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md).

## One command

```bash
npx @open-walnut/plugin-cli new my-plugin --dev
```

That is the whole first loop, in one pass and one order: scaffold, install dependencies, validate the manifest, build the entries, link the directory into `~/.open-walnut/plugins/my-plugin`, ask the running Walnut to discover and load it, read the runtime state back, print the App URL, then watch and reload on every save. A first link needs no server restart, and Walnut may be offline while you work (the link loads on its next start).

After that, the project's own script continues the same loop:

```bash
cd my-plugin
npm run dev
```

`--no-install` skips `npm install` unconditionally. `--open` opens the App in a browser once Walnut reports the plugin active, and only from an interactive terminal.

Needs Node 22 or newer.

This package lives in the Open Walnut repository and is not on the npm registry yet, so the `npx` line above is the shape a release will use. Inside a checkout, build the workspace packages and skip registry installation while the local CLI owns the watcher:

```bash
npm run build:plugins
node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install
```

For another local-checkout loop, run `node packages/plugin-cli/dist/cli.js dev --root my-plugin`. The generated project's `npm run dev` becomes the normal loop after the packages are published and installed.

## Templates

`new` takes `--template server | web | both` (default `both`).

| Template | You get |
| --- | --- |
| `server` | `src/server.ts` only: tools, ops, cron actions, hooks, storage, task sync |
| `web` | `src/web.tsx` only: one App in the console, plus React dev dependencies and the JSX config |
| `both` | one project with both entries |

A `server` project pulls in no React and no JSX config, so a plugin with no UI stays small. Every template also writes a working `skills/<id>/SKILL.md`, which names the host-exposed `<normalized_plugin_id>_ping` Tool and can be read as soon as the plugin loads.

## Commands

| Command | What it does |
| --- | --- |
| `new <id>` | scaffold a project (`--dev`, `--no-install`, `--open`, `--template`, `--directory`) |
| `dev` | build, link, discover, load, then rebuild and reload on change (`--open`) |
| `build` | bundle the manifest's entries into `dist/` (`--watch`) |
| `validate` | check `manifest.json` and its source entry paths |
| `link` | symlink the project into `~/.open-walnut/plugins/`, then discover and load it |
| `status` | print what the running Walnut thinks of this plugin |
| `test` | validate, build, then run the project's `plugin:test` script |
| `publish-check` | production build plus inspection of the real npm file list |

Every command except `new` takes `--root <path>` and defaults to the current directory.

## What the dev loop reports

Each sync ends in exactly one of three states, so a run never leaves you guessing:

- `active`: Walnut loaded the plugin and the App URL is live.
- `offline`: nothing answered at the API URL, so the link loads on Walnut's next start.
- `failed`: Walnut answered and refused, or the plugin never reached `active`. The line carries the reason.

`active` is read back from `/api/plugin-runtime` rather than inferred from a successful reload call, because a reload can return 200 while the plugin lands in `quarantined`. `status` reads the same source on demand.

Set `OPEN_WALNUT_API_URL` to point the CLI at a local Walnut other than `http://127.0.0.1:3456`, which is what you want against an isolated test server. The CLI does not carry a remote authentication credential, so an authenticated remote deployment rejects these management calls. Every call is bounded, so a wedged server is reported as `offline` instead of hanging the terminal.

## publish-check

`publish-check` inspects a release candidate. It never publishes anything.

It runs a production build, requires `manifest.json` and `package.json` to agree on the version, refuses a package marked `private`, then reads the real `npm pack --dry-run --json` file list with lifecycle scripts disabled. It fails when a required file is missing (`manifest.json`, every build output, declared Webview files, everything under `skills/`) or when the package carries `node_modules`, an `.env` file, `.npmrc`, `credentials.json`, `secrets.json`, a source map, a key, or a certificate.

Publishing stays a separate, deliberate `npm publish`. A published plugin must already contain its built artifacts, because Walnut installs npm plugins with `--ignore-scripts`.

## License

MIT. See [LICENSE](./LICENSE).
