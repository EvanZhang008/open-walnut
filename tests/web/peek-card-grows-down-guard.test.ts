/**
 * A card a person types into never widens across the window (2026-11-20, the user, on a Home
 * task's ask card that covered the chat: "when it expand whole button is gone", then "the max its
 * like 1.5 time long not like whole screen"). The shared peek (web/src/utils/truncation-peek-row.ts)
 * opens such a card's cut-off texts in place, in its own column, at most 1.5 times its height.
 *
 * The class: every `data-peek-row` element that holds a field. Each one either carries
 * `data-peek-grow="down"`, or is listed below with why the runtime field rule (`growsDown`) is
 * enough for it. A new row that renders a field fails here until it is decided.
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { findPeekRows } from './truncation-peek-scan';

const WEB_SRC = path.resolve(__dirname, '../../web/src');
const read = (p: string) => fs.readFileSync(path.join(WEB_SRC, p), 'utf8');

/**
 * Rows with a field that keep widening while the field is closed: the field only shows on demand,
 * and while it shows `growsDown` finds it in the DOM and the row opens downward.
 * Keyed by file and the row's first class.
 */
const FIELD_ON_DEMAND: Record<string, string> = {
  'components/board/kanban/KanbanCard.tsx kanban-card': 'a Board card widens over its lane (2026-11-15 design, truncation-peek-surfaces.spec.ts); its prompt and editor show only when opened, and then the field rule opens it downward',
  'components/tasks/QuickSortView.tsx quick-sort-card': 'a sort card widens like a list row; its reply box shows only after Reply (R), and then the field rule opens it downward',
};

/** Cards whose field comes in through a slot the scan cannot see (an answer prop): marked by hand. */
const SLOT_CARDS: Array<[string, string]> = [
  ['components/actions/AskCard.tsx', 'ask-card'],
];

describe('a card a person types into opens downward in its own column', () => {
  const rows = findPeekRows(WEB_SRC);
  const keyOf = (r: { file: string; classes: string[] }) => `${r.file} ${r.classes[0] ?? ''}`;

  it('the scan reads every marked row and the fields in it', () => {
    expect(rows.length).toBeGreaterThan(30);
    const kanban = rows.find((r) => keyOf(r) === 'components/board/kanban/KanbanCard.tsx kanban-card');
    expect(kanban?.fields).toEqual(expect.arrayContaining(['KanbanCardEditor']));
    const perm = rows.find((r) => r.file === 'components/common/NotificationPanel.tsx');
    expect(perm?.fields).toEqual(expect.arrayContaining(['PermissionAnswerButtons']));
  });

  it('every row that renders a field grows down, or is listed with why', () => {
    const undecided = rows.filter((r) => r.fields.length && !r.grow && !FIELD_ON_DEMAND[keyOf(r)])
      .map((r) => `${r.file}:${r.line} <${r.tag} .${r.classes[0]}> holds ${r.fields.join(', ')}`);
    expect(undecided, 'A row with a field must not widen over the panes beside it: add data-peek-grow="down" to it, or list it in FIELD_ON_DEMAND with why').toEqual([]);
    const listed = new Set(rows.filter((r) => r.fields.length && !r.grow).map(keyOf));
    expect(Object.keys(FIELD_ON_DEMAND).filter((k) => !listed.has(k)), 'stale FIELD_ON_DEMAND entries').toEqual([]);
  });

  it('the cards whose box comes through a slot carry the mark', () => {
    for (const [file, cls] of SLOT_CARDS) {
      const site = rows.find((r) => r.file === file && r.classes[0] === cls);
      expect(site?.grow, `${file} .${cls}`).toBe(true);
    }
    // Every ask shows in that one card frame, so all of them grow down.
    expect(read('components/actions/AskCard.tsx')).toMatch(/<div className=\{`ask-card[^>]*data-peek-row=""[^>]*data-peek-grow="down"/);
  });

  it('the peek decides it in one place and opens such a card in place, capped at 1.5 times its height', () => {
    const row = read('utils/truncation-peek-row.ts');
    expect(row).toMatch(/export function growsDown\(row: Element\): boolean/);
    expect(row).toContain('export const DOWN_MAX_GROWTH = 0.5');
    expect(row).toMatch(/growsDown\(row\)\) return openDown\(row, hosts, marks\)/);
    // In place: openDown makes no placeholder and no popover.
    const down = row.slice(row.indexOf('function openDown'), row.indexOf('export function expandRow'));
    expect(down).not.toMatch(/popover|placeholder|createElement/);
    const css = read('styles/truncation-peek-down.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\[data-peek-down\]\s*\{[^}]*max-height:\s*var\(--peek-down-max, none\)/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/overscroll-behavior:\s*contain/);
    // Every rule there is for an opened text alone, never a row that widens.
    for (const m of css.matchAll(/([^{}]+)\{/g)) expect(m[1].trim()).toMatch(/^\[data-peek-down\]/);
  });
});

describe('growsDown', () => {
  const { document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
  const rowOf = (html: string) => {
    document.body.innerHTML = html;
    return document.querySelector('#row')!;
  };

  it('a row with a box to type in, or marked, grows down', () => {
    return import('../../web/src/utils/truncation-peek-row').then(({ growsDown }) => {
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><p>Q</p><textarea></textarea></div>'))).toBe(true);
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><input type="text"></div>'))).toBe(true);
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><div contenteditable="true"></div></div>'))).toBe(true);
      expect(growsDown(rowOf('<div id="row" data-peek-row="" data-peek-grow="down"><p>Q</p></div>'))).toBe(true);
    });
  });

  it('a one-line row, its checkbox and the field of a row nested in it keep the row widening', () => {
    return import('../../web/src/utils/truncation-peek-row').then(({ growsDown }) => {
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><span>Title</span><button>Start</button></div>'))).toBe(false);
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><input type="checkbox"><span>Title</span></div>'))).toBe(false);
      expect(growsDown(rowOf('<div id="row" data-peek-row=""><span>Title</span><div data-peek-row=""><textarea></textarea></div></div>'))).toBe(false);
    });
  });
});
