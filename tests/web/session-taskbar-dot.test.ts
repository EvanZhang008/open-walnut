/**
 * The taskbar's dots wear the task's one user status in the colors every task pill wears
 * (2026-11-09, the user: "we neve ruse the grey acutally if itis read it is read, we use red means
 * it is ready, green is working ... grey might means it is wait liek wait staus, or snoozed").
 * A finished turn of a task that still works, or a To read, was grey before.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chipStateOf, type ChipState } from '../../web/src/pages/sessionTaskbar';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Us = { state: 'needs' | 'read' | 'working' | 'waiting' | 'done'; toRead?: string; snoozed?: unknown };
const task = (us: Us | null, phase = 'IN_PROGRESS') => ({ phase, status: 'todo', user_status: us } as never);
const idle = { process_status: 'idle' };
const running = { process_status: 'running' };

describe('chipStateOf', () => {
  it('reads the task user status, never whether the user saw it', () => {
    expect(chipStateOf(task({ state: 'needs' }), idle).state).toBe('needs');
    expect(chipStateOf(task({ state: 'read' }), idle).state).toBe('needs');
    // An older server's To read: Waiting with toRead.
    expect(chipStateOf(task({ state: 'waiting', toRead: 'turn' }), idle).state).toBe('needs');
    expect(chipStateOf(task({ state: 'working' }), idle)).toEqual({ state: 'working', running: false });
    expect(chipStateOf(task({ state: 'waiting' }), idle).state).toBe('waiting');
    expect(chipStateOf(task({ state: 'waiting', snoozed: { until: 'x' } }), idle).state).toBe('waiting');
    expect(chipStateOf(task({ state: 'done' }, 'COMPLETE'), idle).state).toBe('done');
  });

  it('a running turn is Working and pulses; a prompt waiting on the user is Needs you', () => {
    expect(chipStateOf(task({ state: 'waiting' }), running)).toEqual({ state: 'working', running: true });
    expect(chipStateOf(task({ state: 'working' }), { process_status: 'running', pendingPermissionTool: 'Bash' }).state).toBe('needs');
    // Needs you outranks a turn that runs.
    expect(chipStateOf(task({ state: 'needs' }), running)).toEqual({ state: 'needs', running: true });
  });

  it('a task not derived yet reads its phase; a session with no task reads its process', () => {
    expect(chipStateOf(task(null, 'NEED_ACTION'), idle).state).toBe('needs');
    expect(chipStateOf(task(null, 'IN_PROGRESS'), idle).state).toBe('working');
    expect(chipStateOf(task(null, 'WAITING'), idle).state).toBe('waiting');
    expect(chipStateOf(undefined, { process_status: 'error' }).state).toBe('needs');
    expect(chipStateOf(undefined, idle).state).toBe('waiting');
    expect(chipStateOf(undefined, null).state).toBe('waiting');
  });
});

describe('the dot colors are the task pills\' colors', () => {
  const pill = read('web/src/styles/globals.css');
  const bar = read('web/src/styles/session-taskbar.css');
  const colorOf = (css: string, re: RegExp) => css.match(re)?.[1]?.replace(/\s+/g, '');
  // Every state but Waiting has its own color; Waiting is the plain dot's grey.
  const states: ChipState[] = ['needs', 'working', 'done'];

  it.each(states)('%s', (s) => {
    const want = colorOf(pill, new RegExp(`a\\.task-link\\[data-user-state='${s}'\\]::before\\s*\\{\\s*background:\\s*([^;]+);`));
    const got = colorOf(bar, new RegExp(`\\.session-taskbar-card\\[data-state='${s}'\\] \\.session-taskbar-dot\\s*\\{\\s*background:\\s*([^;]+);`));
    expect(want, `the pill color for ${s}`).toBeTruthy();
    expect(got).toBe(want);
  });

  it('every state the bar stamps has a rule, and no other state is styled', () => {
    const styled = [...bar.matchAll(/\[data-state='([a-z-]+)'\]/g)].map((m) => m[1]);
    expect([...new Set(styled)].sort()).toEqual([...states].sort());
  });

  it('the bar decides a dot only through chipStateOf', () => {
    const src = read('web/src/components/sessions/SessionTaskbar.tsx');
    expect(src).toContain('chipStateOf(');
    expect(src).not.toMatch(/process_status\s*===|taskNeedsAction\(|phase\s*===\s*'COMPLETE'/);
  });
});
