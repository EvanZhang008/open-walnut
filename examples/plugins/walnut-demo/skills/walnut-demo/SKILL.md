---
name: walnut-demo
description: Read the Walnut Plugin Demo's state and explain which Plugin capability does what.
---

# Walnut Plugin Demo

Use this skill when someone asks what the Plugin Demo is doing, whether a plugin capability works, or how a plugin should use one.

## Read its state first

Call `walnut_demo_snapshot` (optional `limit`, 1 to 10). It returns the demo's counters, the tasks in its own project, and the id of the one task it created. `GET /api/plugins/walnut-demo/stats` returns the same picture plus the full registration inventory, the action list, and the timer state.

## What the demo owns

- One reserved project, `Walnut Plugin Demo [walnut-demo]`, claimed only when the persisted demo task proves ownership. Nothing else is claimed, and the Inbox can never be claimed by any plugin.
- One task, created by the `task-create` action. Mutating actions require the id the demo persisted; list and query reads are limited to the `Plugin Demo` project. `task-cleanup` deletes the owned task.
- One secret key, `demo-token`, holding a fixed dummy value. No code path returns a secret value: the demo reports key names and existence only.
- Its own storage: JSON and text files plus a private SQLite database with versioned migrations.

## What it will not do

- No network access from the sync adapter. Every adapter method is implemented and every one is a no-op that counts the call.
- No outbound HTTP unless an operator presses the probe button with the exact fixed URL `https://example.com/`.
- No mutating op invocation. It lists host ops, calls the read-only `walnut_status` op, unwraps the result, and reports keys only.
- No path reporting. Receipts and `/stats` are hand-built JSON, so no data directory and no absolute path appears in them.

## Registered contributions

Server contributions: `sync`, `sourceClaim`, `display`, `migration`, `extIndex`, `tool` (`walnut_demo_snapshot`), `wsMethod` (`walnut-demo:run`), `agent` (`walnut-demo:observer`), `provider` (`walnut-demo:echo`, a local echo), `cronAction` (`walnut-demo:report`), three hooks, `agentContext`, `command` (`/walnut-demo:status`), and this skill directory. Web contributions: one Sidebar App, one auxiliary page, one settings section, injected CSS, and all seven host Views. Everything is owner-scoped: disabling or reloading the Plugin removes all of it.
