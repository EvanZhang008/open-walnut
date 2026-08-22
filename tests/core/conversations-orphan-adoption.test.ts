/**
 * Conversation index self-heal (2026-08-22 vanished-conversation incident).
 *
 * _index.json syncs whole-file with last-writer-wins. When a replica adds a
 * new conversation row while the primary bumps a different row inside the same
 * sync window, the LWW merge keeps ONE side and the other side's new row is
 * annihilated — while the conversation FILE survives on every box (one file
 * per conversation, no cross-box conflict). Every list/read then 404s a
 * conversation whose full content sits on disk.
 *
 * Two defenses under test:
 *  1. adoptOrphanedConversationFiles (via listConversations): the index is a
 *     materialized view — a conv file with no row is re-adopted with metadata
 *     derived deterministically from its content.
 *  2. ensureConversationRow: the primary's relay accept writes the row itself
 *     so both sides of any index merge carry it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  migrateIfNeeded,
  listConversations,
  createConversation,
  ensureConversationRow,
} from '../../src/core/conversations.js';
import {
  WALNUT_HOME,
  conversationDir,
  conversationIndexFile,
  conversationFile,
} from '../../src/constants.js';
import type { ChatHistoryStore, ConversationIndex } from '../../src/core/types.js';

const AGENT = 'general';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

function storeWith(entries: ChatHistoryStore['entries'], lastUpdated: string): ChatHistoryStore {
  return { version: 2, lastUpdated, compactionCount: 0, compactionSummary: null, entries };
}

async function writeConvFile(id: string, store: ChatHistoryStore): Promise<void> {
  await fsp.mkdir(conversationDir(AGENT), { recursive: true });
  await fsp.writeFile(conversationFile(AGENT, id), JSON.stringify(store, null, 2), 'utf-8');
}

async function readIndexRaw(): Promise<ConversationIndex> {
  return JSON.parse(await fsp.readFile(conversationIndexFile(AGENT), 'utf-8')) as ConversationIndex;
}

describe('orphaned conversation file adoption (the LWW annihilation repair)', () => {
  it('re-adopts a conv file whose index row was lost, deriving title/timestamps/count from content', async () => {
    await migrateIfNeeded(AGENT);

    // The incident shape: the file exists (both boxes have it) but the index
    // row was eaten by a whole-file LWW merge.
    const orphanId = 'conv-59be4c9c-3253-4fa5-84f2-a62d62949738';
    await writeConvFile(orphanId, storeWith([
      {
        tag: 'ai', role: 'user', timestamp: '2026-08-22T19:27:37.495Z',
        content: 'Create a project called Stock Analyzer, and inside it a task',
      },
      {
        tag: 'ai', role: 'assistant', timestamp: '2026-08-22T19:27:52.000Z',
        content: [{ type: 'text', text: 'Done — project created.' }],
      },
    ], '2026-08-22T19:27:52.000Z'));

    const list = await listConversations(AGENT);
    const adopted = list.find((c) => c.id === orphanId);
    expect(adopted).toBeDefined();
    expect(adopted!.title).toContain('Stock Analyzer');
    expect(adopted!.createdAt).toBe('2026-08-22T19:27:37.495Z'); // first entry's timestamp
    expect(adopted!.lastMessageAt).toBe('2026-08-22T19:27:52.000Z'); // store lastUpdated
    expect(adopted!.messageCount).toBe(2);
    // Adoption never steals main: the migrated original keeps it.
    expect(adopted!.isMain).toBeFalsy();
    expect(list.filter((c) => c.isMain)).toHaveLength(1);

    // Persisted, not just projected — the next raw read has the row.
    const raw = await readIndexRaw();
    expect(raw.conversations.some((c) => c.id === orphanId)).toBe(true);
  });

  it('adoption is deterministic — a second box adopting the same file derives the identical row', async () => {
    await migrateIfNeeded(AGENT);
    const orphanId = 'conv-11111111-2222-4333-8444-555555555555';
    const store = storeWith([
      { tag: 'ai', role: 'user', timestamp: '2026-08-01T00:00:00.000Z', content: 'hello there' },
    ], '2026-08-01T00:00:01.000Z');
    await writeConvFile(orphanId, store);
    const first = (await listConversations(AGENT)).find((c) => c.id === orphanId)!;

    // Simulate the OTHER box: wipe the row again (as an LWW merge would), keep
    // the file byte-identical, adopt again.
    const raw = await readIndexRaw();
    raw.conversations = raw.conversations.filter((c) => c.id !== orphanId);
    await fsp.writeFile(conversationIndexFile(AGENT), JSON.stringify(raw, null, 2), 'utf-8');
    const second = (await listConversations(AGENT)).find((c) => c.id === orphanId)!;

    expect(second.title).toBe(first.title);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastMessageAt).toBe(first.lastMessageAt);
    expect(second.messageCount).toBe(first.messageCount);
  });

  it('ignores unreadable/garbage conv files and non-conversation files', async () => {
    await migrateIfNeeded(AGENT);
    const before = (await listConversations(AGENT)).length;
    await fsp.mkdir(conversationDir(AGENT), { recursive: true });
    await fsp.writeFile(path.join(conversationDir(AGENT), 'conv-badbadbad-0000-4000-8000-000000000000.json'), 'not json', 'utf-8');
    await fsp.writeFile(path.join(conversationDir(AGENT), 'conv-x.working-memory.md'), '# wm', 'utf-8');
    await fsp.writeFile(path.join(conversationDir(AGENT), 'notes.txt'), 'hi', 'utf-8');

    const list = await listConversations(AGENT);
    expect(list.length).toBe(before);
  });

  it('an adopted orphan OLDER than the real main never steals main', async () => {
    // The real incident had a 1540-entry orphan whose first entry (2026-02)
    // predates the current main (2026-06). Derived createdAt must not win the
    // oldest-is-main self-heal.
    await migrateIfNeeded(AGENT);
    const { getMainConversationId } = await import('../../src/core/conversations.js');
    const mainBefore = await getMainConversationId(AGENT);

    const ancientId = 'conv-99999999-8888-4777-8666-555555555555';
    await writeConvFile(ancientId, storeWith([
      { tag: 'ai', role: 'user', timestamp: '2020-01-01T00:00:00.000Z', content: 'very old thread' },
    ], '2020-01-02T00:00:00.000Z'));
    await listConversations(AGENT); // triggers adoption

    const mainAfter = await getMainConversationId(AGENT);
    expect(mainAfter).toBe(mainBefore);
    const list = await listConversations(AGENT);
    expect(list.find((c) => c.id === ancientId)?.isMain).toBeFalsy();
    expect(list.filter((c) => c.isMain)).toHaveLength(1);
  });

  it('does not resurrect a DELETED conversation twice in a row of listConversations calls after deleteConversation', async () => {
    // deleteConversation unlinks the file, so adoption has nothing to adopt —
    // this pins that delete stays delete (adoption keys off files on disk).
    await migrateIfNeeded(AGENT);
    const created = await createConversation(AGENT, 'to be deleted');
    const { deleteConversation } = await import('../../src/core/conversations.js');
    await deleteConversation(AGENT, created.id);
    const list = await listConversations(AGENT);
    expect(list.some((c) => c.id === created.id)).toBe(false);
  });
});

describe('ensureConversationRow (primary-side row materialization for relayed turns)', () => {
  it('creates a missing row with a title derived from the seed text', async () => {
    await migrateIfNeeded(AGENT);
    const id = 'conv-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await ensureConversationRow(AGENT, id, 'Research NVDA Q2 earnings for me');
    const list = await listConversations(AGENT);
    const row = list.find((c) => c.id === id);
    expect(row).toBeDefined();
    expect(row!.title).toContain('Research NVDA');
    expect(row!.isMain).toBeFalsy();
  });

  it('is idempotent and never clobbers an existing row', async () => {
    await migrateIfNeeded(AGENT);
    const created = await createConversation(AGENT, 'Original Title');
    await ensureConversationRow(AGENT, created.id, 'a completely different seed');
    const list = await listConversations(AGENT);
    const row = list.find((c) => c.id === created.id)!;
    expect(row.title).toBe('Original Title');
    expect(list.filter((c) => c.id === created.id)).toHaveLength(1);
  });

  it('swallows invalid ids (best-effort contract — never throws into a chat turn)', async () => {
    await migrateIfNeeded(AGENT);
    await expect(ensureConversationRow(AGENT, '../../evil', 'x')).resolves.toBeUndefined();
    const list = await listConversations(AGENT);
    expect(list.some((c) => c.id.includes('evil'))).toBe(false);
  });
});
