/**
 * A boot parses a conversation's chat history once (chat-history.ts readStoreShared).
 *
 * 2026-11-25: the live server parsed its 18 MB main conversation three times in the first
 * 30 s of every boot (about 60 MB of text and objects each, at the restart memory peak):
 * the boot's orphan check, then the conversation-bodies copy's messages and its summary.
 * Readers that only look now share one parse of each version of the file.
 *
 * Pinned:
 *   - the boot-time readers (orphan check, lane orphan pass, the first copy round, a
 *     phone read) parse the main conversation once together;
 *   - a write is read back at once, and data an older version wrote reads the same;
 *   - every function that still takes its own parse is a writer or listed with why, and
 *     no module outside chat-history reads a conversation's store itself: a new reader
 *     (at boot or later) has to pick, so it cannot quietly add a parse.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-chat-history-boot-reads'));

import { WALNUT_HOME, conversationFile } from '../../src/constants.js';
import * as chatHistory from '../../src/core/chat-history.js';
import { getMainConversationId } from '../../src/core/conversations.js';
import { reconcileLaneOrphanTurns } from '../../src/core/sessions/lane-orphan-recovery.js';
import { leaderConversationBodies, _resetConversationBodiesLeaderForTesting } from '../../src/core/replication/kinds/conversation-bodies.js';
import { writeJsonFile } from '../../src/utils/fs.js';
import { _resetJsonKeptForTesting } from '../../src/utils/json-kept.js';
import { _resetJsonIoForTesting, jsonIoTop } from '../../src/core/observability/json-io.js';
import type { ChatEntry, ChatHistoryStore } from '../../src/core/types.js';

const ROOT = path.resolve(__dirname, '../..');
/** Past json-kept's racy window: a file changed this moment is read, never kept. */
const settle = () => new Promise((r) => setTimeout(r, 150));

let mainId: string;
let file: string;
const parses = () => jsonIoTop(50).find((r) => r.file === file)?.reads ?? 0;

function turns(n: number): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    out.push({ tag: 'ai', role: 'user', content: `question ${i}`, timestamp: at, turnId: `turn-${i}` });
    out.push({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }], timestamp: at });
  }
  return out;
}

async function seed(store: Partial<ChatHistoryStore> & Record<string, unknown>): Promise<void> {
  await writeJsonFile(file, store);
  await settle();
  _resetJsonKeptForTesting();
  _resetJsonIoForTesting();
}

beforeEach(async () => {
  _resetConversationBodiesLeaderForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  mainId = await getMainConversationId('general');
  file = conversationFile('general', mainId);
});

