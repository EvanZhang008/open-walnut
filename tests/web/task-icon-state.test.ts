/**
 * The one status icon state of a task (web/src/utils/task-icon-state.ts) and the component that
 * draws it (web/src/components/common/TaskStateIcon.tsx): every one of the seven states from a
 * real task shape, the phase as the fallback, the live session status, and the section rule.
 * 2026-11-21, the user: "I can't tell if it is working or not started"; Working, Not started and
 * Waiting each have their own icon now, and Working breathes.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { Task } from '@open-walnut/core';
import {
  TASK_ICON_STATES, TASK_ICON_WORDS, iconStateOf, phaseIconState, sectionHeadState, sectionIconState, taskIconState,
} from '../../web/src/utils/task-icon-state';
import { taskStatusLabel } from '../../web/src/utils/session-status';
import { TaskStateIcon } from '../../web/src/components/common/TaskStateIcon';
import { TASK_STATE_SHAPES, shapeMaskSvg, taskStateMaskCss } from '../../web/src/components/common/task-state-shapes';

type Us = NonNullable<Task['user_status']>;
const task = (user_status: Partial<Us> | null, phase = 'IN_PROGRESS', extra: Partial<Task> = {}) =>
  ({ id: 't', phase, status: phase === 'COMPLETE' ? 'done' : 'todo', user_status: user_status ?? undefined, ...extra }) as unknown as Task;

describe('taskIconState: the seven states from the user status', () => {
  it('reads each stored state', () => {
    expect(taskIconState(task({ state: 'needs' }))).toBe('needs');
    expect(taskIconState(task({ state: 'read', toRead: 'result' }))).toBe('read');
    // An older server's To read: Waiting with toRead.
    expect(taskIconState(task({ state: 'waiting', toRead: 'turn' }))).toBe('read');
    expect(taskIconState(task({ state: 'working' }))).toBe('working');
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING'))).toBe('waiting');
    expect(taskIconState(task({ state: 'done' }, 'COMPLETE'))).toBe('done');
  });

  it('a snoozed wait is Snoozed: stored, or a start date just written', () => {
    expect(taskIconState(task({ state: 'waiting', snoozed: { until: '2099-01-01' } } as Partial<Us>))).toBe('snoozed');
    // Needs you with a start date still to come reads Snoozed at once (snoozedAhead), before the server's pass.
    expect(taskIconState(task({ state: 'needs', source: 'session' }, 'NEED_ACTION', { start_date: '2099-01-01T09:00:00Z' }))).toBe('snoozed');
    // Main is never snoozed.
    expect(taskIconState(task({ state: 'needs', source: 'session' }, 'NEED_ACTION', { start_date: '2099-01-01T09:00:00Z', org_role: 'main' } as Partial<Task>))).toBe('needs');
    // A task not derived yet: the caller's reading of the start date.
    expect(taskIconState(task(null, 'NEED_ACTION'), null, true)).toBe('snoozed');
  });

  it('nobody started it: Not started, never Waiting', () => {
    expect(taskIconState(task({ state: 'waiting', kind: 'not-started' }, 'TODO'))).toBe('todo');
    // A snooze wins over not started; a usage limit is a wait.
    expect(taskIconState(task({ state: 'waiting', kind: 'not-started', snoozed: { until: 'x' } } as Partial<Us>, 'TODO'))).toBe('snoozed');
    expect(taskIconState(task({ state: 'waiting', kind: 'not-started', limit: { auto: true } } as unknown as Partial<Us>, 'TODO'))).toBe('waiting');
    // The phase fallback: TODO with no session is Not started, with one it waits.
    expect(taskIconState(task(null, 'TODO'))).toBe('todo');
    expect(taskIconState(task(null, 'TODO', { session_id: 's1' }))).toBe('waiting');
  });

  it('the phase alone when the server has not derived it yet', () => {
    expect(taskIconState(task(null, 'NEED_ACTION'))).toBe('needs');
    expect(taskIconState(task(null, 'IN_PROGRESS'))).toBe('working');
    expect(taskIconState(task(null, 'WAITING'))).toBe('waiting');
    expect(taskIconState(task(null, 'COMPLETE'))).toBe('done');
  });

  it('the live status: a running turn is Working, a prompt Needs you; Needs you and To read outrank a turn', () => {
    const running = { process_status: 'running' };
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING'), running)).toBe('working');
    expect(taskIconState(task({ state: 'waiting', kind: 'not-started' }, 'TODO'), running)).toBe('working');
    // A completed task is Completed whatever its session does, as its words say (a late turn, a prompt).
    expect(taskIconState(task({ state: 'done' }, 'COMPLETE'), running)).toBe('done');
    expect(taskIconState(task({ state: 'done' }, 'COMPLETE'), { process_status: 'running', pendingPermissionTool: 'Bash' })).toBe('done');
    expect(taskIconState(task(null, 'COMPLETE'), running)).toBe('done');
    expect(taskIconState(task({ state: 'needs' }), running)).toBe('needs');
    expect(taskIconState(task({ state: 'read', toRead: 'result' }), running)).toBe('read');
    expect(taskIconState(task({ state: 'working' }), { process_status: 'running', pendingPermissionTool: 'Bash' })).toBe('needs');
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING'), { process_status: 'idle' })).toBe('waiting');
  });

  it('without a live status, the task\'s enrichment snapshot (session_status) speaks, as askState reads it', () => {
    const snap = (s: Record<string, unknown>) => ({ session_id: 's1', session_status: s }) as Partial<Task>;
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING', snap({ process_status: 'running' })))).toBe('working');
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING', snap({ process_status: 'running' })), null)).toBe('working');
    expect(taskIconState(task({ state: 'working' }, 'IN_PROGRESS', snap({ process_status: 'running', pendingPermissionTool: 'Bash' })))).toBe('needs');
    // A live status the store has is fresher than the snapshot.
    expect(taskIconState(task({ state: 'waiting', kind: 'task' }, 'WAITING', snap({ process_status: 'running' })), { process_status: 'idle' })).toBe('waiting');
    expect(taskIconState(task({ state: 'done' }, 'COMPLETE', snap({ process_status: 'running' })))).toBe('done');
  });

  it('its word is the status words every surface uses (taskStatusLabel)', () => {
    const shapes = [
      task({ state: 'needs' }), task({ state: 'working' }), task({ state: 'waiting', kind: 'task' }, 'WAITING'),
      task({ state: 'waiting', snoozed: { until: 'x' } } as Partial<Us>), task({ state: 'waiting', kind: 'not-started' }, 'TODO'),
      task({ state: 'done' }, 'COMPLETE'),
    ];
    for (const t of shapes) expect(TASK_ICON_WORDS[taskIconState(t)]).toBe(taskStatusLabel(t));
    // To read is drawn under Needs you in words (shownState); its icon is its own.
    expect(taskStatusLabel(task({ state: 'read', toRead: 'result' }))).toBe('Needs you');
    expect(TASK_ICON_WORDS.read).toBe('To read');
  });
});

describe('the other readings', () => {
  it('iconStateOf and phaseIconState', () => {
    expect(iconStateOf('waiting', { snoozed: true, notStarted: true })).toBe('snoozed');
    expect(iconStateOf('waiting', { notStarted: true })).toBe('todo');
    expect(iconStateOf('waiting')).toBe('waiting');
    expect(iconStateOf('read', { snoozed: true })).toBe('read');
    expect(['TODO', 'WAITING', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE', undefined].map(phaseIconState))
      .toEqual(['todo', 'waiting', 'working', 'needs', 'done', 'todo']);
  });

  it('a section row wears its section\'s state, a To read and a snooze kept', () => {
    expect(sectionIconState('needs', 'read')).toBe('read');
    expect(sectionIconState('needs', 'working')).toBe('needs');
    expect(sectionIconState('working', 'waiting')).toBe('working');
    expect(sectionIconState('waiting', 'needs')).toBe('waiting');
    expect(sectionIconState('waiting', 'waiting', true)).toBe('snoozed');
    expect(sectionIconState('waiting', 'snoozed')).toBe('snoozed');
    expect(sectionIconState('waiting', 'todo')).toBe('todo');
    expect(sectionIconState('notstarted', 'waiting')).toBe('todo');
    expect(sectionIconState('watching', 'snoozed')).toBe('snoozed');
    expect(sectionIconState('needs', 'done')).toBe('done');
    expect(['needs', 'working', 'waiting', 'notstarted', 'done', 'watching', 'background'].map(sectionHeadState))
      .toEqual(['needs', 'working', 'waiting', 'todo', 'done', null, null]);
  });
});

describe('TaskStateIcon draws each state', () => {
  const html = (props: Parameters<typeof TaskStateIcon>[0]) => renderToStaticMarkup(createElement(TaskStateIcon, props));

  it('one distinct shape per state, named by its word', () => {
    const shapes = new Set<string>();
    for (const state of TASK_ICON_STATES) {
      const out = html({ state });
      expect(out, state).toContain(`data-state="${state}"`);
      expect(out, state).toContain(`aria-label="${TASK_ICON_WORDS[state]}"`);
      expect(out, state).toContain('viewBox="0 0 16 16"');
      expect(out, state).toContain('width="14"');
      shapes.add(out.replace(/data-state="[^"]+"|aria-label="[^"]+"/g, ''));
    }
    expect(shapes.size).toBe(TASK_ICON_STATES.length);
  });

  it('only Working has the breathing part; the small form is the same shape, and a hidden one', () => {
    for (const state of TASK_ICON_STATES) expect(html({ state }).includes('tsi-pulse'), state).toBe(state === 'working');
    expect(html({ state: 'todo' })).toContain('stroke-dasharray="2.6 2.4"');
    // Beside small text it is the icon at 12px, never a dot of its own (2026-11-22: the dot form drew a
    // Waiting task as a thin ring where the icon drew a clock).
    for (const state of TASK_ICON_STATES) {
      const small = html({ state, size: 12 });
      expect(small, state).toContain('width="12"');
      expect(small.replace(/width="12" height="12"/, 'width="14" height="14"'), state).toBe(html({ state }));
    }
    expect(html({ state: 'done', decorative: true, size: 12 })).toMatch(/aria-hidden="true"[^>]*>|width="12"/);
    expect(html({ state: 'done', decorative: true })).not.toContain('aria-label');
  });

  it('Working\'s breathing centre is an element over the ring, not an SVG part (it composites)', () => {
    const out = html({ state: 'working' });
    expect(out).toMatch(/^<span class="task-state-icon" data-state="working" role="img" aria-label="Working"><svg [^>]*>.*<\/svg><i class="tsi-pulse"><\/i><\/span>$/);
    expect(out.slice(out.indexOf('<svg'), out.indexOf('</svg>'))).not.toContain('tsi-pulse');
  });

  it('To read\'s lines and Completed\'s tick are holes (a mask), never drawn in a page colour', () => {
    for (const state of ['read', 'done'] as const) {
      const out = html({ state });
      const id = out.match(/<mask id="([^"]+)"/)?.[1];
      expect(id, state).toMatch(/^tsi-cut-[\w-]+$/);
      expect(out, state).toContain(`mask="url(#${id})"`);
      expect(out, state).not.toContain('tsi-cut"');
    }
    // Two icons on one page each cut with their own mask.
    const two = renderToStaticMarkup(createElement('div', null, createElement(TaskStateIcon, { state: 'done' }), createElement(TaskStateIcon, { state: 'read' })));
    const ids = [...two.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the marks CSS draws are the icon's own shapes (task pills, the Brief)", () => {
  const html = (props: Parameters<typeof TaskStateIcon>[0]) => renderToStaticMarkup(createElement(TaskStateIcon, props));
  const decode = (css: string, state: string) => decodeURIComponent(css.match(new RegExp(`--tsi-mask-${state}: url\\("data:image/svg\\+xml,([^"]+)"\\)`))![1]!);
  const geometry = (svg: string) => [...svg.matchAll(/\b(?:d|r|cx|cy|x|y|width|height|rx|stroke-width|stroke-dasharray)="[^"]+"/g)].map((m) => m[0].replace(/strokeWidth|stroke-width/, 'sw').replace(/strokeDasharray|stroke-dasharray/, 'sd'));

  it('every state has a mask, each its own, built from the same parts as the inline icon', () => {
    const css = taskStateMaskCss();
    const masks = new Set<string>();
    for (const state of TASK_ICON_STATES) {
      const svg = decode(css, state);
      expect(svg, state).toBe(shapeMaskSvg(state));
      expect(svg, state).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 16 16">/);
      masks.add(svg);
      // Every part of the inline icon is in the mask, at the same place and size.
      const inline = html({ state }).replace(/^<span[^>]*><svg[^>]*>/, '');
      for (const g of geometry(inline).filter((a) => !/^(width|height|x|y)="(16|0)"$/.test(a))) expect(geometry(svg), `${state} ${g}`).toContain(g);
    }
    expect(masks.size).toBe(TASK_ICON_STATES.length);
  });

  it("what the icon cuts or marks is a hole in the mask, and Working's centre is drawn", () => {
    expect(shapeMaskSvg('needs')).toMatch(/<mask id="c"[^>]*><rect width="16" height="16" fill="#fff"\/><g fill="#000"><rect x="7.1"/);
    expect(shapeMaskSvg('done')).toMatch(/<g stroke="#000"><path d="M4.8 8.2/);
    expect(shapeMaskSvg('working')).toContain('<circle cx="8" cy="8" r="3.6" fill="currentColor"/>');
    expect(html({ state: 'working' })).not.toContain('r="3.6"');
    expect(Object.keys(TASK_STATE_SHAPES).sort()).toEqual([...TASK_ICON_STATES].sort());
  });
});
