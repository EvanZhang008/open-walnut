# Time (walnut-time)

A first-party plugin App that answers two questions about a day, and keeps them apart: where your attention went, and what your agents ran.

It contributes ONE App with four tabs and no server entry. Time collection, storage, and the `/api/time/*` endpoints all stay in Walnut; this plugin is only a reader of them (the exceptions are the Apps tab's two on/off switches, which write settings, never records), so uninstalling it cannot affect a single recorded minute.

**This is the whole Time UI.** Walnut used to carry a second copy as a Settings section; that section is gone, so this App is where a recorded minute becomes something you can look at. Because time is captured for every install whether or not anything renders it, the plugin **ships as a builtin**: it is present and enabled on a stock install with no install step. Turn it off with `plugins.walnut-time.enabled: false` in `config.yaml`, or from the Plugin Store section of Settings.

## The four tabs

Each tab is a real URL, so any of them can be bookmarked or linked:

| Tab | Path | What it answers |
|---|---|---|
| Overview | `/apps/walnut-time~main/my-time` | Where did my attention go? Human time only, with range, project and kind filters, plus a 7-day trend. |
| Agents | `/apps/walnut-time~main/agents` | What did my agents run? Agent runtime only, never mixed into the human numbers. |
| Apps | `/apps/walnut-time~main/apps` | Where did the rest of the screen time go? Per Mac app, per site for a browser, and per device once a phone's numbers are here. |
| Timeline | `/apps/walnut-time~main/timeline` | How did this one day actually go? |

The Apps tab is the only one that looks outside Walnut, and it is **off until you turn it on**: while disabled it just says what it would collect (the frontmost app every few seconds; browser hosts, never full addresses; no idle or locked time; nothing leaves the Mac) and offers one button. Once enabled it leads with the split that the other three tabs cannot answer, `Outside` / `In Walnut` / `Total`, then ranks apps with a browser's sites nested underneath. Site names need a one-time macOS Automation grant per browser; when a browser was used and no site came back, the tab says so instead of pretending the browser was one opaque block. Both the Apps and Timeline tabs own their own day switcher, so the shared scope bar is hidden on them.

The tab also carries a second, separately switched reading: **Apple Screen Time**, which is how an iPhone's day gets here. macOS already receives it when Screen Time's Share Across Devices is on, and Walnut reads that copy and keeps it, because Apple deletes its own after a few weeks. This one needs Full Disk Access for one small helper, and macOS never prompts for that, so the tab hands over the exact path and opens the right pane. Apple's own count for this Mac is read too but hidden unless asked for, since Walnut already measures this Mac more finely.

Devices never merge. Apple counts by the hour and Walnut samples every five seconds, and a phone's minutes plus a Mac's minutes describe neither machine, so a chip row switches between them and every number says who counted it. For the same reason a device's app rows and its website rows are two lists: Apple counts the domains visited inside a browser as part of that browser's app time, so adding them would double a browsing hour.

The Timeline tab carries three switchable readings of the same day, sharing one hour axis so switching never moves the day under your eye:

- **胶带 Tape**: one serial ribbon, top to bottom, one colour at a time. At any instant a person is doing exactly one thing, so this view can never show two things at once. Idle time is the grey base showing through. A ranked "where it went" list sits beside it and stays pinned while the ribbon scrolls.
- **章节 Chapters**: the day cut at idle gaps over ten minutes, one card per stretch, each with its clock range, its dominant task (or "fragmented work" when nothing held 40% of it), a composition bar that always adds up, and a click to expand the same ribbon zoomed over that stretch alone.
- **泳道 Lanes**: one row per task, time left to right, titles in full in a fixed left column so no bar has to carry text. The top six tasks get their own row and everything else is aggregated into one row. Agents get their own hatched row, and only when the toggle asks for it. Another device gets one row per device, never one per app: Apple reports a bucket's start and how much of it was used, not when inside it, so a bar spans the whole bucket, is drawn hatched, and cites the real used time in its total. A per-app timeline built out of a device-level bucket would be invented data.

The view choice and the agents toggle persist in `localStorage` under `open-walnut-time-app-view` and `open-walnut-time-app-agents`. They are the plugin's own keys rather than the host's, so a change to how Walnut stores its own preferences can never reshape a value this plugin wrote. The retired Settings section's pair (`open-walnut-time-timeline-view` / `-agents`) is still read once as a fallback, so anyone who had settled on Lanes with agents shown keeps that view instead of silently landing back on a bare Tape.

## What it reads

Everything comes from host endpoints through `walnut.http.fetch`, which is same-origin and carries the device credential, so the plugin never handles a token:

- `GET /api/time/summary?days=7` for both report tabs.
- `GET /api/time/blocks?date=…` twice per day view: once with `raw=1` (the serial ribbon the tape and the chapters draw) and once merged per task (what the swimlanes draw).
- `GET /api/time/apps?date=…` for the Apps tab, plus `GET /api/time/apps/blocks?date=…` for the outside-app rows in the swimlanes.
- `GET /api/time/screentime?date=…` for the Apple Screen Time section and the device rows. It reads Walnut's own permanent copy and never touches Apple's store, so it is cheap and cannot hang on a file behind a permission. `POST /api/time/screentime/refresh` is the one call that does read Apple, for the moment right after someone grants the permission.
- `POST /api/permissions/screen-time/open-settings` behind the grant card's button. The host owns the deep link and the clipboard copy, so the two surfaces that offer this fix cannot drift apart.
- `POST /api/time/apps/toggle` and `POST /api/time/screentime/toggle` behind the Enable / Pause buttons. These are the plugin's only writes, and what they write are `config.time.outside.enabled` and `config.time.screentime.*`: the host owns the sampler and the snapshot loop those settings start and stop.
- `GET /api/tasks?fields=list` for titles and the project filter. This one is a nice-to-have: `blocks` joins its own titles server-side, so a failure here costs the reports their names and nothing else.

## Install

Nothing to install: `scripts/ship-builtin-plugins.mjs` runs during `npm run build` and `npm run web:build`, building this directory's web bundle and copying it (with the manifest) into `dist/integrations/walnut-time/`, where builtin discovery finds it.

The author loop, from a checkout of this repository, is still how you iterate on the code:

```bash
npm run build:plugins                                                    # build the plugin API + CLI once
node packages/plugin-cli/dist/cli.js build --root examples/plugins/walnut-time
node packages/plugin-cli/dist/cli.js link  --root examples/plugins/walnut-time
```

`link` symlinks the directory into `~/.open-walnut/plugins/walnut-time`, then asks the running Walnut to discover and load it, so a first install needs no restart. It talks to `http://127.0.0.1:3456` unless `OPEN_WALNUT_API_URL` says otherwise, which is what you want when testing against an isolated server.

⚠️ **A builtin wins a duplicate id.** On a server started from a build that includes the shipped copy, the builtin in `dist/integrations/walnut-time/` shadows a `link`ed checkout, so `dev` rebuilds will appear to do nothing. Either iterate against a server run from source (a `tsx` run resolves builtins to `src/integrations/`, where this plugin is not), or set `plugins.walnut-time.enabled: false` while you work from the link.

```bash
node packages/plugin-cli/dist/cli.js status --root examples/plugins/walnut-time   # state + App URL
node packages/plugin-cli/dist/cli.js dev    --root examples/plugins/walnut-time   # rebuild + reload on save
```

Once it is active, the **Settings → Plugins** group grows a **Time** row pointing at `/apps/walnut-time~main`, right below the Plugins section. The App declares `placement: 'settings'` for that reason: a day report is something you open now and then, and the Sidebar is for the surfaces you live in. Nothing else about the App changes: it is still a full page at its own route, still deep-linkable per tab, and still in the Command Palette as "Open Time".

That declaration is only the default. Anyone who does open their day every morning can move the row into the sidebar from the plugin's row in **Settings → Plugins** (**Move to Sidebar**), and the same button moves it back.

## Develop

```bash
npm run typecheck    # tsc against the plugin API sources
npm run validate     # manifest + entry paths
npm run build        # bundle src/web.tsx into dist/web.mjs
npm run test         # validate + build (this example ships no plugin:test script)
```

`publish-check` deliberately refuses this package: it is `private: true`, like every example plugin in this repository, and publish-check will not publish a private package.

## A note on duplication

There is none left. The view components and the pure geometry modules (`time-timeline.ts`, `time-views.ts`, `time-chapters.ts`) began as copies of the console's Time Tracking section; that section has been deleted, so these are the only copies and nothing has to be kept in step by hand.

The geometry modules are pure on purpose, and their unit tests (`tests/web/time-timeline.test.ts`, `time-views.test.ts`, `time-chapters.test.ts`) import them from here directly. A plugin bundles standalone and must not import host internals, which is why these rules live in the plugin rather than in a shared host module.
