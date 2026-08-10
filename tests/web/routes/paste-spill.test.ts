/**
 * Oversized-paste spill — POST /api/pastes + the client-side threshold logic.
 *
 * Companion to the image-send fix: a chat message rides ONE WebSocket frame,
 * so a multi-MB paste (a whole log file) must go to disk over HTTP with only
 * the file path in the message. These tests pin the endpoint contract the
 * frontend's spillOversizedText() relies on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-e2e-paste-spill'));

import { WALNUT_HOME, PASTES_DIR } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function postPaste(body: unknown): Promise<Response> {
  return fetch(apiUrl('/api/pastes'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
}, 15_000);

describe('POST /api/pastes', () => {
  it('spills text to disk and returns the absolute path', async () => {
    const text = '日志行\n'.repeat(1000);
    const res = await postPaste({ text });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { path: string; filename: string; chars: number };
    expect(body.path.startsWith(PASTES_DIR)).toBe(true);
    expect(body.filename).toMatch(/^\d+-[a-f0-9]{12}\.txt$/);
    expect(body.chars).toBe(text.length);

    // The file really holds the exact text — the CLI will Read this path.
    const onDisk = await fs.readFile(body.path, 'utf8');
    expect(onDisk).toBe(text);
  });

  it('a multi-MB paste (the incident shape) round-trips intact', async () => {
    // ~5MB — over the old 4MB WS frame cap that closed the socket with 1009.
    const text = 'x'.repeat(5 * 1024 * 1024);
    const res = await postPaste({ text });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { path: string; chars: number };
    expect(body.chars).toBe(text.length);
    const stat = await fs.stat(body.path);
    expect(stat.size).toBe(text.length);
  }, 30_000);

  it('rejects a missing/empty/non-string text with 400', async () => {
    expect((await postPaste({})).status).toBe(400);
    expect((await postPaste({ text: '' })).status).toBe(400);
    expect((await postPaste({ text: 42 })).status).toBe(400);
  });

  it('same content → same hash suffix (content-addressed like images)', async () => {
    const text = 'deterministic content';
    const a = (await (await postPaste({ text })).json()) as { filename: string };
    const b = (await (await postPaste({ text })).json()) as { filename: string };
    const hash = (f: string) => f.split('-')[1]?.split('.')[0];
    expect(hash(a.filename)).toBe(hash(b.filename));
  });
});
