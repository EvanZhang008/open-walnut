/**
 * focusUnlessTyping (web/src/utils/focus-unless-typing.ts): a deferred focus of a form's first field
 * never takes the caret back from a field the person already went to.
 *
 * 2026-11-01: the Mail add-account dialog focused its address field 10 ms after the form mounted. On a
 * busy page that tick ran after the person was in the password field, so the password was typed onto
 * the end of the address (`alice@example.invalidok`, a disabled Add button), into a field the draft
 * store keeps. The ratchet below lists every deferred focus in the web app, so a new one in a form
 * with more than one field has to go through the guard or say why it needs none.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { focusUnlessTyping, isTypingField } from '@/utils/focus-unless-typing';

interface FakeEl {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}

function page(active: FakeEl | null, inScope: boolean) {
  const scope = { contains: (el: unknown) => inScope && el === active };
  const doc = { activeElement: active };
  const target = {
    tagName: 'INPUT',
    type: 'text',
    isConnected: true,
    ownerDocument: doc,
    closest: () => scope,
    focus: vi.fn(),
  };
  return target;
}

describe('focusUnlessTyping', () => {
  it('focuses the first field when nothing is being typed in', () => {
    const target = page({ tagName: 'BODY' }, false);
    expect(focusUnlessTyping(target as unknown as HTMLElement)).toBe(true);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves the caret in another field of the same dialog', () => {
    const target = page({ tagName: 'INPUT', type: 'password' }, true);
    expect(focusUnlessTyping(target as unknown as HTMLElement)).toBe(false);
    expect(target.focus).not.toHaveBeenCalled();
  });

  it('still takes focus from a field outside the dialog, which is what a modal is for', () => {
    const target = page({ tagName: 'TEXTAREA' }, false);
    expect(focusUnlessTyping(target as unknown as HTMLElement)).toBe(true);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('takes focus from a button the person clicked to get here', () => {
    const target = page({ tagName: 'BUTTON' }, true);
    expect(focusUnlessTyping(target as unknown as HTMLElement)).toBe(true);
  });

  it('does nothing for a field that is gone', () => {
    expect(focusUnlessTyping(null)).toBe(false);
    const target = { ...page(null, false), isConnected: false };
    expect(focusUnlessTyping(target as unknown as HTMLElement)).toBe(false);
    expect(target.focus).not.toHaveBeenCalled();
  });

  it('knows which controls take typed text', () => {
    const el = (one: FakeEl) => one as unknown as Element;
    expect(isTypingField(el({ tagName: 'INPUT' }))).toBe(true);
    expect(isTypingField(el({ tagName: 'INPUT', type: 'email' }))).toBe(true);
    expect(isTypingField(el({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(isTypingField(el({ tagName: 'SELECT' }))).toBe(true);
    expect(isTypingField(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isTypingField(el({ tagName: 'BUTTON' }))).toBe(false);
    expect(isTypingField(null)).toBe(false);
  });
});

/**
 * Every `setTimeout` that focuses or selects something, each by its file and a piece of its own call,
 * with why it needs no guard. A new one fails here until it either calls `focusUnlessTyping` (and so
 * no longer matches) or is listed: a deferred focus is only safe on a surface with ONE typing field,
 * or on a control nobody types into. Only timers: a timer is what runs late on a busy page. The
 * scanner is a paren count that does not read strings or comments, which these calls do not need.
 */
