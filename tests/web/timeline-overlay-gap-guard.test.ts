/**
 * A sticky overlay at the end of a flex column (the session timeline's jump button, the phone's
 * prompt pill) takes no room by pulling itself up with a negative top margin. The column's row gap
 * sits BEFORE it all the same, so a margin of only its height leaves that gap as blank space under
 * the last row when the view is scrolled to its end.
 *
 * 2026-11-23: the shared jump button (065f723fc3) stopped shrinking (flex-shrink: 0) and its
 * `margin-top: -36px` left the timeline's 4 px gap under the last row
 * (tests/e2e/browser/session-thread-review-sidebar.spec.ts, "no blank space under the last row").
 * The timeline's gap is the variable --timeline-gap and every such overlay subtracts it.
 * Each check fails when a new member of that class appears without it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith('.css')) out.push(full);
  }
  return out;
}

interface Rule { file: string; selectors: string[]; body: string }

/** Every innermost rule (a rule inside @media counts on its own). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const f of cssFiles(WEB)) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file: path.relative(WEB, f), selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
    }
  }
  return out;
}

const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim();
/** The top margin a rule sets, from `margin-top` or the first value of `margin`. */
function topMargin(body: string): string | undefined {
  const top = decl(body, 'margin-top');
  if (top) return top;
  const all = decl(body, 'margin');
  return all?.match(/^(calc\([^)]*\)|\S+)/)?.[1];
}
const negative = (v: string | undefined) => !!v && /^(?:calc\(\s*)?-/.test(v);
const lastClass = (sel: string) => sel.match(/\.([\w-]+)(?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*\s*$/)?.[1];

describe('sticky overlays at a timeline’s end take no room, its row gap included', () => {
  const all = rules();

  it('every .session-history rule that sets the row gap sets it through --timeline-gap', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const r of all) {
      if (!r.selectors.some((s) => /\.session-history$/.test(s))) continue;
      const gap = decl(r.body, 'gap') ?? decl(r.body, 'row-gap');
      if (!gap) continue;
      seen++;
      if (gap !== 'var(--timeline-gap)' || !decl(r.body, '--timeline-gap')) bad.push(`${r.file}: ${r.selectors.join(', ')} { gap: ${gap} }`);
    }
    expect(seen, 'the timeline sets a gap somewhere').toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('every bottom-sticky overlay that pulls itself up subtracts --timeline-gap too', () => {
    // The overlays: a rule that is position: sticky with a bottom offset and a negative top margin.
    const overlays = new Set<string>();
    for (const r of all) {
      if (decl(r.body, 'position') !== 'sticky' || !decl(r.body, 'bottom') || !negative(topMargin(r.body))) continue;
      for (const s of r.selectors) { const c = lastClass(s); if (c) overlays.add(c); }
    }
    expect([...overlays]).toEqual(expect.arrayContaining(['scroll-to-bottom-btn', 'phone-prompt-pill']));
    // Every rule that sets one of their negative top margins (a phone size included).
    const bad: string[] = [];
    for (const r of all) {
      const m = topMargin(r.body);
      if (!negative(m) || !r.selectors.some((s) => overlays.has(lastClass(s) ?? ''))) continue;
      if (!/var\(--timeline-gap/.test(m!)) bad.push(`${r.file}: ${r.selectors.join(', ')} { margin-top: ${m} }`);
    }
    expect(bad).toEqual([]);
  });
});
