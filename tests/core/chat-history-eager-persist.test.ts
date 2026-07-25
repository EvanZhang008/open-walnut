/**
 * Unit tests for the eager-persist fix in ChatHistoryManager.
 * Covers addUserMessage, dedup guard in addAIMessages, recoverOrphanedUserMessage,
 * and the full turn flow where chat.ts skips the user msg from result.messages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
import crypto from 'node:crypto';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  getApiMessages as _getApiMessages,
  getDisplayEntries as _getDisplayEntries,
  addAIMessages as _addAIMessages,
  addUserMessage as _addUserMessage,
  recoverOrphanedUserMessage as _recoverOrphanedUserMessage,
} from '../../src/core/chat-history.js';
import { WALNUT_HOME, conversationFile } from '../../src/constants.js';
import { getActiveConversationId } from '../../src/core/conversations.js';
import { listNotifications } from '../../src/core/notifications/store.js';
import type { MessageParam } from '../../src/agent/model.js';

// Chat storage is conversation-scoped: inject the General agent's active
// conversation so the store layer's Phase-0 tripwire (rejects bare undefined
// conversationId) is satisfied while existing call sites stay unchanged.
let convId: string;
const CHAT_HISTORY_FILE = (): string => conversationFile('general', convId);

const getApiMessages = () => _getApiMessages('general', convId);
const getDisplayEntries = (page = 1, pageSize = 100) => _getDisplayEntries(page, pageSize, 'general', convId);
const addAIMessages = (
  msgs: MessageParam[],
  options?: Parameters<typeof _addAIMessages>[1],
) => _addAIMessages(msgs, { ...options, agentId: 'general', conversationId: convId });
const addUserMessage = (
  content: Parameters<typeof _addUserMessage>[0],
  options?: Parameters<typeof _addUserMessage>[1],
) => _addUserMessage(content, { ...options, agentId: 'general', conversationId: convId });
const recoverOrphanedUserMessage = () => _recoverOrphanedUserMessage('general', convId);

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  convId = await getActiveConversationId('general');
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('addUserMessage — eager persist', () => {
  it('persists user message immediately with turnId', async () => {
    await addUserMessage('Hello', { displayText: 'Hello', turnId: 'test-turn-1' });

    // getApiMessages returns only 'ai'-tagged entries
    const msgs = await getApiMessages();
    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as { role: string; content: unknown };
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');

    // Raw JSON file must contain the turnId field
    const raw = JSON.parse(await fsp.readFile(CHAT_HISTORY_FILE(), 'utf-8'));
    const entries: Array<Record<string, unknown>> = raw.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].turnId).toBe('test-turn-1');
    expect(entries[0].role).toBe('user');
    expect(entries[0].tag).toBe('ai');
  });
});

describe('addAIMessages — dedup guard', () => {
  it('skips first user message in batch when already eagerly persisted', async () => {
    const turnId = 't-123';

    // Step 1: eagerly persist the user message (as chat.ts does before the agent loop)
    await addUserMessage('Hello', { turnId });

    // Step 2: simulate the batch from the agent loop that INCLUDES the user msg
    // (the dedup guard in addAIMessages should skip the leading user msg)
    const batch: MessageParam[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ];
    await addAIMessages(batch);

    // Should have exactly 2 entries: user + assistant (not 3)
    const msgs = await getApiMessages();
    expect(msgs).toHaveLength(2);

    const userMsgs = msgs.filter((m) => (m as { role: string }).role === 'user');
    const assistantMsgs = msgs.filter((m) => (m as { role: string }).role === 'assistant');
    expect(userMsgs).toHaveLength(1);
    expect(assistantMsgs).toHaveLength(1);

    // Raw store: only 1 user entry and it must retain the turnId
    const raw = JSON.parse(await fsp.readFile(CHAT_HISTORY_FILE(), 'utf-8'));
    const entries: Array<Record<string, unknown>> = raw.entries ?? [];
    const userEntries = entries.filter((e) => e.role === 'user' && e.tag === 'ai');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].turnId).toBe(turnId);
  });
});

describe('recoverOrphanedUserMessage', () => {
  it('adds a feed notification without polluting chat when the last AI entry is orphaned', async () => {
    const turnId = crypto.randomUUID();
    await addUserMessage('Interrupted', { turnId });

    await recoverOrphanedUserMessage();

    // The interrupted user turn stays in chat, but no error card is appended.
    const { messages } = await getDisplayEntries(1, 100);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Interrupted');

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].title).toBe('Chat Interrupted');
    expect(feed[0].body?.toLowerCase()).toContain('restart');

    // Startup may run recovery more than once; the turn id keeps it idempotent.
    await recoverOrphanedUserMessage();
    expect((await listNotifications()).feed).toHaveLength(1);
  });

  it('is a no-op when the last AI entry is an assistant message (no orphan)', async () => {
    // Add a completed turn: user + assistant
    await addAIMessages([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]);

    await recoverOrphanedUserMessage();

    const { messages } = await getDisplayEntries(1, 100);
    // No notification added — still just the 2 original entries
    expect(messages).toHaveLength(2);
    const hasNotification = messages.some(
      (m) => (m as Record<string, unknown>).notification === true,
    );
    expect(hasNotification).toBe(false);
  });

  it('is a no-op when last user entry has no turnId (old-style message, not an eager-persist orphan)', async () => {
    // Add a user message the old way (no turnId)
    await addAIMessages([{ role: 'user', content: 'Old style message' }]);

    await recoverOrphanedUserMessage();

    const { messages } = await getDisplayEntries(1, 100);
    // No notification added — old-style user messages are not treated as orphans
    expect(messages).toHaveLength(1);
    const hasNotification = messages.some(
      (m) => (m as Record<string, unknown>).notification === true,
    );
    expect(hasNotification).toBe(false);
  });
});

describe('Full turn flow — eager persist + assistant-only addAIMessages', () => {
  it('produces exactly 2 entries (user + assistant) with no duplicates', async () => {
    const turnId = crypto.randomUUID();

    // Step 1: snapshot history length (as chat.ts does before sending to agent)
    const historyBefore = await getApiMessages();
    expect(historyBefore).toHaveLength(0);
    const historyLength = historyBefore.length;

    // Step 2: eagerly persist user message
    await addUserMessage('What tasks?', { displayText: 'What tasks?', turnId });

    // Step 3: agent loop completes; result.messages includes the full conversation
    // (user + assistant). chat.ts skips the first user msg via slice(history.length).
    // history.length was 0, so we must skip 1 (the user msg already on disk).
    // Simulating: allNewMsgs = result.messages.slice(0) but caller does slice(1) to skip user.
    const allNewMsgs: MessageParam[] = [
      { role: 'user', content: 'What tasks?' },
      { role: 'assistant', content: [{ type: 'text', text: 'You have 3 tasks.' }] },
    ];

    // chat.ts: newApiMsgs = allNewMsgs.slice(history.length + 1) — skip the eagerly-persisted user
    // In this test we replicate what chat.ts does: skip messages already in history + the eager user msg.
    // history.length was 0 and we eagerly persisted 1 user msg, so skip index 0.
    const newApiMsgs = allNewMsgs.slice(historyLength + 1) as MessageParam[];
    await addAIMessages(newApiMsgs);

    // Assert: exactly 2 entries total — no duplicates
    const finalMsgs = await getApiMessages();
    expect(finalMsgs).toHaveLength(2);

    const userEntry = finalMsgs[0] as Record<string, unknown>;
    const assistantEntry = finalMsgs[1] as Record<string, unknown>;

    expect(userEntry.role).toBe('user');
    expect(assistantEntry.role).toBe('assistant');

    // User entry retains its turnId
    const raw = JSON.parse(await fsp.readFile(CHAT_HISTORY_FILE(), 'utf-8'));
    const entries: Array<Record<string, unknown>> = raw.entries ?? [];
    const userRaw = entries.find((e) => e.role === 'user' && e.tag === 'ai');
    expect(userRaw).toBeDefined();
    expect(userRaw!.turnId).toBe(turnId);
  });
});
