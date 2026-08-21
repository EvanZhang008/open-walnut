/**
 * Plugin apps — the catalogue (`GET /api/apps`) and the static file surface
 * (`GET /plugin-apps/<pluginId>/app/...`) for plugins that declare
 * `capabilities.ui.app`.
 *
 * Security model, and why it is shaped this way:
 *
 *  - **Only `<pluginDir>/app/` is reachable.** A plugin directory also holds its
 *    entry code, its manifest, and whatever a plugin author left lying around
 *    (a `.env`, a scratch token file). Serving the plugin dir root would publish
 *    all of it to anyone who can reach the API. So the static root is the `app/`
 *    subdirectory, always, and the manifest's `entry`/`icon` are normalized into
 *    it (integration-loader.validatePluginAssetPath).
 *
 *  - **The traversal guard resolves REAL paths.** A `..` check on the URL alone
 *    is not enough: a symlink inside `app/` pointing at `~/.aws/credentials` has
 *    no `..` in it. Both the root and the target are realpath'd, and the target
 *    must sit under root + path.sep. Encoded escapes (`%2e%2e`) are caught
 *    because the guard decodes each segment BEFORE testing it.
 *
 *  - **The page itself is hostile by design.** The frontend embeds it in an
 *    iframe WITHOUT `allow-same-origin`, so it has an opaque origin: no access to
 *    Walnut's localStorage (the device token), no cookies, no direct `fetch` to
 *    `/api`. Everything it can do arrives over a postMessage bridge the host
 *    validates. That is what makes serving third-party HTML same-origin
 *    acceptable at all.
 *
 *  - **No directory listings, GET/HEAD only.** A request that resolves to a
 *    directory is a 404, not an index.
 *
 * The router dispatches on `:pluginId` and reads the registry LIVE per request,
 * so it is mounted exactly ONCE at startup: a plugin installed later (plugin-store
 * soft reload) is served with no re-mounting, and there is no per-plugin route to
 * double-register.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import { registry } from '../../core/integration-registry.js';
import { getPluginApps } from '../../core/integration-loader.js';
import { log } from '../../logging/index.js';

/** The only subdirectory of a plugin dir that is ever served. */
export const APP_SUBDIR = 'app';

export interface PluginAppView {
  id: string;
  pluginId: string;
  title: string;
  icon: string | null;
  url: string;
}

/** Catalogue rows for the frontend. Paths are opaque to the client on purpose:
 *  only the server knows where a plugin's entry actually lives. */
export function listAppViews(): PluginAppView[] {
  return getPluginApps(registry).map((app) => ({
    id: app.id,
    pluginId: app.pluginId,
    title: app.title,
    icon: app.icon ? `/plugin-apps/${encodeURIComponent(app.pluginId)}/${app.icon}` : null,
    url: `/plugin-apps/${encodeURIComponent(app.pluginId)}/${app.entry}`,
  }));
}

export type ResolveResult =
  | {
      ok: true;
      /** Real absolute path of the file. */
      absPath: string;
      /** Realpath'd `<pluginDir>/app` — pass as res.sendFile's `root`. */
      root: string;
      /** absPath relative to `root`. Pass THIS to res.sendFile, never absPath:
       *  without a `root`, send() dot-checks every segment of the absolute path,
       *  and the real plugin home is `~/.open-walnut/plugins/` — a dot segment
       *  that would 403 every external plugin's app. */
      relPath: string;
    }
  | { ok: false; status: 400 | 404; reason: string };

/** Split a raw (still percent-encoded) URL path into DECODED segments.
 *  Decoding first is what makes `%2e%2e` a `..` segment we can reject, instead
 *  of a weird-looking filename that path.join happily keeps. */
function decodeSegments(rawPath: string): string[] | null {
  const out: string[] = [];
  for (const seg of rawPath.split('/')) {
    if (seg === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null; // malformed escape — refuse rather than guess
    }
    if (decoded === '.') continue;
    out.push(decoded);
  }
  return out;
}

/**
 * Resolve a request path inside a plugin's `app/` dir, or refuse.
 *
 * `requestPath` is the raw, still-encoded path AFTER the plugin id
 * (`/app/index.html`). Exported so the guard can be unit-tested directly — the
 * interesting cases (symlink escape, absolute path, `%2e%2e`, a directory
 * target) are cheaper and far more legible to assert here than over HTTP.
 */
