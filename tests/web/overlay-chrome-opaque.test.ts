/**
 * Chrome that lies over scrolling content is solid, in light and dark (2026-11-10 review in
 * the Mac app: the chat read through the session header under Fork/Changed/Files and the
 * title, the task list through the bell's tab column, the document through a comment card).
 * The Org page's overlays have their own guard (org-overlays-opaque.test.ts); this one covers
 * every other surface of the kind, found from the CSS:
 *
 *   - every class named like a surface (`…-header`, `…-toolbar`, `…-card`, `…-panel`, `…-dock`,
 *     `…-sheet`, `…-column`, `…-drawer`, `…-bar`) that some rule positions sticky, fixed or
 *     absolute, plus the surfaces listed in INSIDE_AN_OVERLAY that sit in a positioned layer
 *     without being positioned themselves. Menus and popovers (`…-menu`, `…-popover`) take the
 *     shared overlay surface of overlay-glass.css (solid since 2026-11-04; its own guard is
 *     tests/web/overlays-opaque.test.ts);
 *   - each must paint an opaque background (itself, or a full-size ::before layer), and no
 *     rule for it may paint a see-through one (transparent, an alpha under 1, the glass
 *     tokens) or fade it with an opacity between 0 and 1;
 *   - the scroll-under material, --glass-g4-bg, is opaque in every theme block.
 *
 * A new member of the class fails here until it is solid or listed below with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seeThrough } from './helpers/css-see-through';

const WEB = path.resolve(__dirname, '../../web/src');

/** Surfaces that hold no paint of their own on purpose, with why. */
const PAINTS_NOTHING: Record<string, string> = {
  'ask-walnut-bare-header': 'a lone menu button in the empty slot\'s corner: nothing scrolls under it',
  'thread-drawer': 'its .thread-drawer-body paints the drawer (var(--bg-elevated)); the drawer box is only its frame',
  'session-panel': 'the panel itself, not chrome over another surface; its header and body paint',
  'editor-mic-dock': 'a zero-height sticky anchor; the mic inside it paints its own background',
  'thread-review-bar': 'a 12px rail in the gap between the text and the review cards: nothing lies under it',
};

/**
 * Menus portalled to <body> that take the shared overlay surface (overlay-glass.css, globals.css
 * Materials Pass), guarded by tests/web/overlays-opaque.test.ts. Reading panels never go here.
 */
const BLURRED_MENUS: Record<string, string> = {
  'link-hover-card': 'a hover card portalled to <body> with the shared overlay surface',
  'vd-panel': 'the view dropdown menu, portalled to <body> with the menu surface',
};

/** Surfaces inside a positioned layer, not positioned themselves: the layer that places them. */
const INSIDE_AN_OVERLAY: Record<string, { layer: string; paintedBy?: string }> = {
  'doc-comment-card': { layer: 'doc-comment-slot' },
  // The bell's tab column: drawn on its panel's background.
  'nfc-rail': { layer: 'notification-panel', paintedBy: 'notification-panel' },
};

const SURFACE = /(?:^|-)(header|toolbar|card|panel|dock|sheet|column|drawer|bar)$/;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith('.css')) out.push(full);
  }
  return out;
}

interface Rule { file: string; selector: string; body: string }

const RULES: Rule[] = cssFiles(WEB).flatMap((file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => !/^\s*(from|to|\d+%)\s*$/.test(m[1]))
    .map((m) => ({ file: path.relative(WEB, file), selector: m[1].trim(), body: m[2] }));
});

const decl = (body: string, prop: string): string | null => {
  const m = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].replace(/!important/, '').trim() : null;
};
const bgOf = (body: string) => decl(body, 'background') ?? decl(body, 'background-color');

/** The class and pseudo-element a selector's last compound styles. */
function lastOf(sel: string): { cls: string | null; pseudo: string | null } {
  const last = sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const pseudo = /::?(before|after)\b/.exec(last)?.[1] ?? null;
  const clean = last.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  return { cls: /\.([a-zA-Z][\w-]*)/.exec(clean)?.[1] ?? null, pseudo };
}

function topLevelLayers(value: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim());
}

