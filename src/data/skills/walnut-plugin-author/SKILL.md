---
name: walnut-plugin-author
description: Build, test, package, and publish an Open Walnut Plugin with the public Plugin API and author CLI. Use when creating a Plugin, adding server or native web contributions, converting a legacy integration, debugging Plugin lifecycle cleanup, or preparing a Plugin npm release.
---

# Walnut Plugin author

Use the unified `apiVersion: 1` Plugin model. Read `docs/reference/plugin-development.md` and the executable `examples/plugins/reference-walnut` before editing code.

## Trust contract

A Plugin is full-trust code. Server entries have full Node access and native web entries run in the host browser realm. Do not invent capability prompts or describe `server`, `web`, and `webview` as permission levels. `webview` is only an optional iframe entry for content that specifically needs browser isolation.

## Create the project

```bash
npx walnut-plugin new <plugin-id> --template both
cd <plugin-id>
npm install
npm run build
npm run test
```

Choose `server`, `web`, or `both`. Keep `manifest.json` at the package root, set `apiVersion` to `1`, declare an enforced `engines.walnut` range, and point `server` and `web` at built ESM files under `dist/`.

## Use the API in this order

1. Use a typed service when it covers the operation.
2. Use `ops`, HTTP, events, WebSocket RPC, or a registry for a stable lower-level path.
3. Use `unsafe` only when no stable path exists. State why in code review.
4. Never import Walnut private `src/**` files from an external Plugin.

Server modules export `activate(walnut)` from `@open-walnut/plugin-api/server`. Native web modules export `activate(walnut)` from `@open-walnut/plugin-api/web`.

## Keep lifecycle ownership correct

Register routes, Tools, timers, event listeners, Hooks, Cron actions, Commands, Skills, Agents, Providers, RPC methods, pages, panels, Settings, and CSS through `walnut.*`. The host owns those Disposables and removes them in reverse order on disable or reload.

Clean up anything created outside `walnut.*` yourself. Do not assume that unloading frees Node's ESM module memory. Test at least three reload cycles and assert that contribution counts return to one each time.

## Build native React correctly

Import React normally. Let `walnut-plugin build` replace React, ReactDOM, and JSX runtime imports with host shims. Do not bundle another React copy and do not import private Walnut components.

Compose UI with `walnut.ui.views` when a stable View exists. Use `TaskView`, `ChatView`, `SessionView`, `CalendarView`, `FileView`, `NoteView`, and `TerminalView` instead of copying host implementation details. Give every stateful View instance a distinct storage or draft key.

## Write safe handlers

Validate user and network input at the boundary. Put a deadline on network work. Avoid synchronous filesystem, process, database, or parsing work on the server event loop. Keep HTTP request and response bodies bounded.

Store state under `walnut.storage`. Store credentials only through `walnut.secrets`. Never put credentials in source, the manifest, synced config, logs, notifications, examples, or task data.

## Verify the real contract

```bash
npm run build
npm run test
npx walnut-plugin validate
npx walnut-plugin publish-check
npm pack --dry-run --json
```

`publish-check` builds the Plugin and inspects the exact `npm pack --dry-run` file list without running lifecycle scripts. It fails when required artifacts are missing or the package includes source maps or common secret files.

For server behavior, test activation, every contribution, disposal, reload, failure isolation, Safe Mode, and quarantine recovery. For native UI, use an isolated Walnut server and real browser clicks. Verify the main path, error boundary, disable cleanup, persisted Dashboard layout, and multiple stateful View instances.

Do not touch production port 3456 during author tests.

## Publish and install

Publish a package that already contains `manifest.json`, `dist/`, and any declared `skills/` or Webview files. Do not depend on lifecycle scripts to build during install because Walnut installs npm Plugins with `--ignore-scripts`.

The Plugin Store accepts trusted Git URLs, share snippets, and npm registry specs. Updates are explicit. npm installs record the exact resolved version and integrity; Git installs record the commit SHA.

## Common failures

- A second React copy: use the Plugin CLI web build.
- A contribution survives reload: register it through `walnut.*` or return a Disposable.
- A route appears under the wrong URL: Plugin routes live under `/api/plugins/<plugin-id>`.
- A tool has the wrong model name: host namespacing uses the Plugin id and underscore-safe tool names.
- A Skill cannot be read: ship a real `SKILL.md` directory or register an absolute Skill directory.
- A Command disappears after reload: use `walnut.registry.command`, not a private frontend registry.
- A required config field leaves the Plugin inactive: read the `needs-config` diagnostics and `uiHints`.
- npm install succeeds locally but fails in Walnut: ensure every build artifact is packed and no install script is required.
