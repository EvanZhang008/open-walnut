/**
 * A page's single-key shortcut never fires while a sheet or an editor has the reader
 * (web/src/utils/page-shortcut.ts; 2026-11-10 WebKit review: a click under the last line of
 * Source focused nothing, and "F" then opened the task filter over the Files sheet).
 *
 * The class: every document- or window-level keydown handler that acts on a bare printable
 * key. Each one found in the source either asks pageShortcutBlocked or is listed below with
 * why its keys are not bare (a modifier is required) or are the sheet's own.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(t|j)sx?$/.test(n) ? [p] : [];
  });
}

/** Handlers whose keys are not a page's bare-key shortcut, and why. */
const NOT_BARE: Record<string, string> = {
  'utils/scroll-debug.ts': 'Ctrl+Shift+D only',
  'components/common/FileContentView.tsx': 'Cmd+F, and the media view\'s own < > keys inside the file view',
  'components/sessions/SessionDiffView.tsx': 'Cmd+[ / Cmd+] and Cmd+F only',
  'components/sessions/SessionFileExplorer.tsx': 'Cmd+[ / Cmd+] only',
  'components/notes/MarkdownEditorPanel.tsx': 'Cmd+E only',
  'components/notes/CommandPalette.tsx': 'Cmd+K only',
  'hooks/usePanelKeyRouter.ts': 'Cmd+Shift+E only',
  'pages/SettingsPage.tsx': 'Cmd+S only',
  'pages/MainPage.tsx': 'Cmd+Shift+O only',
  'components/common/PageFind.tsx': 'Cmd+F and Cmd+G / Shift+Cmd+G (F3) only',
  'components/chat/ChatInput.tsx': 'its document handler is Escape for its own menus; the Cmd+Z it reads is the box\'s own onKeyDown',
};

