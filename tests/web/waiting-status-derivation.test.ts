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
import { deriveDisplayStatus, waitingBadgeTitle, taskNeedsAction } from '../../web/src/utils/session-status';

describe('deriveDisplayStatus', () => {
  it('INCIDENT SHAPE: running + pendingPermission → waiting (not a fake Running)', () => {
    expect(deriveDisplayStatus('running', { requestId: 'r1' })).toBe('waiting');
  });

  it('INCIDENT SHAPE 67b22d72: idle + pendingPermission → waiting (not a calm Idle)', () => {
    // Turn-lifecycle races routinely leave the record 'idle' while an
    // AskUserQuestion sits unanswered — the user saw a 2h-pending question
    // behind an amber "Idle" badge. Staleness is now cleared at the source
    // (control_cancel_request handler + attach cross-check + startup heal),
    // so a prompt on a live record is trustworthy and must surface.
    expect(deriveDisplayStatus('idle', { requestId: 'r1' })).toBe('waiting');
  });

  it('running/idle without a prompt keep their own state', () => {
    expect(deriveDisplayStatus('running', null)).toBe('running');
    expect(deriveDisplayStatus('running', undefined)).toBe('running');
    expect(deriveDisplayStatus('idle', null)).toBe('idle');
    expect(deriveDisplayStatus('idle', undefined)).toBe('idle');
  });

  it('a prompt on a dead (stopped/error) record does NOT mask that state', () => {
    // A permission prompt cannot outlive its CLI process — on a terminal
    // record it is stale by definition and must not hide the real state.
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

describe('taskNeedsAction (2026-08-14 red-tint regression)', () => {
  // The whole-row red tint used to be phase-driven; the unread rework moved it
  // onto task.unread, which clears the moment the task is OPENED — so a task
  // still sitting at AGENT_COMPLETE went visually quiet after one glance
  // ("Task 是 Agent Complete 为什么没有提醒"). taskNeedsAction pins the tint
  // back to the PHASE: it must ignore the unread marker entirely.
  const base = { id: 't1', title: 'x', status: 'in_progress', created_at: '', updated_at: '' } as never;

  it('AGENT_COMPLETE needs action even when already read (the regression shape)', () => {
    expect(taskNeedsAction({ ...(base as object), phase: 'AGENT_COMPLETE', unread: false } as never)).toBe(true);
  });

  // (WAIT removed 2026-08-18 — AGENT_COMPLETE is the ONE handed-back phase that
  // tints the row; a retired value must not sneak the tint back in.)
  it('a retired WAIT value no longer needs action', () => {
    expect(taskNeedsAction({ ...(base as object), phase: 'WAIT' } as never)).toBe(false);
  });

  it('working / plain / done phases do not', () => {
    expect(taskNeedsAction({ ...(base as object), phase: 'IN_PROGRESS' } as never)).toBe(false);
    expect(taskNeedsAction({ ...(base as object), phase: 'TODO' } as never)).toBe(false);
    expect(taskNeedsAction({ ...(base as object), phase: 'COMPLETE' } as never)).toBe(false);
  });

  it('done status wins over a stale phase', () => {
    expect(taskNeedsAction({ ...(base as object), status: 'done', phase: 'AGENT_COMPLETE' } as never)).toBe(false);
  });
});
