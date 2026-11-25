/**
 * A zero never wears a warning colour (standard.md, "Text": a value of nothing reads plain).
 *
 * 2026-11-24 UI audit: Settings > Walnut Health said "0 in alarm" in bold red with no alarm at all,
 * and the commit and turn panes printed a red "-0" beside a file with only additions. The time
 * page's 0m was already grey; the git glance and the diff pane already dropped a zero side.
 *
 * The class: an element whose CSS class sets `color` to a warning token (--error, --warning,
 * --danger) and whose content is a count, with no guard that drops the element or its class at 0.
 * Found by scanning every TSX file for such an element on one line; a guard is a `> 0`, `!== 0`,
 * `>= 1` or `=== 0` test before it on that line, or on the line before when that one opens the
 * element's `&& (` branch. A guard further up (an early return) is named in GUARDED_ABOVE with
 * where it is. Baseline 0: render the count only above zero, or give the class only then.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss } from './css-scan';

const ROOT = path.resolve(__dirname, '../..');
const WARNING_COLOUR = /var\(--(error|warning|danger)\b/;
/** A count by its name: `.length`, `count`, `counts.X`, `total`, the diff sides, `ALARM`. */
const COUNT_EXPR = /\{[^{}]*(?:\.length|\b(?:count|counts\.\w+|total|added|removed|additions|deletions|insertions|ALARM)|Count)\s*(?:\?\?\s*0\s*)?\}/;
const ZERO_GUARD = /(?:>\s*0|!==\s*0|>=\s*1|===\s*0)/;
/** Guarded further up than the scan reads: file -> the guard. */
const GUARDED_ABOVE: Record<string, string> = {
  'web/src/components/settings/sections/HealthHostProblems.tsx': 'returns null when hosts.length === 0',
};

export function warningClasses(cssFiles: Array<{ file: string; raw: string }>): Set<string> {
  const out = new Set<string>();
  for (const { file, raw } of cssFiles) {
    for (const d of scanCss(file, raw)) {
      if (d.prop !== 'color' || !WARNING_COLOUR.test(d.value)) continue;
      for (const sel of d.selectors) {
        // Only a class that colours by itself: `.x` or `.x .y` ends with the class that is coloured.
        const m = /\.([\w-]+)$/.exec(sel.trim());
        if (m) out.add(m[1]);
      }
    }
  }
  return out;
}

/** Lines of one TSX file that show a count in a warning class without a zero guard. */
export function unguardedZeros(tsx: string, classes: Set<string>): string[] {
  const hits: string[] = [];
  const el = /<(\w+)\s+className="([^"]*)"[^>]*>([^<]*)<\/\1>/g;
  const lines = tsx.split('\n');
  lines.forEach((line, i) => {
    const prev = lines[i - 1] ?? '';
    for (const m of line.matchAll(el)) {
      if (!m[2].split(/\s+/).some((c) => classes.has(c))) continue;
      if (!COUNT_EXPR.test(m[3])) continue;
      if (ZERO_GUARD.test(line.slice(0, m.index))) continue;
      if (/&&\s*\(\s*$/.test(prev) && ZERO_GUARD.test(prev)) continue;
      hits.push(`${i + 1}: ${m[0]}`);
    }
  });
  return hits;
}

describe('a zero never wears a warning colour', () => {
  it('finds the reported shapes (the scan itself)', () => {
    const classes = new Set(['health-count-ALARM', 'scd-del']);
    expect(unguardedZeros('<span className="health-count health-count-ALARM">{view.counts.ALARM} in alarm</span>', classes)).toHaveLength(1);
    expect(unguardedZeros('<span className="scd-del">-{hunk.oldLines.length}</span>', classes)).toHaveLength(1);
    expect(unguardedZeros('<span className="scd-del">-{file.removed ?? 0}</span>', classes)).toHaveLength(1);
    expect(unguardedZeros('{n > 0 && <span className="scd-del">-{n.length}</span>}', classes)).toHaveLength(0);
    expect(unguardedZeros('<span className="scd-del">{reason}</span>', classes)).toHaveLength(0);
    expect(unguardedZeros('{n > 0 && (\n  <span className="scd-del">{n.length}</span>', classes)).toHaveLength(0);
  });

  it('no TSX file shows a count in a warning colour without a zero guard', () => {
    const css = walk(path.join(ROOT, 'web/src'), ['.css']).map((file) => ({ file, raw: fs.readFileSync(file, 'utf8') }));
    const classes = warningClasses(css);
    expect(classes.has('health-count-ALARM')).toBe(true);
    const files = [
      ...walk(path.join(ROOT, 'web/src'), ['.tsx']),
      ...walk(path.join(ROOT, 'examples/plugins'), ['.tsx']),
    ];
    const found: string[] = [];
    for (const f of files) {
      if (GUARDED_ABOVE[path.relative(ROOT, f)]) continue;
      for (const hit of unguardedZeros(fs.readFileSync(f, 'utf8'), classes)) found.push(`${path.relative(ROOT, f)}:${hit}`);
    }
    expect(found, `A count in a warning colour shows red at 0; render it (or its class) only above 0:\n${found.join('\n')}`).toEqual([]);
  });
});
