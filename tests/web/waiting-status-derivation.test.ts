/**
 * Derived "Waiting" display state (incident 7e26389d, 2026-08-03).
 *
 * The CLI is THREE-state (running / idle / requires_action) but ProcessStatus
 * only surfaces two of them: on requires_action (paused on a permission /
 * ExitPlanMode approval prompt) process_status deliberately stays 'running',
 * so the badge showed a green "Running" for 15h while the CLI sat blocked on
 * a human click. The fix derives a display-only 'waiting' state from
 * process_status + pendingPermission — the /api/v1 ProcessStatus enum stays
 * frozen (iOS parses it).
 */

import { describe, it, expect } from 'vitest';
import { deriveDisplayStatus, waitingBadgeTitle } from '../../web/src/utils/session-status';

describe('deriveDisplayStatus', () => {
  it('INCIDENT SHAPE: running + pendingPermission → waiting (not a fake Running)', () => {
    expect(deriveDisplayStatus('running', { requestId: 'r1' })).toBe('waiting');
  });

  it('running without a prompt stays running', () => {
    expect(deriveDisplayStatus('running', null)).toBe('running');
    expect(deriveDisplayStatus('running', undefined)).toBe('running');
  });

  it('a stale prompt on a settled/errored record does NOT mask that state', () => {
    // pendingPermission can linger on disk after a crash; only a live
    // 'running' session can genuinely be paused on it.
    expect(deriveDisplayStatus('idle', { requestId: 'r1' })).toBe('idle');
    expect(deriveDisplayStatus('error', { requestId: 'r1' })).toBe('error');
    expect(deriveDisplayStatus('stopped', { requestId: 'r1' })).toBe('stopped');
  });
});

describe('waitingBadgeTitle', () => {
  it('names the tool and the wait duration', () => {
    const now = Date.parse('2026-08-03T20:00:00Z');
    const receivedAt = '2026-08-03T04:29:12Z'; // the incident's real prompt time
    const title = waitingBadgeTitle({ toolName: 'ExitPlanMode', receivedAt }, now);
    expect(title).toContain('ExitPlanMode');
    expect(title).toMatch(/15h \d+m/); // ~15.5h — the incident's real wait
  });

  it('degrades gracefully without a timestamp or tool name', () => {
    expect(waitingBadgeTitle({})).toBe('Waiting for approval: a tool');
  });
});