const LISTENS = /(document|window)\.addEventListener\(\s*['"]keydown['"]/;
const BARE_KEY = /\.key(\.toLowerCase\(\)|\.toUpperCase\(\))?\s*(===|!==)\s*['"][^\s'"]['"]|\.code\s*(===|!==)\s*['"](Key[A-Z]|Slash|Period|Comma|Bracket(Left|Right))['"]|\/\^\[[^\]]+\]\$\/\.test\(key\)/;

/** The block that starts at the first `{` at or after `from` (strings and comments are not parsed: enough for handlers). */
function blockAt(s: string, from: number): string {
  const open = s.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
}

/** Every global keydown listener of a file with its body: an inline function, or the named handler's own body. */
function keydownHandlers(s: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const call = /(document|window)\.addEventListener\(\s*['"]keydown['"]\s*,\s*/g;
  for (let m = call.exec(s); m; m = call.exec(s)) {
    const at = m.index + m[0].length;
    const named = /^([A-Za-z_$][\w$]*)\s*[,)]/.exec(s.slice(at, at + 80));
    if (named) {
      const name = named[1];
      // The definition nearest above the call: effects often reuse one handler name.
      const defs = [...s.slice(0, m.index).matchAll(new RegExp(`(?:const|let|function)\\s+${name.replace(/\$/g, '\\$')}\\b`, 'g'))];
      const def = defs[defs.length - 1];
      out.push({ name, body: def ? blockAt(s, def.index!) : '' });
    } else out.push({ name: `inline@${at}`, body: blockAt(s, at) });
  }
  return out;
}

describe('page single-key shortcuts', () => {
  const all = sources(WEB).map((p) => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));
  const members = all.filter((f) => LISTENS.test(f.s) && BARE_KEY.test(f.s));

  it('each handler of a bare key asks, not only one handler of its file (2026-11-10 review)', () => {
    const unguarded: string[] = [];
    for (const f of members) {
      if (NOT_BARE[f.p]) continue;
      for (const h of keydownHandlers(f.s)) {
        if (BARE_KEY.test(h.body) && !/pageShortcutBlocked\(/.test(h.body)) unguarded.push(`${f.p}#${h.name}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('the handler reader finds both kinds of listener, and a file with one guarded and one unguarded fails', () => {
    const two = `
      const onKey = (e) => { if (pageShortcutBlocked(e, a)) return; if (e.key === 'f') open(); };
      document.addEventListener('keydown', onKey);
      window.addEventListener('keydown', (e) => { if (e.key === '/') focus(); }, true);`;
    const hs = keydownHandlers(two);
    expect(hs.map((h) => h.name)).toEqual(['onKey', expect.stringMatching(/^inline@/)]);
    expect(hs.filter((h) => BARE_KEY.test(h.body) && !/pageShortcutBlocked\(/.test(h.body))).toHaveLength(1);
  });

  it('every global handler of a bare key asks pageShortcutBlocked, or says why its keys are not bare', () => {
    const unguarded = members.filter((f) => !/pageShortcutBlocked\(/.test(f.s) && !NOT_BARE[f.p]).map((f) => f.p);
    expect(unguarded).toEqual([]);
  });

  it('the list names only handlers that still exist and still do not ask', () => {
    const names = new Set(members.map((f) => f.p));
    for (const p of Object.keys(NOT_BARE)) {
      expect(names.has(p), `${p} no longer has a global key handler: drop it from NOT_BARE`).toBe(true);
      expect(/pageShortcutBlocked\(/.test(all.find((f) => f.p === p)!.s), `${p} asks now: drop it from NOT_BARE`).toBe(false);
    }
  });

  it('the reported ones ask: Home\'s F and /, the board\'s /, Settings\' /, Quick sort\'s keys', () => {
    for (const p of ['components/tasks/useHomeFilters.ts', 'components/tasks/TodoSearchBar.tsx', 'components/board/kanban/KanbanFilters.tsx',
      'components/settings/SettingsNav.tsx', 'components/tasks/QuickSortView.tsx']) {
      expect(all.find((f) => f.p === p)?.s, p).toMatch(/pageShortcutBlocked\(e, /);
    }
  });
});

// ── The rule itself, on a small model of the page (the node tier has no DOM) ──
type Fake = { tagName: string; isContentEditable?: boolean; owner?: Fake | null; typing?: boolean; inside?: Fake[]; rects?: number; isConnected?: boolean };
const el = (o: Partial<Fake> = {}): Fake => ({ tagName: 'DIV', rects: 1, isConnected: true, ...o });
function dom(f: Fake) {
  return Object.assign(f, {
    closest: (sel: string) => (sel.includes('.file-content-view') ? f.owner ?? null : sel.includes('contenteditable') ? (f.typing ? f : null) : null),
    contains: (o: unknown) => o === f || !!f.inside?.includes(o as Fake),
    getClientRects: () => ({ length: f.rects ?? 1 }),
  });
}

let mod: typeof import('../../web/src/utils/page-shortcut');
const listeners: Record<string, (e: { target: unknown }) => void> = {};
const page: { active: unknown; sheets: Fake[]; dialogs: Fake[] } = { active: null, sheets: [], dialogs: [] };
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.Element = function Element() {};
  g.document = {
    addEventListener: (t: string, l: (e: { target: unknown }) => void) => { listeners[t] = l; },
    get activeElement() { return page.active; },
    querySelectorAll: (sel: string) => (sel.includes('fullscreen') ? page.sheets : sel.includes('role=') ? page.dialogs : []),
  };
  mod = await import('../../web/src/utils/page-shortcut');
});
beforeEach(() => { page.active = null; page.sheets = []; page.dialogs = []; mod.resetLastPress(); });

const key = (target: unknown = null, extra: Partial<KeyboardEvent> = {}) => ({ key: 'f', target, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, isComposing: false, ...extra }) as unknown as KeyboardEvent;
const asEl = (f: Fake) => { Object.setPrototypeOf(f, (globalThis as { Element: { prototype: object } }).Element.prototype); return f; };

describe('pageShortcutBlocked', () => {
  const button = dom(el({ tagName: 'BUTTON' }));

  it('the reported case: an open Files sheet takes the key from the Home filter', () => {
    const tree = dom(el());
    page.sheets = [dom(el({ inside: [tree] }))];
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(true);
    // The sheet's own control (a board in a full-screen column) still hears it.
    page.sheets = [dom(el({ inside: [button] }))];
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(false);
  });

  it('a press in the file view, which takes no focus, keeps its keys from the page', () => {
    const view = dom(el());
    const text = asEl(dom(el({ owner: view })));
    listeners.pointerdown?.({ target: text });
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(true);
    // Focus moved by the keyboard to the page: the page hears it again.
    listeners.focusin?.({ target: asEl(dom(el({ tagName: 'BUTTON' }))) });
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(false);
  });

  it('focus in an editor, a modifier, a composition or an open menu', () => {
    page.active = dom(el({ typing: true }));
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(true);
    page.active = null;
    expect(mod.pageShortcutBlocked(key(null, { metaKey: true }), button as unknown as Element)).toBe(true);
    expect(mod.pageShortcutBlocked(key(null, { isComposing: true }), button as unknown as Element)).toBe(true);
    page.dialogs = [dom(el())];
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(true);
    page.dialogs = [dom(el({ rects: 0 }))]; // a closed menu kept in the page
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(false);
  });

  it('nothing in the way: the page hears its key', () => {
    expect(mod.pageShortcutBlocked(key(), button as unknown as Element)).toBe(false);
  });
});
