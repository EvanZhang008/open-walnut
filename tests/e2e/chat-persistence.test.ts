/**
 * E2E test: chat history persists across server restarts and page reloads.
 *
 * Real server, real disk I/O, real REST calls.
 * Proves: write history → stop server → start server → history is still there.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server as HttpServer } from 'node:http';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-chat'));

import { WALNUT_HOME, CHAT_HISTORY_FILE } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function startFresh(): Promise<void> {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 3456;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await startFresh();
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('Chat history persistence (E2E)', () => {
  it('GET /api/chat/history returns empty when fresh', async () => {
    const res = await fetch(apiUrl('/api/chat/history'));
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('addTurn persists and GET returns it', async () => {
    // Write directly via the core module (simulates what chat.ts does after agent loop)
    await chatHistory.addTurn(
      [{ role: 'user', content: 'Hello Walnut' }, { role: 'assistant', content: [{ type: 'text', text: 'Hi! How can I help?' }] }],
      [
        { role: 'user', content: 'Hello Walnut', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Hi! How can I help?', timestamp: new Date().toISOString() },
      ],
    );

    const res = await fetch(apiUrl('/api/chat/history'));
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('Hello Walnut');
    expect(body.messages[1].role).toBe('assistant');
    // v2: AI entries store raw Anthropic content (ContentBlock[])
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'Hi! How can I help?' }]);
  });

  it('chat-history.json exists on disk after addTurn', async () => {
    const content = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
    const store = JSON.parse(content);
    expect(store.version).toBe(2);
    expect(store.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('history survives server restart', async () => {
    // Add another turn before restart
    await chatHistory.addTurn(
      [{ role: 'user', content: 'Remember this' }],
      [{ role: 'user', content: 'Remember this', timestamp: new Date().toISOString() }],
    );

    // Verify file is on disk
    const beforeRestart = await fs.readFile(CHAT_HISTORY_FILE, 'utf-8');
    const storeBefore = JSON.parse(beforeRestart);
    const countBefore = storeBefore.entries.length;
    expect(countBefore).toBeGreaterThanOrEqual(3);

    // Stop and restart server
    await stopServer();
    await startFresh();

    // GET should return the same history from disk
    const res = await fetch(apiUrl('/api/chat/history'));
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.messages).toHaveLength(countBefore);
    expect(body.messages[0].content).toBe('Hello Walnut');
    expect(body.messages[countBefore - 1].content).toBe('Remember this');
  });

  it('POST /api/chat/clear resets everything', async () => {
    const clearRes = await fetch(apiUrl('/api/chat/clear'), { method: 'POST' });
    expect(clearRes.ok).toBe(true);

    // GET confirms empty
    const res = await fetch(apiUrl('/api/chat/history'));
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('clear persists across server restart', async () => {
    // Add something
    await chatHistory.addTurn(
      [{ role: 'user', content: 'will be cleared' }],
      [{ role: 'user', content: 'will be cleared', timestamp: new Date().toISOString() }],
    );

    // Clear via API
    await fetch(apiUrl('/api/chat/clear'), { method: 'POST' });

    // Restart
    await stopServer();
    await startFresh();

    // Still empty
    const res = await fetch(apiUrl('/api/chat/history'));
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('pagination: page/pageSize returns correct slice', async () => {
    // Seed multiple messages
    for (let i = 0; i < 5; i++) {
      await chatHistory.addTurn(
        [{ role: 'user', content: `msg-${i}` }],
        [{ role: 'user', content: `msg-${i}`, timestamp: new Date(Date.now() + i * 1000).toISOString() }],
      );
    }

    // Page 1 with pageSize=3 → last 3 messages (most recent)
    const res = await fetch(apiUrl('/api/chat/history?page=1&pageSize=3'));
    const body = await res.json();
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].content).toBe('msg-2');
    expect(body.messages[2].content).toBe('msg-4');
    expect(body.pagination.hasMore).toBe(true);
    expect(body.pagination.totalMessages).toBe(5);
  });

  it('apiMessages preserve full Anthropic format (tool_use blocks)', async () => {
    await fetch(apiUrl('/api/chat/clear'), { method: 'POST' });

    // Simulate a turn with tool_use content blocks (what the real agent produces)
    await chatHistory.addTurn(
      [
        { role: 'user', content: 'list my tasks' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check your tasks.' },
            { type: 'tool_use', id: 'tu_123', name: 'query_tasks', input: { status: 'todo' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_123', content: '[]' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'You have no tasks.' }],
        },
      ],
      [
        { role: 'user', content: 'list my tasks', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'You have no tasks.', timestamp: new Date().toISOString() },
      ],
    );

    // Read back from disk and verify tool blocks survive serialization
    const apiMsgs = await chatHistory.getApiMessages();
    expect(apiMsgs).toHaveLength(4);

    const assistantMsg = apiMsgs[1] as { role: string; content: Array<{ type: string; id?: string; name?: string }> };
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].type).toBe('text');
    expect(assistantMsg.content[1].type).toBe('tool_use');
    expect(assistantMsg.content[1].id).toBe('tu_123');
    expect(assistantMsg.content[1].name).toBe('query_tasks');

    const toolResultMsg = apiMsgs[2] as { role: string; content: Array<{ type: string; tool_use_id?: string }> };
    expect(toolResultMsg.content[0].type).toBe('tool_result');
    expect(toolResultMsg.content[0].tool_use_id).toBe('tu_123');
  });
});
