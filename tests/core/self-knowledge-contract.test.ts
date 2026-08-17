import { describe, expect, it } from 'vitest';
import { AGENT_HANDOFF_PHASES, HUMAN_COMPLETE_PHASE } from '../../src/core/phase.js';
import {
  SELF_KNOWLEDGE_PROMPT_MAX_CHARS,
  renderSelfKnowledgeContract,
} from '../../src/core/self-knowledge-contract.js';

describe('Walnut self-knowledge contract', () => {
  it('keeps only first-tool-choice facts in a small bootstrap prompt', () => {
    const prompt = renderSelfKnowledgeContract();

    expect(prompt.length).toBeLessThanOrEqual(SELF_KNOWLEDGE_PROMPT_MAX_CHARS);
    expect(prompt).toContain('`task_create` records work only');
    expect(prompt).toContain('Use `delegate`');
    expect(prompt).toContain('explicit task ID');
    expect(prompt).toContain(`Hand work back with \`${AGENT_HANDOFF_PHASES.readyForReview}\``);
    expect(prompt).toContain(`\`${AGENT_HANDOFF_PHASES.needsHuman}\` when human action is required`);
    expect(prompt).toContain(`Only a human may set \`${HUMAN_COMPLETE_PHASE}\``);
    expect(prompt).toContain('Satellite is represented by no stored focus tier');
    expect(prompt).not.toContain('/api/');
    expect(prompt).not.toContain('tasks.sqlite');
  });
});
