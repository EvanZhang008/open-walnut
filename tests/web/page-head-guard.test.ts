/**
 * Page heads, one look (standard.md "Page heads"; web/src/styles/page-head.css): a page's title is
 * `.page-title` (20 px), a pane's title is `.pane-title` (17 px), and the key that makes a new thing
 * has no typed "+" and reads in sentence case.
 *
 * 2026-11-26, the UI audit on the user's data at 1512 x 920: page titles in five sizes (Routines,
 * Agents and Commands 28 px, Apps 26, Time 24, Settings 22), pane titles in four sizes and two
 * weights (Org 17/600, Memory 17/700, Settings 15/600, Notes 14/600, Scratchpad 13/700), and the New
 * key three ways ("+ New Agent", "New routine" a line under its title, Mail's own blue key). The
 * user, 2026-11-21: "why the ui still not consistent ... why they are not even consistent come on".
 *
 * Every member is enumerated from the source, so a new page or pane that draws its title its own
 * way fails here: every `<h1>` in the console and the shipped plugins, every class written beside
 * the two title classes, and every create key's words.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss } from './css-scan';
import { pluginCss, lastCompoundClasses } from './ui-standard-scan';

const ROOT = path.join(__dirname, '../..');
const HOME = 'web/src/styles/page-head.css';
const TSX_ROOTS = ['web/src', 'plugin-store', 'examples/plugins'];
const rel = (f: string) => path.relative(ROOT, f);
const tsxFiles = () => TSX_ROOTS.flatMap((r) => walk(path.join(ROOT, r), ['.tsx']));

/** Comments blanked (their newlines kept, so line numbers hold). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}
const lineAt = (src: string, i: number) => src.slice(0, i).split('\n').length;

/**
 * A heading that is not a page's or a pane's title: a centred card that stands alone on an empty
 * screen (a sign-in, an unlock, a first run), or a printed page. File -> why.
 */
const H1_NOT_A_HEAD: Record<string, string> = {
  'web/src/components/common/UnpairedNotice.tsx': 'the sign-in card centred on an empty window, before any page exists',
  'web/src/components/common/FirstUseSetup.tsx': 'the first-run welcome card centred on an empty window, before any page exists',
  'web/src/components/notes/LockedNoteKeyRestore.tsx': 'a centred recovery card that stands in for the locked note it unlocks',
  'web/src/components/passwords/LockScreens.tsx': 'the Passwords unlock and setup cards centred on an empty page, and the printed recovery kit',
  'web/src/components/passwords/PasswordsApp.tsx': 'the Passwords load failure, drawn in the same centred gate card as the unlock screen',
  'web/src/pages/OpenAgentRefPage.tsx': 'a hand-off page opened from another app: one centred card, no console around it',
  'web/src/pages/ConnectExtensionPage.tsx': 'the browser extension pairing card centred on an empty page, no console around it',
};

/** CSS on a bare `h1` that is a document's heading (markdown, the note editor) or a centred gate card's
 *  (H1_NOT_A_HEAD's: the extension card, the Passwords gate, the first-run card), never a page's head. */
const H1_CONTENT = /markdown-body|tiptap|ProseMirror|context-markdown|org-brief-body|\.pw-ext-card|\.pw-gate-card|\.first-use-card/;

/** What decides how a title reads: only page-head.css sets it. */
const TYPE = /^(font|font-size|font-weight|font-family|letter-spacing|color|text-transform)$/;

/** Words that are names, not labels (sentence case keeps a name's capitals). */
const PROPER = [/New Note Agent chat/, /Create Account API token/];

/** A key that is a bare "+" and makes nothing: zoom in, or open a card back up. File -> why. */
const PLUS_NOT_CREATE: Record<string, string> = {
  'web/src/components/common/PdfPreview.tsx': 'the zoom in key beside zoom out ("-"): a sign of the scale, not a create key',
  'web/src/components/calendar/CalendarGridControls.tsx': 'the grid zoom in key beside zoom out ("-"): a sign of the scale, not a create key',
  'web/src/components/approvals/ApprovalPrompts.tsx': 'the expand key in the corner where the whole card has its "-": it opens the card back up',
};

function h1Tags(): { file: string; line: number; tag: string }[] {
  const out: { file: string; line: number; tag: string }[] = [];
  for (const f of tsxFiles()) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<h1(?=[\s>])[^>]*>/g)) out.push({ file: rel(f), line: lineAt(src, m.index ?? 0), tag: m[0] });
  }
  return out;
}

