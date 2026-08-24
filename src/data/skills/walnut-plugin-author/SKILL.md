---
name: walnut-plugin-author
description: Build, verify, and package an Open Walnut Plugin with the public plugin API and author CLI. Use when creating a Plugin, adding a native App or server automation, converting a legacy integration, debugging Plugin lifecycle cleanup, or preparing a Plugin release.
---

# Walnut Plugin author

Use the unified `apiVersion: 1` plugin model. Read `docs/reference/plugin-development.md` and the executable example `examples/plugins/walnut-demo` (the Walnut Plugin Demo) before writing code.

Follow the eight steps below in order. Each one has a check you can run, so you never claim a plugin works because the code looks right.

## 1. Choose the capabilities first

Decide what the plugin contributes before scaffolding, because the answer picks the template:

| The plugin needs | Capability to use | Template |
|---|---|---|
| The Personal AI to call something | `registry.tool` | `server` |
| A recurring or scheduled action | `registry.cronAction` | `server` |
| To react to sessions or tasks | `registry.hook` | `server` |
| Two-way task sync with an external system | `registry.sync` plus `sourceClaim` and `display` | `server` |
| A screen in the console | `ui.app` | `web` |
| A screen that reads server state | `ui.app` plus `registry.wsMethod` or `http.route` | `both` |
| Instructions an agent should read | a `skills/<name>/SKILL.md` directory | either |
| A namespaced slash command | `registry.command` | `server` |
| An external page that needs browser isolation | a `webview` manifest entry | either |

Write the list down before step 2. A plugin that registers a capability nobody asked for is a review finding, not a feature.

## 2. Scaffold with one command

```bash
npx @open-walnut/plugin-cli new <plugin-id> --dev --template both
```

That command scaffolds, installs, validates, builds, links into `~/.open-walnut/plugins/<plugin-id>`, tells the running Walnut to discover and load it, prints the App URL, and then watches. `--no-install` skips installation unconditionally. Use `--template server` or `--template web` when step 1 ruled the other half out.

The packages are not on the npm registry yet, so inside this repository build the local packages and keep the local CLI process as the watcher:

```bash
npm run build:plugins
node packages/plugin-cli/dist/cli.js new <plugin-id> --dev --no-install --template both
```

For another local-checkout loop, run `node packages/plugin-cli/dist/cli.js dev --root <plugin-directory>`. After the packages are published and installed in the generated project, later loops are `npm run dev` there.

Keep `manifest.json` at the package root, set `apiVersion` to `1`, declare an `engines.walnut` range, and point `server` and `web` at built files under `dist/`.

## 3. Implement the App

One `ui.app` call is the entire browser surface:

```tsx
const app = walnut.ui.app({ id: 'main', title: 'My Plugin', icon: MyIcon, component: MyApp })
```

The host derives the route `/apps/<pluginId>~<appId>`, the Sidebar entry, deep links into every subpath, the App Command Palette entry, the badge channel, and owner lifecycle. The returned handle carries `path`, `setBadge(value)`, and `dispose()`.

Rules that keep an App correct:

- Read route state from `AppProps` (`basePath`, `subpath`, `search`, `navigate`). Never read `window.location` yourself, and never register a second route for a screen that is a subpath.
- Badges are a non-negative integer, `'dot'`, or `null`. Clear the badge when the user has seen the thing it counted.
- Import React normally and let the CLI alias it to the host shims. A second React copy breaks hooks and context.
- Compose with `walnut.ui.views` (`TaskView`, `ChatView`, `SessionView`, `CalendarView`, `FileView`, `NoteView`, `TerminalView`) instead of copying host internals, and give every stateful View instance its own `storageKey` or `draftKey`.
- Use `ui.settings` for configuration and `ui.injectCss` for styles, scoped to a class you own. Use `ui.page` only for a standalone route that is genuinely not an App.

Do not write nav items, dashboard panels, or panel layouts. Those contributions no longer exist: Core Apps, native plugin Apps, and legacy Webviews are rows in one App Registry, and an App owns its own screen.

## 4. Implement the server entry

Server modules export `activate(walnut)` from `@open-walnut/plugin-api/server`. Reach for the API in this order:

1. A typed service (`tasks`, `config`, `notifications`, `storage`, `secrets`, `timers`, `http`, `events`) when it covers the operation.
2. `ops`, an HTTP route, an event, a WebSocket method, or a registry entry for a stable lower-level path.
3. `unsafe` only when no stable path exists, and say why in the code comment and the review.

Never import Walnut's private `src/**` modules from an external plugin.

Bridge the App to the server with one `registry.wsMethod` that takes a named action, or one read-only `http.route`. Two seams are easier to reason about than ten.

## 5. Write safe handlers

