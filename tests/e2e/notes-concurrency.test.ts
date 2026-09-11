/**
 * E2E tests for Notes concurrency safety — content_hash + optimistic locking.
 *
 * Verifies:
 * 1. content_hash is returned on read and write (global + v2 notes)
 * 2. Optimistic locking: PUT with stale expectedHash → 409 Conflict
 * 3. PUT without expectedHash still works (backward compat)
 * 4. WebSocket notes:updated event is emitted on a note write
 * 5. Full race condition simulation
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('notes-concurrency-e2e'));

import { WALNUT_HOME, GLOBAL_NOTES_FILE, NOTES_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { computeContentHash } from '../../src/utils/file-ops.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function apiGet(p: string) {
  const res = await fetch(apiUrl(p));
  return { status: res.status, body: await res.json() };
}

async function apiPut(p: string, data: unknown) {
  const res = await fetch(apiUrl(p), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  await fs.mkdir(path.dirname(GLOBAL_NOTES_FILE), { recursive: true });
  server = await startServer({ port: 0, dev: true });
  port = (server.address() as any).port;
}, 15_000);

afterAll(async () => {
  if (server) await stopServer(server);
});

// ── Global Notes ──

describe('Global Notes — content_hash', () => {
  it('GET returns contentHash', async () => {
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Hello\n', 'utf-8');

    const { status, body } = await apiGet('/api/notes/global');
    expect(status).toBe(200);
    expect(body.content).toBe('# Hello\n');
    expect(body.contentHash).toBe(computeContentHash('# Hello\n'));
  });

  it('GET returns contentHash for empty content', async () => {
    // Delete the file to test empty content path
    try { await fs.unlink(GLOBAL_NOTES_FILE); } catch {}

    const { status, body } = await apiGet('/api/notes/global');
    expect(status).toBe(200);
    expect(body.content).toBe('');
    expect(body.contentHash).toBe(computeContentHash(''));
  });

  it('PUT returns new contentHash on success', async () => {
    await fs.writeFile(GLOBAL_NOTES_FILE, 'old', 'utf-8');

    const { status, body } = await apiPut('/api/notes/global', {
      content: 'new content',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.contentHash).toBe(computeContentHash('new content'));
  });

  it('PUT with matching expectedHash succeeds', async () => {
    const content = '# Version 1';
    await fs.writeFile(GLOBAL_NOTES_FILE, content, 'utf-8');
    const hash = computeContentHash(content);

    const { status, body } = await apiPut('/api/notes/global', {
      content: '# Version 2',
      expectedHash: hash,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.contentHash).toBe(computeContentHash('# Version 2'));

    const disk = await fs.readFile(GLOBAL_NOTES_FILE, 'utf-8');
    expect(disk).toBe('# Version 2');
  });

  it('PUT with stale expectedHash returns 409', async () => {
    await fs.writeFile(GLOBAL_NOTES_FILE, 'version-A', 'utf-8');
    const staleHash = computeContentHash('something-else');

    const { status, body } = await apiPut('/api/notes/global', {
      content: 'version-B',
      expectedHash: staleHash,
    });
    expect(status).toBe(409);
    expect(body.error).toContain('modified externally');
    expect(body.currentHash).toBe(computeContentHash('version-A'));

    // File should NOT be overwritten
    const disk = await fs.readFile(GLOBAL_NOTES_FILE, 'utf-8');
    expect(disk).toBe('version-A');
  });

  it('PUT without expectedHash still works (backward compat)', async () => {
    await fs.writeFile(GLOBAL_NOTES_FILE, 'old stuff', 'utf-8');

    const { status, body } = await apiPut('/api/notes/global', {
      content: 'new stuff',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── Notes v2 (multi-file) ──

describe('Notes v2 — content_hash', () => {
  it('GET content returns contentHash', async () => {
    const filePath = path.join(NOTES_DIR, 'test-hash.md');
    await fs.writeFile(filePath, '# Test Note\n', 'utf-8');

    const { status, body } = await apiGet('/api/notes-v2/content/test-hash.md');
    expect(status).toBe(200);
    expect(body.content).toBe('# Test Note\n');
    expect(body.contentHash).toBe(computeContentHash('# Test Note\n'));
    expect(body.updatedAt).toBeTruthy();
  });

  it('PUT content returns the hash of the BYTES it wrote', async () => {
    const { status, body } = await apiPut('/api/notes-v2/content/test-put.md', {
      content: '# Created\n',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // A create stamps an id into frontmatter, so the hash is of the stamped
    // file, not of the text the caller sent. Hash the file to prove the client
    // is handed a lock it can actually present on its next write.
    const written = await fs.readFile(path.join(NOTES_DIR, 'test-put.md'), 'utf-8');
    expect(body.contentHash).toBe(computeContentHash(written));
    expect(body.id).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });

  it('PUT with matching expectedHash succeeds', async () => {
    const content = '# V1';
    const filePath = path.join(NOTES_DIR, 'test-lock.md');
    await fs.writeFile(filePath, content, 'utf-8');
    const hash = computeContentHash(content);

    const { status, body } = await apiPut('/api/notes-v2/content/test-lock.md', {
      content: '# V2',
      expectedHash: hash,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toContain('# V2');
    expect(body.contentHash).toBe(computeContentHash(written));
  });

  it('PUT with stale expectedHash returns 409', async () => {
    const filePath = path.join(NOTES_DIR, 'test-conflict.md');
    await fs.writeFile(filePath, 'original', 'utf-8');
    const staleHash = computeContentHash('different');

    const { status, body } = await apiPut('/api/notes-v2/content/test-conflict.md', {
      content: 'stale write',
      expectedHash: staleHash,
    });
    expect(status).toBe(409);
    expect(body.error).toContain('modified externally');

    const disk = await fs.readFile(filePath, 'utf-8');
    expect(disk).toBe('original');
  });

  it('PUT without expectedHash still works (backward compat)', async () => {
    const filePath = path.join(NOTES_DIR, 'test-nolock.md');
    await fs.writeFile(filePath, 'old', 'utf-8');

    const { status, body } = await apiPut('/api/notes-v2/content/test-nolock.md', {
      content: 'new',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── WebSocket notes:updated event ──

describe('notes:updated event', () => {
  afterEach(async () => {
    const { bus } = await import('../../src/core/event-bus.js');
    try { bus.unsubscribe('test-notes-event'); } catch {}
  });

  it('a note write emits notes:updated carrying the new contentHash', async () => {
    // Every writer (the UI, an agent through the note_write op, the CLI) reaches
    // this one route, so this is the single place the event can be proven.
    const { bus } = await import('../../src/core/event-bus.js');
    const events: Array<Record<string, unknown>> = [];
    bus.subscribe('test-notes-event', (event) => {
      if (event.name === 'notes:updated') events.push(event.data as Record<string, unknown>);
    }, { global: true });

    const { status, body } = await apiPut('/api/notes-v2/content/test-event.md', {
      content: '# Written by a tool\n',
    });
    expect(status).toBe(200);

    expect(events.length).toBe(1);
    // The event names the note the way every subscriber keys on it: vault path
    // without the .md extension.
    expect(events[0].source).toBe('notes/test-event');
    // The hash on the wire is the one the writer was just handed, so a listener
    // can recognise its own write instead of reloading over it.
    expect(events[0].contentHash).toBe(body.contentHash);
  });
});

// ── Full race condition simulation ──

describe('Race condition simulation', () => {
  it('prevents UI from overwriting agent write via hash check', async () => {
    // 1. UI reads global notes
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Step 1: UI reads this', 'utf-8');
    const uiRead = await apiGet('/api/notes/global');
    expect(uiRead.status).toBe(200);
    const uiHash = uiRead.body.contentHash;

    // 2. Agent writes via direct file write (simulating files_edit completion)
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Step 2: Agent wrote this', 'utf-8');

    // 3. UI tries to auto-save its stale content with the old hash
    const uiSave = await apiPut('/api/notes/global', {
      content: '# Step 1: UI reads this',
      expectedHash: uiHash,
    });

    // Should be rejected
    expect(uiSave.status).toBe(409);

    // 4. Agent's content should be preserved
    const disk = await fs.readFile(GLOBAL_NOTES_FILE, 'utf-8');
    expect(disk).toBe('# Step 2: Agent wrote this');

    // 5. UI reloads — gets fresh content with new hash
    const reload = await apiGet('/api/notes/global');
    expect(reload.body.content).toBe('# Step 2: Agent wrote this');
    expect(reload.body.contentHash).toBe(computeContentHash('# Step 2: Agent wrote this'));
  });

  it('prevents UI from overwriting agent write on v2 notes', async () => {
    const filePath = path.join(NOTES_DIR, 'race-test.md');

    // 1. UI reads note
    await fs.writeFile(filePath, '# Original', 'utf-8');
    const uiRead = await apiGet('/api/notes-v2/content/race-test.md');
    const uiHash = uiRead.body.contentHash;

    // 2. Agent modifies the file directly
    await fs.writeFile(filePath, '# Agent Modified', 'utf-8');

    // 3. UI tries to save stale content
    const uiSave = await apiPut('/api/notes-v2/content/race-test.md', {
      content: '# Original with UI edits',
      expectedHash: uiHash,
    });
    expect(uiSave.status).toBe(409);

    // 4. Agent's content preserved
    const disk = await fs.readFile(filePath, 'utf-8');
    expect(disk).toBe('# Agent Modified');
  });

  it('allows UI save after reload with fresh hash', async () => {
    // Full flow: read → external modify → 409 → reload → save with new hash
    await fs.writeFile(GLOBAL_NOTES_FILE, '# V1', 'utf-8');

    // Step 1: UI reads
    const read1 = await apiGet('/api/notes/global');
    const hash1 = read1.body.contentHash;

    // Step 2: External modification
    await fs.writeFile(GLOBAL_NOTES_FILE, '# V2 by agent', 'utf-8');

    // Step 3: UI save with stale hash → 409
    const save1 = await apiPut('/api/notes/global', {
      content: '# V1 + edits',
      expectedHash: hash1,
    });
    expect(save1.status).toBe(409);

    // Step 4: UI reloads, gets new hash
    const read2 = await apiGet('/api/notes/global');
    expect(read2.body.content).toBe('# V2 by agent');
    const hash2 = read2.body.contentHash;

    // Step 5: UI saves with correct hash → success
    const save2 = await apiPut('/api/notes/global', {
      content: '# V3 by user',
      expectedHash: hash2,
    });
    expect(save2.status).toBe(200);
    expect(save2.body.contentHash).toBe(computeContentHash('# V3 by user'));
  });
});
