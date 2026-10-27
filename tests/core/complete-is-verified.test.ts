/**
 * A completed task is verified (2026-10-27, the user: "If the task is closed, mostly close by me
 * means I already verified ... this is generic rules"): its stored status reads Done from the
 * completing write on, task_get shows none of its last open words, the Brief's list of moves
 * names it Done with no words, and its own turn-end ask says it is verified.
 */
import { describe, expect, it } from 'vitest';
import { phaseDerivedFields } from '../../src/core/phase.js';
import { taskView } from '../../src/ops/task-execution.js';
import { briefMoveLines, briefPrompt } from '../../src/core/sessions/brief.js';
import { buildSelfReportPrompt } from '../../src/core/session-hooks/builtins.js';
import { COMPLETE_IS_VERIFIED } from '../../src/core/user-status.js';
import type { Task } from '../../src/core/types.js';

const NOW = '2026-10-27T10:00:00.000Z';

describe('COMPLETE counts as verified', () => {
  it('the completing write stores a Done status; other phases leave it alone', () => {
    expect(phaseDerivedFields({}, 'COMPLETE', NOW).set.user_status).toEqual({ state: 'done' });
    expect(phaseDerivedFields({}, 'IN_PROGRESS', NOW).set).not.toHaveProperty('user_status');
    // Reopened: the Done status goes; any other one is left to the sync.
    expect(phaseDerivedFields({ user_status: { state: 'done' } }, 'IN_PROGRESS', NOW).clear).toContain('user_status');
    expect(phaseDerivedFields({ user_status: { state: 'working' } }, 'IN_PROGRESS', NOW).clear).not.toContain('user_status');
  });

  it('task_get shows Done and no leftover report', () => {
    const view = taskView({
      id: 't1', phase: 'COMPLETE', status: 'done',
      user_status: { state: 'waiting', waitingOn: 'The user installs TestFlight 127' },
      status_report: { state: 'waiting', waitingOn: 'The user installs TestFlight 127' },
    })
    expect(view.user_status).toEqual({ state: 'done' })
    expect(view).not.toHaveProperty('status_report')
    const open = taskView({ id: 't2', phase: 'WAITING', status: 'in_progress', user_status: { state: 'waiting', waitingOn: 'CI' } })
    expect(open.user_status).toEqual({ state: 'waiting', waitingOn: 'CI' })
  });

  it("the Brief's moves name a completed task Done with none of its last words", () => {
    const owner = { id: 'lead', title: 'Lead', org_role: 'lead', project: 'Walnut', phase: 'IN_PROGRESS', brief: { text: 'x', at: '2026-10-27T09:00:00.000Z' } } as Task;
    const done = {
      id: 'w1', title: 'Phone video', project: 'Walnut', parent_task_id: 'lead', phase: 'COMPLETE', status: 'done',
      updated_at: NOW, phase_changed_at: NOW, completed_at: NOW,
      user_status: { state: 'waiting', waitingOn: 'The user installs TestFlight 127', at: '2026-10-27T08:00:00.000Z' },
    } as unknown as Task;
    const lines = briefMoveLines(owner, [owner, done]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/: now Done$/);
    expect(lines.join('\n')).not.toContain('TestFlight');
  });

  it('the prompts say it', () => {
    expect(briefPrompt({ hadBrief: true, moves: [] })).toContain(COMPLETE_IS_VERIFIED);
    expect(buildSelfReportPrompt('', 'Phone video', { complete: true })).toContain('This task is COMPLETE: the user closed it, so it is verified.');
    expect(buildSelfReportPrompt('', 'Phone video', {})).not.toContain('This task is COMPLETE');
    expect(buildSelfReportPrompt('', 'Main', { mainAgent: true })).toContain('whose task is COMPLETE, becomes one short [DONE] line');
  });
});
