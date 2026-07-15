/**
 * Tests for the notes API routes:
 *
 * B3: PUT /api/notes/global emits notes:updated bus event with correct source/hash
 * B4: GET /api/notes-v2 tree includes root global-notes.md (editable from the
 *     /notes page since the Notion-class editor rework) alongside other notes
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-routes-test'));

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME, GLOBAL_NOTES_FILE, NOTES_DIR } from '../../../src/constants.js';
import { notesRouter } from '../../../src/web/routes/notes.js';
import { notesV2Router } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';
import { computeContentHash } from '../../../src/utils/file-ops.js';

// ── App factories ──

function createNotesApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notes', notesRouter);
  app.use(errorHandler);
  return app;
}

function createNotesV2App() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

// ── Lifecycle ──

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  // Clean up any lingering bus subscribers from previous tests
  bus.clear();
});

afterEach(async () => {
  bus.clear();
  // The notes indexer's debounced update can write into WALNUT_HOME while the
  // recursive rm is traversing (ENOTEMPTY flake) — settle, then retry once.
  try {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  }
});

// ── B3: PUT /api/notes/global emits bus event ─────────────────────────────

describe('B3: PUT /api/notes/global emits notes:updated event', () => {
  it('emits notes:updated with correct source and contentHash', async () => {
    const app = createNotesApp();
    const receivedEvents: BusEvent[] = [];

    bus.subscribe('test-listener', (event) => {
      if (event.name === EventNames.NOTES_UPDATED) {
        receivedEvents.push(event);
      }
    }, { global: true });

    const content = '# My Global Notes\n\nHello world.';
    const res = await request(app)
      .put('/api/notes/global')
      .send({ content });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Bus event must have been emitted
    expect(receivedEvents).toHaveLength(1);

    const event = receivedEvents[0];
    expect(event.name).toBe('notes:updated');

    const payload = event.data as { source: string; contentHash: string };
    // Canonical source: `notes/{vault-path-without-.md}` — 'notes/global' is
    // reserved for a literal vault-root global.md.
    expect(payload.source).toBe('notes/global-notes');

    // Hash must match what computeContentHash produces for the written content
    const expectedHash = computeContentHash(content);
    expect(payload.contentHash).toBe(expectedHash);
    expect(payload.contentHash).toBe(res.body.contentHash);
  });

  it('emits notes:updated with updated hash after each write', async () => {
    const app = createNotesApp();
    const receivedEvents: BusEvent[] = [];

    bus.subscribe('test-listener', (event) => {
      if (event.name === EventNames.NOTES_UPDATED) {
        receivedEvents.push(event);
      }
    }, { global: true });

    await request(app).put('/api/notes/global').send({ content: 'first version' });
    await request(app).put('/api/notes/global').send({ content: 'second version' });

    expect(receivedEvents).toHaveLength(2);

    const hash1 = (receivedEvents[0].data as any).contentHash;
    const hash2 = (receivedEvents[1].data as any).contentHash;

    expect(hash1).toBe(computeContentHash('first version'));
    expect(hash2).toBe(computeContentHash('second version'));
    expect(hash1).not.toBe(hash2);
  });

  it('does not emit when PUT is rejected (missing content)', async () => {
    const app = createNotesApp();
    const receivedEvents: BusEvent[] = [];

    bus.subscribe('test-listener', (event) => {
      if (event.name === EventNames.NOTES_UPDATED) {
        receivedEvents.push(event);
      }
    }, { global: true });

    const res = await request(app)
      .put('/api/notes/global')
      .send({});

    expect(res.status).toBe(400);
    expect(receivedEvents).toHaveLength(0);
  });
});

// ── B4: GET /api/notes-v2 tree includes root global-notes.md ──────────────
// global-notes.md is deliberately IN the v2 tree: the /notes page edits it via
// /api/notes-v2/content/global-notes.md (same doc as the home-panel widget).
// The old root exclusion was removed in the Notion-class editor rework.

describe('B4: GET /api/notes-v2 tree includes root global-notes.md', () => {
  /** Helper: write a file inside NOTES_DIR */
  async function writeNote(relPath: string, content = '# Note'): Promise<void> {
    const fullPath = path.join(NOTES_DIR, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  it('lists global-notes.md as a note alongside regular notes', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Global Notes', 'utf-8');
    await writeNote('regular.md', '# Regular Note');

    const app = createNotesV2App();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const { tree } = res.body;

    const names = (tree as Array<{ name: string }>).map((n) => n.name);
    expect(names).toContain('global-notes.md');
    expect(names).toContain('regular.md');

    const globalNode = (tree as Array<{ name: string; kind?: string }>)
      .find((n) => n.name === 'global-notes.md');
    expect(globalNode?.kind).toBe('note');
  });

  it('includes other .md files in the root', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Global', 'utf-8');
    await writeNote('notes-a.md', '# A');
    await writeNote('notes-b.md', '# B');

    const app = createNotesV2App();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const names = (res.body.tree as Array<{ name: string }>).map((n) => n.name);
    expect(names).toContain('notes-a.md');
    expect(names).toContain('notes-b.md');
    expect(names).toContain('global-notes.md');
  });

  it('includes global-notes.md that lives inside a subfolder', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await writeNote('archive/global-notes.md', '# Not reserved');

    const app = createNotesV2App();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const { tree } = res.body;

    const archiveFolder = (tree as Array<{ name: string; type: string; children?: any[] }>)
      .find((n) => n.name === 'archive' && n.type === 'folder');
    expect(archiveFolder).toBeDefined();
    expect(archiveFolder!.children).toHaveLength(1);
    expect(archiveFolder!.children![0].name).toBe('global-notes.md');
  });

  it('returns just global-notes.md when it is the only file', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Global only', 'utf-8');

    const app = createNotesV2App();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    expect(res.body.tree).toEqual([
      { name: 'global-notes.md', path: 'global-notes.md', type: 'file', kind: 'note' },
    ]);
  });
});