const KNOWN_DEFERRED_FOCUS: Array<{ file: string; call: string; why: string }> = [
  { file: 'components/board/kanban/BoardKanban.tsx', call: 'el?.focus({ preventScroll: true })', why: 'a board card, not a typing field' },
  { file: 'components/board/kanban/BoardKanban.tsx', call: 'cardEl(rootEl.current, taskId)?.focus()', why: 'a board card, not a typing field' },
  { file: 'components/board/kanban/BoardKanban.tsx', call: '"kanban-add-task"]\')?.focus()', why: "the new lane's add-task button" },
  { file: 'components/board/kanban/KanbanCardMenu.tsx', call: 'items(menuRef.current)[0]?.focus()', why: 'the first menu item' },
  { file: 'components/board/kanban/KanbanCardMenu.tsx', call: 'items(flyRef.current).find(', why: 'the first enabled flyout item' },
  { file: 'components/common/PageFind.tsx', call: 'editableIn(root)?.focus({ preventScroll: true })', why: 'only while focus sits on the page body (nobody is typing anywhere): the note view a find bar toggle just swapped in' },
  { file: 'components/common/ConfirmDialog.tsx', call: 'inputRef.current?.select(); else if (focusCancel && cancelRef.current) cancelRef.current.focus()', why: "the prompt's one input, the cancel button of a discard, or the confirm button" },
  { file: 'components/notes/CommandPalette.tsx', call: 'inputRef.current?.focus()', why: "the palette's one input" },
  { file: 'components/notes/slash-commands/NoteLinkPanel.tsx', call: 'inputRef.current?.focus()', why: "the panel's one search input" },
  { file: 'components/notes/slash-commands/TaskSearchPanel.tsx', call: 'inputRef.current?.focus()', why: "the panel's one search input" },
  { file: 'components/sessions/SessionPathSelector.tsx', call: 'searchRef.current?.focus({ preventScroll: true })', why: "the selector's one search box" },
  { file: 'components/sessions/SessionHeaderLabels.tsx', call: 'buttonRef.current?.focus()', why: 'a keyboard user whose focus was inside the closing label list gets it back on the list button, never a form field' },
  { file: 'components/first-run/FirstRunDialog.tsx', call: 'modalRef.current?.focus()', why: 'the dialog box itself, on open (it has no typing field)' },
  { file: 'components/first-run/FirstRunDialog.tsx', call: 'next.focus()', why: "the next host's Add button or the dialog's primary button, only when focus fell to the page" },
  { file: 'components/settings/sections/cloud/PairQrDialog.tsx', call: '(primaryRef.current ?? boxRef.current)?.focus()', why: 'a button or the dialog box' },
  { file: 'components/tasks/QuickTaskComposer.tsx', call: 'inputRef.current?.focus()', why: "the composer's one input, on open" },
  { file: 'components/tasks/QuickTaskComposer.tsx', call: 'inputRef.current?.focus()', why: "the composer's one input, after a create" },
];

/** The whole `setTimeout(...)` call starting at `open`, by its matching parenthesis. */
function callAt(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length && at < open + 3000; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, at + 1);
    }
  }
  return text.slice(open, open + 3000);
}

describe('ratchet: a deferred focus never lands on a form with another field to type in', () => {
  const root = path.resolve(__dirname, '../../web/src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p);
    }
  };
  walk(root);

  it('scans the web app', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('every setTimeout that focuses is listed with its reason, or goes through focusUnlessTyping', () => {
    const unlisted: string[] = [];
    const left = [...KNOWN_DEFERRED_FOCUS];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bsetTimeout\(/g)) {
        const call = callAt(text, m.index! + m[0].length - 1).replace(/\s+/g, ' ');
        if (!/\.(focus|select)\(/.test(call)) continue;
        const rel = path.relative(root, f);
        // Each listed entry answers for ONE call, so a second call of the same shape needs its own.
        const at = left.findIndex((one) => one.file === rel && call.includes(one.call));
        if (at >= 0) left.splice(at, 1);
        else unlisted.push(`${rel}:${text.slice(0, m.index).split('\n').length}  setTimeout${call.slice(0, 120)}`);
      }
    }
    expect(unlisted, 'a deferred focus nobody has said is safe: use focusUnlessTyping, or list it with why').toEqual([]);
    expect(left.map((one) => `${one.file}  ${one.call}`), 'listed calls that are gone: take them off the list').toEqual([]);
  });

  it('the Mail add-account dialog focuses through the guard', () => {
    const text = readFileSync(path.join(root, 'apps/mail/AddAccountDialog.tsx'), 'utf8');
    expect(text).toContain('focusUnlessTyping(firstFieldRef.current)');
  });

  it('the scan catches the shape this replaced', () => {
    const old = 'const timer = setTimeout(() => firstFieldRef.current?.focus(), 10);';
    const call = callAt(old, old.indexOf('setTimeout(') + 'setTimeout'.length);
    expect(call).toBe('(() => firstFieldRef.current?.focus(), 10)');
    expect(/\.(focus|select)\(/.test(call)).toBe(true);
  });
});
