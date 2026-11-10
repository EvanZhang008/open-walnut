/**
 * Working, Waiting / snoozed and Completed fold back by themselves 60 s after the user's last
 * action in the side bar (2026-11-06, the user: "the complete and working snooze need to auto
 * collapse in 60s if no action, so why is it still open? no action means people not actively
 * scrolling, click in the side bar"). Completed had stayed open in his Mac app: the clock ran
 * 15 minutes from the opening, and a pointer resting on the fold, its row being the task open or
 * the user looking at it held it longer still.
 *
 * This fails when a status fold can stay open past 60 s with no action: a longer clock, a new
 * hold in the busy check or the page's fold pass, a pointer move counted as an action, or a
 * surface that draws status sections from an open state no fold store keeps (a project jump's
 * own map did, and never folded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOLD_AUTO_CLOSE_MS,
  STATUS_SECTION_FOLD,
  foldIsDue,
  nextAutoClose,
  projectFoldKind,
  setFold,
  statusSectionFoldKind as kind,
} from '../../web/src/components/tasks/section-fold-rule';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const T0 = Date.parse('2026-11-06T19:42:50Z');
const autoKeys = Object.entries(STATUS_SECTION_FOLD).filter(([, k]) => k === 'auto').map(([key]) => key);

describe('a status fold folds 60 s after the last action in its panel', () => {
  it('the time is 60 s', () => {
    expect(FOLD_AUTO_CLOSE_MS).toBe(60_000);
    expect(autoKeys.sort()).toEqual(['done', 'notstarted', 'waiting', 'working']);
  });

  for (const key of [...autoKeys, 'list\u0000Garden\u0000done']) {
    const fk = key.includes('\u0000') ? projectFoldKind : kind;
    it(`${JSON.stringify(key)}: due 60 s after opening with no action, later after one`, () => {
      const s = setFold({}, key, true, fk, T0);
      expect(foldIsDue(s, key, fk, T0 + 59_999)).toBe(false);
      expect(foldIsDue(s, key, fk, T0 + 60_000)).toBe(true);
      // A click or a scroll in the panel at +50 s gives it 60 s from then.
      const acted = () => T0 + 50_000;
      expect(foldIsDue(s, key, fk, T0 + 60_000, acted)).toBe(false);
      expect(foldIsDue(s, key, fk, T0 + 110_000, acted)).toBe(true);
      expect(nextAutoClose(s, fk, acted)).toBe(T0 + 110_000);
      // An action before the opening counts from the opening.
      expect(nextAutoClose(s, fk, () => T0 - 30_000)).toBe(T0 + 60_000);
    });
  }

  it('Watching and Needs you have no clock', () => {
    for (const key of ['watching', 'needs']) {
      expect(STATUS_SECTION_FOLD[key as 'needs']).toBe('sticky');
      expect(foldIsDue(setFold({}, key, true, kind, T0), key, kind, T0 + 7 * 24 * 3600_000)).toBe(false);
    }
  });
});

describe('nothing but an action keeps a due fold open', () => {
  const rule = read('web/src/components/tasks/section-fold-rule.ts');
  const store = read('web/src/components/tasks/useFoldStore.ts');

  it('the busy check holds only for typing in it or a menu open from it', () => {
    const body = /export function foldBusy\([^)]*\): boolean \{([\s\S]*?)\n\}/.exec(rule)?.[1] ?? '';
    expect(body).not.toBe('');
    const holds = [...body.matchAll(/if \(([^)]*(?:\([^)]*\)[^)]*)*)\) return true;/g)].map((m) => m[1].trim());
    expect(holds).toEqual(['typing && el.contains(focused)', 'el.querySelector(MENU_OPEN)']);
    expect(body).not.toMatch(/:hover|inPanelView|reading|OPEN_TASK_ROW|keyboardFocus/);
  });

  it('the page folds a due fold unless the busy check holds it, nothing else', () => {
    const pass = /const foldDue = useCallback\(\(\): boolean => \{([\s\S]*?)\n  \}, \[/.exec(store)?.[1] ?? '';
    expect(pass).not.toBe('');
    expect(pass).toMatch(/foldIsDue\(cur, key, kind, t \+ FOLD_BATCH_MS, lastActionOf\)/);
    const skips = [...pass.matchAll(/if \((.*)\) \{ busy = true;[^}]*continue; \}/g)].map((m) => m[1]);
    expect(skips).toEqual(['drawnRef.current && foldBusy(document, key)']);
    // A fold another store draws (a project jump's) is folded by its clock, never held.
    expect(pass).toMatch(/if \(!drawnRef\.current\) \{ next = setFold\(next, key, false, kind, t\); continue; \}/);
  });

  it('an action is a click, a scroll, a key or a touch: never a pointer that only moves or rests', () => {
    const listen = /function listenForActions\(\): void \{([\s\S]*?)\n\}/.exec(store)?.[1] ?? '';
    const types = /for \(const type of \[([^\]]+)\] as const\)/.exec(listen)?.[1] ?? '';
    expect(types.split(',').map((t) => t.trim().replace(/'/g, '')).sort()).toEqual(['keydown', 'pointerdown', 'touchmove', 'wheel']);
    expect(listen).not.toMatch(/pointermove|mousemove|pointerover|mouseenter/);
  });

  it('every drawn status section reads a fold store, a project jump included', () => {
    const panel = read('web/src/components/tasks/TodoPanel.tsx');
    expect(panel).toMatch(/const shownSectionOpen = jumpLive \? jumpOpen : sectionOpen;/);
    expect(panel).toMatch(/const jumpOpen = useMemo\(\(\) => statusSectionsOpen\(jumpFolds\.store\)/);
    expect(panel).toMatch(/const sectionOpen = useMemo\(\(\) => statusSectionsOpen\(sectionFolds\.store\)/);
    expect(panel).not.toMatch(/projectJump\??\.open\b/);
    // The sections draw `shownSectionOpen`, never an open state of their own.
    const drawn = [...panel.matchAll(/<StatusSectionGroup\b[^>]*\bopen=\{(\w+)\}/g)].map((m) => m[1]);
    expect(drawn.length).toBeGreaterThan(0);
    expect(new Set(drawn)).toEqual(new Set(['shownSectionOpen']));
  });
});
