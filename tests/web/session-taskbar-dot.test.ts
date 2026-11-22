/**
 * The taskbar's dots wear the task's status icon state (TaskStateIcon's dot), the same as every
 * row and pill of that task
 * (2026-11-09, the user: "we neve ruse the grey acutally if itis read it is read, we use red means
 * it is ready, green is working ... grey might means it is wait liek wait staus, or snoozed").
 * A finished turn of a task that still works, or a To read, was grey before.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chipStateOf } from '../../web/src/pages/sessionTaskbar';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Us = { state: 'needs' | 'read' | 'working' | 'waiting' | 'done'; toRead?: string; snoozed?: unknown };
const task = (us: Us | null, phase = 'IN_PROGRESS') => ({ phase, status: 'todo', user_status: us } as never);
const idle = { process_status: 'idle' };
const running = { process_status: 'running' };

describe('chipStateOf', () => {
  it('reads the task user status, never whether the user saw it', () => {
    expect(chipStateOf(task({ state: 'needs' }), idle).state).toBe('needs');
    expect(chipStateOf(task({ state: 'read' }), idle).state).toBe('read');
    // An older server's To read: Waiting with toRead.
    expect(chipStateOf(task({ state: 'waiting', toRead: 'turn' }), idle).state).toBe('read');
    expect(chipStateOf(task({ state: 'working' }), idle)).toEqual({ state: 'working', running: false });
    expect(chipStateOf(task({ state: 'waiting' }), idle).state).toBe('waiting');
    expect(chipStateOf(task({ state: 'waiting', snoozed: { until: 'x' } }), idle).state).toBe('snoozed');
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

describe('the dot is the shared status dot', () => {
  const bar = read('web/src/styles/session-taskbar.css');
  const src = read('web/src/components/sessions/SessionTaskbar.tsx');

  it('draws every dot through TaskStateIcon and colours none of its own', () => {
    expect(src).not.toMatch(/<span className="session-taskbar-dot"/);
    expect((src.match(/<TaskStateIcon state=\{state\} className="session-taskbar-dot" size=\{12\} decorative \/>/g) ?? []).length).toBe(4);
    expect(bar).not.toMatch(/session-taskbar-dot[^{]*\{[^}]*background/);
    // The chip's border and the card's line may follow the state (label styling); the dot may not.
    expect(bar).not.toMatch(/\[data-state='[a-z-]+'\][^{,]*session-taskbar-dot/);
  });

  it('the bar decides a dot only through chipStateOf', () => {
    expect(src).toContain('chipStateOf(');
    expect(src).not.toMatch(/process_status\s*===|taskNeedsAction\(|phase\s*===\s*'COMPLETE'/);
  });
});