/** Classes written beside `page-title` / `pane-title` on one element (`pane-title org-list-title`). */
function titleCompanions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of tsxFiles()) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{[^}]*?['"`]([^'"`]*)['"`][^}]*\})/g)) {
      const words = (m[1] ?? m[2] ?? '').split(/\s+/).filter(Boolean);
      if (!words.some((w) => w === 'page-title' || w === 'pane-title')) continue;
      for (const w of words) if (w !== 'page-title' && w !== 'pane-title' && /^[a-z][\w-]*$/.test(w)) out.set(w, rel(f));
    }
  }
  return out;
}

/** Every stylesheet a title can be drawn by: the console's CSS and the plugins' `styles*.ts`. */
function sheets(): [string, string][] {
  const css = walk(path.join(ROOT, 'web/src'), ['.css']).map((f) => [rel(f), fs.readFileSync(f, 'utf8')] as [string, string]);
  const plugins = ['plugin-store', 'examples/plugins']
    .flatMap((r) => walk(path.join(ROOT, r), ['.ts']))
    .filter((f) => /\/styles[\w-]*\.ts$/.test(f))
    .map((f) => [rel(f), pluginCss(fs.readFileSync(f, 'utf8'))] as [string, string]);
  return [...css, ...plugins];
}

describe('page heads: one title look and one New key look', () => {
  it('every <h1> is a page title or a pane title', () => {
    const off = h1Tags().filter((h) => !/\b(page|pane)-title\b/.test(h.tag) && !H1_NOT_A_HEAD[h.file]);
    expect(off.map((h) => `${h.file}:${h.line} ${h.tag}`), 'Give the title className="page-title" (a whole page; PageHeader writes it) or "pane-title" (a list pane, a sheet). A centred gate card goes in H1_NOT_A_HEAD with why.').toEqual([]);
  });

  it('every exemption still names a file with a bare <h1>, with its reason', () => {
    const bare = new Set(h1Tags().filter((h) => !/\b(page|pane)-title\b/.test(h.tag)).map((h) => h.file));
    expect(Object.keys(H1_NOT_A_HEAD).filter((f) => !bare.has(f)), 'Drop these from H1_NOT_A_HEAD').toEqual([]);
    expect(Object.values(H1_NOT_A_HEAD).every((why) => why.length >= 40)).toBe(true);
  });

  it('only page-head.css sets how a page or pane title reads', () => {
    const companions = titleCompanions();
    const owned = new Set(['page-title', 'pane-title', ...companions.keys()]);
    const off: string[] = [];
    for (const [file, text] of sheets()) {
      if (file === HOME) continue;
      for (const d of scanCss(file, text)) {
        if (!TYPE.test(d.prop)) continue;
        for (const sel of d.selectors) {
          // A label that is a title only sometimes keeps its other look under :not(.pane-title).
          if (/:not\(\.(page|pane)-title\)/.test(sel)) continue;
          const mine = lastCompoundClasses(sel).filter((c) => owned.has(c));
          const bareH1 = /(^|[\s>+~])h1(?![\w-])[^\s>+~]*$/.test(sel.trim()) && !H1_CONTENT.test(sel);
          if (mine.length || bareH1) off.push(`${file}:${d.line} ${sel.trim()} { ${d.prop}: ${d.value} }`);
        }
      }
    }
    expect(off, 'A page or pane title takes its type from page-head.css: a view sets only its margin, padding or line').toEqual([]);
  });

  it('a page head is the shared PageHeader, never a row written by hand', () => {
    const off: string[] = [];
    for (const f of walk(path.join(ROOT, 'web/src'), ['.tsx'])) {
      if (rel(f) === 'web/src/components/common/PageHeader.tsx') continue;
      const src = code(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/className=["'{`][^>]*\bpage-header\b/g)) off.push(`${rel(f)}:${lineAt(src, m.index ?? 0)}`);
    }
    expect(off, 'Use <PageHeader title subtitle action={<NewKey label="New ..." />} />').toEqual([]);
  });

  it('a create key has no typed "+" and reads in sentence case', () => {
    const plus = /<span[^>]*>\s*\+\s*<\/span>\s*(New|Add|Create)\b|>\s*\+\s*(New|Add|Create)\b|['"`]\+ ?(New|Add|Create)\b[^'"`]*['"`]/g;
    const title = />\s*(New|Add|Create|Edit|Clone) [A-Z][a-z]+\b[^<{]*<|['"`](New|Add|Create|Edit|Clone) [A-Z][a-z]+[^'"`\n]{0,40}['"`]/g;
    const lonePlus = />\s*\+\s*<\/(button|Chip|span)\b/g;
    const off: string[] = [];
    for (const f of tsxFiles()) {
      const src = code(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(plus)) off.push(`${rel(f)}:${lineAt(src, m.index ?? 0)} typed plus: ${m[0].replace(/\s+/g, ' ')}`);
      if (!PLUS_NOT_CREATE[rel(f)]) for (const m of src.matchAll(lonePlus)) off.push(`${rel(f)}:${lineAt(src, m.index ?? 0)} typed plus key: ${m[0].replace(/\s+/g, ' ')}`);
      for (const m of src.matchAll(title)) {
        if (PROPER.some((re) => re.test(m[0]))) continue;
        off.push(`${rel(f)}:${lineAt(src, m.index ?? 0)} Title Case: ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(off, 'A drawn plus (ICON_PLUS, or NewKey) and sentence case: "New agent", not "+ New Agent"').toEqual([]);
  });

  it('finds each shape it guards', () => {
    expect(/\b(page|pane)-title\b/.test('<h1 className="pane-title org-list-title">')).toBe(true);
    expect(/(^|[\s>+~])h1(?![\w-])[^\s>+~]*$/.test('.apps-hero h1')).toBe(true);
    expect(/(^|[\s>+~])h1(?![\w-])[^\s>+~]*$/.test('.apps-hero h1 + .x')).toBe(false);
    expect(lastCompoundClasses('.settings-container .settings-nav-title')).toEqual(['settings-nav-title']);
    expect(titleCompanions().get('org-list-title')).toBe('web/src/components/org/OrgChannelList.tsx');
    // The shapes a create key's words came in (2026-11-26): a typed plus alone, and a ternary's words.
    expect('>\n        +\n      </button>'.match(/>\s*\+\s*<\/(button|Chip|span)\b/)).not.toBeNull();
    expect("{submitting ? 'Adding…' : 'Add Event'}".match(/['"`](New|Add|Create|Edit|Clone) [A-Z][a-z]+[^'"`\n]{0,40}['"`]/)).not.toBeNull();
    expect(Object.values(PLUS_NOT_CREATE).every((why) => why.length >= 40)).toBe(true);
  });
});
