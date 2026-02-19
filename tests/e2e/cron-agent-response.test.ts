/**
 * E2E test: Cron job with wakeMode='now' triggers visible agent response.
 *
 * Real server, real WebSocket, real cron execution.
 * Proves: when a cron job fires with wakeMode='now', the UI receives
 * either agent:text-delta/agent:response (success) or agent:error (failure),
 * and the response is persisted in chat history.
 *
 * In test environments without Bedrock credentials, the agent loop will error.
 * The critical assertion is that the error is NOT silently swallowed — it must
 * be broadcast via WebSocket so the UI can display it.
 *
 * All test cron jobs are cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-cron-agent'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';

// ── Helpers ──

let server: HttpServer;
let port: number;
const createdJobIds: string[] = [];

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Collect WS messages matching any of the given event names.
 * Resolves when either the expected count is reached or the timeout fires.
 */
function collectWsMessagesByName(
  ws: WebSocket,
  names: string[],
  maxCount: number,
  timeoutMs = 30000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const matched: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(matched);
    }, timeoutMs);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (names.includes(msg.name as string)) {
        matched.push(msg);
      }
      if (matched.length >= maxCount) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(matched);
      }
    };
    ws.on('message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  // Clean up all test cron jobs
  for (const id of createdJobIds) {
    try {
      await fetch(apiUrl(`/api/cron/${id}`), { method: 'DELETE' });
    } catch {
      // ignore cleanup errors
    }
  }
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('Cron agent response delivery (wakeMode=now)', () => {
  it('cron job with wakeMode=now produces visible agent event (response or error)', async () => {
    // Step 1: Create a cron job with wakeMode='now', sessionTarget='main'
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent Response Test',
        schedule: { kind: 'every', everyMs: 3600000 }, // 1 hour (won't auto-fire)
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'Say hello in one sentence.' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };
    createdJobIds.push(job.id);

    // Step 2: Connect WS and start collecting agent events
    const ws = await connectWs();
    const agentEventNames = [
      'agent:text-delta',
      'agent:response',
      'agent:error',
      'cron:notification',
      'cron:chat-message',
    ];
    const msgPromise = collectWsMessagesByName(ws, agentEventNames, 3, 30000);

    // Step 3: Trigger the cron job manually
    const runRes = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Step 4: Wait for WS events
    const messages = await msgPromise;
    ws.close();

    // Step 5: Verify cron notification was broadcast
    const notifMsg = messages.find((m) => m.name === 'cron:notification');
    expect(notifMsg).toBeDefined();

    // Step 6: Verify agent produced SOME visible output (response OR error)
    // In test env without Bedrock, we expect agent:error.
    // In real env with Bedrock, we expect agent:text-delta + agent:response.
    // Either way, the UI must NOT be left in silence.
    const agentResponse = messages.find((m) => m.name === 'agent:response');
    const agentError = messages.find((m) => m.name === 'agent:error');
    const agentDelta = messages.find((m) => m.name === 'agent:text-delta');

    const hasAgentOutput = agentResponse || agentError || agentDelta;
    expect(hasAgentOutput).toBeDefined();

    // Step 7: Verify chat history was updated (not empty)
    // Give a moment for persistence
    await delay(500);
    const display = await chatHistory.getDisplayHistory();
    // Should have at least the cron notification message
    expect(display.length).toBeGreaterThan(0);
  });

  it('cron job with wakeMode=next-cycle does NOT trigger agent (by design)', async () => {
    // Create a next-cycle job
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Next Cycle Test',
        schedule: { kind: 'every', everyMs: 3600000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'Queued notification test.' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };
    createdJobIds.push(job.id);

    // Connect WS and collect events
    const ws = await connectWs();
    const agentEventNames = ['agent:text-delta', 'agent:response', 'agent:error'];
    // Short timeout — we expect NO agent events
    const msgPromise = collectWsMessagesByName(ws, agentEventNames, 1, 3000);

    // Trigger
    const runRes = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Wait — should time out with no agent events
    const messages = await msgPromise;
    ws.close();

    // No agent events should have been received
    expect(messages).toHaveLength(0);
  });

  it('cron notification appears in chat history display messages', async () => {
    // Clear chat first
    await chatHistory.clear();

    // Create a next-cycle job (fast, no agent call)
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Chat History Test',
        schedule: { kind: 'every', everyMs: 3600000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'Chat history persistence test.' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };
    createdJobIds.push(job.id);

    // Trigger
    await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });

    // Wait for persistence
    await delay(500);

    // Verify the notification was persisted to display messages
    const display = await chatHistory.getDisplayHistory();
    const cronMsg = display.find(
      (m) => typeof m.content === 'string' && m.content.includes('Chat history persistence test'),
    );
    expect(cronMsg).toBeDefined();
    // Cron notifications are stored with role='user' and source='cron'
    expect(cronMsg!.role).toBe('user');
  });
});
