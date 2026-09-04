/**
 * A window that stayed open across a deploy can still fetch ITS OWN build's
 * chunks over HTTP.
 *
 * This is the contract that stops the reported flash (2026-09-03, Mac app: "I
 * click a path, the page flashes, nothing opens; the second click works"). The
 * Mac app window lives across every deploy. A deploy re-hashes and wipes
 * `/assets`, so the old bundle's first fetch of a lazily-loaded chunk — the
 * CodeMirror grammar the Files panel needs, requested only at that click —
 * 404ed, `vite:preloadError` fired, and the tab reloaded on top of the click.
 *
 * Asserted here, at the level the browser actually experiences:
 *  - the previous build's entry AND chunk answer 200 with their real bytes,
 *  - the current build is served for `/` and its own assets,
 *  - a name no build ever had still 404s (the loud path the client's reload
 *    recovery depends on, and the reason a missing asset never becomes HTML).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import { refreshStaticMirror } from '../../src/web/static-mirror';

let tmp: string;
let staticDir: string;
let mirrorDir: string;
let server: Server & { address: () => { port: number } };
let port: number;

const OLD_GRAMMAR = 'grammar-go-OLDHASH.js';
const NEW_GRAMMAR = 'grammar-go-NEWHASH.js';
const OLD_GRAMMAR_BYTES = 'export const goGrammar = "v1"\n';

const indexFor = (hash: string) =>
  `<!doctype html><script type="module" src="/assets/index-${hash}.js"></script>`;

function writeBuild(hash: string, grammar: string, grammarBytes: string) {
  fs.rmSync(path.join(staticDir, 'assets'), { recursive: true, force: true });
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), indexFor(hash));
  fs.writeFileSync(path.join(staticDir, 'assets', `index-${hash}.js`), `entry ${hash}\n`);
  fs.writeFileSync(path.join(staticDir, 'assets', grammar), grammarBytes);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mirror-prev-'));
  staticDir = path.join(tmp, 'stage', 'dist', 'web', 'static');
  mirrorDir = path.join(tmp, 'mirror');
  fs.mkdirSync(staticDir, { recursive: true });

  // Build 1 goes live, and the window that is about to go stale loads it.
  writeBuild('OLDBUILD', OLD_GRAMMAR, OLD_GRAMMAR_BYTES);
  refreshStaticMirror({ staticDir, mirrorDir });
  // A deploy: new hashes, old assets gone from the primary entirely.
  writeBuild('NEWBUILD', NEW_GRAMMAR, 'export const goGrammar = "v2"\n');
  expect(fs.existsSync(path.join(staticDir, 'assets', OLD_GRAMMAR))).toBe(false);

  process.env.WALNUT_WEB_STATIC_DIR = staticDir;
  process.env.WALNUT_WEB_STATIC_MIRROR = mirrorDir;
  const { startServer } = await import('../../src/web/server.js');
  server = await startServer({ port: 0, dev: false }) as typeof server;
  port = server.address().port;
}, 120_000);

afterAll(async () => {
  delete process.env.WALNUT_WEB_STATIC_MIRROR;
  delete process.env.WALNUT_WEB_STATIC_DIR;
  await new Promise<void>((r) => server?.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${port}${p}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

describe('serving a previous build after a deploy', () => {
  it('answers the stale window\'s chunk with its real bytes, not a 404', async () => {
    const chunk = await get(`/assets/${OLD_GRAMMAR}`);
    expect(chunk.status, 'the chunk the click needed must not 404').toBe(200);
    expect(chunk.body).toBe(OLD_GRAMMAR_BYTES);
    expect(chunk.type).toContain('javascript');
    // Its entry bundle too — a hard reload of that window still works.
    expect((await get('/assets/index-OLDBUILD.js')).status).toBe(200);
  });

  it('still serves the CURRENT build for the document and its own assets', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.body, 'a new load must get the new build, not the kept one').toContain('index-NEWBUILD.js');
    expect((await get(`/assets/${NEW_GRAMMAR}`)).status).toBe(200);
    expect((await get('/assets/index-NEWBUILD.js')).status).toBe(200);
  });

  it('reports the bundle it serves, so a tab can tell it has drifted', async () => {
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    expect(cfg.webAssets.bundle).toBe('NEWBUILD');
    expect(cfg.webAssets.ok).toBe(true);
    expect(cfg.webAssets.mirrorReady).toBe(true);
  });

  it('a chunk no build ever had is STILL a loud 404, never the SPA shell', async () => {
    const bogus = await get('/assets/index-NEVEREXISTED.js');
    expect(bogus.status, 'the client reload recovery needs this to stay honest').toBe(404);
    // The exact 2026-08 bug was a 200 carrying index.html, which the browser
    // then tried to parse as a module. Any error body is fine; the SPA shell
    // is not (Express's own 404 page is HTML, hence body and not content-type).
    expect(bogus.body).not.toContain('index-NEWBUILD.js');
    // And a real SPA deep link is unaffected.
    const route = await get('/sessions?id=whatever');
    expect(route.status).toBe(200);
    expect(route.body).toContain('index-NEWBUILD.js');
  });
});