export async function resolveAppAsset(pluginDir: string, requestPath: string): Promise<ResolveResult> {
  const segments = decodeSegments(requestPath);
  if (segments === null) return { ok: false, status: 400, reason: 'malformed percent-encoding' };
  if (segments.length === 0) return { ok: false, status: 404, reason: 'no file requested' };
  if (segments.some((s) => s.includes('\0'))) return { ok: false, status: 400, reason: 'null byte in path' };
  // Only `app/` is served, so the plugin dir root is unreachable by construction.
  if (segments[0] !== APP_SUBDIR) {
    return { ok: false, status: 404, reason: `only ${APP_SUBDIR}/ is served` };
  }
  // Segment-wise (not substring): `v1..2.html` is an ordinary filename.
  if (segments.some((s) => s === '..')) return { ok: false, status: 400, reason: '".." segment' };
  // An absolute segment (from a decoded `%2f`-mangled request) would make
  // path.join reset the base — refuse anything that looks rooted.
  if (segments.some((s) => s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s))) {
    return { ok: false, status: 400, reason: 'absolute path segment' };
  }

  const appRoot = path.join(pluginDir, APP_SUBDIR);
  const candidate = path.join(pluginDir, ...segments);

  // Realpath BOTH sides: a symlink inside app/ can point anywhere, and no
  // string-level check can see that.
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fsp.realpath(appRoot);
  } catch {
    return { ok: false, status: 404, reason: 'plugin has no app/ directory' };
  }
  try {
    realTarget = await fsp.realpath(candidate);
  } catch {
    return { ok: false, status: 404, reason: 'file not found' };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return { ok: false, status: 400, reason: 'resolved outside the app directory' };
  }

  // Directories are not browsable — a listing would expose the plugin's file
  // layout and invites treating app/ as a file server.
  let isFile = false;
  try {
    isFile = (await fsp.stat(realTarget)).isFile();
  } catch {
    return { ok: false, status: 404, reason: 'file not found' };
  }
  if (!isFile) return { ok: false, status: 404, reason: 'not a file' };

  return {
    ok: true,
    absPath: realTarget,
    root: realRoot,
    relPath: path.relative(realRoot, realTarget),
  };
}

/** GET /api/apps — mounted under /api, so it inherits authMiddleware. */
export const appsRouter = Router();

appsRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.json(listAppViews());
  } catch (err) {
    log.web.warn('failed to list plugin apps', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'could not list plugin apps' });
  }
});

/**
 * GET|HEAD /plugin-apps/:pluginId/app/*  — a plugin's own static files.
 *
 * MUST be mounted with the other routers, i.e. BEFORE the production SPA static
 * middleware and its catch-all index.html fallback; otherwise every app URL
 * would return the Walnut shell instead of the plugin's page.
 *
 * Deliberately OUTSIDE the /api mount: these are page/asset loads made by an
 * iframe with an opaque origin, which cannot attach a Bearer token. They expose
 * nothing but files the user chose to install (see the module header).
 */
export const pluginAppStaticRouter = Router();

pluginAppStaticRouter.use(async (req: Request, res: Response) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).type('text/plain').send('Method not allowed');
    return;
  }

  // Parse the mount-relative path ourselves (`/<pluginId>/app/index.html`)
  // instead of leaning on a route pattern: the wildcard syntax differs between
  // express 4 and 5, and `req.url` keeps the ORIGINAL percent-encoding, which the
  // traversal guard needs to see (`req.path` is already decoded).
  const rawPath = (req.url ?? '').split(/[?#]/)[0];
  const slash = rawPath.indexOf('/', 1);
  const rawId = slash < 0 ? rawPath.slice(1) : rawPath.slice(1, slash);
  const rest = slash < 0 ? '' : rawPath.slice(slash);
  let pluginId: string;
  try {
    pluginId = decodeURIComponent(rawId);
  } catch {
    res.status(400).type('text/plain').send('Bad request');
    return;
  }

  const plugin = registry.get(pluginId);
  if (!plugin?.uiApp || !plugin.pluginDir) {
    res.status(404).type('text/plain').send('No app for this plugin');
    return;
  }

  const resolved = await resolveAppAsset(plugin.pluginDir, rest);
  if (!resolved.ok) {
    log.web.debug('plugin app asset refused', { pluginId, path: rawPath, reason: resolved.reason });
    res.status(resolved.status).type('text/plain').send(resolved.status === 400 ? 'Bad request' : 'Not found');
    return;
  }

  // `root` + a RELATIVE path, deliberately. sendFile sets Content-Type from the
  // extension either way, but with an absolute path and no root, send() applies
  // its dotfile rule to EVERY segment of that absolute path — and the real
  // external plugin home is `~/.open-walnut/plugins/`, whose leading dot would
  // then 403 every installed app. Scoping to `root` limits the dot check to the
  // part the request actually chose, which is what we want denied (a stray
  // `.env` sitting inside app/).
  res.sendFile(resolved.relPath, { root: resolved.root, dotfiles: 'deny' }, (err) => {
    if (!err) return;
    if (!res.headersSent) res.status(404).type('text/plain').send('Not found');
    log.web.debug('plugin app sendFile failed', {
      pluginId, path: rawPath, error: err instanceof Error ? err.message : String(err),
    });
  });
});
