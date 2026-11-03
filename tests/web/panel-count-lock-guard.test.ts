/**
 * Every browser spec that writes the fixture's panel count holds the panel count lock.
 *
 * `ui.session_panels` is one config value a fixture server shares, and Playwright runs other
 * files against that server at once. 2026-11-03, CI shard 11: session-panel-lock-grant read 3
 * columns where it had made 4, then a saved count of 2, because session-panel-count was setting
 * its own count on the next worker. tests/e2e/browser/panel-count-lock.ts serializes the writers;
 * this reads every spec and fails on one that writes the count (setPanelMode, a config write of
 * session_panels, a click on a panel count option) without calling holdPanelCountLock.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));

/** The code of a spec, comment lines left out (a comment may name the setting). */
function code(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const WRITES = [
  /\bsetPanelMode\(/,
  /session_panels\s*[:=]/,
  /delete\s+[\w.]*session_panels/,
  /panels-opt[^\n]*\.click\(/,
  /panelsSeg\([^\n]*\.click\(/,
];

describe('panel count lock', () => {
  const writers = specs.filter((f) => { const src = code(f); return WRITES.some((re) => re.test(src)); });

  it('finds the writers it knows of (the matcher still matches)', () => {
    for (const known of ['session-panel-count.spec.ts', 'session-panel-lock-grant.spec.ts', 'view-menu-session-panels.spec.ts', 'session-voice-selection.webkit.spec.ts']) {
      expect(writers, known).toContain(known);
    }
  });

  it('every spec that writes the panel count holds the lock', () => {
    const missing = writers.filter((f) => !/\bholdPanelCountLock\('(file|test)'\)/.test(code(f)));
    expect(missing, 'call holdPanelCountLock() from ./panel-count-lock at the top level of these specs').toEqual([]);
  });

  it('a queue helper makes room in the time limit before it waits, never only after', () => {
    // 2026-11-03, CI: fixture-lease.ts added the wait to the limit once the lease came, so a queue
    // longer than the test had left timed it out inside the wait.
    const helpers = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const late: string[] = [];
    for (const f of helpers) {
      const src = code(f);
      const extend = src.indexOf('info.setTimeout(');
      if (extend === -1) continue;
      const loop = src.search(/(for \(;;\)|while \()[^\n]*\n[\s\S]{0,800}?setTimeout\(r,/);
      if (loop !== -1 && extend > loop) late.push(f);
    }
    expect(helpers).toContain('fixture-lease.ts');
    expect(late).toEqual([]);
  });

  it('a serial file holds it per file, any other file per test', () => {
    const wrong: string[] = [];
    for (const f of writers) {
      const src = code(f);
      const serial = /mode:\s*'serial'/.test(src);
      if (serial !== /holdPanelCountLock\('file'\)/.test(src)) wrong.push(`${f} (serial: ${serial})`);
    }
    expect(wrong).toEqual([]);
  });
});
