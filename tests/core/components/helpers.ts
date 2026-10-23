/**
 * A local release server for component tests, and a tiny component to serve:
 * real HTTP (Range, Content-Length, redirects) with knobs for the ways a
 * download goes wrong (corrupt, cut short, stalled, failing).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { packTar } from '../../../src/lib/tar.js';
import type { ComponentName, ComponentsManifest, ManifestPlatformEntry, Platform } from '../../../src/core/components/types.js';

export const tmpDir = (prefix = 'walnut-comp-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export interface Fault {
  /** Serve these bytes instead (a corrupt mirror). */
  body?: Buffer;
  /** Close the connection after this many bytes, promising the full length. */
  cutAfter?: number;
  /** Send this many bytes, then nothing for `stallMs`. */
  stallAfter?: number;
  stallMs?: number;
  /** Answer with this status. */
  status?: number;
  /** Delay every chunk (a slow link). */
  chunkDelayMs?: number;
  /** Answer a Range request with the whole file (a server without Range support). */
  ignoreRange?: boolean;
}

export interface ReleaseServer {
  base: string;
  serve(asset: string, body: Buffer): void;
  /** Faults applied to the next N requests for an asset, in order. */
  fault(asset: string, ...faults: Fault[]): void;
  requests: Array<{ url: string; range?: string }>;
  close(): Promise<void>;
}

export async function startReleaseServer(): Promise<ReleaseServer> {
  const files = new Map<string, Buffer>();
  const faults = new Map<string, Fault[]>();
  const requests: ReleaseServer['requests'] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    requests.push({ url, range: req.headers.range });
    // GitHub answers asset URLs with a redirect to its storage.
    if (url.startsWith('/redirect/')) { res.writeHead(302, { Location: url.slice('/redirect'.length) }).end(); return; }
    const name = url.slice(1);
    const fault = faults.get(name)?.shift() ?? {};
    if (fault.status) { res.writeHead(fault.status).end('no'); return; }
    const full = fault.body ?? files.get(name);
    if (!full) { res.writeHead(404).end(); return; }
    let start = 0;
    const m = fault.ignoreRange ? null : /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m) start = Number(m[1]);
    if (start >= full.length && full.length > 0) { res.writeHead(416).end(); return; }
    const body = full.subarray(start);
    res.writeHead(m ? 206 : 200, {
      'Content-Length': body.length,
      ...(m ? { 'Content-Range': `bytes ${start}-${full.length - 1}/${full.length}` } : {}),
    });
    void (async () => {
      const chunk = 16 * 1024;
      for (let off = 0; off < body.length; off += chunk) {
        if (res.destroyed) return;
        const piece = body.subarray(off, off + chunk);
        if (fault.cutAfter !== undefined && off + piece.length > fault.cutAfter) {
          // Flushed first, so the client really holds the bytes before the cut.
          await new Promise((r) => res.write(piece.subarray(0, Math.max(0, fault.cutAfter! - off)), r));
          await new Promise((r) => setTimeout(r, 50));
          res.socket?.destroy();
          return;
        }
        if (fault.stallAfter !== undefined && off >= fault.stallAfter) {
          await new Promise((r) => setTimeout(r, fault.stallMs ?? 60_000));
          if (res.destroyed) return;
        }
        if (fault.chunkDelayMs) await new Promise((r) => setTimeout(r, fault.chunkDelayMs));
        await new Promise((r) => res.write(piece, r));
      }
      res.end();
    })();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serve: (asset, body) => { files.set(asset, body); },
    fault: (asset, ...f) => { faults.set(asset, [...(faults.get(asset) ?? []), ...f]); },
    requests,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

export interface FakeComponent {
  archive: Buffer;
  entry: ManifestPlatformEntry;
  manifest: ComponentsManifest;
}

/**
 * A component whose tree is one CommonJS package `fake-lib` (and its own
 * dependency `fake-dep`, resolved from inside the tree): enough to prove a
 * feature loads from the component dir. `padBytes` adds random (incompressible)
 * bytes, so a download is long enough to cut, stall or slow down.
 */
export function fakeComponent(name: ComponentName, platform: Platform, opts: { version?: string; padBytes?: number; marker?: string } = {}): FakeComponent {
  const version = opts.version ?? '1.0.0-1';
  const marker = opts.marker ?? `${name}-${version}`;
  const tar = packTar([
    { path: 'node_modules/fake-dep/index.js', type: 'file', data: Buffer.from(`module.exports = ${JSON.stringify(marker)};\n`) },
    { path: 'node_modules/fake-dep/package.json', type: 'file', data: Buffer.from('{"name":"fake-dep","main":"index.js"}') },
    { path: 'node_modules/fake-lib/index.js', type: 'file', data: Buffer.from("module.exports = { hello: () => 'hello from ' + require('fake-dep') };\n") },
    { path: 'node_modules/fake-lib/index.mjs', type: 'file', data: Buffer.from("export const hello = () => 'esm hello';\n") },
    { path: 'node_modules/fake-lib/package.json', type: 'file', data: Buffer.from('{"name":"fake-lib","main":"index.js"}') },
    ...(opts.padBytes ? [{ path: 'node_modules/fake-lib/pad.bin', type: 'file' as const, data: randomBytes(opts.padBytes) }] : []),
  ]);
  const archive = gzipSync(tar);
  const asset = `walnut-${name}-${version}-${platform}.tar.gz`;
  const entry: ManifestPlatformEntry = {
    asset, size: archive.length, tarSize: tar.length, tarSha256: createHash('sha256').update(tar).digest('hex'),
  };
  const empty = { version: '0.0.0', tag: 'none', entry: '', packages: {}, platforms: {} };
  const manifest: ComponentsManifest = {
    schema: 1,
    repo: 'example/none',
    components: {
      embedding: empty,
      images: empty,
      'audio-capture': empty,
      [name]: { version, tag: `component-${name}-${version}`, entry: 'node_modules/fake-lib/index.mjs', packages: {}, platforms: { [platform]: entry } },
    },
  };
  return { archive, entry, manifest };
}
