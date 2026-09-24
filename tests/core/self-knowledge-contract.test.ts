import { describe, expect, it } from 'vitest';
import { PHASE_ORDER } from '../../src/core/phase.js';
import {
  SELF_KNOWLEDGE_PROMPT_MAX_CHARS,
  renderSelfKnowledgeContract,
} from '../../src/core/self-knowledge-contract.js';

describe('Walnut self-knowledge contract', () => {
  it('keeps only first-tool-choice facts in a small bootstrap prompt', () => {
    const prompt = renderSelfKnowledgeContract();

    expect(prompt.length).toBeLessThanOrEqual(SELF_KNOWLEDGE_PROMPT_MAX_CHARS);
    expect(prompt).toContain('`task_create` creates AND starts it');
    expect(prompt).toContain('`record_only: true` saves a placeholder');
    expect(prompt).toContain('`task_start` starts an existing task');
    expect(prompt).toContain('`task_send` adds context');
    expect(prompt).toContain('`task_history` reads its conversation');
    // The task is the only work identity the first tool call needs, so the
    // retired session ops must not come back into the bootstrap prompt.
    expect(prompt).not.toContain('session_start');
    expect(prompt).not.toContain('session_send');
    expect(prompt).toContain('explicit task ID');
    expect(prompt).toContain('Satellite is represented by no stored focus tier');
    expect(prompt).not.toContain('/api/');
    expect(prompt).not.toContain('tasks.sqlite');
  });

  it('teaches the whole lifecycle from PHASE_ORDER, with no human-vs-AI rule', () => {
    const prompt = renderSelfKnowledgeContract();

    // Every phase the product has is named, and the list is derived — a phase
    // added to phase.ts must reach this prompt without a second edit.
    for (const phase of PHASE_ORDER) expect(prompt).toContain(phase);
    // (WAIT removed 2026-08-18) — the prompt no longer names a blocked phase;
    // it teaches that a blocked/parked task is just TODO.
    expect(prompt).toContain('A blocked or parked task is just TODO');
    expect(prompt).not.toContain('`WAIT`');
    expect(prompt).toContain('`COMPLETE` when it is finished');
    expect(prompt).toContain('You may set any phase; none is reserved');

    // `status` left every tool surface 2026-09-01, so the bootstrap prompt has
    // to say phase is the only state field. Without this line the Main Agent
    // keeps writing where.status / task_update{status}, which no longer resolve.
    expect(prompt).toContain('ONE state field');
    expect(prompt).toContain('no `status`');
    // Phase is the lifecycle the agent WRITES; execution is what a read reports
    // about the run. An agent that thinks it can set execution invents a call.
    expect(prompt).toContain('`execution` on a read observes the run; you never set it');
    // NEED_ACTION is the rename of AGENT_COMPLETE (same state, honest name). The
    // old name must not survive anywhere in the prompt, or the agent learns a
    // phase value the API will reject.
    expect(prompt).toContain('NEED_ACTION');
    expect(prompt).not.toContain('AGENT_COMPLETE');

    // The deleted mechanism must not creep back in as prose.
    expect(prompt).not.toMatch(/only a human/i);
    expect(prompt).not.toMatch(/human-only/i);
    expect(prompt).not.toContain('AWAIT_HUMAN_ACTION');
    expect(prompt).not.toContain('HUMAN_VERIFIED');
    expect(prompt).not.toContain('POST_WORK_COMPLETED');
  });
});
