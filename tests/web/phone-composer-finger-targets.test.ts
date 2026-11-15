/**
 * On a phone every button that stands on the composer's controls row takes a finger
 * (C19: 44 px each way, in hit testing). The row's direct buttons (Note, btw:
 * ComposerDirectControl) were drawn 23 px tall with a 2 px gap; at 375 and 320 px wide,
 * where the row keeps them out of the "+" menu, a tap above or beside one missed it or
 * hit its neighbour (phone-session.spec C18/C19 sweep, 2026-11-15).
 *
 * The row's buttons are the "+" button, the mic, the controls bar's pills and every
 * direct button; a direct button is one class whatever control it mirrors, so a new
 * direct control is covered by the same rule. This reads the class each of them renders
 * from its source and checks the phone hit-area rule in phone-session.css names it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The selector lists of the C19 block's hit-area rules: `:is(...)::before` and its `position: relative` twin. */
function hitAreaClasses(css: string): { raised: Set<string>; wide: Set<string> } {
  const block = css.slice(css.indexOf('Finger-sized targets and 12 px text in the session surfaces (C19)'));
  const lists = [...block.matchAll(/:is\(\s*([^)]*?)\s*\)(::before)?\s*,/g)];
  const classesOf = (list: string) => new Set(list.split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean));
  const before = lists.find((m) => m[2] === '::before');
  const relative = lists.find((m) => !m[2] && /msg-copy-btn/.test(m[1]!));
  expect(before, 'the ::before hit-area rule').toBeTruthy();
  expect(relative, 'the position: relative rule').toBeTruthy();
  const raised = classesOf(before![1]!);
  for (const c of classesOf(relative![1]!)) expect(raised.has(c), `${c} is positioned but has no hit area`).toBe(true);
  // A short control is also at least 44 wide (min-width), so neighbours never share a probe.
  const wide = new Set<string>();
  for (const m of block.matchAll(/([^{}]+)\{[^}]*min-width:\s*44px/g)) {
    for (const c of m[1]!.matchAll(/\.([a-z][\w-]*)/g)) wide.add(c[1]!);
  }
  return { raised, wide };
}

describe('phone composer row finger targets', () => {
  const css = read('web/src/styles/phone-session.css');
  const { raised, wide } = hitAreaClasses(css);

  it('every direct button on the input box gets a 44 px hit area', () => {
    const src = read('web/src/components/chat/ComposerDirectControl.tsx');
    const cls = /className=\{`side-question-pill ([\w-]+)/.exec(src)?.[1];
    expect(cls).toBe('composer-direct-control');
    expect(raised.has(cls!)).toBe(true);
    expect(wide.has(cls!)).toBe(true);
  });

  it('the row\'s other short pills keep theirs', () => {
    for (const cls of ['chat-plus-btn', 'mic-btn', 'mode-toggle-pill', 'session-detail-model-pill']) {
      expect(raised.has(cls), cls).toBe(true);
      expect(wide.has(cls), cls).toBe(true);
    }
  });
});