afterAll(async () => {
  _resetConversationBodiesLeaderForTesting();
  _resetJsonKeptForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('a boot parses the main conversation once', () => {
  it('the orphan check, the lane orphan pass, the first copy round and a phone read share one parse', async () => {
    // A boot right after a crash: the last message got no answer.
    const entries = turns(20);
    entries.push({ tag: 'ai', role: 'user', content: 'cut off', timestamp: new Date().toISOString(), turnId: 'turn-cut' });
    await seed({ version: 2, lastUpdated: new Date().toISOString(), compactionCount: 1, compactionSummary: 'Earlier: Acme planning.', entries });

    // server.ts boot step.
    await chatHistory.recoverOrphanedUserMessage('general', mainId);
    // server.ts lane orphan pass (8 s after boot), on a lane of this conversation.
    await reconcileLaneOrphanTurns({
      listLanes: async () => [{ sessionId: 'lane-session-1', agentId: 'general', conversationId: mainId, host: null }],
      readStreamTail: async () => null,
    });
    // The first conversation-bodies copy round: its messages and its summary.
    const rows = await leaderConversationBodies();
    expect(rows.map((r) => r.id)).toContain(mainId);
    // A phone's first read of the chat.
    const page = await chatHistory.getDisplayEntries(1, 50, 'general', mainId);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(await chatHistory.getCompactionSummary('general', mainId)).toBe('Earlier: Acme planning.');

    expect(parses()).toBe(1);
  });

  it('a write is read back at once, and the shared value cannot be changed by a reader', async () => {
    await seed({ version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null, entries: turns(3) });
    const before = await chatHistory.getDisplayEntries(1, 100, 'general', mainId);
    expect(before.messages).toHaveLength(6);
    expect(() => { (before.messages[0] as { content: unknown }).content = 'changed'; }).toThrow(TypeError);

    await chatHistory.addAIMessages([{ role: 'user', content: 'new question' }, { role: 'assistant', content: 'new answer' }], { agentId: 'general', conversationId: mainId });
    const after = await chatHistory.getDisplayEntries(1, 100, 'general', mainId);
    expect(after.messages).toHaveLength(8);
    expect(after.messages[0]!.content).toBe('question 0');
  });

  it('a v1 store an older version wrote reads the same, and is migrated on disk as before', async () => {
    await seed({
      version: 1, lastUpdated: '2026-01-01T00:00:00.000Z', compactionCount: 0, compactionSummary: 'old summary',
      apiMessages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      displayMessages: [],
    });
    const page = await chatHistory.getDisplayEntries(1, 100, 'general', mainId);
    expect(page.messages.map((e) => e.content)).toEqual(['hi', 'hello']);
    expect(await chatHistory.getCompactionSummary('general', mainId)).toBe('old summary');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8')) as ChatHistoryStore;
    expect(onDisk.version).toBe(2);
    expect(onDisk.entries).toHaveLength(2);
  });

  it('a store with an orphan tool_result is cleaned on disk the first time a looking reader reads it, as before', async () => {
    const entries: ChatEntry[] = [
      { tag: 'ai', role: 'user', content: 'run it', timestamp: '2026-11-01T00:00:00.000Z' },
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: '2026-11-01T00:00:01.000Z' },
      { tag: 'ai', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x'.repeat(2000) }], timestamp: '2026-11-01T00:00:02.000Z' },
    ];
    await seed({ version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null, entries });
    await chatHistory.getDisplayEntries(1, 100, 'general', mainId);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8')) as ChatHistoryStore;
    expect(onDisk.entries[2]!.compacted).toBe(true);
  });

  it('a missing store reads as empty', async () => {
    await fs.rm(file, { force: true });
    _resetJsonKeptForTesting();
    expect((await chatHistory.getDisplayEntries(1, 100, 'general', mainId)).messages).toEqual([]);
    expect(await chatHistory.getCompactionSummary('general', mainId)).toBeNull();
  });
});

describe('a new reader of a conversation store cannot quietly add a parse', () => {
  /**
   * The functions that take their own parse (readStore) and why. A reader that only looks
   * uses readStoreShared instead; one that changes what it read, or hands it to a caller
   * that does, is listed here.
   */
  const OWN_PARSE: Record<string, string> = {
    readStoreShared: 'reads an older store the writing way once, so it is rewritten as before',
    getModelContext: 'its messages go to the model call, which marks their blocks (cache points, images)',
    addAIMessages: 'writer',
    addUserMessage: 'writer',
    adoptRecoveredAssistantMessage: 'writer',
    adoptCloudTurn: 'writer',
    buildConversationSeed: 'not a boot reader; a caller may pass its own source',
    buildLaneCatchUp: 'not a boot reader; a caller may pass its own source',
    recordLaneSeen: 'writer',
    addNotification: 'writer',
    getTriageEntries: 'not a boot reader',
    addTurn: 'writer',
    compact: 'writer',
  };

  it('every function of chat-history.ts that calls readStore is a known writer or listed with why', async () => {
    const text = await fs.readFile(path.join(ROOT, 'src/core/chat-history.ts'), 'utf-8');
    const callers = new Set<string>();
    let fn = '';
    for (const line of text.split('\n')) {
      const m = /^(?:export )?(?:async )?function (\w+)/.exec(line);
      if (m) fn = m[1]!;
      if (/\breadStore\(/.test(line) && !/^(?:export )?(?:async )?function readStore\(/.test(line)) callers.add(fn);
    }
    expect([...callers].sort()).toEqual(Object.keys(OWN_PARSE).sort());
  });

  it('no module outside chat-history parses a conversation store itself, except the listed ones', async () => {
    // conversations.ts: its five JSON reads (the index, an imported and a legacy store, re-adopting
    // a store with no index row, the first title of a new conversation); none parses the main
    // conversation at boot. A new parse in a module that names conversationFile() changes the count.
    const ALLOWED = new Map([['src/core/conversations.ts', 5]]);
    const found = new Map<string, number>();
    async function walk(dir: string): Promise<void> {
      for (const d of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { await walk(p); continue; }
        if (!d.name.endsWith('.ts')) continue;
        const rel = path.relative(ROOT, p);
        if (rel === 'src/core/chat-history.ts') continue;
        // Any module that both names a conversation's file and parses JSON: the path may sit in a
        // variable first (const file = conversationFile(...); readJsonFile(file)).
        const src = await fs.readFile(p, 'utf-8');
        if (!/\bconversationFile\(/.test(src)) continue;
        const n = (src.match(/\breadJsonFile(?:Kept)?\s*(?:<[^>]*>)?\(/g) ?? []).length;
        if (n > 0) found.set(rel, n);
      }
    }
    await walk(path.join(ROOT, 'src'));
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(ALLOWED));
  });
});
