/**
 * A menu opened at the cursor, and every picker it opens, knows the row it was opened on
 * (ContextMenu's `returnFocus`, the third argument of a useCursorFlyout `open`). With the row
 * known, only a scroll that moves that row closes it; without it ANY scroll on the page does: a
 * session column following its own tail, a list restoring its offset after a sync (the
 * 2026-09-22 "right-click disappears after about two seconds" report). On 2026-11-03 the folder
 * menu and its Sprint picker passed no row, and on a busy CI fixture both closed under the click.
 *
 * The scan finds every `<ContextMenu` element and every open of a cursor picker (and of the bulk
 * settings rows, which open one) under web/src. A new one without its row fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../web/src');

/** Menus that keep their own point and no row yet, and so still close on any scroll. Each is
 *  listed with why; give it its row (`returnFocus`) and take it off this list. */
const NO_ORIGIN_YET: Record<string, string> = {
  'components/inbox/LetterEnvelopeRow.tsx': 'letter row menu, predates the origin rule',
  'components/chat/ChatMessage.tsx': 'chat message menus, predate the origin rule',
  'components/layout/Sidebar.tsx': 'sidebar app menu, predates the origin rule',
  'components/common/FileThreadLayer.tsx': 'keeps its own point from a text mark, with no row element',
  'components/sessions/SessionMessage.tsx': 'session row menu, predates the origin rule',
  'components/sessions/useThreadReviewPane.tsx': 'keeps its own point from a question mark, with no row element',
  'components/notes/NotesTabStrip.tsx': 'notes tab menu, predates the origin rule',
  'apps/mail/MailAccountsPane.tsx': 'keeps its own point (menuPointFor), with no row element',
  'apps/mail/compose/MailDraftsList.tsx': 'draft row menu, predates the origin rule',
  'apps/mail/compose/ComposerPanel.tsx': 'identity menu keeps its own point, with no row element',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));

/** The text of a JSX element's opening tag starting at `at` (`<ContextMenu ... >` or `/>`), braces
 *  balanced, comments between its props skipped (one may say `<li>`). */
function openingTag(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (depth === 0 && c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (depth === 0 && c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

describe('cursor menus and their pickers know the row they were opened on', () => {
  it('every <ContextMenu> passes returnFocus, or is listed with why', () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const { rel, src } of files) {
      if (rel === 'components/common/ContextMenu.tsx') continue;
      for (const m of src.matchAll(/<ContextMenu[\s\n]/g)) {
        seen.add(rel);
        if (/\breturnFocus=/.test(openingTag(src, m.index!))) continue;
        if (NO_ORIGIN_YET[rel]) continue;
        missing.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(missing, 'pass returnFocus={menu.state.origin} (the row the menu was opened on)').toEqual([]);
    // The scan sees the menus it guards, and the list names only files that still lack a row.
    expect([...seen]).toEqual(expect.arrayContaining(['components/tasks/FolderContextMenu.tsx', 'components/tasks/ProjectContextMenu.tsx']));
    for (const rel of Object.keys(NO_ORIGIN_YET)) {
      const src = files.find((f) => f.rel === rel)?.src ?? '';
      const tags = [...src.matchAll(/<ContextMenu[\s\n]/g)].map((m) => openingTag(src, m.index!));
      expect(tags.length, `${rel} renders no ContextMenu any more: drop it from the list`).toBeGreaterThan(0);
      expect(tags.every((t) => /\breturnFocus=/.test(t)), `${rel} passes returnFocus now: drop it from the list`).toBe(false);
    }
  });

  it('every cursor picker and bulk settings row opens with the menu\'s row', () => {
    const missing: string[] = [];
    let opens = 0;
    for (const { rel, src } of files) {
      if (rel === 'components/tasks/CursorFlyout.tsx') continue;
      // `const picker = useCursorFlyout<...>()` -> picker.open(payload, point, origin)
      const pickers = [...src.matchAll(/const (\w+) = useCursorFlyout\b/g)].map((m) => ({ name: m[1], method: 'open', args: 3 }));
      // `const settings = useBulkTaskSettings()` -> settings.rows(scope, point, origin)
      const bulk = [...src.matchAll(/const (\w+) = useBulkTaskSettings\(\)/g)].map((m) => ({ name: m[1], method: 'rows', args: 3 }));
      for (const h of [...pickers, ...bulk]) {
        for (const m of src.matchAll(new RegExp(`\\b${h.name}\\.${h.method}\\(`, 'g'))) {
          opens++;
          const args = callArgs(src, m.index! + m[0].length - 1);
          if (args.length < h.args) missing.push(`${rel}:${src.slice(0, m.index).split('\n').length} ${h.name}.${h.method}`);
        }
      }
    }
    // Inside useBulkTaskSettings the picker opens with the origin its caller handed to rows().
    const bulkSrc = files.find((f) => f.rel === 'components/tasks/BulkTaskSettings.tsx')!.src;
    expect(bulkSrc).toMatch(/rows: BulkTaskSettingsHandle\['rows'\] = \(scope, point, origin\)/);
    expect(opens).toBeGreaterThanOrEqual(6);
    expect(missing, 'pass the menu\'s origin (menu.state.origin) as the last argument').toEqual([]);
  });
});
