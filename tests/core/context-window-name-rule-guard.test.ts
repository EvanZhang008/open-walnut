/**
 * Every place that decides a context window from a model's NAME.
 *
 * 2026-11-07, the user, on an Opus 5.5 session that read 200K: "how to find the actual model
 * context window for the current model ... not by string matching which is flacky". The window
 * now comes from what Claude Code reported (`result.modelUsage[model].contextWindow`, an unclamped
 * `get_context_usage`, the same numbers kept on disk per host+model: src/providers/context-window.ts
 * and model-window-store.ts) or what an ACP engine reported. A name rule is the last resort, its
 * answer is flagged `estimate`, and every surface shows it as one.
 *
 * This test lists every source file that reaches a name rule, and fails on one not listed, so a new
 * surface cannot decide a window from the model's name on its own. A name rule is: the name-based
 * helpers of context-window.ts, the Personal AI catalog lookup by id (getContextWindowSize /
 * getContextThreshold), the catalog's `native_1m` flag, or a `[1m]` test next to a window-sized number.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const ALLOWED: Record<string, string> = {
  'src/providers/context-window.ts': 'the rule itself: the last resort of resolveContextWindow and knownModelWindow, flagged estimate',
  'web/src/hooks/useSessionUsage.ts': 'the web twin for a page with no reading; its answer carries estimate',
  'src/model/model.ts': 'the Personal AI model layer: its own API calls, by catalog id, and the 1M beta header',
  'src/model/providers/model-catalog.ts': 'the catalog the rules read',
  'src/model/providers/types.ts': 'the catalog entry type',
  'src/web/routes/chat-history.ts': 'chat stats before the lane reported its window, flagged contextWindowEstimate',
  'src/core/chat-history.ts': 'the compaction gate before the lane reported its window',
  'src/core/sessions/engine-switch-context.ts': 'knownModelWindow: the CLI\'s number first, the name only when none was ever reported',
  'src/core/agents/pi-gateway.ts': 'knownModelWindow for pi\'s models.json, which needs a number',
};

const NAME_RULE = [
  /\b(?:modelNameWindowEstimate|hasNativeExtendedWindow|windowFromModelString|knownModelWindow|getContextWindowSize|getContextThreshold)\s*\(/,
  /\bnative_1m\b/,
];
const ONE_M_PATTERN = /\\\[1m\\\]|'\[1m\]'|"\[1m\]"/;
/** A window-sized number: a `[1m]` test near one is a window read off the model id. */
const WINDOW_NUMBER = /\b(?:200_?000|1_?000_?000|1e6|EXTENDED_WINDOW|ANTHROPIC_DEFAULT_WINDOW|CONTEXT_WINDOW_1M|CONTEXT_WINDOW_DEFAULT)\b/;

function walk(dir: string, out: string[], ext: RegExp): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, ext);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

function nameRuleFiles(): Set<string> {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), files, /\.(ts|tsx)$/);
  walk(path.join(ROOT, 'web/src'), files, /\.(ts|tsx)$/);
  const found = new Set<string>();
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const lines = readFileSync(f, 'utf8').split('\n');
    const code = (l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l);
    const hit = lines.some((line, i) => code(line) && (
      NAME_RULE.some((re) => re.test(line))
      || (ONE_M_PATTERN.test(line) && WINDOW_NUMBER.test(lines.slice(Math.max(0, i - 3), i + 4).join('\n')))
    ));
    if (hit) found.add(rel);
  }
  return found;
}

describe('a context window is never decided from the model name outside the listed places', () => {
  it('no unlisted file reaches a name rule', () => {
    const found = nameRuleFiles();
    const unlisted = [...found].filter((f) => !(f in ALLOWED));
    expect(unlisted, 'read the window the CLI reported (resolveContextWindow in a session, knownModelWindow elsewhere) and mark a name-rule answer as an estimate').toEqual([]);
    // A listed file that no longer reaches one comes off the list.
    expect(Object.keys(ALLOWED).filter((f) => !found.has(f))).toEqual([]);
  });

  it('the iOS app decides no window of its own', () => {
    const files: string[] = [];
    walk(path.join(ROOT, 'ios-native/Walnut'), files, /\.swift$/);
    const deciders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // A window number next to a [1m] test is the app guessing a window from a model id.
      return /contains\("\[1m\]"\)[^\n]*(1_000_000|200_000)|(1_000_000|200_000)[^\n]*contains\("\[1m\]"\)/.test(src);
    }).map((f) => path.relative(ROOT, f));
    expect(deciders).toEqual([]);
  });
});
