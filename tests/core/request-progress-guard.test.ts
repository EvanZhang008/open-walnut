/**
 * A turn that only made progress does not settle the requests its target owes (2026-11-02, the org
 * reflection: a worker's turn end settled the six requests its lead held as "no reply", then it parked
 * to wait for a build and they were settled again). Every place that settles a request or tells an
 * asker is classified here, counted from the source: a turn-end site must go through
 * `progressReason` / `settleAfterReport`, so a NEW site that settles at a turn edge fails until it is
 * placed on one side with its reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

function callSites(): Record<string, number> {
  const sites: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name)) {
        const n = (fs.readFileSync(p, 'utf8').match(/\b(?:notifyRequesterFallback|notifyRequesterGroup|settleNotified)\(/g) ?? []).length;
        if (n) sites[path.relative(SRC, p)] = n;
      }
    }
  };
  walk(SRC);
  return sites;
}

describe('every place that settles a request is classified', () => {
  it('lists the files, each with why it may settle', () => {
    expect(callSites()).toEqual({
      // The settle primitive itself (a definition, not a caller).
      'core/session-requests.ts': 1,
      // NOT turn edges: a failed start (the target never ran), a park of a message that never ran,
      // and the deadline sweeper. None is a progress-only turn end.
      'core/sessions/task-start.ts': 1,
      'core/sessions/undelivered-requests.ts': 1,
      // The notify module: both definitions, the wrapper's delegation, the group settle, the sweeper's timeout.
      'core/sessions/session-request-notify.ts': 5,
      // Turn edges, which must hold for progress: the deferred pass after the report, and the hook.
      'core/sessions/request-progress.ts': 1,
      'core/session-hooks/builtins.ts': 2,
    });
  });

  it('the turn-end hook asks progressReason, and a plain stop waits for the report', () => {
    const hook = read('core/session-hooks/builtins.ts');
    expect(hook).toMatch(/progressReason\(/);
    expect(hook).toMatch(/settleAfterReport\(/);
  });

  it('the stop hook and the turn-end hook share the one progress rule', () => {
    expect(read('core/sessions/unanswered-at-stop.ts')).toMatch(/progressReason\(/);
  });

  it('the deferred pass looks again before it speaks (the task may have parked or run on)', () => {
    const src = read('core/sessions/request-progress.ts');
    expect(src).toMatch(/whenReportSettled\(/);
    expect(src).toMatch(/phase !== 'NEED_ACTION'/);
    expect(src).toMatch(/progressReason\(/);
  });

  it('progressReason holds a parked task, running-on work and a wait on another task', () => {
    const src = read('core/sessions/request-progress.ts');
    for (const reason of ['parked', 'work-outlives-turn', 'waits-on-another-task']) expect(src, reason).toContain(`'${reason}'`);
    expect(src).toMatch(/phase === 'WAITING'/);
  });

  it('one merged notice per asker: the group notifier names the other requests, on the server and in the kit the daemon inlines', () => {
    expect(read('core/sessions/session-request-notify.ts')).toMatch(/alsoUnanswered/);
    const kit = read('core/peers/envelope-kit.ts');
    expect(kit).toMatch(/alsoLine/);
    expect(kit).toMatch(/alsoUnanswered/);
  });

  it('the offline host holds a parked task\'s requests too', () => {
    expect(read('providers/offline-host-core.ts')).toMatch(/owner\?\.phase === 'WAITING'/);
  });
});
