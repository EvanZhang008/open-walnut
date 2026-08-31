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
    expect(prompt).toContain('`task_create` records work only');
    expect(prompt).toContain('`session_start` starts a session');
    expect(prompt).toContain('`session_send` messages a live session');
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

    // The deleted mechanism must not creep back in as prose.
    expect(prompt).not.toMatch(/only a human/i);
    expect(prompt).not.toMatch(/human-only/i);
    expect(prompt).not.toContain('AWAIT_HUMAN_ACTION');
    expect(prompt).not.toContain('HUMAN_VERIFIED');
    expect(prompt).not.toContain('POST_WORK_COMPLETED');
  });
});
