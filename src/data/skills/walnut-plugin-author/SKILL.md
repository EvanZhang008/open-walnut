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
| Any AI session (the Personal AI, a coding session) to call something | `registry.op` (read-only ops reach every session through `walnut tools call <plugin>_<name>`) | `server` |
| The AI beside your App to see what the App shows (an editor, a test run, a timer) | `appState.publish`, see step 4a | either |
| An AI that watches the person's work and draws conclusions | an event log plus an observer session, see step 4b | `both` |
| Files a person wants on every machine and in the backup (a review, a rules file) | `storage.files`, declared in the manifest, see step 5 | `server` |
| A recurring or scheduled action | `registry.cronAction` | `server` |
| To react to sessions or tasks | `registry.hook` | `server` |
| Two-way task sync with an external system | `registry.sync` plus `sourceClaim` and `display` | `server` |
| A screen in the console | `ui.app` | `web` |
| A screen that reads server state | `ui.app` plus `registry.wsMethod` or `http.route` | `both` |
| Instructions an agent should read | a `skills/<name>/SKILL.md` directory (indexed in every session's prompt), or an `agent-skills/` directory you `registry.skill` only while it applies | either |
| A namespaced slash command | `registry.command` | `server` |
| An external page that needs browser isolation | a `webview` manifest entry | either |

Write the list down before step 2. A plugin that registers a capability nobody asked for is a review finding, not a feature.

## 2. Scaffold with one command

The author packages are not on the npm registry yet (`npx @open-walnut/plugin-cli` answers 404), so scaffold from a clone of open-walnut: build the local packages once and keep the local CLI process as the watcher:

```bash
npm run build:plugins
node packages/plugin-cli/dist/cli.js new <plugin-id> --dev --no-install --template both
```

That command scaffolds, validates, builds, links into `~/.open-walnut/plugins/<plugin-id>`, tells the running Walnut to discover and load it, prints the App URL, and then watches. `--no-install` skips installation (inside the checkout the packages resolve from it). Use `--template server` or `--template web` when step 1 ruled the other half out. Once the packages are published, the same command will be `npx @open-walnut/plugin-cli new <plugin-id> --dev --template both`.

For another local-checkout loop, run `node packages/plugin-cli/dist/cli.js dev --root <plugin-directory>`. After the packages are published and installed in the generated project, later loops are `npm run dev` there.

Keep `manifest.json` at the package root, set `apiVersion` to `1`, declare an `engines.walnut` range, and point `server` and `web` at built files under `dist/`.

## 3. Implement the App

One `ui.app` call is the entire browser surface:

```tsx
const app = walnut.ui.app({ id: 'main', title: 'My Plugin', icon: MyIcon, component: MyApp, placement: 'sidebar' })
```

The host derives the route `/apps/<pluginId>~<appId>`, a nav row, deep links into every subpath, the App Command Palette entry, the badge channel, and owner lifecycle. The returned handle carries `path`, `setBadge(value)`, and `dispose()`.

The row lives under Settings unless the App passes `placement: 'sidebar'`. A plugin someone asked for through Build a plugin passes `'sidebar'`, because that card tells them it appears in their sidebar (the scaffold already does). A plugin whose App is mostly its own settings passes nothing and sets `"settingsIn": "app"` in `manifest.json`, then draws `walnut.ui.views.PluginSettingsView` on its page.

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

## 4a. Connect the App to its AI

When the App embeds a session (`SessionView` beside an editor, a board, a form), that session should see what the person sees without being told. Do not build an MCP server for it; Walnut already gives the session three channels, and a good App uses all three:

1. **Files.** Start the session with `walnut.ops.call('task_create', { cwd, engine, message, ... })` in a folder that holds the work, so it reads code and runs commands there. Keep what it must not read (an answer key) outside that folder.
2. **App state, pushed.** `walnut.appState.publish(taskId, state, { mode, note })` from the server or the browser. Passive (default): the next message into the session carries what changed since it last read the state, in the same turn, as a diff (one line per value, a line patch for text). Proactive: it also starts a turn, debounced and at most one a minute; keep it for events the AI should react to unasked. Publish on every change (the browser side folds bursts); keep it under 64 KB; leave out spoilers and secrets. The session can read all of it with `walnut tools call app_state`.
3. **Ops, pulled.** `registry.op({ readonly: true, ... })` for anything the AI should fetch or check on demand (history, a recomputed summary). An op the AI calls must not change the person's record unless that is its job: a test run through your own runner that counts as the person's attempt is a write, not a read.

Tell the session these exist: name the ops and what the app state holds in its opening message, and ship the how-to as an `agent-skills/` skill you `registry.skill` while the plugin has something to say, so other sessions do not pay for it in every prompt.

When the session edits a file the person has open in your App, merge the change into the editor: a three-way merge against the copy both sides last saw, so the person's unsaved typing and the AI's edit both survive. Ask only when both changed the same lines. A "changed on disk while you typed" prompt for every AI edit trains the person to stop letting the AI help.

Check it end to end on an isolated server: type in the App, send a message from the embedded session, and read the session's history to see the `kind="app-state"` note and the answer that used it.

## 4b. Make the App AI-native

An App with an AI beside it is not a form with a chat box. Seven rules, each with the mistake it prevents:

1. **The AI sees every operation, not only the latest state.** Keep an append-only event log: each run with its time, a code snapshot and the result; each chat question and answer; edits, saves, hints, settings changes, pauses. App state says where the person is; the log says how they got there, and that is where the mistakes are (two runs that failed for the same reason, a fix that made the pass count drop). Give every failure its own entry, with the cause summarized and deduplicated ("6 x IndexError", "load error: line 41 SyntaxError"), the diff from the previous attempt, and what the person did next (fixed it alone, asked the AI).
2. **Record quietly, analyze on meaningful events.** Recording costs nothing and never interrupts. Analysis runs on events that mean something (a run, the end of a chat turn, a finished attempt), not on every keystroke. When the person asked not to be disturbed (an interview round, a timed attempt), the AI records and stays silent until it is over.
3. **Rules give facts, the AI gives judgment, and the judgment is shown.** Counting failures, grouping causes and diffing runs are rules: cheap, exact, and the evidence. Deciding what the core problem was is judgment, and that is the AI's job. Show its conclusion by default with the facts under it. Do not hide it behind an "Ask the AI" button, and do not let a rule guess the conclusion: a rule that counted "edge case failed in 9 runs" and preselected "missed an edge case" missed that 5 of the 9 runs failed on syntax.
4. **Conclusions carry over.** Store each conclusion with a type (a knowledge gap, a logic error, a habit such as another language's syntax), aggregate by type across items, and feed it into what the App offers next: a review card for a gap, a similar item for a logic error.
5. **Separate the roles.** The assistant the person talks to and a background observer are different sessions with different instructions and permissions. The observer never talks to the person or to the assistant; it writes its findings through a plugin op that only it may call (`remote: 'allow'` on a write op is what lets a session call it, so scope what it accepts). The assistant answers what it is asked.
6. **Control the cost.** Batch events into one observer turn, put a minimum gap between turns (30 to 60 seconds), give the person a setting to turn the observer off, and leave the model to the person's default unless a setting says otherwise.
7. **Put each file in the right place.** `walnut.storage` (plugin-data, this machine only) for the log, the database and anything large; `walnut.storage.files` (synced text, in the backup) for what the person would want on a new machine, such as a written review; `walnut.storage.tmp` (removed after a TTL) for scratch. Where a person-facing review goes (their notes vault or `storage.files`) is their setting, not your choice.

Check the App against all seven before calling it done, and write down which rule each part serves.

## 5. Write safe handlers

- Validate every input at the boundary, including anything that arrived over HTTP or from a model.
- Put a deadline on every network call (`walnut.http.fetch` takes `timeoutMs`).
- Keep request and response bodies bounded.
- Never block the event loop. No synchronous filesystem, process, database, or multi-megabyte parse work in the server entry. Trusted code shares one process with every route, so one blocking call freezes the whole console.
- Store state through `walnut.storage` (machine-local, any size). Small text the person wants on every machine goes in `walnut.storage.files`, scratch in `walnut.storage.tmp`; declare each in `manifest.json` (`"storage": { "files": true, "tmp": true }`), or it throws on use. `storage.files` takes text only (lower-case extensions), at most 1 MiB a file, 1,000 files and 5 MiB in all, and reaches git at most every five minutes, so never use it as a database. Store credentials only through `walnut.secrets`.
- Writes that must land together go in one `walnut.storage.database.batch([{ sql, params }, ...])`: one transaction, rolled back whole when any statement fails, and none of the plugin's other calls lands in between. Never send `BEGIN` and `COMMIT` as separate calls.
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

`@open-walnut/plugin-api/testing` exports `createFakeWalnut()` for handler-level tests with no running Walnut. Its `storage.database` is a real in-memory SQLite that binds and refuses like Walnut's (it needs Node.js 22.13 or later), so test database code against it instead of stubbing it.

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
