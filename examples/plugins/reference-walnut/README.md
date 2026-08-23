# Reference Walnut Plugin

This package is the executable contract test for the public Open Walnut Plugin API. It uses only `@open-walnut/plugin-api` and `@open-walnut/plugin-cli`, so external authors can copy its structure without importing Walnut private source files.

## What it demonstrates

The server entry registers a Tool, Cron action, WebSocket RPC method, Agent, Provider, typed Hooks, Event Bus listener, HTTP route, notification, JSON storage, and private SQLite migration. The native web entry registers sidebar navigation, a page, Settings, owner-scoped CSS, Dashboard panels, and stable `CalendarView`, `SessionView`, `TaskView`, and `ChatView` facades.

The lifecycle test activates, disables, reloads, and disposes the package while checking that every owner-scoped contribution is removed.

## Build and test

```bash
npm install
npm run build
npm run test
npx walnut-plugin validate
npx walnut-plugin publish-check
```

During development, link the package into Walnut with `walnut-plugin link`, then use an isolated Walnut server for browser verification. Do not test against production port 3456.

## Files

- `manifest.json`: API version, Walnut engine range, server entry, web entry, and build sources.
- `src/server.ts`: Server API examples.
- `src/web.tsx`: Native React and stable View examples.
- `skills/reference-walnut/SKILL.md`: A packaged Plugin Skill.

## Trust

This is a full-trust Plugin. Its server code runs with the Walnut process privileges, and its native web code runs in the Walnut browser realm. Review any fork before installing it.
