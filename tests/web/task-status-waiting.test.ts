/**
 * Waiting as a status (2026-09-30): where it sits among the options, how its
 * optional clock (`wait_until`) reads and is written, and the line above a
 * Waiting task's composer.
 *
 * The pure helpers run as plain functions. The status row and the composer
 * line are mounted with React under linkedom, with the same stubs as
 * task-action-menu-draft-props.test.ts (TaskStatusControl is part of that
 * module graph).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/contexts/FocusBarContext', () => ({ useFocusBarContextSafe: () => null }));
vi.mock('@/hooks/useProjectRegistry', () => ({ useProjectRegistry: () => ({ projects: [] }) }));
vi.mock('@/hooks/useShowPriority', () => ({ useShowPriority: () => true, useShowPriorityState: () => true }));
vi.mock('@/hooks/useIntegrations', () => ({ getIntegrationMeta: () => undefined, useIntegrations: () => [] }));
vi.mock('@/utils/session-status', () => ({ resolveTaskSessionId: () => undefined }));
vi.mock('@/components/tasks/PluginFieldPicker', () => ({ PluginFieldsSection: () => null }));
vi.mock('@/components/tasks/QuoteInSessionItem', () => ({ QuoteInSessionItem: () => null }));
vi.mock('@/api/sessions', () => ({ peekWorkingDirs: () => null }));

const {
  STATUS_OPTIONS, statusLabel, formatWaitUntil, waitUntilFromPick, waitingLineText,
  TaskStatusMenuSection, WaitingComposerLine,
} = await import('../../web/src/components/tasks/TaskStatusControl');

let doc: Document;
let win: Window & typeof globalThis;
let root: { render: (n: unknown) => void; unmount: () => void } | null = null;

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  doc = dom.document as unknown as Document;
  win = dom.window as unknown as Window & typeof globalThis;
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  doc.body.innerHTML = '';
});

async function mount(component: unknown, props: Record<string, unknown>): Promise<HTMLElement> {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(component as never, props)); });
  return host;
}

async function rerender(component: unknown, props: Record<string, unknown>): Promise<void> {
  await act(async () => { root!.render(createElement(component as never, props)); });
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })); });
}

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', title: 'Ship it', status: 'todo', phase: 'TODO', priority: 'none', project: '',
  created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z', ...over,
});

describe('status options', () => {
  it('offer Waiting between To Do and In Progress, in the lifecycle order', () => {
    expect(STATUS_OPTIONS.map((o) => o.value)).toEqual(['TODO', 'WAITING', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
    expect(STATUS_OPTIONS.map((o) => o.label)).toEqual(['To Do', 'Waiting', 'In Progress', 'Need Action', 'Complete']);
    expect(statusLabel('WAITING')).toBe('Waiting');
  });
});

describe('wait_until helpers', () => {
  // A time exactly a week out would print as today's weekday with the shared formatter.
  it('formats the clock with day words, a week out as M/D, and nothing when unset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 10, 0));
    expect(formatWaitUntil(new Date(2026, 9, 6, 10, 54).toISOString())).toBe('10/6 10:54');
    expect(formatWaitUntil(new Date(2026, 8, 30, 9, 5).toISOString())).toBe('Tomorrow 9:05');
    expect(formatWaitUntil(new Date(2026, 9, 2, 18, 0).toISOString())).toBe('Fri 18:00');
    expect(formatWaitUntil(undefined)).toBe('');
    expect(formatWaitUntil('')).toBe('');
  });

  it('turns a day pick into 9:00 local that day, and passes a time pick through', () => {
    const at = new Date(waitUntilFromPick('2026-10-02'));
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 9, 2, 9, 0]);
    expect(waitUntilFromPick('2026-10-02T16:30:00.000Z')).toBe('2026-10-02T16:30:00.000Z');
  });

  it('writes the composer line for a Waiting task only', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 10, 0));
    expect(waitingLineText({ phase: 'WAITING', wait_until: new Date(2026, 9, 2, 13, 27).toISOString() }))
      .toBe('Waiting until Fri 13:27 · a message here moves it to In Progress');
    expect(waitingLineText({ phase: 'WAITING' })).toBe('Waiting until something happens · a message here moves it to In Progress');
    expect(waitingLineText({ phase: 'TODO' })).toBe('');
  });
});

describe('WaitingComposerLine', () => {
  it('renders one line for a Waiting task, with no buttons', async () => {
    const host = await mount(WaitingComposerLine, { task: task({ phase: 'WAITING' }) });
    const line = host.querySelector('[data-testid="session-waiting-line"]')!;
    expect(line).toBeTruthy();
    expect(line.textContent).toBe('Waiting until something happens · a message here moves it to In Progress');
    expect(line.querySelectorAll('button')).toHaveLength(0);
  });

  it('names the time when the task has one, and renders nothing for any other phase', async () => {
    const wait_until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const host = await mount(WaitingComposerLine, { task: task({ phase: 'WAITING', wait_until }) });
    expect(host.querySelector('[data-testid="session-waiting-line"]')!.textContent)
      .toBe(waitingLineText({ phase: 'WAITING', wait_until }));
    await rerender(WaitingComposerLine, { task: task({ phase: 'TODO' }) });
    expect(host.querySelector('[data-testid="session-waiting-line"]')).toBeNull();
    await rerender(WaitingComposerLine, { task: null });
    expect(host.innerHTML).toBe('');
  });
});

describe('TaskStatusMenuSection and Waiting', () => {
  const spies = () => ({ onSetPhase: vi.fn(), onSetWaitUntil: vi.fn(), afterAction: vi.fn() });
  const open = async (host: HTMLElement) => click(host.querySelector('[data-testid="task-status-toggle"]'));
  const pill = (host: HTMLElement, phase: string) => host.querySelector(`.task-status-pill[data-phase="${phase}"]`);

  it('picking Waiting sets it and keeps the box open on the until row', async () => {
    const s = spies();
    const host = await mount(TaskStatusMenuSection, { task: task(), ...s });
    await open(host);
    expect(host.querySelector('[data-testid="task-status-until"]')).toBeNull();
    await click(pill(host, 'WAITING'));
    expect(s.onSetPhase).toHaveBeenCalledWith('task-1', 'WAITING');
    expect(s.afterAction).not.toHaveBeenCalled();
    // Shown before the task prop catches up (no optimistic copy on the plain PATCH
    // path): the row names the default clock the server is about to set.
    const until = host.querySelector('[data-testid="task-status-until"]')!;
    expect(until).toBeTruthy();
    expect(until.textContent).toContain('Until: 1 day (default)');
    expect(until.querySelector('[data-testid="task-status-until-clear"]')).toBeNull();
  });

  it('a Waiting task without a clock says so (an explicit no-limit, not the default again)', async () => {
    const host = await mount(TaskStatusMenuSection, { task: task({ phase: 'WAITING' }), ...spies() });
    await open(host);
    const until = host.querySelector('[data-testid="task-status-until"]')!;
    expect(until.textContent).toContain('Until: no time limit');
    expect(until.querySelector('[data-testid="task-status-until-clear"]')).toBeNull();
  });

  it('a pick other than Waiting writes it and closes, with no until row', async () => {
    const s = spies();
    const host = await mount(TaskStatusMenuSection, { task: task(), ...s });
    await open(host);
    await click(pill(host, 'IN_PROGRESS'));
    expect(s.onSetPhase).toHaveBeenCalledWith('task-1', 'IN_PROGRESS');
    expect(s.afterAction).toHaveBeenCalledTimes(1);
  });

  it('a day picked under Until is written as 9:00 local with phase Waiting kept by the setter', async () => {
    const s = spies();
    const host = await mount(TaskStatusMenuSection, { task: task({ phase: 'WAITING' }), ...s });
    await open(host);
    await click(host.querySelector('[data-testid="task-status-until-toggle"]'));
    // The inline picker's second pill row is the days, tomorrow first.
    const tomorrow = host.querySelectorAll('.task-status-until .dp-pills')[1].querySelector('.dp-pill');
    await click(tomorrow);
    expect(s.onSetWaitUntil).toHaveBeenCalledTimes(1);
    const [id, iso] = s.onSetWaitUntil.mock.calls[0] as [string, string];
    expect(id).toBe('task-1');
    const at = new Date(iso);
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([expected.getDate(), 9, 0]);
    expect(s.afterAction).toHaveBeenCalledTimes(1);
    expect(s.onSetPhase).not.toHaveBeenCalled();
  });

  it('a Waiting task with a time reads it on the collapsed row, and "No limit" writes ""', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 29, 10, 0));
    const s = spies();
    const wait_until = new Date(2026, 9, 2, 13, 27).toISOString();
    const host = await mount(TaskStatusMenuSection, { task: task({ phase: 'WAITING', wait_until }), ...s });
    expect(host.querySelector('.task-kebab-status-value')!.textContent).toBe('Status: Waiting · until Fri 13:27');
    await open(host);
    expect(pill(host, 'WAITING')!.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[data-testid="task-status-until"]')!.textContent).toContain('Until: Fri 13:27');
    expect(host.querySelector('[data-testid="task-status-until-clear"]')!.textContent).toBe('No limit');
    await click(host.querySelector('[data-testid="task-status-until-clear"]'));
    expect(s.onSetWaitUntil).toHaveBeenCalledWith('task-1', '');
    expect(s.afterAction).toHaveBeenCalledTimes(1);
  });

  it('a To Do task never shows a time on the collapsed row', async () => {
    const host = await mount(TaskStatusMenuSection, { task: task({ wait_until: '2026-10-02T16:00:00.000Z' }), ...spies() });
    expect(host.querySelector('.task-kebab-status-value')!.textContent).toBe('Status: To Do');
  });
});
