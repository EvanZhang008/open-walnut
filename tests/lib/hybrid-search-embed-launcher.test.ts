/**
 * The embedder starts its worker processes through a caller's launcher when
 * one is configured (EmbedderConfig.workerLauncher): Walnut passes the utility
 * QoS clamp there when the server was raised to Interactive, so model inference
 * stays in the band the agents run in (src/lib/background-qos.ts).
 *
 * The launcher here is a stand-in that records its argv and execs the rest;
 * the worker is the stop-protocol fixture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, type Embedder } from '../../src/lib/hybrid-search/embedder.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;

let dir = '';
let embedder: Embedder | null = null;

afterEach(async () => {
  await embedder?.dispose();
  embedder = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function launcher(): { program: string; log: string } {
  const program = path.join(dir, 'launcher');
  const log = path.join(dir, 'launcher.log');
  fs.writeFileSync(program, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec "$@"\n`, { mode: 0o755 });
  return { program, log };
}

describe('embed worker launcher', () => {
  it('runs the worker behind the launcher, which execs node with the worker script', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-launcher-'));
    const l = launcher();
    const knobs = { markerFile: path.join(dir, 'marks.txt') };
    embedder = createEmbedder(
      {
        modelId: 'fake/busy:' + JSON.stringify(knobs), dims: 4, workerPath: BUSY_WORKER,
        workerLauncher: { execPath: l.program, execArgv: [process.execPath] },
      },
      () => {},
    );
    expect((await embedder.embedQuery('a query', 15_000))?.source).toBe('worker');
    expect(fs.readFileSync(l.log, 'utf8')).toBe(`${process.execPath} ${BUSY_WORKER}\n`);
  });

  it('without a launcher, forks node directly', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-launcher-'));
    const l = launcher();
    const knobs = { markerFile: path.join(dir, 'marks.txt') };
    embedder = createEmbedder({ modelId: 'fake/busy:' + JSON.stringify(knobs), dims: 4, workerPath: BUSY_WORKER }, () => {});
    expect((await embedder.embedQuery('a query', 15_000))?.source).toBe('worker');
    expect(fs.existsSync(l.log)).toBe(false);
  });
});
