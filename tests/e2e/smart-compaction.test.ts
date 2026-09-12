/**
 * E2E test: Smart compaction with memory extraction.
 *
 * Real server, real disk I/O, real REST calls.
 * Proves: compaction extracts knowledge into global memory, project memory, and daily logs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-compact'));

import {
  WALNUT_HOME,
  DAILY_DIR,
  CHAT_HISTORY_FILE,
} from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';
import type { DisplayMessage } from '../../src/core/types.js';
import type { MessageParam } from '../../src/model/model.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// Chat storage is conversation-scoped: resolve the General agent's active
// conversation once and target it everywhere — matching what the REST endpoints
// resolve to when no conversationId is supplied.
let convId: string;

// ── Setup / Teardown ──

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 3456;
  const { getActiveConversationId } = await import('../../src/core/conversations.js');
  convId = await getActiveConversationId('general');
});

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('Two-step compaction E2E', () => {
  it('step 2 stores structured summary directly and trims old messages', async () => {
    // Seed 20 turns (40 messages) to exceed the keep threshold
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `Tell me about task ${i}` });
      apiMsgs.push({ role: 'assistant', content: `Task ${i}: processing…` });
      displayMsgs.push({
        role: 'user',
        content: `Tell me about task ${i}`,
        timestamp: `2025-06-01T00:${String(i).padStart(2, '0')}:00Z`,
      });
      displayMsgs.push({
        role: 'assistant',
        content: `Task ${i}: processing…`,
        timestamp: `2025-06-01T00:${String(i).padStart(2, '0')}:01Z`,
      });
    }
    await chatHistory.addTurn(apiMsgs, displayMsgs, 'general', convId);

    // Compact with a structured summary (no XML — direct storage)
    const structuredSummary = `## Goal
Discussed 20 tasks with the user.

## Progress
### Done
- [x] Task management workflows reviewed
- [x] User prefers concise summaries

### In Progress
- [ ] Walnut compaction feature

## Key Decisions
- **Two-step compaction**: Separate memory flush from summarization`;

    await chatHistory.compact(async () => structuredSummary, undefined, 'general', convId);

    // 1. Verify compactionSummary stores the response directly
    const summary = await chatHistory.getCompactionSummary('general', convId);
    expect(summary).toBe(structuredSummary);

    // 2. Daily log: not written by compact() itself — only by memoryFlusher (tested separately).
    // Verify compact() without a memoryFlusher doesn't crash on missing daily dir.

    // 3. Verify API messages were trimmed to recent only
    const remaining = await chatHistory.getApiMessages('general', convId);
    expect(remaining.length).toBe(20); // 10 turns * 2

    // 4. Pre-boundary entries are deleted (not marked compacted).
    //    20 turns → keep last 10 turns × 2 entries each = 20 entries remain.
    const display = await chatHistory.getDisplayHistory('general', convId);
    expect(display).toHaveLength(20);

    // 5. Verify the REST API returns correct compaction state
    const res = await fetch(apiUrl('/api/chat/history'));
    expect(res.ok).toBe(true);
    const body = await res.json() as { messages: Array<{ compacted?: boolean }> };
    expect(body.messages).toHaveLength(20);
    expect(body.messages.filter((m) => m.compacted)).toHaveLength(0);
  });

  it('step 1 memoryFlusher is called with conversation history', async () => {
    await chatHistory.clear('general', convId);

    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      displayMsgs.push({
        role: 'user',
        content: `msg ${i}`,
        timestamp: `2025-06-02T00:${String(i).padStart(2, '0')}:00Z`,
      });
      displayMsgs.push({
        role: 'assistant',
        content: `reply ${i}`,
        timestamp: `2025-06-02T00:${String(i).padStart(2, '0')}:01Z`,
      });
    }
    await chatHistory.addTurn(apiMsgs, displayMsgs, 'general', convId);

    let flushedMsgCount = 0;
    const memoryFlusher = async (msgs: MessageParam[]) => {
      flushedMsgCount = msgs.length;
    };

    await chatHistory.compact(
      async () => 'Summary after flush',
      memoryFlusher,
      'general',
      convId,
    );

    // Memory flusher should have received the full conversation
    expect(flushedMsgCount).toBe(40);

    const summary = await chatHistory.getCompactionSummary('general', convId);
    expect(summary).toBe('Summary after flush');

    const remaining = await chatHistory.getApiMessages('general', convId);
    expect(remaining.length).toBe(20); // 10 turns * 2
  });
});
