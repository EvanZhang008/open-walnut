import { describe, expect, it } from 'vitest';
import { parseSessionMessages } from '../../src/core/history-parse.js';
import { SESSION_EFFORT_IDS } from '../../src/core/types.js';
import { agentPromptInput, recordedAgentEffort } from '../../web/src/components/sessions/agent-effort.js';

const row = (effort?: unknown, id = 'msg-agent', role = 'assistant') => ({
  type: role, uuid: id, timestamp: '2026-01-01T00:00:00.000Z', effort,
  message: { id, role, content: [{ type: 'text', text: 'Agent output' }] },
});
const parse = (...rows: unknown[]) => parseSessionMessages(rows.map(r => JSON.stringify(r)).join('\n'));

describe('agent effort from the call or its own transcript', () => {
  it.each(SESSION_EFFORT_IDS)('preserves the CLI-recorded %s effort', effort => {
    const messages = parse(row(effort));
    expect(messages[0].effort).toBe(effort);
    expect(agentPromptInput({ model: 'opus', run_in_background: true }, recordedAgentEffort(messages)))
      .toEqual({ model: 'opus', run_in_background: true, effort });
  });

  it.each([undefined, null, '', 'unknown', 100, {}, ['high']])('does not invent an effort for %j', effort => {
    const messages = parse(row(effort));
    expect(messages[0]).not.toHaveProperty('effort');
    const input = { model: 'sonnet' };
    expect(agentPromptInput(input, recordedAgentEffort(messages))).toBe(input);
  });

  it('keeps the effort explicitly passed to the Agent call', () => {
    const input = { model: 'opus', effort: 'max', run_in_background: true };
    expect(agentPromptInput(input, recordedAgentEffort(parse(row('high'))))).toBe(input);
  });

  it('takes effort from a later fragment of the same assistant message', () => {
    expect(parse(row(), row('xhigh'))).toHaveLength(1);
    expect(recordedAgentEffort(parse(row(), row('xhigh')))).toBe('xhigh');
  });

  it('uses the newest assistant record and ignores user metadata and prompt text', () => {
    expect(recordedAgentEffort(parse(row('low'), row('max', 'msg-next'), row('high', 'user-row', 'user')))).toBe('max');
    expect(recordedAgentEffort(parse(row('high', 'user-only', 'user')))).toBeUndefined();
    expect(recordedAgentEffort([{ role: 'assistant', timestamp: '', text: 'effort: high' }])).toBeUndefined();
  });

  it('has no fallback on an empty or missing transcript', () => {
    expect(recordedAgentEffort(null)).toBeUndefined();
    expect(agentPromptInput(undefined, undefined)).toBeUndefined();
    expect(agentPromptInput(undefined, 'medium')).toEqual({ effort: 'medium' });
  });
});
