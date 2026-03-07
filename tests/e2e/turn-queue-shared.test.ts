/**
 * E2E test: GUI chat and cron main-agent turns serialize through the SAME queue.
 *
 * Real: Express server, WebSocket, event bus, chat-history disk I/O, cron service,
 *       agent turn queue, agent loop, agent tools, config, memory system.
 * Mocked: ONLY the Bedrock model API (sendMessageStream) to avoid real LLM calls.
 *
 * Test flow:
 * 1. Start a real server on a random port
 * 2. Send a chat message via WebSocket (goes through enqueueMainAgentTurn('chat'))
 * 3. While chat is running, trigger a cron main-agent turn (enqueueMainAgentTurn('cron:...'))
 * 4. Prove the cron turn waited for the chat turn to finish
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-turnqueue'));

// ── Mock ONLY the model API ──
// We control when the model "responds" so we can hold the chat turn open
// while enqueueing a cron turn.

let chatModelResolve: (() => void) | null = null;
let modelCallCount = 0;
const modelCallLabels: string[] = [];

const { mockSendMessageStream } = vi.hoisted(() => ({
  mockSendMessageStream: vi.fn(),
}));

vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: mockSendMessageStream,
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'test-model',
  getContextWindowSize: (model?: string) => model?.includes('[1m]') ? 1_000_000 : 200_000,
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';
import { getQueueStatus } from '../../src/web/agent-turn-queue.js';

let server: HttpServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendRpc(ws: WebSocket, method: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: 'req', method, payload }));
}

interface WsFrame {
  type: string;
  name?: string;
  data?: Record<string, unknown>;
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 10000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(raw.toString()) as WsFrame;
        if (frame.type === 'event' && frame.name === eventName) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(frame);
        }
      } catch { /* ignore non-JSON frames */ }
    };
    ws.on('message', handler);
  });
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });

  // Default: model returns a text response immediately
  mockSendMessageStream.mockImplementation(async (opts: any) => {
    modelCallCount++;
    const text = `Model response #${modelCallCount}`;
    opts?.onTextDelta?.(text);
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  });

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  expect(port).toBeGreaterThan(0);
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}, 15_000);

// ── Tests ──

describe('Turn Queue E2E: chat + cron serialize through same queue', () => {
  it('chat via WS goes through the queue and persists to chat history', async () => {
    modelCallCount = 0;
    const ws = await connectWs();

    // Send a chat message via WebSocket RPC (same path as the browser UI)
    const responsePromise = waitForWsEvent(ws, 'agent:response');
    sendRpc(ws, 'chat', { message: 'Hello from E2E test' });

    const response = await responsePromise;
    expect(response.data?.text).toContain('Model response');

    // Verify chat history was persisted to disk (real I/O, not mocked)
    const msgs = await chatHistory.getModelContext();
    expect(msgs.length).toBeGreaterThanOrEqual(2); // user + assistant

    // Model was called at least once
    expect(modelCallCount).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it('cron main-agent turn goes through the same queue and persists', async () => {
    const beforeMsgs = await chatHistory.getModelContext();
    const beforeCount = beforeMsgs.length;
    modelCallCount = 0;

    // Trigger a cron main-agent turn directly (same code path as CronService.runMainAgentWithPrompt)
    const { enqueueMainAgentTurn } = await import('../../src/web/agent-turn-queue.js');
    const { runAgentLoop } = await import('../../src/agent/loop.js');

    await enqueueMainAgentTurn('cron:test-e2e', async () => {
      const history = await chatHistory.getApiMessages();
      const result = await runAgentLoop('[Scheduled Job "test-e2e"] Check status', history, {
        onTextDelta: () => {},
      }, { source: 'cron' });
      const newMsgs = result.messages.slice(history.length);
      await chatHistory.addAIMessages(newMsgs);
    });

    // Verify cron turn persisted to chat history (shares same file as chat)
    const afterMsgs = await chatHistory.getModelContext();
    expect(afterMsgs.length).toBeGreaterThan(beforeCount);
    expect(modelCallCount).toBeGreaterThanOrEqual(1);
  });

  it('cron turn is BLOCKED while chat turn is running (proves same queue)', async () => {
    // Reset model mock: first call blocks until we release it
    let callIndex = 0;
    chatModelResolve = null;
    modelCallLabels.length = 0;

    mockSendMessageStream.mockImplementation(async (opts: any) => {
      callIndex++;
      const isFirstCall = callIndex === 1;

      if (isFirstCall) {
        // BLOCK the chat turn's model call until we explicitly release it.
        // This holds the queue slot while we enqueue the cron turn.
        modelCallLabels.push('chat-model-start');
        await new Promise<void>((resolve) => { chatModelResolve = resolve; });
        modelCallLabels.push('chat-model-end');
      } else {
        modelCallLabels.push(`model-call-${callIndex}`);
      }

      const text = `Response ${callIndex}`;
      opts?.onTextDelta?.(text);
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });

    const ws = await connectWs();

    // 1. Send chat message via WebSocket (enters queue → starts agent loop → hits blocked model call)
    sendRpc(ws, 'chat', { message: 'Blocking chat message' });

    // 2. Wait for the model to be called (chat turn is now running, holding the queue)
    await vi.waitFor(() => {
      expect(modelCallLabels).toContain('chat-model-start');
    }, { timeout: 5000, interval: 20 });

    // 3. Queue status: chat turn is active
    const statusDuringChat = getQueueStatus();
    expect(statusDuringChat.active).toBe(1);

    // 4. Enqueue a cron turn — it must WAIT behind the chat turn
    const cronOrder: string[] = [];
    const cronPromise = (async () => {
      const { enqueueMainAgentTurn } = await import('../../src/web/agent-turn-queue.js');
      const { runAgentLoop } = await import('../../src/agent/loop.js');
      await enqueueMainAgentTurn('cron:blocked-test', async () => {
        cronOrder.push('cron-dequeued');
        const history = await chatHistory.getApiMessages();
        const result = await runAgentLoop('[Cron] Test', history, {
          onTextDelta: () => {},
        }, { source: 'cron' });
        const newMsgs = result.messages.slice(history.length);
        await chatHistory.addAIMessages(newMsgs);
        cronOrder.push('cron-done');
      });
    })();

    // 5. Wait for cron to enter the queue (not timing-dependent)
    await vi.waitFor(() => {
      expect(getQueueStatus().queued).toBe(1);
    }, { timeout: 5000, interval: 20 });

    // ── KEY ASSERTIONS ──
    // Cron is in the queue but has NOT been dequeued — blocked behind the chat turn
    expect(cronOrder).toEqual([]);
    expect(getQueueStatus().active).toBe(1);   // chat is active
    expect(getQueueStatus().queued).toBe(1);    // cron is queued

    // 6. Release the chat turn's model call
    expect(chatModelResolve).not.toBeNull();
    chatModelResolve!();

    // 7. Wait for chat to complete (agent:response event on WS)
    await waitForWsEvent(ws, 'agent:response');

    // 8. Now cron should execute (unblocked)
    await cronPromise;

    // 9. Verify cron ran AFTER chat released the queue
    expect(cronOrder).toEqual(['cron-dequeued', 'cron-done']);

    // 10. Verify model call order
    expect(modelCallLabels[0]).toBe('chat-model-start');
    expect(modelCallLabels[1]).toBe('chat-model-end');
    expect(modelCallLabels.length).toBeGreaterThanOrEqual(3); // chat + cron's call(s)

    ws.close();
  }, 15_000);
});
