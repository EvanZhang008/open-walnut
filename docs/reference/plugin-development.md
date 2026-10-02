# Plugin development

## One command

```bash
npx @open-walnut/plugin-cli new my-plugin --dev
```

That single command is the whole first loop: it scaffolds the project, installs dependencies, validates the manifest, builds the entries, links the directory into `~/.open-walnut/plugins/my-plugin`, asks the running Walnut to discover and load the new plugin, reads the runtime state back, prints the App URL, and then keeps watching so every save rebuilds and reloads. A first link needs no server restart. Walnut may be offline while you work, in which case the link loads on Walnut's next start.

Or skip the terminal entirely: Settings → Plugins has a **Build a plugin** card. Describe what you want and click **Build it**, and an AI session starts in `~/walnut-plugins`, runs the command above itself, and keeps the watcher alive so the plugin appears in your sidebar as it takes shape. The same card links to the guided version of this page at `/plugins/new`: the command with a copy button, plus a live panel that shows your plugin's App the moment the first build links in.

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

One plugin can contribute any mix of: a native React App in the console, Settings sections, owner-scoped CSS, Ops that sessions and the CLI call, Tools for routine watchers, Skills, slash Commands, Hooks, Cron actions, Agents, model Providers, HTTP routes, WebSocket methods, Services other plugins build on, task sync with its display metadata, and its own storage, secrets, and timers.

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
- **`icon`**: optional path of an `.svg` file inside your plugin folder, such as `"icon.svg"`. Settings → Plugins draws it on your row's colored tile, in Installed and in Available. It is used as a single-color mark: every visible pixel is painted white on the tile, so draw a line or solid glyph on a transparent background (a 24 by 24 viewBox with `stroke="currentColor"` works well). The file must stay inside the plugin folder (no `..`, no absolute path) and be at most 64 KB. Without an icon, the tile shows the first letter of `name`. `walnut-plugin validate` rejects a bad value, and `publish-check` fails when the file is not in the package.
- **`version`**: the plugin's release version. `publish-check` requires it to equal `package.json`'s version.
- **`apiVersion`**: `1` for the unified API. Anything else is rejected by validation.
- **`engines.walnut`**: required. Walnut checks the range before importing any plugin code.
- **`server`**: optional built ESM server entry.
- **`web`**: optional single-file ESM native web entry.
- **`webview`**: optional iframe entry (`{ "title": "...", "entry": "app/index.html" }`). This is a compatibility path, not the default UI.
- **`dependencies`**: optional `{ "<pluginId>": "<semver range>" }` matched against the other plugin's manifest `version`. Walnut activates a declared dependency first, and holds this plugin back while one is missing, wrong-version or not running. It is also what permits `walnut.services.get` on that plugin's services.
- **`build`**: the source entries `walnut-plugin build` compiles, plus an optional `external` list for the server bundle.
- **`configSchema`** and **`uiHints`**: optional generated Settings form for `plugins.<id>`.
- **`settingsIn`**: where that form is drawn. `'plugins'` (the default) is the Configure card on your row in Settings → Plugins. `'app'` means your own App renders it through `walnut.ui.views.PluginSettingsView`, and the row's Configure button takes the person to your App instead of opening a second copy of the form, so a plugin whose page is mostly its settings has one home, not two. Draw the view on your page even when it fails to load its own data, or the settings have no way in.
- **`taskFields`**: optional task fields for a sync integration.
- **`phases`**: optional list of task phases added after the plugin API's first release that your sync plugin understands. Today that is `["WAITING"]`: a task parked until something happens, which belongs to the `todo` status bucket. A sync plugin that does not list it receives every WAITING task folded onto `TODO` (in `pushTask`, the `update*` calls, the content hooks and the `getTasks()` snapshot of its poll), so a plugin that maps the phase set exhaustively keeps working unchanged. List the phase once your mapping has a row for it; `legacyPhase()` from the API folds a phase onto the older set when you need a stable 3-state view. Whatever a plugin writes back, a sync pull can move a WAITING task only to COMPLETE; a phase it does not know should be treated as `TODO`.
- **`catalog`**: optional `{ "adds": ["App"], "homepage": "...", "docs": "..." }`, read by the Settings store to describe a plugin in the bundled store before it is installed (see [Bundled store](#bundled-store)). Values of the wrong type are dropped.

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
| `walnut.tasks` | Read, query, create, update, complete, and delete tasks; file, tag, pin and date tasks into a project or a folder in batches; list, create and delete folders; list and ensure pin groups. |
| `walnut.hosts` | List the hosts in Settings, Hosts, and run a short script on one (over ssh for a remote host). |
| `walnut.sessionImports` | The importer of outside sessions: the tag and project it files them under, a callback when an import run ends, its idle window, and a way to keep its lifecycle on tasks you file elsewhere. |
| `walnut.tags` | Say how your plugin's tags show on tasks: a tag or a `<namespace>:*` can default to hidden (searchable and filterable still, just no pill). |
| `walnut.config` | Read and patch only `plugins.<id>`, and subscribe to changes. |
| `walnut.notifications` | Raise notices (including `kind: 'reminder'` with up to three op buttons), `dismiss` your own, report plugin errors and recover from them, and hold Walnut's quiet mode with `quiet.get/set/clear`. |
| `walnut.ui` | Show a live status item in the console's left rail: a ring the host ticks from a timer, a label, and a popover with up to three op buttons. |
| `walnut.letters` | Send a letter to the human, hear the answer, reply in its thread, withdraw a stale one. |
| `walnut.ops` | Call stable host operations that no typed service covers yet. |
| `walnut.services` | Publish a capability for other plugins, and use the ones you declared as dependencies. |
| `walnut.events` | Subscribe to host events and emit namespaced plugin events. |
| `walnut.http` | Register plugin routes and make outbound requests with a deadline. |
| `walnut.storage` | Files in the plugin data directory, plus a private SQLite database. |
| `walnut.secrets` | Credentials, stored outside synced config. |
| `walnut.timers` | Timeouts and intervals that stop on disposal. |
| `walnut.registry` | Tools, Ops, Hooks, Cron actions, Agents, Providers, Commands, Skills, task sync, and their metadata. |
| `walnut.log` | The plugin's structured logger, with `child(name)` for subsystems. |
| `walnut.replica` | `true` on a cloud replica, `false` on the primary box. Check it before polling anything outside Walnut: an account, a mailbox or an inbox has ONE owner, and two boxes polling it double every fetch and every write. |
| `walnut.unsafe` | Unstable raw host objects, for when no stable API exists. First access logs a warning. |

There is no supported way to import Walnut's private `src/**` modules. Those paths change without notice. Use a typed service, `ops`, events, HTTP, a registry, or `unsafe`.

#### Tasks, folders and tags

A task carries `groupId` (the folder it is filed in, absent at the project root) and `sessionIds` (every session ever linked to it, which survives completion), so a plugin can find the task behind a session it knows about. To change one tag, pass `addTags` or `removeTags` to `update`: they apply to the tags the task has when the write lands, so a tag someone else changes meanwhile survives. `tags` replaces the whole set and wins over both.

A folder belongs to one project, and moving a task to another project with `update` drops its folder. `folders()` lists every folder, empty ones included. `createFolder({ label, project })` makes one, and creates the project as a local one (no sync provider claims it) when the board has none by that name. `fileIntoFolder(folderId, items)` files tasks: each item moves into the folder's project if it is elsewhere, joins the folder, and takes the item's `addTags` and `title`. Use it for anything past a handful of tasks: `update` rewrites the whole task store once per call, so a plugin filing a thousand tasks one `update` at a time holds the server for minutes, while `fileIntoFolder` writes only the changed rows. It moves only local tasks across projects and reports the rest as skipped (`synced`, `missing`, or `rejected` for a title the owning plugin refuses). Never name a plugin setting `project`: Walnut reads `plugins.<id>.project` as that plugin reserving the project for its own sync.

`fileIntoProject(project, items)` is the same batch with a project as the target: a task that moves in lands at the project's top level, and one already in the project keeps its folder unless its item says `topLevel: true`. The project is created as a local one when the board has none by that name. `deleteFolder(folderId)` removes an empty folder, such as one your plugin filed into before its settings changed; it refuses a folder that still holds a task or another folder, because the user may keep their own work there.

A filing item carries more than its place. `removeTags` takes tags off (before `addTags`, so one item swaps a tag for another). `createdAt` sets when the work really began, for a task whose creation time is only when Walnut first saw it: an imported run of a ticket opened a week earlier then sorts and filters by the ticket's date. `pinTier` says where the task is pinned on the board: `focus`, `satellite`, `wait`, or a pin group id pins an open task there (the retired `backlog` is accepted and lands in `wait`) (one pinned elsewhere moves tier and keeps its place in the order), `null` unpins, and an omitted field leaves pins alone; a completed task is never pinned. `pinAt` places the pin in the pinned order: `top` above every pin so far, `bottom` below them, item order kept, so a batch filed newest-first ends newest on top. A new pin goes to the bottom without it, and a pin that already exists keeps its place unless it is given, which lets a plugin re-sort the pins it owns. Walnut does not know whether the user placed a pin, so decide for yourself which pins are yours to move: the usual way is a hidden marker tag on the pins you make (see `walnut.tags`), left off any pin you did not make and taken off again when you let a pin go.

A pin group is one of the user's custom tiers beside Focus, Satellite, Backlog and Wait. `pinGroups()` lists them, in board order. `ensurePinGroup(label)` answers the group by that name, creating it when the board has none (names are compared case-insensitively, so a group the user already made by that name is reused, never doubled). The group is the user's from then on: renaming, reordering or deleting it is theirs, and a plugin never does either. Its `id` is what `pinTier` takes.

#### Hosts

`walnut.hosts.list()` returns this machine (`__local__`) and every host in Settings, Hosts, with its hostname, user and port. `walnut.hosts.run(alias, { script, args })` runs a POSIX `sh` script on one: over ssh for a remote host (key auth only, it never prompts), directly for this machine. Arguments arrive as `$1`, `$2`, … exactly as passed, so a plugin never quotes anything for a remote shell. The run is bounded: `timeoutMs` (default 60 s, at most 10 minutes) and `maxOutputBytes` (default 8 MB) end it with `timedOut` or `truncated` rather than letting it hang or fill memory. A failure to connect is a nonzero `code` with ssh's words in `stderr`; a host Walnut does not know throws. Keep the work on the host and print a small answer: a script that reads a local database and prints one JSON line costs one connection, where copying the database over costs every byte of it.

#### Outside sessions

Walnut's importer files every session started outside Walnut (in a terminal, or by another tool) as one task, under a project per host. `walnut.sessionImports.projectFor(host)` names that project and `walnut.sessionImports.tag` is the tag on every task the importer still owns; the first message a person sends into the session removes it. `walnut.sessionImports.onRun(handler)` fires once after each import run that changed the board, so a plugin that files imported sessions somewhere else can pick up new ones right away instead of on its next timer.

The importer also completes an imported task nobody wrote to once its session has been idle `autoCompleteAfterDays()` days (0 means never), but only in its own projects. A plugin that files imported tasks into a project of its own keeps that promise with `extendTo(project)`: tasks there still carrying the importer's tag are completed on the same clock, and a task someone wrote to is a regular task. Dispose the returned handle to stop; the plugin's own disposal does it too.

#### Tag display

Every tag is a key:value pair (`ticket:V1234567890`, `sev:2`): Walnut stores whatever a plugin writes in that form, so a plain word becomes the label `label:<word>`, and a plugin that syncs tags with an outside service must send them back the way the service spells them (match `label:<word>` to the remote `<word>`). `created:` and `updated:` are the task's own dates, worked out by Walnut and never stored.

Every tag is an ordinary tag (searched, filtered, edited), and how it shows as a pill on a task is a separate, display-only rule. `walnut.tags.setDefaultDisplay(pattern, display)` sets your plugin's default for an exact tag or a whole key (`ticket-id:*`): `'shown'` draws the whole tag, `'value'` only the text after the key (a ticket pill reading `V1234567890`), `'hidden'` no pill, so a tag that exists to be searched for (a ticket's UUID) or to mark what your plugin did (a pin marker) never clutters the board. The user's own rule for a pattern (Settings, Tasks, Tags) wins over yours, yours wins over Walnut's defaults (labels read as their value, the two date keys hidden), Walnut's machine tags (`walnut:*`) never show, and two plugins disagreeing on one pattern take the quieter display (hidden, then value). An older Walnut throws on `'value'`: catch it and fall back to `'shown'`. The default lives while your plugin does; `displayRules()` lists every rule in force.

A tag can also open something: `walnut.tags.setDefaultLink(pattern, link)` makes the pill of every matching tag a link, with `{value}` standing for the tag's value (URL-encoded), so `setDefaultLink('ticket:*', 'https://tracker.example.com/{value}')` opens a ticket from its pill. Only an http(s) URL that names `{value}` is accepted. The user's link for the same pattern wins (their empty link removes yours), and the link lives while your plugin does; `linkRules()` lists every link in force. Both methods are absent on a Walnut older than 2026-10, so check `typeof walnut.tags.setDefaultLink === 'function'` first.

#### Letters

A letter is a document Walnut delivers to the one human who reads it: a subject, a markdown or HTML body, and optionally a few one-tap actions. It shows up in the human inbox on the console and on the phone, so it is how a plugin asks a question when the person is not sitting in front of the app. Use it as your approval object whenever your plugin must not act without a human decision (sending a message on their behalf, spending money, deleting something that is not yours): send the letter with actions, do nothing, and act only when the answer arrives.

Answers arrive as EVENTS, not as a return value. `walnut.letters.send` resolves as soon as the letter exists, and `onAnswered` fires whenever the human taps an action, whichever surface they tapped it on. Your handler only ever sees answers to letters your own plugin sent. A letter can be answered exactly once, which is what makes "one approval, one action" enforceable; if the thing you asked about changes before they answer, call `withdraw` with a short note and send a fresh letter, so a stale decision is never tappable.

Subscribe ONCE, at activate, and dispatch by letter id. A subscription per letter looks tidier and is a leak: every letter you send adds a handler that outlives the answer, they all run for every answer, and the host cannot tell you which one mattered. Record what a letter was for (a row in your own database is better than a Map, because an answer can arrive after a restart), and look it up when the answer comes in.

```ts compile=letters
import type { Disposable, WalnutServerApi } from '@open-walnut/plugin-api/server'

/** What each outstanding letter was about. A real plugin stores this in its own database. */
const pending = new Map<string, { summary: string }>()

export function watchAnswers(walnut: WalnutServerApi): Disposable {
  // ONE subscription for the whole plugin, owned by the Disposable your activate returns.
  return walnut.letters.onAnswered(async (event) => {
    const what = pending.get(event.letterId)
    if (!what) return
    pending.delete(event.letterId)
    if (event.actionId === 'send') await walnut.letters.reply(event.letterId, { text: 'Sent.' })
  })
}

export async function askBeforeSending(walnut: WalnutServerApi, summary: string): Promise<string> {
  const { letterId } = await walnut.letters.send({
    subject: 'Approve this before it goes out',
    markdown: summary,
    actions: [
      { id: 'send', label: 'Send' },
      { id: 'discard', label: 'Discard' },
    ],
  })
  pending.set(letterId, { summary })
  return letterId
}
```

One more thing the example cannot show: an answer can be RECORDED without your handler ever running, because the event bus does not wait for its subscribers and the process can die in between. If acting on an answer matters (it does, for anything that spends money or sends mail), give yourself a periodic sweep that looks for work you froze and never finished, and use `letters.get(letterId)` to find out whether it was answered while you were gone.

Limits worth knowing before you write the loop: at most 30 letters per plugin per minute, and over that `send` rejects with a message saying so. A letter badges the bell and pushes to the phone, so per-item letters bury the human even under the limit: roll a batch up into one letter with one decision.

### Registrations

Every local id is validated and namespaced by the host. Register a Tool with a local name matching `/^[a-z0-9_]+$/`, such as `status`; Walnut exposes it to the model as `<normalized_plugin_id>_<local_name>`, such as `my_plugin_status`. The host folds punctuation in the Plugin id to underscores and does not add the prefix twice. Other ids surface as `<pluginId>:<localId>`.

- `tool`: a tool with a JSON input schema, for the in-process loops that still take a tool list. Today that means routine watchers, which allowlist plugin tools by name. It is NOT how you reach a session: sessions call ops.
- `op`: a named operation other code can call by name, and the way a plugin exposes work to sessions. See Ops below.
- `hook`: one or more typed session or task hook points.
- `cronAction`: an action a routine can invoke.
- `wsMethod`: a namespaced browser RPC method.
- `agent`: a runtime plugin Agent, optionally visible in the console.
- `provider`: a runtime model provider adapter.
- `command`: a namespaced slash command whose `content` is sent to the Personal AI.
- `skill`: an extra absolute directory holding one or more `SKILL.md` files.
- `agentContext`: **deprecated, reaches no model.** It fed a system prompt Walnut no longer builds; register a skill instead. The call still succeeds so plugin loading never breaks, and each plugin that uses it gets one warning per load.
- `sync`, `sourceClaim`, `display`, `migration`, `extIndex`: task integration registration.

A sync integration may implement `prepareNewTask(task, { reason })` next to `pushTask` and `createTask`. Core calls it once when a task enters the plugin's domain (created in, or moved into, a project the plugin claims; `reason` is `'created'` or `'moved'`), after the row is written and before its first push, so the create already carries the values. Return the fields you want as defaults; core fills only fields the task has no value for yet, from a fixed set (`sprint`, `priority`, `due_date`, `start_date`, `end_date`, `tags`), drops anything else with a warning, and treats a throwing hook as "no defaults" (it can never fail the create). Tasks the plugin imported from its remote and moves between two projects of the same plugin never see it. A tracker uses this to put a new task in the sprint running today; a plugin with nothing to default omits the method.

A plugin can also ship a conventional `skills/` directory with no `registry.skill` call at all. Those skills join discovery below workspace, user, and shipped Walnut skills, so a local copy of the same name still wins.

That directory is found when the plugin is **loaded**, from the manifest and a `stat` of the directory, so it is indexed even when the plugin registered no Tools this run (no account connected, a missing dependency, a replica). Convenient, and the right default for a skill that always applies; wrong for a skill that describes tools which may not be there, because a skills index entry rides every turn of every user's prompt.

**Gate it with `registry.skill` when the capability is conditional.** Put the directory somewhere the convention does not look (the Mail base uses `agent-skills/`, not `skills/`), and register it from the same branch that registers the Tools, so it appears and disappears with them:

```ts compile=skills
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

// path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-skills')
//
// Resolved from THIS module's own location, because both layouts are real: the plugin source tree
// when the server runs from source, and the built output when it does not. A path built from cwd
// or from the manifest is right in only one of them.
declare const SKILL_DIR: string

export function activate(walnut: WalnutServerApi) {
  const live = true // whatever makes the capability real: an account, a credential, a dependency
  if (!live) return
  const skill = walnut.registry.skill({ id: 'my-skill', directory: SKILL_DIR })
  return { dispose: () => skill.dispose() }
}
```

`directory` is the ROOT ABOVE the skill folder: pass the directory that CONTAINS `<name>/SKILL.md` (the Mail base passes `agent-skills`, not `agent-skills/walnut-mail`). Passing the folder that holds `SKILL.md` registers without complaint and contributes nothing, so right after registering, the host probes the layout and logs a warning under the `plugin/<your-id>` subsystem: "Plugin skill directory is the skill folder itself; register its parent" when the directory itself holds a `SKILL.md`, and "Plugin skill directory holds no <name>/SKILL.md" when it holds neither. A directory that does not exist yet is never warned about, because creating it later is legitimate, and the categorized layout `<root>/<category>/<name>/SKILL.md` counts as correct. The registration itself always succeeds: the probe only tells you why nothing showed up.

Either way the skill text is read before the model knows whether the tools exist (the management UI lists it regardless), so name the condition the tools depend on rather than assuming they are there. If you ship the directory outside `<pluginDir>/skills`, make sure your build copies it: the manifest-copy step only knows the names it is told.

### Ops

An op is a named operation in the host's one catalogue, the same catalogue `walnut.ops.call` reads. **This is how a plugin exposes work to AI**, because every AI turn Walnut runs is a Claude Code session and a session reaches Walnut through ops, over the Walnut MCP mount or `walnut tools call`. `walnut.registry.op` lands on `definePluginOp` in `src/ops/registry.ts`, which owns the naming and the ownership check. Register a Tool instead only for the in-process loops that take a tool list, which today means routine watchers. Ops are named `<normalized_plugin_id>_<local_name>` with an underscore, not a colon, and a final name that already belongs to a built-in op is refused rather than allowed to shadow it.

```ts compile=ops
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export function activate(walnut: WalnutServerApi) {
  walnut.registry.op({
    name: 'ping',
    title: 'Ping the plugin',
    description: 'Answer with the greeting this plugin was asked for. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'Who to greet' } },
      required: ['who'],
    },
    readonly: true,
    async handler(args) {
      return { greeting: `hello ${String(args.who)}` }
    },
  })
}
```

`inputSchema` is a JSON Schema object. The host honours `type` (`string`, `number`, `integer`, `boolean`, `array`, `object`), string `enum`, nested `properties`/`required`, and `description`, and ignores `default`. A nested object keeps keys you did not declare, matching JSON Schema rather than dropping them. Invalid arguments never reach the handler: the caller gets `{ ok: false, message }` naming the field. Handlers get a `ctx.call(method, path, body)` for reaching a Walnut API route, because a plugin op has no HTTP binding of its own, and `timeoutMs` is the deadline for each of those calls, not for the handler.

**Know how far an op reaches before you declare one.** A read-only op defaults to `remote: 'allow'`, and `'allow'` means `walnut tools call <op>` inside **every** Walnut-managed session, on every host, can invoke it the moment the plugin activates: those calls arrive through the gateway, which resolves against this server process's own catalogue. `remote: 'deny'` (the default for a write op) keeps the op to in-process callers: `walnut.ops.call`, `GET /api/plugin-runtime/<pluginId>/ops`, `POST /api/plugin-runtime/<pluginId>/ops/<opName>`, and action cards clicked on this Mac (a card clicked on a paired phone is refused). A session on another host cannot reach it through the `api` passthrough's plugin-runtime route either. The passthrough does still reach the plugin's own HTTP routes, so do not put a write that only this Mac may make behind a plain route. Set `remote` explicitly whenever the default is not what you want.

Two surfaces are still blind to plugin ops, because they are separate processes with their own registry: a standalone `walnut …` command, and the stdio MCP server. `docs/reference/ops.md` is generated from the repo's core ops only, for the same reason.

### Services: plugins on top of plugins

A service is how one plugin builds on another. The publisher hands out a bag of methods under `<pluginId>:<name>`, and a plugin that declared the publisher in its manifest `dependencies` calls those methods directly, in the same process, with no HTTP and no serialization. This is the seam a capability plugin stands on: a base plugin publishes, and its provider plugins depend on it.

The manifest line is what makes it safe, because Walnut activates a declared dependency before the plugin that declared it:

```json
{
  "id": "greeting-desk",
  "version": "1.0.0",
  "dependencies": { "greeter-plugin": "^1" }
}
```

The publisher exports the api's type from its own file, and publishes an object of that type:

```ts compile=services-publish
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

/** Export this from the plugin's own `api.ts` so a dependent can `import type` it. */
export interface GreeterApi {
  greet(who: string): string
}

export function activate(walnut: WalnutServerApi) {
  let greeted = 0
  const api: GreeterApi = {
    greet(who) {
      greeted++
      walnut.log.info('greeted someone', { who, greeted })
      return `hi ${who}`
    },
  }
  walnut.services.publish('greeter', api)
}
```

The dependent takes the handle once, in `activate`, and keeps it:

```ts compile=services-require
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

// In a real plugin this type comes from the publisher's own file, by relative path:
//   import type { GreeterApi } from '../../greeter-plugin/src/api.js'
interface GreeterApi {
  greet(who: string): string
}

export function activate(walnut: WalnutServerApi) {
  // Declared as dependencies["greeter-plugin"], so it is already active right here.
  const greeter = walnut.services.require<GreeterApi>('greeter-plugin:greeter')

  walnut.registry.tool({
    name: 'greet',
    description: 'Greet someone through the greeter plugin.',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
    },
    execute: (input) => greeter.greet(String(input.who)),
  })
}
```

Rules to know before you design a service:

- **A capability's type travels as an `import type` from the publisher's own file, never through `@open-walnut/plugin-api`.** Walnut's kernel does not know what a mail or a calendar is, and it must not learn: the shape belongs to the plugin that owns it. Publish an `api.ts` next to your server entry and export the type from there. It is a build-time reference only, so nothing is bundled twice.
- **Publish synchronously inside `activate`.** A plugin that depends on you is activated after you are, and it may call your service during its own `activate`, so a service that only appears after an `await` is a service that is not there when it is first needed.
- **The handle is keyed by the service and resolved at call time.** Take it once and keep it: every call reaches whatever the publisher has published at that moment, so a republish or a reload needs nothing from you. That holds for a method you destructured or stored in a field as well, so `const { greet } = greeter` is safe.
- **Everything is synchronous, on purpose.** There is no awaitable `get`: your declared dependency is already active when your `activate` runs, so waiting could only ever wait for something that is not coming.
- **A published api is a plain bag of methods.** `publish` refuses a class instance, an `EventEmitter`, a `Promise`, or any object with a non-function property, because those carry identity a consumer's handle cannot re-resolve. It also refuses a method named `then`, which would make the handle a thenable and turn `await handle` into a resolution attempt. Close over your state inside the functions instead.
- **`get` is lazy, `require` is eager.** `get` resolves nothing until the first call, so you may hold a handle for a key a peer publishes later. `require` additionally checks that a publisher exists right now, so a mistyped key throws inside your `activate` where the stack still points at it.
- **Gone is loud.** Once the publisher is disabled, uninstalled or broken, every call through the handle throws an error naming the key and the publisher's state. Describing the handle stays safe: `Object.keys(handle)` and `'greet' in handle` answer instead of throwing. Walnut also parks your plugin while a declared dependency is down, so you normally never see this: it is what a handle kept across your own reactivation does.
- **Ask only for what you declared.** `get` on a plugin absent from your `dependencies` throws and names the manifest line you are missing. The exception is `core:<name>`, a capability the host itself publishes (`walnut.services.require('core:calendar-source')`): a plugin cannot declare a dependency on the host, so those keys are gated by `engines.walnut` instead. Never list `core` in `dependencies`: the id is reserved for the host, no plugin may use it, and your plugin would wait forever for something that can never be installed.
- **`onChange`** reports every publish, replace and removal, including your own, and the subscription is owned by your plugin.
- **`caller()` tells a publisher who is calling right now.** Call it on the first line of one of your own service methods and it returns that consumer's plugin id, or `undefined` when the host called you. Use it when a method hands out a REGISTRATION: key the row by owner, subscribe to `plugin:lifecycle-changed`, and drop that owner's rows when it leaves a live state, so a consumer whose `activate` threw right after registering cannot leave you a row you can never attribute or replace. It is only meaningful in the synchronous body of the call: after an `await` it is `undefined`, so read it before you do anything else.

The calendar is the reference for the `core:*` half of this seam. It ships as a built-in plugin in `src/integrations/calendar/`, and everything the macOS calendar grant needs stays in the host: the plugin asks for `core:calendar-source` in its `activate`, and the host publishes that method bag from `src/core/platform-services.ts` before it loads any plugin. Read it when you are designing a plugin around a resource the user cannot be asked to re-authorize: the signed helper that carries the permission stays host side, the plugin owns the polling, the tools, the routes and the config, and its `deactivate` gives all of that back.

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

The other points cover session start, message send, turn start, tool use and result, plan completion, mode change, turn completion and error, task created, updated, phase changed and completed, and cron fired. A handler can declare `priority`, a `timeoutMs` deadline, and a `filter` on modes, projects, phases, sources, or a predicate. One failing hook does not stop the others. The turn points hand the handler a `PluginTurnStartContext`, `PluginTurnCompleteContext` or `PluginTurnErrorContext`; every one carries `sessionId`, a completion carries `result`, a failure carries `error`.

### Reminders, quiet mode and presence

A plugin that interrupts the human on a schedule (a stand-up nudge, a pomodoro, a hydration reminder) needs four things the API provides, and needs nothing from Walnut's core. The bundled `plugin-store/walnut-rhythm` is the worked example.

1. **Know when the human is there.** Subscribe to `time:banked` (attention the console or the phone just recorded, roughly once a minute while someone is present) and, when the user has turned on app sampling in the Time App, `time:outside` (attention in other Mac apps). Fold the records yourself: a gap longer than your threshold means the person was away.
2. **Interrupt with a reminder, not a notice.** `notify({ kind: 'reminder' })` toasts for two minutes, chimes, raises a browser notification when the tab is hidden, and carries up to three buttons. Each button names one of YOUR ops by its local name; the host binds it to your plugin, so a click can never run someone else's op. Re-firing under the same `dedupKey` replaces the previous reminder, and `dismiss` retires it when it stops being true, so the feed never fills with stale copies.
3. **Go quiet while the human focuses.** `notifications.quiet.set({ until, reason })` holds Walnut's quiet mode: every other producer's toasts, chimes, browser notifications and phone pushes wait, the feed still collects, and permission asks still show unless your hold says otherwise. One hold per plugin; `clear` releases it, and so does disabling or reloading the plugin. Read `quiet.get()` or subscribe to `quiet:changed` before you fire, because a reminder raised during quiet lands only in the feed.
4. **Show progress without shouting.** A countdown belongs in a status item (next section): a small ring at the bottom of the rail that ticks on its own and turns orange only when you set `tone: 'warning'`.

```ts compile=reminders
import type {
  PluginTurnCompleteContext, TimeBankedEvent, WalnutServerApi,
} from '@open-walnut/plugin-api/server'

const HOUR = 60 * 60_000
const AWAY = 5 * 60_000

export function activate(walnut: WalnutServerApi) {
  let streakStart = 0
  let lastSeen = 0
  let turnsInFlight = 0

  // 1. presence: a five-minute gap means the person stood up, so the streak restarts.
  walnut.events.on('time:banked', (event) => {
    for (const record of (event.data as TimeBankedEvent).records) {
      const start = Date.parse(record.ts)
      const end = start + record.durationMs
      if (streakStart === 0 || start - lastSeen >= AWAY) streakStart = start
      lastSeen = Math.max(lastSeen, end)
    }
  })

  // Wait for a natural pause: a running agent turn is a bad moment to interrupt.
  walnut.registry.hook({ id: 'turns', point: 'onTurnStart', handler: () => { turnsInFlight += 1 } })
  walnut.registry.hook({
    id: 'turn-ends', points: ['onTurnComplete', 'onTurnError'],
    handler: (context) => {
      turnsInFlight = Math.max(0, turnsInFlight - 1)
      walnut.log.info('turn ended', { sessionId: (context as PluginTurnCompleteContext).sessionId })
    },
  })

  // 2. the reminder, with buttons bound to this plugin's own ops.
  walnut.registry.op({
    name: 'snooze', title: 'Snooze', description: 'Put the reminder off by ten minutes.', readonly: false,
    async handler() { streakStart = Date.now() - HOUR + 10 * 60_000; return { ok: true } },
  })
  walnut.timers.interval(async () => {
    const quiet = await walnut.notifications.quiet.get()
    if (quiet.active || turnsInFlight > 0 || streakStart === 0 || lastSeen - streakStart < HOUR) return
    if (Date.now() - lastSeen >= AWAY) { await walnut.notifications.dismiss('stand-up'); return }
    await walnut.notifications.notify({
      kind: 'reminder',
      title: 'Time to stand up',
      body: 'An hour at the keyboard. Walk for a couple of minutes.',
      dedupKey: 'stand-up',
      actions: [{ label: 'Snooze 10 min', op: 'snooze' }],
    })
    streakStart = Date.now()
  }, 30_000)

  // 3. quiet while a focus block runs; the hold ends on its own at `until`.
  walnut.registry.op({
    name: 'focus', title: 'Start a focus block', description: 'Twenty-five quiet minutes.', readonly: false,
    async handler() {
      await walnut.notifications.quiet.set({ until: Date.now() + 25 * 60_000, reason: 'Focus block' })
      return { ok: true }
    },
  })
}
```

### Sidebar status items

`walnut.ui.statusItem({ id })` gives your plugin a small live item at the bottom of the console's left rail, above Voice. It is data, not a component: you say what is true now and the host draws it the same way for every plugin.

- **The ring ticks on its own.** Give it `timer: { startedAt, endsAt, mode }` in epoch milliseconds; `drain` empties it as time runs out, `fill` fills it up. The collapsed rail shows the minutes left in the centre, or a `glyph` (`check`, `alert`, `stand`, `pause`) instead. Put `{remaining}` in `title` and the host fills in the live time left ("12 min", "1 h 5 min"), so one `set` stays current for the whole block.
- **Tone says how much it matters.** `neutral` (the default) is grey and quiet, `accent` is a running activity, `success` is a finished one, and `warning` is "this needs you now": it turns the label orange and nudges the ring once.
- **Clicking opens a popover** with the title, `detail`, up to three buttons and a link to your App (`app`, a local App id; default your first App). Buttons follow the reminder rule: each names one of YOUR ops by its local name, and the host binds it to your plugin. At most one is `primary`. Name what happens next ("Start break", "Snooze 10 min"), never a bare "Done".
- **It lives as long as you do.** `set` replaces what the item shows and skips the broadcast when nothing changed, so calling it on every state change is fine. `clear` hides it; disabling, reloading or uninstalling the plugin removes it. Items are not saved: after a restart your `activate` publishes again. At most two per plugin.

```ts compile=status-items
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export function activate(walnut: WalnutServerApi) {
  const item = walnut.ui.statusItem({ id: 'focus' })

  walnut.registry.op({
    name: 'start', title: 'Start a focus block', description: 'Twenty-five minutes.', readonly: false,
    async handler() {
      const startedAt = Date.now()
      item.set({
        title: 'Focus · {remaining} left',
        detail: 'Walnut is quiet until it ends.',
        tone: 'accent',
        timer: { startedAt, endsAt: startedAt + 25 * 60_000, mode: 'drain' },
        actions: [{ label: 'Stop block', op: 'stop' }],
      })
      return { ok: true }
    },
  })
  walnut.registry.op({
    name: 'stop', title: 'Stop the focus block', description: 'End it early.', readonly: false,
    async handler() { item.clear(); return { ok: true } },
  })
}
```

Tests read what an item shows from `createFakeWalnut().statusItems`, a map from id to the last state you set.

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

Plugin files live under `~/.open-walnut/plugin-data/<id>/`. That directory is machine-local and excluded from git sync. File methods reject traversal and write atomically. The private database runs in a worker, so a synchronous native SQLite call cannot block Walnut's event loop. When the file does not exist yet, `readJson` and `updateJson` hand back a copy of the fallback you passed, so mutating what you read is safe even if that fallback is a shared constant.

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
- **`placement`**: which surface carries the App's entry row, `'settings'` (the default) or `'sidebar'`. See [Where the App's row lives](#where-the-apps-row-lives).

What the host derives for you, with no second registration:

- **The route**: `/apps/<pluginId>~<appId>`, plus every subpath under it. You never declare a path, and you cannot collide with a Walnut route or another plugin.
- **The entry row**: icon, title, and badge, in the Settings Plugins group, or in the Sidebar beside the Core Apps when the App asks for `placement: 'sidebar'`.
- **Deep links**: `/apps/my-plugin~main/history?tab=recent` opens your App with the rest of the URL handed to your component.
- **A Command Palette entry**: `Open <title>`, refreshed whenever the App list changes.
- **The badge channel**: `handle.setBadge(...)` updates the row live, on whichever surface it sits.
- **Owner lifecycle**: disable, reload, or uninstall the plugin and the App, its route, its entry row, and its palette entry all disappear together.

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

A badge is a number, `'dot'`, `{ text }`, or `null`. A number is a count and draws red, like unread mail. `{ text: '24m' }` is a short status that is not a count (a countdown, a mode) and draws muted; the text is 1 to 6 characters. A non-integer or negative number, or text outside that length, is refused at the call. Set an initial value on the contribution, then move it with the handle as state changes, and clear it with `null` when the user has seen whatever it was counting.

### Where the App's row lives

An App declares which surface carries its entry row. The default, `'settings'`, puts it in Settings under the Plugins group, right below the Plugins section that manages every installed plugin, and gives it no sidebar row at all. `'sidebar'` puts it in the app sidebar next to Home and Tasks instead, and an App only gets that by asking.

```tsx compile=web-placement
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function ReportApp({ subpath }: AppProps) {
    return <main>Report {subpath || 'overview'}</main>
  }

  walnut.ui.app({
    id: 'main',
    title: 'Inbox Zero',
    component: ReportApp,
    placement: 'sidebar',
  })
}
```

Nothing else changes: same route at `/apps/<pluginId>~<appId>`, same deep links, same Command Palette entry, same badge, same owner lifecycle. The Settings row is a real link that navigates to the App's own full-page route, so the App is never squeezed into a settings panel.

Pick by how often the App is opened. The sidebar is for surfaces someone lives in all day and its length is the whole point: every row added there costs every other row a little attention, which is why an App has to ask for it. A report, an audit, an occasional tool, a plugin whose page is mostly its own settings, all belong in the Settings Plugins group, where people already go looking for the things they configure and inspect. The shipped `walnut-time` example and the bundled `walnut-rhythm` plugin both stay there.

**Your `placement` is the default, not the verdict.** Only the person using the sidebar knows whether your App belongs in it, so your plugin's row in Settings → Plugins lists each of its Apps with a **Move to Settings** / **Move to Sidebar** action. Their choice wins over yours, applies immediately, and survives a reload. Write the declaration as the answer that is right for most people and let the rest move it.

Two consequences worth knowing. Because moving the row cannot change what the App can do, code that branches on where its own row currently sits is code that will be wrong: read the route, not the surface. And because Core Apps and legacy webview Apps have no placement of their own to override, they get no Move action at all.

A user can also **Hide** your App there, which removes its entry from either surface while keeping the deep link working. An unknown placement value is refused at the call rather than accepted, because an App that matches no surface would register successfully and then appear nowhere.

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

Core Walnut screens, native plugin Apps, and legacy Webviews are all rows in the same App Registry, so they share one order, one visibility model, one badge shape, and one navigation path. The registry is what the Sidebar, the App host route, the Command Palette, and your plugin's app rows in Settings → Plugins all read.

The consequences worth knowing as an author: a user can hide your App or move it between surfaces from your plugin's row; your App is reachable by URL, palette, and its entry row without you wiring any of the three, and `placement` decides which surface renders that row from the same registration; and your App renders inside its own error boundary, so a render failure names your plugin instead of blanking the console. Home and Settings are recovery surfaces, so Walnut locks their visibility.

Home, Tasks, Notes, Calendar, Routines, and Settings are the Core Apps. Home's Chat, Todo, and Agenda are Dock controls inside Home rather than separate Apps, which is why you will not find them in the App list.

### Stable Views

`walnut.ui.views` hands you host-owned React facades: `CalendarView`, `FileView`, `NoteView`, `TerminalView`, `SessionView`, `TaskView`, `ChatView`, and `PluginSettingsView` (your plugin's generated settings form, for `settingsIn: 'app'`; optional, since an older host does not have it). These are stable contracts, unlike private component imports.

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

A plugin that arrives needing another plugin comes back as `pendingDependencies` on the 201, and nothing else is installed. `POST /api/plugin-sources/<slug>/dependencies` installs that plan after the user has seen the source list (git and npm catalog entries only, three hops at most; an example entry returns its `walnut-plugin link` command instead). Turning off a plugin that others declare in `dependencies` answers 409 `{ code: "has-dependents", dependents }`; `POST /api/plugin-runtime/<id>/disable` with `{ "cascade": true }` turns it off anyway and the dependents move to `needs-dependency` without being switched off themselves.

Because Walnut installs with lifecycle scripts disabled, your published package must already contain its built artifacts. A plugin that expects `postinstall` or `prepare` to build it will install and then fail to load.

A plugin whose `~/.open-walnut/plugins/<id>` is a symlink into a git checkout (what `walnut-plugin link` or a hand-made `ln -s` produces) is a **linked** plugin. Its row in Settings, Plugins shows the checkout, branch, commit, and whether the tree has uncommitted changes, with two buttons: **Check** fetches and reports how many commits the checkout is behind and ahead (a fetch that fails, offline or without access, is reported as such, never as "up to date"), and **Update** fast-forwards the checkout and hot-reloads every plugin linked out of it. Update refuses a dirty or diverged tree (409 `{ code: "dirty" | "diverged" }`) rather than touching your work. The same two operations are `POST /api/plugin-runtime/<id>/linked/check` and `POST /api/plugin-runtime/<id>/linked/update`.

Discovery and reload are different operations: `POST /api/plugin-runtime/discover` only picks up a plugin id the host has not loaded yet, so a plugin that is already loaded keeps the module it was loaded from and the answer comes back with `alreadyLoaded: true` plus a `note` saying so. After you change the files of a plugin that is already running, call `POST /api/plugin-runtime/<id>/reload` instead, which is what `walnut-plugin dev` does on every save.

### Bundled store

The repo folder `plugin-store/` holds plugins that ship inside every Walnut build but are not loaded by default. Each one uses the same layout as `examples/plugins/<id>/`, and the folder name must equal the manifest `id`. The build (`scripts/ship-store-plugins.mjs`, run by `npm run build` and `npm run web:build`) builds each one with `walnut-plugin build`, checks its declared `server` and `web` artifacts, and copies `manifest.json`, `README.md`, `dist/` and `skills/` to `dist/plugin-store/<id>/`.

In Settings, Plugins, a bundled plugin lists under Available with an **Install** button:

- **Install** (`POST /api/plugin-runtime/bundled/<id>/install`) writes `plugins.<id>.enabled: true` and loads the plugin live, with no restart. If nothing could load it (for example, its build output is missing), the config write is taken back and the answer says why.
- Once installed, the row is labelled `Bundled` and has the normal on/off switch.
- **Remove** (`POST /api/plugin-runtime/bundled/<id>/remove`) turns it off, unloads it, and deletes the whole `plugins.<id>` block, settings included, so the row is Available again. It answers 409 `{ code: "has-dependents", dependents }` while another running plugin depends on it.

Only an explicit `enabled: true` makes the loader discover a bundled folder, and the bundled store is scanned last, so a linked or source-installed copy of the same id wins. A bundled plugin is not a builtin: its `engines.walnut` range is enforced strictly and Safe Mode turns it off. The store row takes its name, description and version from the manifest, and the optional manifest `catalog` field supplies `adds`, `homepage` and `docs`. A catalog entry with the same id in `src/data/plugin-registry.json` or `~/.open-walnut/plugin-registry.json` can reword the row but cannot change its source. See `plugin-store/README.md` for adding one.

## Troubleshooting

| State | Meaning | Action |
|---|---|---|
| `active` | The plugin is running. | None. |
| `disabled` | The user disabled the plugin. | Enable it when its code is trusted and ready. |
| `needs-config` | A required config field is missing. | Fill the generated Settings form. |
| `unsupported` | The API version or Walnut engine range is incompatible. | Update Walnut, or install a compatible plugin version. |
| `failed` | Activation threw or timed out. | Read the `plugin/<id>` logs and fix the first error. |
| `quarantined` | The server exited during this plugin's activation twice in a row on the same build (a caught failure only marks `failed` and is retried on the next start). | Fix the code, then clear the quarantine. |

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
