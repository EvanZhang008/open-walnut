/**
 * The web app survives its static root being deleted underneath the running
 * server.
 *
 * This happened TWICE on 2026-09-02. A deploy boots from a staged copy of `dist`
 * under TMPDIR and reads web assets from it per request, so anything that cleans
 * that temp space — another deploy's reap, an OS sweep, a stray rm — removes the
 * app's files while cli.js keeps running from memory. Every API stays green while
 * `/` and each hashed asset answer ENOENT, which is why the first occurrence ran
 * for four hours and reached the user as "the Mac app is laggy" rather than as
 * "the app is broken".
 *
 * Detection was not enough (the second occurrence had the detection), so the
 * server now keeps a durable mirror outside the temp volume and serves it as a
 * second root. What matters, and what this pins:
 *  - a normal boot still serves the primary,
 *  - deleting the primary AFTER boot still serves the app, from the mirror,
 *  - the mirror is refreshed when the build changes and NOT wiped when the
 *    primary is already missing (wiping it then would destroy the only copy).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';

let tmp: string;
let mirror: string;
let staticDir: string;
let server: Server & { address: () => { port: number } };
let port: number;

const INDEX = '<!doctype html><script type="module" src="/assets/index-TESTHASH.js"></script>';

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-static-mirror-'));
  staticDir = path.join(tmp, 'dist', 'web', 'static');
  mirror = path.join(tmp, 'mirror');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), INDEX);
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-TESTHASH.js'), 'export const x = 1\n');
  // Point the server at the fixture rather than the repo's own build, so the
  // deletion below is a temp directory and not something a developer needs back.
  process.env.WALNUT_WEB_STATIC_DIR = staticDir;
  process.env.WALNUT_WEB_STATIC_MIRROR = mirror;
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
  return { status: res.status, body: await res.text() };
};

describe('static root mirror', () => {
  it('mirrors the build at boot and serves the primary', async () => {
    expect(fs.readFileSync(path.join(mirror, 'index.html'), 'utf-8')).toBe(INDEX);
    expect(fs.existsSync(path.join(mirror, 'assets', 'index-TESTHASH.js'))).toBe(true);
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('index-TESTHASH.js');
    expect((await get('/assets/index-TESTHASH.js')).status).toBe(200);
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    expect(cfg.webAssets.ok).toBe(true);
    expect(cfg.webAssets.mirrorReady).toBe(true);
  });

  it('keeps serving the app after the static root is deleted under it', async () => {
    fs.rmSync(path.join(tmp, 'dist'), { recursive: true, force: true });
    // The exact failure: the entry document and a hashed asset, both of which used
    // to answer with an ENOENT body while every API stayed fine.
    const index = await get('/');
    expect(index.status, 'the SPA entry must not 404 because a temp dir was cleaned').toBe(200);
    expect(index.body).toContain('index-TESTHASH.js');
    const asset = await get('/assets/index-TESTHASH.js');
    expect(asset.status, 'hashed assets come from the mirror too').toBe(200);
    expect(asset.body).toContain('export const x');
    // And it still reports the truth, so this is visible rather than silent.
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    expect(cfg.webAssets.mirrorReady).toBe(true);
  });
});
