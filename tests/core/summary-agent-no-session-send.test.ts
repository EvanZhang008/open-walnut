/**
 * Guards the retirement of the summarizer subagents.
 *
 * History: "triage" first auto-drove sessions (session_send), then became a
 * recorder-only subagent, and finally (2026-07) was DELETED entirely: the session
 * itself writes the merged summary via side_question and a deterministic
 * PHASE_SIGNAL lookup decides phase/notify (see session-hooks/builtins.ts).
 *
 * If either retired agent id resolves to a real agent definition again, someone
 * re-introduced a model-driven summarizer — that regression must be deliberate
 * (re-read the eval notes in memory usage_dashboard_and_summarizer_cost_overhaul.md).
 */
import { describe, it, expect } from 'vitest';
import { getAgent, DEFAULT_TRIAGE_AGENT_ID } from '../../src/core/agent-registry.js';

describe('summarizer subagents are retired', () => {
  it('the turn-complete triage agent no longer exists (session self-report replaced it)', async () => {
    const agent = await getAgent(DEFAULT_TRIAGE_AGENT_ID);
    expect(agent).toBeUndefined();
  });

  it('the id constant survives for event/usage classification', () => {
    expect(DEFAULT_TRIAGE_AGENT_ID).toBe('turn-complete-triage');
  });

  it('the retired per-message triage agent no longer exists either', async () => {
    const retired = await getAgent('message-send-triage');
    expect(retired).toBeUndefined();
  });
});
