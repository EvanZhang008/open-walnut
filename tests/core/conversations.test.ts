/**
 * Unit tests for the conversation registry (src/core/conversations.ts), focused on
 * the MAIN-conversation invariant introduced in round 2:
 *   - exactly ONE isMain per agent after migrate / create / delete / back-fill
 *   - the main conversation is never deletable (throws "main")
 *   - getMainConversationId back-fills a legacy (pre-isMain) index idempotently
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  migrateIfNeeded,
  listConversations,
  createConversation,
  deleteConversation,
  getMainConversationId,
  getActiveConversationId,
  setActiveConversationId,
} from '../../src/core/conversations.js';
import {
  WALNUT_HOME,
  conversationIndexFile,
  conversationFile,
} from '../../src/constants.js';
import type { ConversationIndex, ConversationMeta } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function countMain(list: ConversationMeta[]): number {
  return list.filter((c) => c.isMain).length;
}

describe('main-conversation invariant', () => {
  it('migrateIfNeeded marks the first conversation as main', async () => {
    await migrateIfNeeded('general');
    const list = await listConversations('general');
    expect(list).toHaveLength(1);
    expect(countMain(list)).toBe(1);
    expect(list[0].isMain).toBe(true);
  });

  it('createConversation makes side conversations (exactly one main stays)', async () => {
    await migrateIfNeeded('general');
    await createConversation('general', 'Side A');
    await createConversation('general', 'Side B');
    const list = await listConversations('general');
    expect(list).toHaveLength(3);
    expect(countMain(list)).toBe(1);
    // The single main outranks the others in the sorted list.
    expect(list[0].isMain).toBe(true);
  });

  it('the very first conversation of a brand-new agent becomes main via createConversation', async () => {
    // No migrate first — createConversation runs migrateIfNeeded internally, which
    // creates the main; the explicit create is then a side conversation.
    const first = await createConversation('fresh-agent');
    const list = await listConversations('fresh-agent');
    expect(countMain(list)).toBe(1);
    // The main is the migrate-created one, not the explicitly created side conv.
    const main = list.find((c) => c.isMain)!;
    expect(main.id).not.toBe(first.id);
  });

  it('getMainConversationId is idempotent and does not create duplicates', async () => {
    await migrateIfNeeded('general');
    const a = await getMainConversationId('general');
    const b = await getMainConversationId('general');
    expect(a).toBe(b);
    const list = await listConversations('general');
    expect(countMain(list)).toBe(1);
  });

  it('stores namespaced Plugin agents under a cross-platform path segment', async () => {
    const agentId = 'sample-plugin:observer';
    const side = await createConversation(agentId, 'Plugin side chat');
    const list = await listConversations(agentId);

    expect(list.some((conversation) => conversation.id === side.id)).toBe(true);
    expect(countMain(list)).toBe(1);
    expect(conversationIndexFile(agentId)).toContain('sample-plugin%3Aobserver');
    await expect(fsp.stat(conversationFile(agentId, side.id))).resolves.toBeDefined();
  });
});

describe('deleteConversation guards the main', () => {
  it('refuses to delete the main conversation (error message contains "main")', async () => {
    await migrateIfNeeded('general');
    const mainId = await getMainConversationId('general');
    await expect(deleteConversation('general', mainId)).rejects.toThrow(/main/i);
    // Still present + still exactly one main.
    const list = await listConversations('general');
    expect(list.some((c) => c.id === mainId)).toBe(true);
    expect(countMain(list)).toBe(1);
  });

  it('deletes a side conversation while keeping exactly one main', async () => {
    await migrateIfNeeded('general');
    const side = await createConversation('general', 'Side');
    await deleteConversation('general', side.id);
    const list = await listConversations('general');
    expect(list.some((c) => c.id === side.id)).toBe(false);
    expect(countMain(list)).toBe(1);
  });
});

describe('back-fill for legacy (pre-isMain) indexes', () => {
  async function writeLegacyIndex(agentId: string, index: ConversationIndex) {
    await fsp.mkdir(
      conversationIndexFile(agentId).slice(0, conversationIndexFile(agentId).lastIndexOf('/')),
      { recursive: true },
    );
    await fsp.writeFile(conversationIndexFile(agentId), JSON.stringify(index), 'utf8');
  }

  it('promotes the OLDEST conversation even when a NEWER one is active, and persists', async () => {
    // Back-fill must pick the oldest (the migrated/original thread), NOT the active
    // one — "active" is just whatever was last clicked. Regression test for the bug
    // where a freshly-created active side conversation wrongly became main.
    const now = new Date().toISOString();
    const c1: ConversationMeta = {
      id: 'conv-aaaaaaaa-0000-0000-0000-000000000001', agentId: 'legacy', title: 'old1',
      createdAt: '2020-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 1,
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    const c2: ConversationMeta = {
      id: 'conv-aaaaaaaa-0000-0000-0000-000000000002', agentId: 'legacy', title: 'old2',
      createdAt: '2021-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 1,
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    // c2 is ACTIVE but c1 is OLDER → main must be c1.
    await writeLegacyIndex('legacy', { version: 1, activeConversationId: c2.id, conversations: [c1, c2] });
    await fsp.writeFile(conversationFile('legacy', c1.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));
    await fsp.writeFile(conversationFile('legacy', c2.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));

    const mainId = await getMainConversationId('legacy');
    expect(mainId).toBe(c1.id); // oldest, NOT the active c2

    // Persisted: re-reading the list shows exactly one main = c1.
    const list = await listConversations('legacy');
    expect(countMain(list)).toBe(1);
    expect(list.find((c) => c.isMain)!.id).toBe(c1.id);
  });

  it('self-heals a mis-assigned main (corrects a non-oldest main to the oldest)', async () => {
    // An early buggy back-fill could persist isMain on a newer conversation. The next
    // getMainConversationId call must correct it to the oldest.
    const now = new Date().toISOString();
    const original: ConversationMeta = {
      id: 'conv-cccccccc-0000-0000-0000-000000000001', agentId: 'legacy3', title: 'original',
      createdAt: '2020-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 240,
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    const sideWronglyMain: ConversationMeta = {
      id: 'conv-cccccccc-0000-0000-0000-000000000002', agentId: 'legacy3', title: 'hi',
      createdAt: '2022-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 2,
      isMain: true, // ← wrongly flagged by the old heuristic
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    await writeLegacyIndex('legacy3', { version: 1, activeConversationId: sideWronglyMain.id, conversations: [original, sideWronglyMain] });
    await fsp.writeFile(conversationFile('legacy3', original.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));
    await fsp.writeFile(conversationFile('legacy3', sideWronglyMain.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));

    const mainId = await getMainConversationId('legacy3');
    expect(mainId).toBe(original.id); // corrected to oldest

    const list = await listConversations('legacy3');
    expect(countMain(list)).toBe(1);
    expect(list.find((c) => c.isMain)!.id).toBe(original.id);
  });

  it('promotes the OLDEST conversation when there is no active id', async () => {
    const now = new Date().toISOString();
    const older: ConversationMeta = {
      id: 'conv-bbbbbbbb-0000-0000-0000-000000000001', agentId: 'legacy2', title: 'older',
      createdAt: '2019-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 1,
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    const newer: ConversationMeta = {
      id: 'conv-bbbbbbbb-0000-0000-0000-000000000002', agentId: 'legacy2', title: 'newer',
      createdAt: '2022-01-01T00:00:00.000Z', lastMessageAt: now, messageCount: 1,
      lastDistilledAt: null, lastDistilledMessageCount: 0,
    };
    await writeLegacyIndex('legacy2', { version: 1, activeConversationId: null, conversations: [newer, older] });
    await fsp.writeFile(conversationFile('legacy2', older.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));
    await fsp.writeFile(conversationFile('legacy2', newer.id), JSON.stringify({ version: 2, lastUpdated: now, compactionCount: 0, compactionSummary: null, entries: [] }));

    const mainId = await getMainConversationId('legacy2');
    expect(mainId).toBe(older.id); // oldest by createdAt
  });

  it('after back-fill, deleting the (now-main) conversation is blocked', async () => {
    await migrateIfNeeded('general');
    await setActiveConversationId('general', (await getActiveConversationId('general')));
    const mainId = await getMainConversationId('general');
    await expect(deleteConversation('general', mainId)).rejects.toThrow(/main/i);
  });
});
