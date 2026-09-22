/**
 * Whose ask is this? The task's own stamp answers, and a FAILURE TO READ IT IS NOT AN ANSWER.
 *
 * A retry on an existing ask (the slot's Retry, or ▶ Start on a stamped task) names no agent, so the
 * launch reads `agent_id` off the task. That read used to fold every failure into `undefined`, which is
 * also what "this is Walnut's own ask" looks like: a store hiccup therefore resumed a Mentor ask as
 * Walnut, with the wrong persona and the wrong memory, under a task whose own stamp said Mentor.
 *
 * Refusing the launch is recoverable, a session wearing another agent's identity is not, so a store
 * failure throws. The one failure that stays `undefined` is the task genuinely not existing, because the
 * caller's own lookup turns that into the 404 it should be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const getTask = vi.fn();
vi.mock('../../src/core/task-manager.js', () => ({ getTask: (id: string) => getTask(id) }));

import { stampedAgentId } from '../../src/core/sessions/ask-agent.js';

beforeEach(() => {
  getTask.mockReset();
});

describe('stampedAgentId', () => {
  it('answers with the stamp when the task carries one', async () => {
    getTask.mockResolvedValue({ id: 't1', agent_id: 'mentor' });
    await expect(stampedAgentId('t1')).resolves.toBe('mentor');
  });

  it('answers undefined for a task with no stamp — that is Walnut s own ask', async () => {
    getTask.mockResolvedValue({ id: 't1', agent_id: '' });
    await expect(stampedAgentId('t1')).resolves.toBeUndefined();
    getTask.mockResolvedValue({ id: 't1' });
    await expect(stampedAgentId('t1')).resolves.toBeUndefined();
  });

  it('THROWS when the store could not be read, rather than claiming there is no stamp', async () => {
    getTask.mockRejectedValue(new Error('EIO: could not read tasks.json'));
    await expect(stampedAgentId('t1')).rejects.toThrow('EIO');
  });

  it('still answers undefined for a task that is not there, so the caller s own 404 stands', async () => {
    getTask.mockRejectedValue(new Error('No task found matching "t-gone"'));
    await expect(stampedAgentId('t-gone')).resolves.toBeUndefined();
  });
});
