/**
 * Every menu, popover and panel that floats over the page is solid. The shared glass (an 80%
 * tint with a backdrop blur) read as see-through in WebKit, the Mac app's engine, wherever the
 * blur could not reach the page (inside a backdrop root, or an engine build without it): three
 * independent reviews on 2026-11-04 read the rows behind a menu through its items (the Org
 * page's settings panel, a task's kebab menu, a session header's "···" menu). Each overlay is
 * found from the source (the first two elements a component portals out, and every overlay the
 * glass lists name), and every style rule for it must paint an opaque background with no
 * backdrop blur. A full-window scrim (`inset: 0`) behind a panel may stay see-through.
 *
 * One material is see-through on purpose: the legible glass (`wn-glass`, overlay-glass.css;
 * 2026-11-17, the user: "calendar should be glass view please"). It is a raised surface at 84%
 * or more over a strong blur, so the page behind reads as colour, never as words; it is only for
 * overlays portalled to <body> (WebKit blurs up to the nearest backdrop root), only for the
 * ones listed in GLASS_OVERLAYS, and solid without blur support, with Reduce transparency and on
 * a low-end device. The second describe block checks each of those.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seeThrough } from './helpers/css-see-through';

const WEB = path.resolve(__dirname, '../../web/src');
const STYLES = path.join(WEB, 'styles');

/** The legible glass's own classes: the material, never an overlay. */
const GLASS_CLASSES = ['wn-glass', 'wn-glass-fill'];
/** The overlays that take the legible glass, with why each one may. */
const GLASS_OVERLAYS: Record<string, string> = {
  'cal-create-popover': 'the calendar\'s new-item popover beside the block it creates',
  'cal-create-arrow': 'that popover\'s arrow (wn-glass-fill: the material without its frame)',
  'cal-item-popover': 'an event or task opened from the calendar',
  'cal-ctx-menu': 'the calendar\'s right-click menu',
  'cal-cals-popover': 'the calendar list (which calendars show) and its hidden events',
  'cal-overflow-popover': 'a month cell\'s "+N more" list',
  'cal-cal-list': 'the new-event form\'s calendar picker',
  'cal-day-flyout': 'the new-event form\'s mini month (date picker)',
};
/** The tint floor: the raised surface's share of the glass. */
const GLASS_TINT_MIN = 84;

function files(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The classes of each overlay a component portals out: the first two elements after `createPortal(`. */
function portalledClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of files(WEB, '.tsx')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const p of text.matchAll(/createPortal\(\s*(\w+)?/g)) {
      const built = p[1] ? text.search(new RegExp(`(?:const|let)\\s+${p[1]}\\s*=`)) : -1;
      const after = text.slice(built >= 0 ? built : p.index!);
      const names = [...after.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].slice(0, 2);
      for (const m of names) {
        // A template's `${...}` parts are code (`${i === active ? ' active' : ''}`), not class names;
        // a name it is glued to stays out too (`$` fails the name test below).
        const literal = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, '$');
        for (const token of literal.split(/\s+/)) if (/^[a-z][\w-]*$/.test(token)) classes.add(token);
      }
    }
  }
  return classes;
}

/** The overlays the glass rules name (each selector's last class), wherever they are mounted. */
function glassListed(): Set<string> {
  const classes = new Set<string>();
  for (const file of files(STYLES, '.css')) {
    for (const m of strip(fs.readFileSync(file, 'utf8')).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/backdrop-filter\s*:\s*var\(--(?:overlay-glass-blur|glass-blur-menu)\)/.test(m[2])) continue;
      for (const sel of m[1].split(',')) {
        const last = sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
        const cls = last.replace(/::?[\w-]+(\([^)]*\))?/g, '').match(/\.([a-z][\w-]*)/g)?.pop();
        if (cls) classes.add(cls.slice(1));
      }
    }
  }
  return classes;
}

interface Rule { file: string; selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const file of files(STYLES, '.css')) {
    for (const m of strip(fs.readFileSync(file, 'utf8')).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file: path.relative(WEB, file), selector: m[1].trim(), body: m[2] });
    }
  }
  return out;
}

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

/** The shared glass tokens, read from where they are defined: they must resolve to a solid fill. */
function tokenValues(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files(STYLES, '.css')) {
    for (const m of strip(fs.readFileSync(file, 'utf8')).matchAll(/(--(?:overlay-glass-bg|glass-bg-menu|overlay-glass-blur|glass-blur-menu))\s*:\s*([^;]+);/g)) {
      out.set(`${path.relative(WEB, file)} ${m[1]}`, m[2].trim());
    }
  }
  return out;
}

