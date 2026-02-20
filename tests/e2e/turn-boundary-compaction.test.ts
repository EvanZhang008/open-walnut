/**
 * E2E test: Turn-boundary compaction with tool chains.
 *
 * Real server, real disk I/O, real REST calls.
 * Proves:
 * 1. Compaction cuts at turn boundaries — never splits tool_use/tool_result pairs
 * 2. Kept entries are slimmed (tool payloads truncated with [truncated] marker)
 * 3. Orphan tool_result migration cleans existing corrupted history
 * 4. Model context after compaction is valid (no orphans, proper alternation)
 * 5. REST API returns correct state after compaction
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-turn-boundary'));

import {
  WALNUT_HOME,
  CHAT_HISTORY_FILE,
} from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';
import type { MessageParam } from '../../src/agent/model.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 3456;
});

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(async () => {
  await chatHistory.clear();
});

// ── Helpers ──

/** Build a simple text turn: user + assistant */
function simpleTurn(userText: string, assistantText: string): MessageParam[] {
  return [
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ];
}

/** Build a tool-chain turn: user → assistant(tool_use) → user(tool_result) → assistant(text) */
function toolChainTurn(
  userText: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalText: string,
  toolId: string,
): MessageParam[] {
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Let me ${toolName}` },
        { type: 'tool_use', id: toolId, name: toolName, input: toolInput },
      ],
    } as MessageParam,
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: toolResult }],
    } as MessageParam,
    {
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
    } as MessageParam,
  ];
}

// ── Tests ──

describe('Turn-boundary compaction E2E', () => {
  it('compacts tool-chain conversations without producing orphan tool_results', async () => {
    // Build 15 turns: mix of simple and tool-chain turns
    const allMsgs: MessageParam[] = [];

    for (let i = 0; i < 15; i++) {
      if (i % 2 === 0) {
        // Tool chain turn (4 messages each)
        allMsgs.push(
          ...toolChainTurn(
            `search task ${i}`,
            'query_tasks',
            { query: `task ${i}` },
            `[{"id":"t${i}","title":"Task ${i}"}]`,
            `Found task ${i}`,
            `tu_${i}`,
          ),
        );
      } else {
        // Simple turn (2 messages each)
        allMsgs.push(...simpleTurn(`tell me about ${i}`, `Here's info about ${i}`));
      }
    }

    await chatHistory.addAIMessages(allMsgs);

    // Compact
    await chatHistory.compact(async () => 'Turn-boundary test summary');

    // ── Verify 1: Model context has no orphan tool_results ──
    const ctx = await chatHistory.getModelContext();
    expect(ctx.length).toBeGreaterThan(0);

    // First message must be a user text message (not tool_result)
    const first = ctx[0] as { role: string; content: unknown };
    expect(first.role).toBe('user');
    if (Array.isArray(first.content)) {
      const hasToolResult = (first.content as Array<{ type: string }>).some(
        (b) => b.type === 'tool_result',
      );
      expect(hasToolResult).toBe(false);
    }

    // Every tool_result must be preceded by an assistant with tool_use
    for (let i = 0; i < ctx.length; i++) {
      const msg = ctx[i] as { role: string; content: unknown };
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = (msg.content as Array<{ type: string }>).some(
          (b) => b.type === 'tool_result',
        );
        if (hasToolResult) {
          expect(i).toBeGreaterThan(0);
          const prev = ctx[i - 1] as { role: string; content: unknown };
          expect(prev.role).toBe('assistant');
          const hasToolUse = (prev.content as Array<{ type: string }>).some(
            (b) => b.type === 'tool_use',
          );
          expect(hasToolUse).toBe(true);
        }
      }
    }

    // ── Verify 2: Compaction summary is stored ──
    const summary = await chatHistory.getCompactionSummary();
    expect(summary).toBe('Turn-boundary test summary');
  });

  it('slims kept entries to prevent token bloat', async () => {
    // Build 15 turns with large tool payloads
    const largeInput = 'x'.repeat(500);
    const largeResult = 'y'.repeat(1000);
    const allMsgs: MessageParam[] = [];

    for (let i = 0; i < 15; i++) {
      allMsgs.push(
        ...toolChainTurn(
          `big tool call ${i}`,
          'read_file',
          { path: `/some/file_${i}.ts`, content: largeInput },
          largeResult,
          `File ${i} read successfully`,
          `tu_big_${i}`,
        ),
      );
    }

    await chatHistory.addAIMessages(allMsgs);
    await chatHistory.compact(async () => 'Slim test summary');

    // ── Verify: ALL entries (compacted + kept) have slimmed tool payloads ──
    const entries = (await chatHistory.getDisplayEntries()).messages;

    // Check compacted entries
    const compactedWithTools = entries.filter(
      (e) =>
        e.compacted
        && Array.isArray(e.content)
        && (e.content as Array<{ type: string }>).some((b) => b.type === 'tool_use'),
    );
    expect(compactedWithTools.length).toBeGreaterThan(0);
    for (const entry of compactedWithTools) {
      for (const block of entry.content as Array<{
        type: string;
        input?: Record<string, unknown>;
      }>) {
        if (block.type === 'tool_use' && block.input) {
          for (const val of Object.values(block.input)) {
            if (typeof val === 'string' && val.length > 214) {
              throw new Error(
                `Compacted tool_use input not slimmed: ${val.length} chars`,
              );
            }
          }
        }
      }
    }

    // Check kept (non-compacted) entries — these should ALSO be slimmed
    const keptWithToolResults = entries.filter(
      (e) =>
        !e.compacted
        && e.tag === 'ai'
        && Array.isArray(e.content)
        && (e.content as Array<{ type: string }>).some(
          (b) => b.type === 'tool_result',
        ),
    );
    expect(keptWithToolResults.length).toBeGreaterThan(0);
    for (const entry of keptWithToolResults) {
      for (const block of entry.content as Array<{
        type: string;
        content?: string;
      }>) {
        if (
          block.type === 'tool_result'
          && typeof block.content === 'string'
        ) {
          // 500 chars + "… [truncated]" = max 514
          expect(block.content.length).toBeLessThanOrEqual(514);
          if (block.content.length > 500) {
            expect(block.content).toContain('[truncated]');
          }
        }
      }
    }
  });

  it('orphan migration cleans corrupted history on read', async () => {
    // Manually write a corrupted store with orphan tool_result at start of
    // non-compacted entries (simulates old compaction bug)
    const corruptedStore = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      compactionCount: 1,
      compactionSummary: 'Old summary',
      entries: [
        // Compacted entries (old)
        {
          tag: 'ai',
          role: 'user',
          content: 'old message',
          timestamp: '2025-01-01T00:00:00Z',
          compacted: true,
        },
        {
          tag: 'ai',
          role: 'assistant',
          content: [
            { type: 'text', text: 'old reply' },
            { type: 'tool_use', id: 'tu_old', name: 'search', input: {} },
          ],
          timestamp: '2025-01-01T00:00:01Z',
          compacted: true,
        },
        // ORPHAN: tool_result with no preceding tool_use in non-compacted section
        {
          tag: 'ai',
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_old',
              content: 'stale result',
            },
          ],
          timestamp: '2025-01-01T00:00:02Z',
        },
        // Normal non-compacted entries after the orphan
        {
          tag: 'ai',
          role: 'user',
          content: 'clean message',
          timestamp: '2025-01-01T00:01:00Z',
        },
        {
          tag: 'ai',
          role: 'assistant',
          content: 'clean reply',
          timestamp: '2025-01-01T00:01:01Z',
        },
      ],
    };
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(corruptedStore));

    // Reading model context should trigger migration and clean the orphan
    const ctx = await chatHistory.getModelContext();

    // The orphan should have been compacted away — only clean messages remain
    expect(ctx).toHaveLength(2);
    expect((ctx[0] as { content: string }).content).toBe('clean message');
    expect((ctx[1] as { content: string }).content).toBe('clean reply');

    // Verify the orphan is now marked as compacted in the store
    const entries = (await chatHistory.getDisplayEntries()).messages;
    const orphan = entries.find(
      (e) =>
        Array.isArray(e.content)
        && (e.content as Array<{ type: string }>).some(
          (b) => b.type === 'tool_result',
        )
        && !e.content.some?.((b: { type: string }) => b.type !== 'tool_result'),
    );
    // The orphan entry should exist but be compacted
    const orphanEntries = entries.filter(
      (e) =>
        e.compacted
        && Array.isArray(e.content)
        && (e.content as Array<{ type: string }>).some(
          (b) => b.type === 'tool_result',
        ),
    );
    expect(orphanEntries.length).toBeGreaterThan(0);
  });

  it('REST API /compact endpoint returns correct state after compaction', async () => {
    // Build 15 simple turns
    const allMsgs: MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      allMsgs.push(...simpleTurn(`user msg ${i}`, `reply ${i}`));
    }
    await chatHistory.addAIMessages(allMsgs);

    // Compact
    await chatHistory.compact(async () => 'REST test summary');

    // Verify REST GET /api/chat/history
    const res = await fetch(apiUrl('/api/chat/history'));
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      messages: Array<{ compacted?: boolean }>;
    };
    expect(body.messages).toHaveLength(30);

    // Count compacted vs non-compacted in REST response
    const compactedCount = body.messages.filter((m) => m.compacted).length;
    const nonCompactedCount = body.messages.filter((m) => !m.compacted).length;
    expect(compactedCount).toBe(10); // 5 old turns * 2
    expect(nonCompactedCount).toBe(20); // 10 kept turns * 2
  });

  it('model context maintains proper role alternation after compaction', async () => {
    // Mix of simple and tool-chain turns
    const allMsgs: MessageParam[] = [];
    for (let i = 0; i < 14; i++) {
      if (i % 3 === 0) {
        allMsgs.push(
          ...toolChainTurn(
            `tool turn ${i}`,
            'exec',
            { command: `ls ${i}` },
            `file_${i}.txt`,
            `Found file ${i}`,
            `tu_alt_${i}`,
          ),
        );
      } else {
        allMsgs.push(...simpleTurn(`msg ${i}`, `reply ${i}`));
      }
    }
    await chatHistory.addAIMessages(allMsgs);
    await chatHistory.compact(async () => 'Alternation test');

    const ctx = await chatHistory.getModelContext();

    // Verify strict alternation: user, assistant, user, assistant, ...
    for (let i = 1; i < ctx.length; i++) {
      const prev = (ctx[i - 1] as { role: string }).role;
      const curr = (ctx[i] as { role: string }).role;
      expect(curr).not.toBe(prev);
    }

    // First must be user, last must be assistant
    if (ctx.length > 0) {
      expect((ctx[0] as { role: string }).role).toBe('user');
      expect((ctx[ctx.length - 1] as { role: string }).role).toBe('assistant');
    }
  });
});
