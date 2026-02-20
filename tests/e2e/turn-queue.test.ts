/**
 * E2E tests for the Main Agent Turn Queue and Token Budget Guard.
 *
 * Verifies:
 * 1. Turn queue serializes concurrent main-agent turns
 * 2. Queue status is queryable
 * 3. Token budget guard trims messages when over budget
 * 4. Cron timer error propagation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

describe('Agent Turn Queue', () => {
  let enqueueMainAgentTurn: typeof import('../../src/web/agent-turn-queue.js').enqueueMainAgentTurn;
  let getQueueStatus: typeof import('../../src/web/agent-turn-queue.js').getQueueStatus;

  beforeEach(async () => {
    // Dynamic import to get fresh module after mock setup
    const mod = await import('../../src/web/agent-turn-queue.js');
    enqueueMainAgentTurn = mod.enqueueMainAgentTurn;
    getQueueStatus = mod.getQueueStatus;
  });

  it('executes tasks serially (max concurrency = 1)', async () => {
    const executionOrder: string[] = [];
    let task1Running = false;
    let task2StartedWhile1Running = false;

    const task1 = enqueueMainAgentTurn('task1', async () => {
      task1Running = true;
      executionOrder.push('task1-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('task1-end');
      task1Running = false;
      return 'result1';
    });

    const task2 = enqueueMainAgentTurn('task2', async () => {
      // If task1 is still running when task2 starts, the queue is broken
      if (task1Running) task2StartedWhile1Running = true;
      executionOrder.push('task2-start');
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push('task2-end');
      return 'result2';
    });

    const [r1, r2] = await Promise.all([task1, task2]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    expect(task2StartedWhile1Running).toBe(false);
    // task1 must complete before task2 starts
    expect(executionOrder).toEqual(['task1-start', 'task1-end', 'task2-start', 'task2-end']);
  });

  it('returns correct queue status', async () => {
    // Initially empty
    const initial = getQueueStatus();
    expect(initial.active).toBe(0);
    expect(initial.queued).toBe(0);

    let resolveTask: () => void;
    const blockingTask = enqueueMainAgentTurn('blocking', () => {
      return new Promise<void>((r) => { resolveTask = r; });
    });

    // Give the queue time to pick up the task
    await new Promise((r) => setTimeout(r, 10));

    const during = getQueueStatus();
    expect(during.active).toBe(1);

    resolveTask!();
    await blockingTask;

    const after = getQueueStatus();
    expect(after.active).toBe(0);
    expect(after.queued).toBe(0);
  });

  it('propagates errors from tasks', async () => {
    const failingTask = enqueueMainAgentTurn('failing', async () => {
      throw new Error('intentional failure');
    });

    await expect(failingTask).rejects.toThrow('intentional failure');

    // Queue should be clear and accept new tasks after error
    const recovery = await enqueueMainAgentTurn('recovery', async () => 'ok');
    expect(recovery).toBe('ok');
  });

  it('handles three concurrent enqueues in order', async () => {
    const order: number[] = [];

    const p1 = enqueueMainAgentTurn('t1', async () => { order.push(1); });
    const p2 = enqueueMainAgentTurn('t2', async () => { order.push(2); });
    const p3 = enqueueMainAgentTurn('t3', async () => { order.push(3); });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('Token Budget Guard', () => {
  let guardBudget: typeof import('../../src/agent/token-budget.js').guardBudget;
  let emergencyTrim: typeof import('../../src/agent/token-budget.js').emergencyTrim;

  beforeEach(async () => {
    const mod = await import('../../src/agent/token-budget.js');
    guardBudget = mod.guardBudget;
    emergencyTrim = mod.emergencyTrim;
  });

  it('returns messages unchanged when within budget', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ] as any[];

    const result = await guardBudget({
      system: 'You are a helpful assistant.',
      tools: [],
      messages,
      budget: 100_000, // Very generous budget
    });

    expect(result.trimmed).toBe(false);
    expect(result.messages).toBe(messages); // Same reference = no copy
  });

  it('trims messages when over budget', async () => {
    // Use varied words that don't compress well in BPE
    const words = 'the quick brown fox jumps over a lazy dog while exploring complex algorithms ';
    const bigContent = words.repeat(500); // ~37K chars of varied text = ~10K+ tokens
    const messages = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
      { role: 'user', content: 'latest question' },
      { role: 'assistant', content: [{ type: 'text', text: 'latest answer' }] },
    ] as any[];

    const result = await guardBudget({
      system: 'You are a helper.',
      tools: [],
      messages,
      budget: 20_000, // Small budget — forces trim
    });

    expect(result.trimmed).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    // The latest messages should be preserved
    const lastMsg = result.messages[result.messages.length - 1] as any;
    expect(lastMsg.content[0].text).toBe('latest answer');
  });

  it('returns trimmed=true and reduced message count when over budget', async () => {
    const words = 'the quick brown fox jumps over a lazy dog while exploring complex algorithms ';
    const bigContent = words.repeat(500);
    const messages = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: [{ type: 'text', text: bigContent }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ] as any[];

    const result = await guardBudget({
      system: 'system',
      tools: [],
      messages,
      budget: 5_000,
    });

    expect(result.trimmed).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    // First message in trimmed result must be a user message (valid alternation)
    expect((result.messages[0] as any).role).toBe('user');
  });

  it('emergencyTrim preserves minimum messages', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ] as any[];

    // Even with 0 target, should keep at least 4 (but we only have 2)
    const result = emergencyTrim(messages, 0);
    expect(result.length).toBe(2); // Can't go below what we have
  });

  it('emergencyTrim prefers non-tool_result starts when possible', () => {
    // Create enough messages that the trimmer has room to skip tool_result starts
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      { role: 'user', content: 'question 2' },
      { role: 'assistant', content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 't1', name: 'search', input: {} },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'result' },
      ]},
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: 'another q' },
      { role: 'assistant', content: [{ type: 'text', text: 'another a' }] },
    ] as any[];

    // Budget large enough to keep ~6 messages but not all 10
    const result = emergencyTrim(messages, 500);
    // Verify the result has fewer messages than the original
    expect(result.length).toBeLessThan(messages.length);
    // The trimmed result should start on a user text message, not a tool_result
    const first = result[0] as any;
    if (first.role === 'user' && Array.isArray(first.content)) {
      const hasToolResult = first.content.some((b: any) => b.type === 'tool_result');
      expect(hasToolResult).toBe(false);
    }
  });
});

describe('Cron Timer Error Propagation', () => {
  it('applyJobResult tracks consecutive errors on failure', async () => {
    const { applyJobResult } = await import('../../src/core/cron/timer.js');

    const now = Date.now();
    // Use a one-shot 'at' schedule — simpler than 'every' for testing
    const job = {
      id: 'test-job',
      name: 'test',
      enabled: true,
      schedule: { kind: 'at' as const, at: new Date(now).toISOString() },
      sessionTarget: 'main' as const,
      wakeMode: 'now' as const,
      payload: { kind: 'systemEvent' as const, text: 'test' },
      state: {
        consecutiveErrors: 0,
        lastRunAtMs: undefined as number | undefined,
        nextRunAtMs: now,
      },
      createdAtMs: now - 120000,
      updatedAtMs: now - 60000,
    };

    const state = {
      store: { jobs: [job], lastPersistedAtMs: now },
      deps: {
        log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
        nowMs: () => now,
      },
      op: Promise.resolve(),
    } as any;

    // First error — should track the error
    applyJobResult(state, job, {
      status: 'error',
      error: 'Token budget exceeded',
      startedAt: now,
      endedAt: now + 1000,
    });

    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.lastStatus).toBe('error');
    expect(job.state.lastError).toBe('Token budget exceeded');
    // One-shot jobs are disabled after error
    expect(job.enabled).toBe(false);

    // Success resets consecutive errors
    job.enabled = true; // Re-enable for test
    applyJobResult(state, job, {
      status: 'ok',
      startedAt: now + 60000,
      endedAt: now + 61000,
    });
    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.lastStatus).toBe('ok');
  });
});
