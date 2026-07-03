/**
 * Guards the post-turn SUMMARY agent's tool discipline.
 *
 * The agent formerly known as "triage" used to auto-drive sessions (Outcome A →
 * session_send to push the 5-phase workflow forward). That auto-pilot was removed:
 * the agent now only RECORDS what a session did (summary/note/phase + optional
 * notify). It must NOT have the session_send tool — if this regresses, the agent
 * could once again message live sessions on its own.
 *
 * The retired per-message triage agent (message-send-triage) must also be gone.
 */
import { describe, it, expect } from 'vitest';
import { getAgent, DEFAULT_TRIAGE_AGENT_ID } from '../../src/core/agent-registry.js';

describe('session summary agent (formerly turn-complete-triage)', () => {
  it('does NOT have session_send in allowed_tools (records, never drives)', async () => {
    const agent = await getAgent(DEFAULT_TRIAGE_AGENT_ID);
    expect(agent).toBeDefined();
    expect(agent!.allowed_tools).not.toContain('session_send');
  });

  it('keeps the recorder tools it needs (task_get/task_update/notify_main_agent)', async () => {
    const agent = await getAgent(DEFAULT_TRIAGE_AGENT_ID);
    expect(agent!.allowed_tools).toContain('task_get');
    expect(agent!.allowed_tools).toContain('task_update');
    expect(agent!.allowed_tools).toContain('notify_main_agent');
  });

  it('the retired per-message triage agent no longer exists', async () => {
    const retired = await getAgent('message-send-triage');
    expect(retired).toBeUndefined();
  });
});