/** A background a reader cannot see through: its bottom layer is an opaque colour. */
export function opaqueBackground(value: string): boolean {
  const bottom = topLevelLayers(value).at(-1) ?? '';
  if (/^(none|inherit|initial|unset|currentColor)$/i.test(bottom) || /url\(|gradient\(/.test(bottom)) return false;
  return !seeThrough(bottom);
}

interface Hit { rule: Rule; pseudo: string | null }
function rulesFor(cls: string): Hit[] {
  const out: Hit[] = [];
  for (const rule of RULES) {
    for (const sel of rule.selector.split(',')) {
      const l = lastOf(sel);
      if (l.cls === cls) { out.push({ rule, pseudo: l.pseudo }); break; }
    }
  }
  return out;
}

function positionedSurfaces(): Set<string> {
  const out = new Set<string>();
  for (const r of RULES) {
    const pos = decl(r.body, 'position');
    if (!pos || !/sticky|fixed|absolute/.test(pos)) continue;
    // A full-window scrim is the one layer allowed to be see-through.
    if (/fixed/.test(pos) && decl(r.body, 'inset') === '0') continue;
    for (const sel of r.selector.split(',')) {
      const { cls, pseudo } = lastOf(sel);
      if (cls && !pseudo && SURFACE.test(cls)) out.add(cls);
    }
  }
  return out;
}

/** What is wrong with a surface's paint, one line each. */
function problemsOf(cls: string): string[] {
  const bad: string[] = [];
  const hits = rulesFor(cls);
  let paints = false;
  for (const { rule, pseudo } of hits) {
    const at = `${rule.file}: ${rule.selector.replace(/\s+/g, ' ')}`;
    const bg = bgOf(rule.body);
    const opacity = decl(rule.body, 'opacity');
    if (pseudo) {
      // Only a layer drawn over the whole box (the glass ::before) paints the surface.
      if (!bg || decl(rule.body, 'inset') === null) continue;
      if (opaqueBackground(bg)) paints = true;
      else if (!/^(none|transparent)$/.test(bg)) bad.push(`${at} { background: ${bg} }`);
      continue;
    }
    if (opacity && Number(opacity) > 0 && Number(opacity) < 1) bad.push(`${at} { opacity: ${opacity} }`);
    if (!bg) continue;
    if (opaqueBackground(bg)) paints = true;
    // `transparent` / `none` on the element is fine only when a full ::before layer paints it.
    else if (!/^(none|transparent)$/.test(bg)) bad.push(`${at} { background: ${bg} }`);
  }
  const clear = hits.filter(({ rule, pseudo }) => !pseudo && /^(none|transparent)$/.test(bgOf(rule.body) ?? ''));
  if (clear.length && !hits.some(({ rule, pseudo }) => pseudo === 'before' && opaqueBackground(bgOf(rule.body) ?? 'none'))) {
    for (const { rule } of clear) bad.push(`${rule.file}: ${rule.selector.replace(/\s+/g, ' ')} clears its background with no opaque ::before layer`);
  }
  if (!paints) bad.push(`.${cls} paints no opaque background anywhere`);
  return bad;
}

describe('chrome over scrolling content is solid', () => {
  const surfaces = positionedSurfaces();

  it('finds the surfaces the review saw through', () => {
    for (const known of ['session-panel-header', 'todo-panel-toolbar', 'cal-toolbar', 'notification-panel', 'thread-review-card']) {
      expect(surfaces, known).toContain(known);
    }
    expect(surfaces.size).toBeGreaterThan(30);
  });

  it('every positioned surface paints an opaque background and fades nothing', () => {
    const bad: string[] = [];
    for (const cls of surfaces) {
      if (PAINTS_NOTHING[cls] || BLURRED_MENUS[cls]) continue;
      bad.push(...problemsOf(cls));
    }
    expect(bad, 'a surface over content is see-through: give it var(--bg) / var(--bg-elevated), a tint over an opaque base, no opacity').toEqual([]);
  });

  it('every surface inside a positioned layer is solid, and the layer really places it', () => {
    const bad: string[] = [];
    for (const [cls, { layer, paintedBy }] of Object.entries(INSIDE_AN_OVERLAY)) {
      expect(rulesFor(layer).some(({ rule }) => /sticky|fixed|absolute/.test(decl(rule.body, 'position') ?? '')), `${layer} is positioned`).toBe(true);
      const problems = problemsOf(cls).filter((p) => !(paintedBy && p.endsWith('paints no opaque background anywhere')));
      bad.push(...problems);
      if (paintedBy) bad.push(...problemsOf(paintedBy));
    }
    expect(bad).toEqual([]);
  });

  it('every exemption still names a real surface', () => {
    for (const cls of [...Object.keys(PAINTS_NOTHING), ...Object.keys(BLURRED_MENUS)]) expect(surfaces, cls).toContain(cls);
    for (const cls of Object.keys(INSIDE_AN_OVERLAY)) expect(rulesFor(cls).length, cls).toBeGreaterThan(0);
  });

  it('the scroll-under material and the base surfaces are opaque in every theme block', () => {
    const tokens = ['--glass-g4-bg', '--bg', '--bg-secondary', '--bg-elevated', '--card-bg'];
    const bad: string[] = [];
    let seen = 0;
    for (const r of RULES) {
      for (const t of tokens) {
        const v = decl(r.body, t);
        if (v === null) continue;
        seen++;
        if (!opaqueBackground(v)) bad.push(`${r.file}: ${r.selector} { ${t}: ${v} }`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(bad).toEqual([]);
  });

  it('reads layered and translucent backgrounds right', () => {
    expect(opaqueBackground('linear-gradient(rgba(255, 59, 48, 0.08), rgba(255, 59, 48, 0.08)), var(--bg)')).toBe(true);
    expect(opaqueBackground('#FFFFFF')).toBe(true);
    expect(opaqueBackground('var(--bg-elevated, var(--bg))')).toBe(true);
    for (const v of ['rgba(255, 59, 48, 0.08)', 'var(--glass-bg)', 'transparent', 'none',
      'color-mix(in srgb, var(--bg-secondary) 88%, transparent)', 'linear-gradient(transparent, var(--bg) 35%)']) {
      expect(opaqueBackground(v), v).toBe(false);
    }
  });
});
