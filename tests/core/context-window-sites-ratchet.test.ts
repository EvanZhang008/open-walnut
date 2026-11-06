/**
 * Every place that names a context window by a number of its own.
 *
 * 2026-11-06, the user's Mac app: an Opus 5.5 session read "Context 324.4K / 200K (162%)". Opus 5.5
 * runs a 1M window as `claude-opus-5-5`, with no `[1m]`, and three places each kept their own
 * "no [1m] means 200K" rule: the session readout, an engine handoff's budget and the pi gateway's
 * model list. They now read one rule (`modelStringWindow` / `resolveContextWindow` in
 * src/providers/context-window.ts, its web twin `sessionContextWindow` in useSessionUsage.ts),
 * which knows the models with 1M built in from the model catalog and lifts any guess to what a
 * session shows it holds.
 *
 * This test lists every source file with a window-sized number next to a window or context
 * word, and fails on one in a file not listed below, so a new surface cannot bring back a
 * guess of its own.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Files allowed to name a window by number, and why. A line counts when a window or context word
 *  stands within three lines above it or the line after. */
const ALLOWED: Record<string, string> = {
  'src/providers/context-window.ts': 'the rule itself',
  'web/src/hooks/useSessionUsage.ts': 'the web twin of the rule (sessionContextWindow)',
  'src/model/providers/model-catalog.ts': 'the catalog the rule reads its native-1M models from',
  'src/model/providers/defaults.ts': 'the Personal AI model layer constants, read with the catalog',
  'src/model/model.ts': 'the 1M beta header decision, from the catalog',
  'src/core/sessions/engine-switch-context.ts': 'engine defaults for engines that are not Claude; Claude goes through modelStringWindow',
  'src/core/agents/pi-gateway.ts': 'the 200K fallback of modelStringWindow for an id it cannot name',
  'web/src/api/paste-spill.ts': 'a paste size threshold, not a model window',
  'web/src/components/sessions/compact-offer.ts': 'formats a token count as "1.2M", not a model window',
  'src/core/event-loop-monitor.ts': 'nanoseconds to milliseconds, not a model window',
  'src/providers/claude-code-session.ts': 'comments quoting what the CLI reported',
};

const WINDOW_NUMBER = /\b(?:200_?000|1_?000_?000|1e6)\b/;
const WINDOW_WORD = /window|context/i;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

describe('context window numbers live in one rule', () => {
  it('no file outside the list names a window by number', () => {
    const files: string[] = [];
    walk(path.join(ROOT, 'src'), files);
    walk(path.join(ROOT, 'web/src'), files);
    const found = new Set<string>();
    for (const f of files) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      const lines = readFileSync(f, 'utf8').split('\n');
      if (lines.some((line, i) => WINDOW_NUMBER.test(line) && WINDOW_WORD.test(lines.slice(Math.max(0, i - 3), i + 2).join('\n')))) found.add(rel);
    }
    const unlisted = [...found].filter((f) => !(f in ALLOWED));
    expect(unlisted, 'name the window through modelStringWindow / resolveContextWindow (server) or sessionContextWindow (web)').toEqual([]);
    // A listed file that no longer names one comes off the list.
    expect(Object.keys(ALLOWED).filter((f) => !found.has(f))).toEqual([]);
  });
});
