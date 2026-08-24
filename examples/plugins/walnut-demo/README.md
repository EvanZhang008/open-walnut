# Walnut Plugin Demo

A working plugin that exercises every public Open Walnut plugin capability from one interactive app. It is meant to be read as much as run: each capability is wired the way an author should wire it, and each trigger shows the receipt it got back, so you can see what a capability actually returns instead of guessing from a type.

It depends only on `@open-walnut/plugin-api` and `@open-walnut/plugin-cli`, so you can copy this directory as the starting point for your own plugin.

## The app

The main browser surface is one App registered through `walnut.ui.app`, plus one auxiliary `ui.page`, one settings panel, and one injected stylesheet. The App automatically gets its Sidebar entry, route, deep link, Command Palette entry, badge, and owner-scoped lifecycle. The auxiliary page proves that a Plugin can add a native route without adding another Sidebar App.

The app has six sections, and the section comes from the route the host passes in, so `<app route>/views` opens the host views section directly and switching tabs moves the host's URL:

| Section | What it shows |
| --- | --- |
| App platform | Shared React state, host theme tokens, the App badge (count, dot, cleared), host-derived deep links, an auxiliary page, and the container layout mode |
| Host views | `TaskView`, `CalendarView`, `NoteView`, `FileView`, `ChatView`, `SessionView` and `TerminalView`, mounted one at a time |
| Web API | The WS method round trip, the Plugin's own HTTP route, the event echo, `ops.list/call/unwrap`, and the type of each unsafe handle |
| Server API | Tasks, config, storage (JSON, text, SQLite), secrets, timers, notifications, outbound HTTP, ops and the unsafe handle |
| Registry | The live host registration inventory plus direct handler and adapter probes, labelled separately so a local probe is never mistaken for host dispatch |
| Lifecycle | Reload, disable, and a deliberate crash that shows the host's plugin error boundary |

Every trigger is one button with a stable test id (`plugin-demo-action-<action>`) and one receipt underneath it (`plugin-demo-receipt-<action>`), so the same surface drives both a human demo and an end to end test.

## Capability matrix

Server API, in `src/server.ts` and `src/server/`:

| Capability | How the demo uses it |
| --- | --- |
| `tasks` | Runs `get`, `list`, `query`, `children`, `create`, `update`, `appendNote`, `appendLog`, `complete`, and `delete` against its own project and persisted task id |
| `config` | Reads, patches, and observes its own config block through an owner-scoped `onChange` listener |
| `storage` | Runs JSON and text reads and writes, list and delete, plus SQLite `migrate`, `exec`, `run`, `get`, and `all` |
| `secrets` | Writes one key holding a fixed dummy value, then reports key names and existence only |
| `timers` | A one shot timeout that emits an event, and an interval you can start and stop |
| `notifications` | An informational notice, a recoverable error notice, and recovery |
| `events` | One prefix subscription, plus emits the browser echoes |
| `http` | An inbound read-only route, plus a user-triggered outbound fetch restricted to the fixed URL `https://example.com/` |
| `ops` | Lists the catalogue, calls the read-only `walnut_status` op, and unwraps its result while reporting keys only |
| `unsafe` | Reports the type of each handle and never anything reached through one |

Registry categories, all registered for real in `src/server/registrations.ts`:

| Category | Registration |
| --- | --- |
| `sync` | Full adapter, every method implemented, every method a no op, no network |
| `sourceClaim` | Exact reserved project name plus persisted demo-task ownership |
| `display` | A `DEMO` badge, and an external URL that is always null because there is no external system |
| `migration` | Identity: returns the tasks unchanged |
| `extIndex` | One `json_extract` path inside the demo's own `ext` block |
| `tool` | `walnut_demo_snapshot`, read only |
| `wsMethod` | `walnut-demo:run`, the one entry point the app uses |
| `agent` | `walnut-demo:observer`, the agent the demo's `ChatView` talks to |
| `provider` | `walnut-demo:echo`, a local echo with no credentials and no network |
| `cronAction` | `walnut-demo:report`, a read only counter report |
| `hook` | Three points (`onSessionStart`, `onTaskCreated`, `onTurnComplete`), counting only |
| `agentContext` | One sentence telling the Personal AI what this plugin is |
| `command` | `/walnut-demo:status` |
| `skill` | `skills/walnut-demo`, registered as an absolute directory derived from the built module's own URL |

## Safety boundary

The demo is deliberately conservative, because a demo that surprises you is a bad demo. What holds by construction:

- It owns exactly one reserved project, `Walnut Plugin Demo [walnut-demo]`, and one task. The source claim requires both the exact project name and the persisted id of that task. Every task action refuses to run against any other id. `Clean up demo task` removes it.
- The sync adapter opens no network connection and mutates nothing. Its direct adapter probe runs against an inert context whose write methods throw, so the probe cannot become a write even if the adapter changed.
- No secret value ever leaves the server. The stored value is a fixed dummy, and the only secret facts the API reports are key names and whether a key exists.
- No host path is reported. Receipts and the `/stats` payload are hand built JSON objects, so the data directory, the Walnut home directory and any absolute path stay out of the response. Stored files appear as names relative to the plugin's own directory.
- Outbound HTTP is opt in per click and restricted to the fixed reserved URL `https://example.com/`. Every other target is rejected.
- The Ops demos invoke only the read-only `walnut_status` op. Receipts report result keys, never status values.
- The lifecycle buttons act on this plugin id only, and disable asks for confirmation first because it removes the app you are standing in.

The crash button is the one intentionally destructive control: it throws inside the app's own React tree so you can watch the host contain the failure. Reload the plugin or refresh the page to come back.

## Receipts endpoint

`GET /api/plugins/walnut-demo/stats` returns the capability list, the counters, the registration inventory, the action list, the timer state, the demo task id, secret key names, the names of stored files, and the recent receipts. It is read only, and it is what the Registry and Web API sections render.

## Build and check

From the Open Walnut repository checkout, build the unpublished author packages and then build and validate the Demo:

```bash
npm run build:plugins
node packages/plugin-cli/dist/cli.js build --root examples/plugins/walnut-demo
node packages/plugin-cli/dist/cli.js validate --root examples/plugins/walnut-demo
npm --prefix examples/plugins/walnut-demo run typecheck
```

Link it into an isolated Walnut install during development. Do not point the Demo at a production server.

## Files

- `manifest.json`: api version 1, engine range, server and web entries, build sources.
- `src/server.ts`: activation, the `run` WS method, and the read only stats route.
- `src/server/registrations.ts`: every registry category.
- `src/server/actions.ts`: one safe named action per server capability.
- `src/server/sync.ts`: the network free task source adapter.
- `src/server/state.ts`: counters, receipts and the SQLite audit table.
- `src/web.tsx`: the App, auxiliary page, settings, stylesheet, and browser event registration.
- `src/web/`: the six sections, the shared UI kit, and the injected CSS.
- `skills/walnut-demo/SKILL.md`: the packaged skill.

## Trust

This is a full trust plugin. Server code runs with the Walnut process privileges and native web code runs in the Walnut browser realm. Read a plugin before you install it, including this one.
