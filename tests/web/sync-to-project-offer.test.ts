/**
 * "Sync to <service>" is offered only where it can go: a task kept local whose project syncs
 * nowhere now (the project made local, keeping the task's own hold: core/private-tasks/hold-owner.ts;
 * or the task moved to a local project) gets the server's 409 project_local
 * (task-manager.ts releaseSyncHold), so the menu says why instead of offering it.
 *
 * Class guard: every client file that calls the sync-to-project route gates the offer on the
 * project syncing now (the web on SyncStanding's projectSyncs, the phone on projectService).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SyncHold } from '@open-walnut/core';
import { keptLine, syncStanding } from '../../web/src/components/tasks/private-task-model';

const ROOT = path.resolve(__dirname, '../..');
const chosen: SyncHold = { target: 'plugin-a', state: 'chosen', by: 'user', reason: 'Kept local when it was created', at: '2026-11-20T00:00:00.000Z' } as SyncHold;
const name = (s: string) => (s === 'plugin-a' ? 'Tracker' : s);

describe('syncStanding: whether its project syncs now', () => {
  it('a held task in a project that syncs can be sent', () => {
    const s = syncStanding({ source: 'local', project: 'Atlas', sync_hold: chosen }, 'plugin-a');
    expect(s).toMatchObject({ kind: 'kept', service: 'plugin-a', projectSyncs: true });
    expect(keptLine(s, name)).toBe('Kept out of Tracker: Kept local when it was created');
  });

  it('a held task in a project made local keeps its standing but cannot be sent, and says why', () => {
    const s = syncStanding({ source: 'local', project: 'Atlas', sync_hold: chosen }, 'local');
    expect(s).toMatchObject({ kind: 'kept', service: 'plugin-a', projectSyncs: false });
    expect(keptLine(s, name)).toContain('Its project does not sync to an outside service now');
  });

  it('a held task in the Inbox or an unknown project cannot be sent either', () => {
    expect(syncStanding({ source: 'local', project: '', sync_hold: chosen }, 'plugin-a')).toMatchObject({ projectSyncs: false });
    expect(syncStanding({ source: 'local', project: 'Gone', sync_hold: chosen }, undefined)).toMatchObject({ projectSyncs: false });
  });

  it('before the project registry has loaded, the offer stays (the server decides) and no reason is guessed', () => {
    const s = syncStanding({ source: 'local', project: 'Atlas', sync_hold: chosen }, undefined, false);
    expect(s).toMatchObject({ kind: 'kept', projectSyncs: true });
    expect(keptLine(s, name)).not.toContain('does not sync');
  });

  it('a local task in a local project has nothing to choose', () => {
    expect(syncStanding({ source: 'local', project: 'Home' }, 'local')).toEqual({ kind: 'local' });
  });
});

/** Files under `dir` (recursive) with one of `exts`. */
function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...files(p, exts)); }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

describe('every client that offers Sync to <service> gates it on the project syncing now', () => {
  const clients = [
    // The web's menus: the call is syncTaskToProject (web/src/api/private-tasks.ts defines it).
    ...files(path.join(ROOT, 'web/src'), ['.tsx', '.ts'])
      .filter((f) => !f.endsWith(path.join('api', 'private-tasks.ts')))
      .filter((f) => /\bsyncTaskToProject\(/.test(fs.readFileSync(f, 'utf8')))
      // The condition right before the offer reads the standing's projectSyncs (not a comment's word).
      .map((f) => ({ f, gate: /standing\.projectSyncs\)\) && \(\s*<button[^>]*data-testid="kebab-sync-to-project"/ })),
    // The phone's views: the call is the store's syncToProject (Stores/ defines it).
    ...files(path.join(ROOT, 'ios-native/Walnut/Views'), ['.swift'])
      .filter((f) => /\bsyncToProject\(/.test(fs.readFileSync(f, 'utf8')))
      // The branch that offers it asks projectService (whether the project syncs now).
      .map((f) => ({ f, gate: /else if [^\n]*store\.projectService\(task\.project\) != nil \{[\s\S]{0,200}?syncToProject\(/ })),
  ];

  it('finds the clients (the scan still sees them)', () => {
    expect(clients.map((c) => path.relative(ROOT, c.f)).sort()).toEqual([
      'ios-native/Walnut/Views/Tasks/TaskSyncViews.swift',
      'web/src/components/tasks/TaskSyncMenuRows.tsx',
    ]);
  });

  it.each(clients.map((c) => [path.relative(ROOT, c.f), c.gate] as const))('%s gates the offer', (rel, gate) => {
    expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).toMatch(gate);
  });
});