- Validate every input at the boundary, including anything that arrived over HTTP or from a model.
- Put a deadline on every network call (`walnut.http.fetch` takes `timeoutMs`).
- Keep request and response bodies bounded.
- Never block the event loop. No synchronous filesystem, process, database, or multi-megabyte parse work in the server entry. Trusted code shares one process with every route, so one blocking call freezes the whole console.
- Store state through `walnut.storage`. Store credentials only through `walnut.secrets`.
- Never put a credential in source, `manifest.json`, synced config, logs, notifications, examples, task fields, or a receipt returned to the browser. Report secret key names and existence, never values.

## 6. Keep ownership and cleanup correct

Register routes, Tools, timers, event listeners, Hooks, Cron actions, Commands, Skills, Agents, Providers, RPC methods, Apps, Settings sections, and CSS through `walnut.*`. The host owns those disposables and removes them in reverse order on disable or reload.

Clean up anything created outside `walnut.*` yourself, and do not assume unloading frees Node's ESM module memory.

Verify it rather than asserting it: reload the plugin at least three times and check that every contribution count returns to one, and that the App, its Sidebar entry, and its palette entry disappear when the plugin is disabled.

## 7. Verify against a real Walnut

```bash
npm run validate
npm test
npx walnut-plugin status
```

`status` is the honest check: it reads `/api/plugin-runtime` and prints what the running Walnut actually thinks. The dev loop reports one of three outcomes, and only one of them means it works:

- `active`: loaded, and the App URL is live.
- `offline`: nothing answered at the API URL, so the link loads on Walnut's next start.
- `failed`: Walnut answered and refused, or the plugin never reached `active`. The line carries the reason.

Never report a plugin as working on the strength of a successful reload call. A reload can return 200 while the plugin lands in `quarantined`.

For UI, drive real clicks. Cover the App's main path, a deep link straight into a subpath, a badge update, the error boundary, disable cleanup, and two instances of any stateful View. Use an isolated Walnut server and point the CLI at it with `OPEN_WALNUT_API_URL`. Never test against the user's production server on port 3456.

`@open-walnut/plugin-api/testing` exports `createFakeWalnut()` for handler-level tests with no running Walnut.

## 8. Security review, then publish-check

Review the diff against the trust model before shipping. A plugin is full-trust code: a server entry has full Node access and a native web entry runs in the host browser realm. Do not invent capability prompts, and do not describe `server`, `web`, and `webview` as permission levels. `webview` is only an iframe entry for content that needs browser isolation, and it does not sandbox a server entry in the same plugin.

Check each of these explicitly:

- Every secret goes through `walnut.secrets`, and no code path returns a secret value.
- No absolute path, data directory, or host detail leaks into a receipt, a notification, or an HTTP response.
- Every external call has a deadline and a bounded body.
- The plugin touches only what it declared: its own project claim, its own task ids, its own storage.
- Nothing runs at import time that should run in `activate`.

Then run the release inspection:

```bash
npx walnut-plugin publish-check
npm pack --dry-run --json
```

`publish-check` does a production build, requires `manifest.json` and `package.json` to agree on the version, refuses a `private` package, and reads the real `npm pack --dry-run` file list with lifecycle scripts disabled. It fails when a required artifact is missing (`manifest.json`, every build output, declared Webview files, everything under `skills/`) or when the package carries `node_modules`, an `.env` file, `.npmrc`, `credentials.json`, `secrets.json`, a source map, a key, or a certificate.

Both commands only inspect. Publishing is a separate, deliberate `npm publish` the human runs. Do not publish on the user's behalf, and do not claim a package is released.

A published package must already contain its built artifacts, because Walnut installs npm plugins with `--ignore-scripts`. The Plugin Store accepts trusted Git URLs, share snippets, and npm specs; Git sources record a commit SHA, npm sources record the resolved version and integrity, and updates are always explicit.

## Common failures

- **A second React copy**: build the web entry with the CLI so React resolves to the host shims.
- **A contribution survives reload**: it was created outside `walnut.*`. Register it through the API, or dispose it yourself.
- **A route answers 404**: plugin routes live under `/api/plugins/<plugin-id>/`, and your registered path is appended to that prefix.
- **The App never appears**: the plugin is not `active`. Read `walnut-plugin status` before editing UI code.
- **A tool is never called**: register a lowercase local name such as `status`, then describe the host-exposed `<normalized_plugin_id>_status` Tool in one plain sentence.
- **A Skill cannot be read**: ship a real `skills/<name>/SKILL.md` directory, or register an absolute directory with `registry.skill`.
- **A Command disappears after reload**: use `walnut.registry.command`, not a private frontend registry.
- **A required config field leaves the plugin inactive**: read the `needs-config` diagnostics and the `uiHints`.
- **A first link seems to need a restart**: the running Walnut predates the discover route. Update Walnut.
- **npm install works locally but the plugin fails in Walnut**: an artifact is unpacked, or the build depended on a lifecycle script.
