/**
 * A key's words sit in its middle, however tall the key is. 2026-11-26: on a phone (390 px) a
 * permission card's one-line choices (Allow once, Deny) stood 44 px tall with their words about
 * 10 px under the top edge and the lower half empty, because the choice row set
 * `align-items: flex-start` (so a wrapping choice keeps its number key on the first line) and the
 * phone's finger size made the row taller than its words.
 *
 * The class: every CSS rule on a key (a selector whose last part names a `btn` or `*-btn` class, or
 * a `button`) that pulls its items to the top: `align-items: flex-start`, or `baseline` in a row
 * that wraps (2026-11-26: the toast's and the notification panel's rules list at 1512 px, its
 * words 5 px under the top and 9 px over the bottom of the 28 px row). Each must also centre its line of items (`flex-wrap: wrap` with
 * `align-content: center`), or the words leave the middle as soon as the key grows. A new rule that
 * does not fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');
const DIRS = [path.join(ROOT, 'web/src'), path.join(ROOT, 'plugin-store')];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** The last compound of each selector in a rule names a key. */
const isKey = (selector: string) => selector.split(',').some((one) => {
  const last = one.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const bare = last.replace(/::?[\w-]+(\([^)]*\))?/g, '');
  return /\.(btn|[\w-]+-btn)(?![\w-])/.test(bare) || /^button(?![\w-])/.test(bare);
});

/** Keys whose height is only their words (no min-height anywhere), so the words cannot leave the middle. */
const OWN_HEIGHT: Record<string, string> = {
  '.kanban-card-status-btn': "a Kanban card's status line drawn as text: padding 0, as tall as its words",
  '.oc-project-btn': "the org chart's project name: 3 px padding, as tall as its words",
};

export function topPulledKeys(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [sel, body] = [m[1]!.trim(), m[2]!];
    // Baseline too: in a wrapping row the line stretches to the key's height and baseline puts the words at its top.
    const top = /align-items:\s*(flex-start|start)\b/.test(body) || (/align-items:\s*baseline\b/.test(body) && /flex-wrap:\s*wrap\b/.test(body))
    if (!top || !isKey(sel) || sel in OWN_HEIGHT) continue;
    // In a column align-items places the words across, not up and down.
    if (/flex-direction:\s*column\b/.test(body)) continue;
    if (/align-content:\s*center\b/.test(body) && /flex-wrap:\s*wrap\b/.test(body)) continue;
    out.push(sel);
  }
  return out;
}

describe("a key's words stay in its middle", () => {
  it('every key that pulls its items to the top centres its line', () => {
    const hits = DIRS.flatMap((d) => walk(d)).flatMap((f) => topPulledKeys(fs.readFileSync(f, 'utf8')).map((s) => `${path.relative(ROOT, f)}: ${s}`));
    expect(hits, 'add flex-wrap: wrap and align-content: center to the same rule').toEqual([]);
  });

  it('catches the rule that put the words at the top', () => {
    expect(topPulledKeys('.permission-request-btn.permission-request-choice { align-items: flex-start; }')).toHaveLength(1);
    expect(topPulledKeys('.a-btn.x { align-items: flex-start; flex-wrap: wrap; align-content: center; }')).toEqual([]);
    expect(topPulledKeys('.settings-row.choice { align-items: flex-start; }')).toEqual([]);
    // 2026-11-26: the toast's and the panel's rules list at 1512 px, words 5 px under the top and 9 px over the bottom.
    expect(topPulledKeys(':is(.nfc-perm-toast, .nfc-perm-card) .perm-options-stack > button { display: flex; flex-wrap: wrap; align-items: baseline; }')).toHaveLength(1);
  });
});
