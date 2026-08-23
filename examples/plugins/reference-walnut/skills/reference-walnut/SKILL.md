---
name: reference-walnut
summary: Inspect the executable reference Plugin and its owner-scoped contributions.
---

# Reference Walnut Plugin

Use `reference_walnut_snapshot` when the user asks whether the reference Plugin is active, what it has observed, or which tasks it can read.

The Plugin also provides `GET /api/plugins/reference-walnut/stats`, a cron action named `reference-walnut:snapshot`, and an `onTaskCreated` hook. All contributions disappear when the Plugin is disabled or reloaded.
