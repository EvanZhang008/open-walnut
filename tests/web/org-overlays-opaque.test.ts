/**
 * The Org page's own overlays are solid (2026-11-04: the gear's settings panel showed the VP
 * list straight through it, on prod). Every overlay a component in web/src/components/org/
 * portals out (a menu, a picker, a panel, a sheet) is found from the source, and every style
 * rule for it in web/src/styles/ must paint an opaque background with no backdrop blur: the
 * overlays' shared glass (overlay-glass.css) reads as see-through wherever the blur is missing.
 * A full-window scrim (`inset: 0`) behind a panel is the one layer allowed to be see-through.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
const ORG = path.join(WEB, 'components/org');
const STYLES = path.join(WEB, 'styles');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/**
 * The classes of each overlay an Org component portals out: the first two elements after
 * `createPortal(` (a scrim and the panel it holds, or the panel and its first row).
 */
function orgOverlayClasses(): Set<string> {
  const classes = new Set<string>();
  for (const name of fs.readdirSync(ORG)) {
    if (!name.endsWith('.tsx')) continue;
    const text = fs.readFileSync(path.join(ORG, name), 'utf8');
    for (const p of text.matchAll(/createPortal\(\s*(\w+)?/g)) {
      // `createPortal(sheet, ...)` portals a JSX value built earlier: read from where it is built.
      const built = p[1] ? text.search(new RegExp(`(?:const|let)\\s+${p[1]}\\s*=`)) : -1;
      const after = text.slice(built >= 0 ? built : p.index!);
      const names = [...after.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].slice(0, 2);
      for (const m of names) {
        for (const token of (m[1] ?? m[2]).split(/\s+/)) if (/^[a-z][\w-]*$/.test(token)) classes.add(token);
      }
    }
  }
  return classes;
}

interface Rule { file: string; selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const file of cssFiles(STYLES)) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file: path.relative(WEB, file), selector: m[1].trim(), body: m[2] });
    }
  }
  return out;
}

/** The selectors of a rule that style the element wearing `cls` itself (its last compound). */
function targets(rule: Rule, cls: string): boolean {
  return rule.selector.split(',').some((sel) => {
    const last = sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
    return new RegExp(`\\.${cls}(?![\\w-])`).test(last.replace(/::?[\w-]+(\([^)]*\))?/g, ''));
  });
}

const decl = (body: string, prop: string): string | null => {
  const m = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

/** A background a reader sees through: transparent, an alpha under 1, or the shared glass. */
export function seeThrough(value: string): boolean {
  if (/transparent|--overlay-glass-bg|--glass-bg/.test(value)) return true;
  for (const m of value.matchAll(/(?:rgba|hsla)\(([^)]*)\)/g)) {
    const parts = m[1].split(/[,/]/).map((s) => s.trim());
    const a = parseFloat(parts[3] ?? '1');
    if (a < 1) return true;
  }
  for (const m of value.matchAll(/(?:rgb|hsl)\([^)]*\/\s*([\d.]+%?)\)/g)) {
    const a = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    if (a < 1) return true;
  }
  for (const m of value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{4})\b/gi)) {
    const h = m[1];
    if (!/^f+$/i.test(h.length === 8 ? h.slice(6) : h.slice(3))) return true;
  }
  return false;
}

describe('the Org page overlays are solid', () => {
  const classes = orgOverlayClasses();
  const all = rules();

  it('finds the overlays it guards', () => {
    for (const known of ['org-answer-menu', 'org-settings-menu', 'org-snooze-menu', 'org-sheet', 'am-modal']) {
      expect(classes, known).toContain(known);
    }
  });

  it('every overlay rule paints an opaque background and no backdrop blur', () => {
    const bad: string[] = [];
    let painted = 0;
    for (const cls of classes) {
      // A full-window scrim behind a panel is the one layer allowed to be see-through.
      const own = all.filter((r) => targets(r, cls) && decl(r.body, 'inset') !== '0');
      for (const r of own) {
        const bg = decl(r.body, 'background') ?? decl(r.body, 'background-color');
        if (bg) painted++;
        if (bg && seeThrough(bg)) bad.push(`${r.file}: ${r.selector} { background: ${bg} }`);
        for (const prop of ['backdrop-filter', '-webkit-backdrop-filter']) {
          const v = decl(r.body, prop);
          if (v && v !== 'none') bad.push(`${r.file}: ${r.selector} { ${prop}: ${v} }`);
        }
      }
    }
    expect(painted).toBeGreaterThanOrEqual(3);
    expect(bad, 'an Org overlay is see-through; give it var(--bg-elevated) and no blur').toEqual([]);
  });

  it('reads a see-through background as one', () => {
    for (const v of ['transparent', 'rgba(0,0,0,.5)', 'rgb(0 0 0 / 80%)', '#ffffffcc', 'var(--overlay-glass-bg)',
      'color-mix(in srgb, var(--bg) 82%, transparent)']) expect(seeThrough(v), v).toBe(true);
    for (const v of ['var(--bg-elevated, var(--card-bg, var(--bg)))', '#fff', 'rgba(0,0,0,1)', '#ffffffff']) {
      expect(seeThrough(v), v).toBe(false);
    }
  });
});
