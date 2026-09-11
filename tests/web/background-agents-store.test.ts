/**
 * background-agents-store — the ledger→chat-card bridge. The store exists so a
 * task_progress heartbeat re-renders only the card whose agent moved; that
 * property IS the identity contract pinned here: an unchanged entry keeps its
 * object, and the per-agent map keeps ITS identity when no entry moved (so a
 * useSyncExternalStore reader of the map sees an equal snapshot and skips the
 * render). The whole-list snapshot, read by the Background tasks panel, is
 * replaced on every publish because tokens/elapsed move on every heartbeat.
 */
import { describe, it, expect } from 'vitest';
import { publishLiveAgents, getLiveAgentStatus, getLiveTasks, subscribeLiveAgents } from '../../web/src/stores/background-agents-store';
import type { BackgroundTask } from '../../web/src/hooks/useBackgroundTasks';

const SID = 'sess-1';
const snapshot = (toolUseId: string, sessionId = SID) => getLiveAgentStatus(sessionId, toolUseId);
const task = (t: Partial<BackgroundTask> & { status: string }): BackgroundTask =>
  ({ taskId: t.toolUseId ?? 'anon', taskType: 'local_agent', ...t } as BackgroundTask);

describe('publishLiveAgents — identity + notification contract', () => {
  it('keeps the entry object for an agent whose status and tool count did not change', () => {
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 3 })]);
    const first = snapshot('tu-a');
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 3 }), task({ toolUseId: 'tu-b', status: 'running' })]);
    expect(snapshot('tu-a')).toBe(first);
    expect(snapshot('tu-b')).toEqual({ status: 'running', toolUses: undefined });
  });

  it('replaces the entry when the count or status moves', () => {
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 3 })]);
    const first = snapshot('tu-a');
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 4 })]);
    expect(snapshot('tu-a')).not.toBe(first);
    expect(snapshot('tu-a')?.toolUses).toBe(4);
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'completed', toolUses: 4 })]);
    expect(snapshot('tu-a')?.status).toBe('completed');
  });

  it('notifies on every publish, but the per-agent map keeps its identity when nothing moved', () => {
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 1 })]);
    const entry = snapshot('tu-a');
    let calls = 0;
    const off = subscribeLiveAgents(SID, () => { calls++; });
    const same = [task({ toolUseId: 'tu-a', status: 'running', toolUses: 1, tokens: 500 })];
    publishLiveAgents(SID, same); // a heartbeat: tokens moved, status/count did not
    expect(calls).toBe(1);
    expect(snapshot('tu-a')).toBe(entry);
    expect(getLiveTasks(SID)).toBe(same);
    publishLiveAgents(SID, same); // the very same array → silent
    expect(calls).toBe(1);
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running', toolUses: 2 })]);
    expect(calls).toBe(2);
    expect(snapshot('tu-a')).not.toBe(entry);
    off();
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'completed', toolUses: 2 })]);
    expect(calls).toBe(2);
  });

  it('serves the whole ledger per session for the panel; empty for a session never published', () => {
    const list = [task({ toolUseId: 'tu-p', status: 'running' }), task({ toolUseId: 'tu-q', status: 'completed' })];
    publishLiveAgents('panel-sess', list);
    expect(getLiveTasks('panel-sess')).toBe(list);
    expect(getLiveTasks('never')).toEqual([]);
    expect(getLiveTasks(undefined)).toEqual([]);
  });

  it('ignores tasks without a toolUseId and forgets agents that left the snapshot', () => {
    publishLiveAgents(SID, [task({ status: 'running' }), task({ toolUseId: 'tu-x', status: 'running' })]);
    expect(snapshot('tu-x')).toEqual({ status: 'running', toolUses: undefined });
    publishLiveAgents(SID, []);
    expect(snapshot('tu-x')).toBeNull();
  });

  it('is per session', () => {
    publishLiveAgents('other', [task({ toolUseId: 'tu-a', status: 'failed' })]);
    publishLiveAgents(SID, [task({ toolUseId: 'tu-a', status: 'running' })]);
    expect(snapshot('tu-a')?.status).toBe('running');
    expect(snapshot('tu-a', 'other')?.status).toBe('failed');
  });
});
