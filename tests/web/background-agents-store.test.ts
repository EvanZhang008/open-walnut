/**
 * background-agents-store — the ledger→chat-card bridge. The store exists so a
 * task_progress heartbeat re-renders only the card whose agent moved; that
 * property IS the identity contract pinned here: an unchanged entry keeps its
 * object, an unchanged snapshot notifies nobody.
 */
import { describe, it, expect } from 'vitest';
import { publishLiveAgents, getLiveAgentStatus, subscribeLiveAgents } from '../../web/src/stores/background-agents-store';

const SID = 'sess-1';
const snapshot = (toolUseId: string, sessionId = SID) => getLiveAgentStatus(sessionId, toolUseId);

describe('publishLiveAgents — identity + notification contract', () => {
  it('keeps the entry object for an agent whose status and tool count did not change', () => {
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 3 }]);
    const first = snapshot('tu-a');
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 3 }, { toolUseId: 'tu-b', status: 'running' }]);
    expect(snapshot('tu-a')).toBe(first);
    expect(snapshot('tu-b')).toEqual({ status: 'running', toolUses: undefined });
  });

  it('replaces the entry when the count or status moves', () => {
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 3 }]);
    const first = snapshot('tu-a');
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 4 }]);
    expect(snapshot('tu-a')).not.toBe(first);
    expect(snapshot('tu-a')?.toolUses).toBe(4);
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'completed', toolUses: 4 }]);
    expect(snapshot('tu-a')?.status).toBe('completed');
  });

  it('notifies subscribers only when something changed', () => {
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 1 }]);
    let calls = 0;
    const off = subscribeLiveAgents(SID, () => { calls++; });
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 1 }]); // same → silent
    expect(calls).toBe(0);
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running', toolUses: 2 }]);
    expect(calls).toBe(1);
    off();
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'completed', toolUses: 2 }]);
    expect(calls).toBe(1);
  });

  it('ignores tasks without a toolUseId and forgets agents that left the snapshot', () => {
    publishLiveAgents(SID, [{ status: 'running' }, { toolUseId: 'tu-x', status: 'running' }]);
    expect(snapshot('tu-x')).toEqual({ status: 'running', toolUses: undefined });
    publishLiveAgents(SID, []);
    expect(snapshot('tu-x')).toBeNull();
  });

  it('is per session', () => {
    publishLiveAgents('other', [{ toolUseId: 'tu-a', status: 'failed' }]);
    publishLiveAgents(SID, [{ toolUseId: 'tu-a', status: 'running' }]);
    expect(snapshot('tu-a')?.status).toBe('running');
    expect(snapshot('tu-a', 'other')?.status).toBe('failed');
  });
});
