# Bundled plugin store

Plugins in this folder ship inside every Walnut build, but none of them is loaded by default. Each one shows up in Settings, Plugins, under **Available**, with an **Install** button. Nothing runs until somebody presses it.

This is the place for a plugin that is useful to many people but not to everyone: it costs nothing until it is installed, and installing it needs no git URL, no npm package and no terminal.

## How Install and Remove work

- **Install** writes `plugins.<id>.enabled: true` to `config.yaml` and loads the plugin right away, with no restart. The row moves to **Installed**, labelled `Bundled`, with the usual on/off switch and, when the plugin has settings, **Configure**.
- The switch works like any other plugin's: off writes `enabled: false`, on writes `enabled: true`.
- **Remove** turns the plugin off, unloads it, and deletes the whole `plugins.<id>` block from `config.yaml`, settings included. The row goes back to **Available**. Walnut refuses the Remove while another running plugin depends on it, and names that plugin.
- Only an explicit `enabled: true` counts as installed. A plugin with no `plugins.<id>` block, or with `enabled: false`, is never loaded from here.
- If a plugin with the same id is also installed another way (a `walnut-plugin link`, a git or npm source), that copy wins, as usual for duplicate ids.

The same actions are `POST /api/plugin-runtime/bundled/<id>/install` and `POST /api/plugin-runtime/bundled/<id>/remove`.

## Adding a plugin

Use the same layout as the examples in [`examples/plugins/`](../examples/plugins/):

```
plugin-store/<id>/
  manifest.json   apiVersion 1, engines.walnut, server and/or web entries
  package.json    scripts and dependencies (dependencies may be empty)
  src/            server.ts and/or web.tsx
  skills/         optional
  README.md       what it does, what it needs
```

Rules:

- The folder name must equal the manifest `id` (lowercase letters, digits, `.`, `_`, `-`).
- `engines.walnut` is enforced exactly as for any external plugin.
- Build output goes to `dist/`, which git ignores. You do not commit it.
- Anything listed in the manifest's `build.external` must be one of Walnut's own dependencies, because the plugin runs from inside the Walnut package.

An optional `catalog` field in the manifest tells the store how to describe the plugin before it is installed:

```json
"catalog": {
  "adds": ["App", "Agent tools"],
  "homepage": "https://github.com/EvanZhang008/open-walnut/tree/main/plugin-store/my-plugin",
  "docs": "plugin-store/my-plugin/README.md"
}
```

The store row takes its name, description and version from the manifest. An entry with the same id in `src/data/plugin-registry.json`, or in a user's `~/.open-walnut/plugin-registry.json`, may reword the row (name, description, adds, links), but cannot change where the plugin comes from.

## How it gets into the build

`npm run build` and `npm run web:build` run `scripts/ship-store-plugins.mjs`, which builds every plugin here with `walnut-plugin build`, checks that each declared `server` and `web` artifact exists and is not a stub, and copies `manifest.json`, `README.md`, `dist/` and `skills/` into `dist/plugin-store/<id>/`. A build error in one of these plugins fails the Walnut build, on purpose: a broken bundle would otherwise only show up after someone pressed Install.

To try a plugin while you work on it, `walnut-plugin link plugin-store/<id>` works as for any other plugin, and the linked copy wins over the bundled one.
