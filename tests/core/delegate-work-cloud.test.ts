/**
 * delegateWork on a CLOUD REPLICA must relay to the primary — never run the
 * local SESSION_START path (there is no session-runner on the replica, so that
 * emit is a silent no-op that still mutates the task and reports accepted:
 * the 2026-08-22 "ghost session" incident: the Personal AI's replica fallback
 * turn delegated a task, told the user the session started, and no box ever
 * ran it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-delegate-cloud', { CLOUD_MODE: true }));

const callPrimaryControlMock = vi.fn();
vi.mock('../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: callPrimaryControlMock,
}));

import { delegateWork } from '../../src/core/delegate-work.js';

beforeEach(() => {
  callPrimaryControlMock.mockReset();
});

describe('delegateWork on a REPLICA', () => {
  it('relays existing-task delegation to the primary and returns its result', async () => {
    const primaryResult = {
      action: 'started_existing', accepted: true,
      taskId: 'mt4wuvbr-8f81', title: 'Compare NVDA vs AMD data-center revenue growth',
      ref: '[task mt4wuvbr-8f81]',
    };
    callPrimaryControlMock.mockResolvedValue({ ok: true, result: primaryResult });

    const out = await delegateWork({ taskId: 'mt4wuvbr-8f81', message: 'go' }, 'agent');

    expect(out).toEqual(primaryResult);
    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.delegate', '__server__',
      expect.objectContaining({ taskId: 'mt4wuvbr-8f81', message: 'go' }),
    );
  });

  it('relays new-task delegation (creation fields) unchanged', async () => {
    callPrimaryControlMock.mockResolvedValue({
      ok: true,
      result: { action: 'created_started', accepted: true, taskId: 't1', title: 'T', ref: '[task t1]' },
    });

    await delegateWork({ message: 'do it', title: 'T', project: 'Stock Analyzer', cwd: '/x' }, 'agent');

    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.delegate', '__server__',
      expect.objectContaining({ message: 'do it', title: 'T', project: 'Stock Analyzer', cwd: '/x' }),
    );
  });

  it('bridge down → throws an honest error, does NOT report accepted', async () => {
    callPrimaryControlMock.mockResolvedValue({
      ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__' },
    });

    await expect(delegateWork({ taskId: 't1', message: 'go' }, 'agent'))
      .rejects.toThrow(/primary box is unreachable.*Nothing was started/s);
  });

  it('still validates message locally before any relay', async () => {
    await expect(delegateWork({ taskId: 't1', message: '  ' }, 'agent'))
      .rejects.toThrow(/message must be a non-empty string/);
    expect(callPrimaryControlMock).not.toHaveBeenCalled();
  });
});
