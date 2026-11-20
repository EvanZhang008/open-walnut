/**
 * Guard: a popover's outside-press closer is armed once per opening, by `useOutsidePress`.
 *
 * The class: an effect that adds a document (or window) listener after a delay, so the press
 * that opened the popover does not close it. When that effect also depends on its handler, every
 * new handler identity removes the listener and starts the delay again; a parent that re-renders
 * every few dozen milliseconds (an inline `onClose`) keeps it unarmed nearly all the time.
 * 2026-11-20: a press on the draft's More, or anywhere outside, left the folder picker open and
 * the typed folder not taken (tests/e2e/browser/workspace-scripts.spec.ts); the quick task
 * composer had the same effect.
 *
 * Members, enumerated from the source: every `setTimeout`/`requestAnimationFrame` callback in
 * web/src that adds a document or window listener. The only one allowed is the hook itself
 * (web/src/hooks/useOutsidePress.ts), which reads the latest handler from a committed ref.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');
const ALLOWED = new Set(['web/src/hooks/useOutsidePress.ts']);

/** A delayed callback whose first statement adds a document or window listener. */
const DELAYED_ADD = /(?:setTimeout|requestAnimationFrame)\(\s*\(\)\s*=>\s*\{?\s*(?:document|window)\.addEventListener\(/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('outside-press closers', () => {
  it('only useOutsidePress arms a document listener after a delay', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(DELAYED_ADD)) {
        offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders, 'use useOutsidePress (web/src/hooks/useOutsidePress.ts) instead').toEqual([]);
  });

  it('the hook still arms its listener after a delay, once per opening', () => {
    const text = readFileSync(join(ROOT, 'web/src/hooks/useOutsidePress.ts'), 'utf8');
    expect(text).toMatch(DELAYED_ADD);
    // Its effect never depends on the handler itself, only on the committed ref of it.
    expect(text).toMatch(/\}, \[open, ref, latest\]\);/);
  });
});