/** A background with the shared tokens replaced by what they are (each one is checked above). */
function resolveTokens(value: string): string {
  return value.replace(/var\(--(?:overlay-glass-bg|glass-bg-menu)\)/g, 'var(--bg-elevated)');
}

describe('overlays are solid', () => {
  const classes = new Set([...portalledClasses(), ...glassListed()].filter((c) => !GLASS_CLASSES.includes(c)));
  const all = rules();

  it('finds the overlays it guards', () => {
    // State words a template adds (`active`) are never taken for an overlay.
    expect(classes).not.toContain('active');
    for (const known of ['task-kebab-menu', 'session-header-more-menu', 'session-control-menu', 'chat-plus-menu', 'org-settings-menu', 'sfe-path-suggest']) {
      expect(classes, known).toContain(known);
    }
  });

  it('the shared glass tokens are solid and carry no blur', () => {
    const bad: string[] = [];
    for (const [where, value] of tokenValues()) {
      if (/-bg/.test(where) ? seeThrough(resolveTokens(value)) : value !== 'none' && value !== 'var(--overlay-glass-blur)') bad.push(`${where}: ${value}`);
    }
    expect(bad, 'a glass token is see-through; menus and panels are solid (var(--bg-elevated), no blur)').toEqual([]);
  });

  it('every overlay rule paints an opaque background and no backdrop blur', () => {
    const bad: string[] = [];
    let painted = 0;
    for (const cls of classes) {
      // A full-window scrim (some rule of it sets `inset: 0`) may stay see-through.
      if (all.some((r) => targets(r, cls) && decl(r.body, 'inset') === '0')) continue;
      // A row of an overlay (`<overlay>-item`, laid out in it, not floating): its hover tint
      // lies on the overlay's own solid surface.
      if ([...classes].some((o) => cls.startsWith(`${o}-`))
        && !all.some((r) => targets(r, cls) && /^(?:absolute|fixed)$/.test(decl(r.body, 'position') ?? ''))) continue;
      const own = all.filter((r) => targets(r, cls));
      for (const r of own) {
        const bg = decl(r.body, 'background') ?? decl(r.body, 'background-color');
        if (bg) painted++;
        // `transparent` on a row or a part inside an overlay shows the overlay's own solid surface.
        if (bg && bg !== 'transparent' && seeThrough(resolveTokens(bg))) bad.push(`${r.file}: ${r.selector.replace(/\s+/g, ' ').slice(0, 120)} { background: ${bg} }`);
        for (const prop of ['backdrop-filter', '-webkit-backdrop-filter']) {
          const v = decl(r.body, prop);
          if (v && v !== 'none' && !/var\(--(?:overlay-glass-blur|glass-blur-menu)\)/.test(v)) bad.push(`${r.file}: ${r.selector.replace(/\s+/g, ' ').slice(0, 120)} { ${prop}: ${v} }`);
        }
      }
    }
    expect(painted).toBeGreaterThanOrEqual(20);
    expect(bad, 'an overlay is see-through; give it var(--bg-elevated) and no blur').toEqual([]);
  });

  it('every overlay paints the raised surface, never the page behind it', () => {
    // --bg is the page itself (pure black in dark): a menu painted with it sinks into the chat
    // behind it, one hairline apart, while every other menu reads #2C2C2E (2026-11-04 review).
    const bad: string[] = [];
    for (const cls of classes) {
      const own = all.filter((x) => targets(x, cls));
      if (own.some((r) => decl(r.body, 'inset') === '0')) continue;
      // A floating surface: positioned over the page with rounded corners. A pane or a phone
      // layer that fills its place paints the page, and so does a field inside a menu.
      const floats = own.some((r) => /^(?:absolute|fixed)$/.test(decl(r.body, 'position') ?? ''))
        && own.some((r) => decl(r.body, 'border-radius') != null)
        && !own.some((r) => decl(r.body, 'outline') != null);
      if (!floats) continue;
      for (const r of own) {
        const bg = decl(r.body, 'background') ?? decl(r.body, 'background-color');
        if (bg && /^var\(--bg\)$/.test(bg.trim())) bad.push(`${r.file}: ${r.selector.replace(/\s+/g, ' ').slice(0, 120)} { background: ${bg} }`);
      }
    }
    expect(bad, 'an overlay paints var(--bg); give it var(--bg-elevated, var(--card-bg))').toEqual([]);
  });
});

describe('the legible glass stays legible, and only where it is listed', () => {
  const glassCss = strip(fs.readFileSync(path.join(STYLES, 'overlay-glass.css'), 'utf8'));
  const allCss = files(STYLES, '.css').map((f) => strip(fs.readFileSync(f, 'utf8'))).join('\n');

  /** Every element that carries a glass class, with the classes beside it and its file. */
  function carriers(): { file: string; classes: string[] }[] {
    const out: { file: string; classes: string[] }[] = [];
    for (const file of files(WEB, '.tsx')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        const tokens = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
        if (tokens.some((t) => GLASS_CLASSES.includes(t))) out.push({ file: path.relative(WEB, file), classes: tokens });
      }
    }
    return out;
  }

  it('only the listed overlays carry it, each one portalled to <body>', () => {
    const found = carriers();
    const bad: string[] = [];
    for (const c of found) {
      const named = c.classes.filter((t) => GLASS_OVERLAYS[t]);
      if (!named.length) bad.push(`${c.file}: ${c.classes.join(' ')} (not in GLASS_OVERLAYS)`);
      const text = fs.readFileSync(path.join(WEB, c.file), 'utf8');
      if (!/createPortal\([\s\S]*document\.body/.test(text)) bad.push(`${c.file}: ${c.classes.join(' ')} is not portalled to <body>`);
    }
    expect(bad).toEqual([]);
    const carried = new Set(found.flatMap((c) => c.classes));
    expect(Object.keys(GLASS_OVERLAYS).filter((o) => !carried.has(o)), 'a GLASS_OVERLAYS entry no element carries: drop it').toEqual([]);
  });

  it('its tint never falls under the floor, over a strong blur', () => {
    const tints = [...allCss.matchAll(/--glass-legible-bg\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(tints.length).toBeGreaterThan(0);
    for (const t of tints) {
      const m = t.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\)$/);
      expect(m, t).not.toBeNull();
      expect(seeThrough(m![1]), `the tinted surface itself is solid: ${t}`).toBe(false);
      expect(Number(m![2]), t).toBeGreaterThanOrEqual(GLASS_TINT_MIN);
    }
    for (const m of allCss.matchAll(/--glass-legible-blur\s*:\s*([^;]+);/g)) {
      const px = Number(m[1].match(/blur\((\d+)px\)/)?.[1] ?? 0);
      expect(px, m[1]).toBeGreaterThanOrEqual(20);
    }
  });

  it('it is see-through only where the engine blurs, and solid with Reduce transparency or on a low-end device', () => {
    // Every rule that paints the glass tint sits in an @supports block for backdrop blur.
    const blocks = [...glassCss.matchAll(/@supports[^{]*backdrop-filter[^{]*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)].map((m) => m[1]);
    const supports = blocks.join('\n');
    const outside = blocks.reduce((css, b) => css.replace(b, ''), allCss);
    const painted = [...outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background(?:-color)?\s*:\s*var\(--glass-legible-bg\)/.test(m[2]));
    expect(painted.map((m) => m[1].trim()), 'the glass tint is painted outside its @supports block').toEqual([]);
    expect(supports).toMatch(/background\s*:\s*var\(--glass-legible-bg\)/);
    expect(supports).toMatch(/backdrop-filter\s*:\s*var\(--glass-legible-blur\)/);

    const solidFor = (block: string) => {
      for (const cls of GLASS_CLASSES) expect(block, cls).toMatch(new RegExp(`\\.${cls}`));
      const bg = block.match(/background\s*:\s*([^;]+);/)?.[1] ?? '';
      expect(seeThrough(resolveTokens(bg)), bg).toBe(false);
      expect(block).toMatch(/(?:^|[^-])backdrop-filter\s*:\s*none/);
    };
    const reduce = glassCss.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/);
    expect(reduce, 'a prefers-reduced-transparency block').not.toBeNull();
    solidFor(reduce![1]);
    const lowEnd = glassCss.match(/html\[data-glass="solid"\][^{]*\{[^{}]*\}/);
    expect(lowEnd, 'an html[data-glass="solid"] rule').not.toBeNull();
    solidFor(lowEnd![0]);
  });
});
