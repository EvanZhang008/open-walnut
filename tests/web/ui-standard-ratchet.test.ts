/**
 * The UI standard (.claude/skills/walnut-ui-requirements/standard.md): one look per kind of control.
 *
 * 2026-11-21, the user, on one screen with a question card (grey rounded option buttons) and a
 * result card (filled blue Acknowledge, outlined Snooze, outlined watch): "why they are not even
 * consistent come on". Both were the shared `.btn`, each restyled by its own card's CSS.
 *
 * Three ways a second style gets in, counted per file (ui-standard-scan.ts):
 *   - restyledBtn: a rule that changes how `.btn` looks for one place (`.scope .btn`,
 *     `.btn.extra`, or a class the TSX writes beside `btn`). The card family's one home,
 *     components/actions/ask-card.css, is exempt (from ownControl too: it maps an approval's own
 *     buttons onto the family inside a card).
 *   - ownControl: a `*-btn` / `*-button` / `*-pill` / `*-chip` class with its own fill and corner.
 *   - rawAccent: a literal #007aff / #0a84ff where var(--accent) belongs.
 *   - the token kinds (ui-token-scan.ts): rawColour, radiusNotToken, pillRadius, fontSizeOffScale,
 *     shadowLiteral, zIndexLiteral, spacingOffGrid: a value written where a token belongs.
 *   - bareButton: a `<button>` in a TSX file whose className has no `btn` (the family in
 *     web/src/styles/buttons.css), choice controls (role tab, radio, switch, checkbox, option)
 *     aside. A new file starts at 0: every button it draws is `.btn` plus a variant.
 *   - restyledInput: a rule outside web/src/styles/input-box.css that gives an input box (a class
 *     the TSX writes beside `wn-input`), its send key (beside `wn-input-send`) or the mic and
 *     attach keys inside it a corner, fill, edge or size of its own (2026-11-21, the user on the
 *     Threads reply box: "it's oval ... can there be one unified input box?").
 *   - cutTitle: a rule that cuts a title, name, subject or summary class with an ellipsis or a line
 *     clamp (standard.md, "Text that does not fit"): titles wrap (`.wn-title`), only metadata cuts.
 *   - restyledField: a rule outside web/src/styles/input-box.css that gives a field (an input,
 *     textarea or select, a class the TSX writes on one, or a class beside `wn-field`) a fill, edge,
 *     corner, shadow, outline, height or placeholder colour of its own (2026-11-21 UI audit: the
 *     Home, Display menu, Mail, Apps, Memory and Settings searches and the plain fields beside them
 *     each looked different). A rule that takes a field's look away (`border: 0` inside a box) is fine.
 *   - cardBg: a `*-card` with a corner, in the flow, filled with `--bg` or `--bg-elevated` instead of
 *     the one card fill `--card-bg` (standard.md, "Cards"): one list's cards drifted in dark.
 *   - ownLabel: a `*-badge` / `*-pill` / `*-chip` / `*-tag` class that paints its own fill, words
 *     colour, edge colour or corner, or a rule that restyles `.badge` for one place, instead of the
 *     one label in styles/badge.css (standard.md, "Status labels"); and a `*-count` / `*-state` /
 *     `*-role` / `*kind` / `*-type` / `*-new` / `*-status` class that draws a box of its own (a label under
 *     another name; plain text and round dots are free).
 * The counts that exist today are in ui-standard-baseline.json and may only go down. A new file or
 * a higher count fails: use the family the standard names. A lower count fails too until the
 * baseline is lowered with `UI_STANDARD_RECORD=1` on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pluginCss, pluginStyles, countAll, isSquareKey, isRoundRow, restylesBtn, ownBehaviour, isOwnControl, TOKEN_KINDS, buttonTags, isBareButton, FAMILY_CSS, inputParts, restylesInput, cutsTitle, fieldClasses, restylesField, isOwnLabel, paintsLabel, isBoxedLabelName, drawsBox, LABEL_HOME, isCard, offCardFill, META_MARK, SIZE_MARK, WEB_SRC, type Counts } from './ui-standard-scan';
import { tokenBreaks } from './ui-token-scan';
import type { Decl } from './css-scan';

const BASELINE = path.join(__dirname, 'ui-standard-baseline.json');
/** The one home of the card button family (standard.md, "The button family"). */
const FAMILY_HOME = 'components/actions/ask-card.css';
/** The one home of the choice controls (standard.md, "Choice controls"). */
const CHOICE_HOME = 'styles/choice-controls.css';
/** The one home of the Picked row, the Nav item and the Option card (standard.md, "Choice controls"). */
const PICK_HOME = 'styles/pick-and-nav.css';
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';

function current(): Counts {
  const c = countAll();
  // The family's home gives every card control the family's look, an approval's own buttons included.
  delete c.restyledBtn[FAMILY_HOME];
  delete c.ownControl[FAMILY_HOME];
  // The choice controls' home draws the chip and the one round control the standard names, the
  // switch (standard.md, "Choice controls").
  delete c.ownControl[CHOICE_HOME];
  delete c.pillRadius[CHOICE_HOME];
  // The shared rows' home draws the Nav item's row and the Option card for every list that uses them.
  delete c.ownControl[PICK_HOME];
  // The family's own stylesheet draws `.btn` and its slots.
  delete c.restyledBtn[FAMILY_CSS];
  return c;
}

function compare(kind: keyof Counts, now: Record<string, number>, was: Record<string, number>) {
  const grew: string[] = [];
  const fell: string[] = [];
  for (const [file, n] of Object.entries(now)) {
    const before = was[file] ?? 0;
    if (n > before) grew.push(`${kind}: web/src/${file} has ${n} (was ${before})`);
  }
  for (const [file, before] of Object.entries(was)) {
    const n = now[file] ?? 0;
    if (n < before) fell.push(`${kind}: web/src/${file} has ${n} (baseline ${before})`);
  }
  return { grew, fell };
}

/**
 * Every font size kept off the type scale by a `size: <why>` comment mark, and why. A mark not listed
 * here fails, so the type scale gives way only where a measurement says it must.
 */
const SIZE_MARKS: Record<string, string> = {
  // 2026-11-23: 24c5c5b1de rounded it to --font-size-xs (11px), and the collapse row's sentence
  // ("58 more folders, 6 with unread") no longer fits the scrolled pane's 158px slot.
  'apps/mail/mail.css': 'the mail pane collapse row: its sentence measures 147px at 10px and 161px at 11px against a 158px slot',
};

describe('UI standard: font sizes off the scale', () => {
  it('every size mark is listed with why', () => {
    const marked: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.css') && fs.readFileSync(p, 'utf8').split('\n').some((l) => SIZE_MARK.test(l))) marked.push(path.relative(WEB_SRC, p).split(path.sep).join('/'));
      }
    };
    walk(WEB_SRC);
    expect(marked.sort(), 'a size: comment mark keeps a font size off the scale: list it in SIZE_MARKS with its measurement').toEqual(Object.keys(SIZE_MARKS).sort());
  });
});

describe('UI standard: one look per kind of control', () => {
  const now = current();

  if (process.env.UI_STANDARD_RECORD === '1') {
    fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  }
  const recorded = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Partial<Counts>;
  const was = Object.fromEntries(Object.keys(now).map((k) => [k, recorded[k as keyof Counts] ?? {}])) as Counts;

  for (const kind of ['restyledBtn', 'ownControl', 'rawAccent', 'bareButton', 'restyledInput', 'restyledField', 'ownLabel', 'cardBg', 'squareKey', ...TOKEN_KINDS] as const) {
    it(`${kind}: no new second style`, () => {
      const { grew } = compare(kind, now[kind], was[kind] ?? {});
      expect(grew, `A second style of a shared control. Use the family in ${STANDARD} instead:\n${grew.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const { fell } = compare(kind, now[kind], was[kind] ?? {});
      expect(fell, `Fewer exceptions than recorded: good. Lower the baseline with\nUI_STANDARD_RECORD=1 bun --bun vitest run tests/web/ui-standard-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  // standard.md, "Shapes" (2026-11-22, the user: "我想变成圆形"): every key is round, in every file.
  it('squareKey: no key, chip, tab or count has a corner short of round', () => {
    const files = Object.entries(now.squareKey).map(([f, n]) => `web/src/${f}: ${n}`);
    expect(files, `Draw a key round (border-radius: var(--radius-full)); a row named like a key says so: /* shape: <why> */\n${files.join('\n')}`).toEqual([]);
  });

  it('roundRow: no row, menu row or option row is drawn as a capsule', () => {
    const files = Object.entries(now.roundRow).map(([f, n]) => `web/src/${f}: ${n}`);
    expect(files, `A row keeps its container's corner (var(--radius-sm) for a list or menu row): standard.md "Shapes"\n${files.join('\n')}`).toEqual([]);
    const d = (prop: string, value: string) => ({ prop, value });
    expect(isRoundRow([d('border-radius', 'var(--radius-full)'), d('width', '100%'), d('text-align', 'left')])).toBe(true);
    expect(isRoundRow([d('border-radius', 'var(--radius-full)'), d('width', '100%'), d('justify-content', 'center')])).toBe(false);
    expect(isRoundRow([d('border-radius', 'var(--radius-full)'), d('justify-content', 'space-between')])).toBe(true);
    expect(isRoundRow([d('border-radius', 'var(--radius-sm)'), d('width', '100%'), d('text-align', 'left')])).toBe(false);
  });

  it('tells a square key from a row, a label and the input box', () => {
    expect(isSquareKey('.my-thing-btn', 'var(--label-radius)', new Set())).toBe(true);
    expect(isSquareKey('.my-chip', 'var(--label-radius)', new Set())).toBe(false);
    const keys = new Set(['org-ask-tool']);
    expect(isSquareKey('.my-thing-btn', '6px', keys)).toBe(true);
    expect(isSquareKey('.org-ask-tool:hover', 'var(--radius-sm)', keys)).toBe(true);
    expect(isSquareKey('.scope .btn', '8px', keys)).toBe(true);
    // A pressable named like a menu is the key that opens it; a menu that is no key keeps its corner.
    expect(isSquareKey('.todo-section-tabs-menu', '6px', new Set(['todo-section-tabs-menu']))).toBe(true);
    expect(isSquareKey('.todo-section-tabs-menu', '6px', new Set())).toBe(false);
    expect(isSquareKey('.my-count', 'var(--radius-xs)', keys)).toBe(true);
    expect(isSquareKey('.my-thing-btn', 'var(--radius-full)', keys)).toBe(false);
    expect(isSquareKey('.my-thing-btn', '50%', keys)).toBe(false);
    expect(isSquareKey('.split-btn', 'var(--radius-full) 0 0 var(--radius-full)', keys)).toBe(false);
    expect(isSquareKey('.my-tag', 'var(--label-radius)', keys)).toBe(false);
    expect(isSquareKey('.my-thing-row', '8px', keys)).toBe(false);
    expect(isSquareKey('.my-thing-card', '16px', keys)).toBe(false);
    expect(isSquareKey('.my-thing-btn::after', '2px', keys)).toBe(false);
    expect(isSquareKey('.wn-input > .box-mic .mic-btn', 'var(--input-key-radius)', keys)).toBe(false);
    expect(isSquareKey(".wn-tabs[aria-orientation='vertical'] > .wn-tab", 'var(--radius-md)', keys)).toBe(false);
    expect(isSquareKey('.page-title', '8px', keys)).toBe(false);
    // A key listed in :is() is still a key; one under :not() is not the element styled.
    expect(isSquareKey('.pr-card :is(.pr-card-refresh, .org-ask-tool)', '6px', keys)).toBe(true);
    expect(isSquareKey('.panel:not(.org-ask-tool) .page-title', '6px', keys)).toBe(false);
  });

  it('finds each shape of a second style', () => {
    const companions = new Set(['org-ask-tool']);
    expect(restylesBtn('.ask-card-answer .btn')).toBe(true);
    expect(restylesBtn('.btn.org-thread-watch-btn')).toBe(true);
    expect(restylesBtn('.org-ask-tool', companions)).toBe(true);
    expect(restylesBtn('.org-ask-tool:hover', companions)).toBe(true);
    expect(restylesBtn('.btn')).toBe(false);
    expect(restylesBtn('.btn.btn-sm.btn-primary:hover')).toBe(false);
    expect(restylesBtn('.something-else')).toBe(false);
    expect(isOwnControl('.kanban-icon-btn')).toBe(true);
    expect(isOwnControl('.row .pr-pill:hover')).toBe(true);
    expect(isOwnControl('.card-title')).toBe(false);
    // A shipped plugin's stylesheet is read from the template string its styles.ts exports.
    expect(pluginCss('/** `x` */\nexport const CSS = `\n.a { color: red; }\n`\n')).toBe('\n.a { color: red; }\n');
    expect(pluginStyles().some(([f]) => f.includes('walnut-rhythm'))).toBe(true);
    // A class on a <button> outside the family is a key with its own look, whatever its name.
    expect(isOwnControl('.nfc-card-action')).toBe(false);
    expect(isOwnControl('.nfc-card-action:hover', new Set(['nfc-card-action']))).toBe(true);
    // Only a listed behaviour of a key (the armed countdown bar) is exempt, never the key itself.
    expect(ownBehaviour('.nfc-perm-btn.is-armed::after')).toBe(true);
    expect(ownBehaviour('.nfc-perm-btn.is-armed')).toBe(false);
    expect(ownBehaviour('.nfc-perm-btn::after')).toBe(false);
    expect(ownBehaviour('.app-shell-navigation .permission-request-btn.is-busy::after')).toBe(true);
    expect(ownBehaviour('.permission-request-btn:hover')).toBe(false);
    const bare = (src: string) => buttonTags(src).map(isBareButton);
    expect(bare('<button className="btn btn-sm" onClick={() => a > b}>x</button>')).toEqual([false]);
    expect(bare("<button className={`btn${on ? ' btn-primary' : ''}`}>y</button>")).toEqual([false]);
    expect(bare('<button className="foo-btn" onClick={() => { if (x > 1) y() }}>z</button>')).toEqual([true]);
    expect(bare('<button onClick={f}>n</button><button role="tab" className="t">t</button>')).toEqual([true, false]);
    expect(cutsTitle('.home-navigation-scroll .todo-item-title')).toBe(true);
    expect(cutsTitle('.org-rail-name:hover')).toBe(true);
    expect(cutsTitle('.mail-row .mail-subject-line')).toBe(false);
    expect(cutsTitle('.todo-item-title .task-project-label')).toBe(false);
    expect(isOwnLabel('.org-badge.is-alert')).toBe(true);
    expect(isOwnLabel('.row .tag-chip:hover')).toBe(true);
    expect(isOwnLabel('.badge.my-pill')).toBe(true);
    expect(isOwnLabel('.status-card-meta .badge')).toBe(true);
    expect(isOwnLabel('.badge.badge-accent')).toBe(false);
    expect(isOwnLabel('.org-badge-row')).toBe(false);
    expect(paintsLabel('background', 'var(--bg-tertiary)')).toBe(true);
    expect(paintsLabel('background', 'transparent')).toBe(false);
    expect(paintsLabel('border', '1px dashed var(--border)')).toBe(true);
    expect(paintsLabel('border', '0')).toBe(false);
    expect(paintsLabel('border-radius', '999px')).toBe(true);
    expect(paintsLabel('padding', '0 6px')).toBe(false);
    expect(isBoxedLabelName('.team-card-count')).toBe(true);
    expect(isBoxedLabelName('.oc-vp-new')).toBe(true);
    expect(isBoxedLabelName('.session-diff-tree-repokind')).toBe(true);
    expect(isBoxedLabelName('.hib-type')).toBe(true);
    expect(isBoxedLabelName('.team-card-title')).toBe(false);
    expect(drawsBox([{ prop: 'background', value: 'var(--bg-tertiary)' }, { prop: 'border-radius', value: '8px' }])).toBe(true);
    expect(drawsBox([{ prop: 'color', value: 'var(--fg-muted)' }])).toBe(false);
    expect(drawsBox([{ prop: 'background', value: 'var(--accent)' }, { prop: 'border-radius', value: '50%' }])).toBe(false);
    expect(isCard('.board .kanban-card')).toBe(true);
    expect(isCard('.thread-card-head')).toBe(false);
    const r = { prop: 'border-radius', value: 'var(--radius-md)' };
    expect(offCardFill([{ prop: 'background', value: 'var(--bg-elevated)' }, r])).toBe(true);
    expect(offCardFill([{ prop: 'background', value: 'var(--bg)' }, r])).toBe(true);
    expect(offCardFill([{ prop: 'background', value: 'var(--card-bg)' }, r])).toBe(false);
    expect(offCardFill([{ prop: 'background', value: 'var(--bg-secondary)' }, r])).toBe(false);
    expect(offCardFill([{ prop: 'background', value: 'var(--bg)' }])).toBe(false);
    expect(offCardFill([{ prop: 'background', value: 'var(--bg-elevated)' }, r, { prop: 'position', value: 'fixed' }])).toBe(false);
    // A cut that is right says why on its own line; a bare or short mark does not count.
    expect(META_MARK.test('  text-overflow: ellipsis; /* meta: one-line tab strip, the tab peeks */')).toBe(true);
    expect(META_MARK.test('  text-overflow: ellipsis; /* meta: tab */')).toBe(false);
    expect(META_MARK.test('  text-overflow: ellipsis;')).toBe(false);
  });

  it('finds each value that is not a token', () => {
    const d = (prop: string, value: string, selectors = ['.x']): Decl => ({ file: 'x.css', line: 1, prop, value, selectors, atRules: [] });
    expect(tokenBreaks(d('color', '#1d1d1f'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('border', '1px solid rgba(0, 0, 0, 0.1)'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('color', 'var(--fg, #1d1d1f)'))).toEqual([]);
    expect(tokenBreaks(d('--my-ink', '#333'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('--fg', '#1d1d1f', [':root[data-theme="dark"]']))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '6px'))).toEqual(['radiusNotToken']);
    expect(tokenBreaks(d('border-radius', 'var(--radius-sm) var(--radius-sm) 0 0'))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '50%'))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '999px'))).toEqual(['pillRadius']);
    expect(tokenBreaks(d('font-size', '12.5px'))).toEqual(['fontSizeOffScale']);
    expect(tokenBreaks(d('font-size', 'var(--font-size-sm)'))).toEqual([]);
    expect(tokenBreaks(d('font', '500 12px/1.4 var(--font-sans)'))).toEqual(['fontSizeOffScale']);
    expect(tokenBreaks(d('font', '500 var(--font-size-sm)/18px var(--font-sans)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', '0 8px 24px rgba(0, 0, 0, 0.16)'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('box-shadow', '0 0 0 2px var(--accent)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', 'inset 0 1px 3px rgba(0, 0, 0, 0.2)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', 'var(--shadow-sm), 0 0 0 1px var(--border)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', '0 10px 30px color-mix(in srgb, var(--fg) 20%, transparent)'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('box-shadow', 'rgb(0 0 0 / 20%) 0 4px 12px'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('color', 'red'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('border-color', 'var(--red-ish)'))).toEqual([]);
    expect(tokenBreaks(d('z-index', '1000'))).toEqual(['zIndexLiteral']);
    expect(tokenBreaks(d('z-index', '1'))).toEqual([]);
    expect(tokenBreaks(d('padding', '5px 8px'))).toEqual(['spacingOffGrid']);
    expect(tokenBreaks(d('padding', '1px 6px'))).toEqual([]);
  });
  it('finds every input box and the second looks given to one', () => {
    const parts = inputParts();
    for (const box of ['chat-input-box', 'answer-box', 'thread-card-composer']) expect(parts.boxes.has(box), box).toBe(true);
    for (const key of ['chat-send-btn-icon', 'answer-box-send', 'thread-card-send']) expect(parts.keys.has(key), key).toBe(true);
    expect(restylesInput('.my-card .answer-box', [{ prop: 'border-radius' }], parts)).toBe(true);
    expect(restylesInput('.thread-card-send', [{ prop: 'background' }], parts)).toBe(true);
    expect(restylesInput('.answer-box-tools .mic-btn', [{ prop: 'height' }], parts)).toBe(true);
    expect(restylesInput(':is(.answer-box, .thread-card-composer)', [{ prop: 'border-radius' }], parts)).toBe(true);
    expect(restylesInput('.thread-card-composer', [{ prop: 'border-top' }], parts)).toBe(true);
    expect(restylesInput('.answer-box-send:disabled', [{ prop: 'opacity' }], parts)).toBe(true);
    expect(restylesInput('.session-notes-heading-actions .mic-btn', [{ prop: 'height' }], parts)).toBe(false);
    expect(restylesInput('.answer-box .mic-btn', [{ prop: 'height' }], parts)).toBe(true);
    expect(restylesInput('.answer-box', [{ prop: 'flex-wrap' }], parts)).toBe(false);
  });
  it('finds every field and the second looks given to one', () => {
    const fields = fieldClasses();
    for (const f of ['todo-search-input', 'fb-search-input', 'settings-input', 'apps-search', 'memory-filter-input']) expect(fields.has(f), f).toBe(true);
    const d = (prop: string, value: string) => [{ prop, value }];
    expect(restylesField('.memory-filter-input', d('border', '1px solid var(--border)'), fields)).toBe(true);
    expect(restylesField('.settings-input:focus', d('box-shadow', 'var(--settings-focus-ring)'), fields)).toBe(true);
    expect(restylesField('.my-search input', d('background', 'var(--bg)'), fields)).toBe(true);
    expect(restylesField('.my-search input', d('border', '0'), fields)).toBe(false);
    expect(restylesField('.todo-search-input::placeholder', d('opacity', '0.6'), fields)).toBe(true);
    expect(restylesField('.apps-search', d('--input-fill', 'var(--bg)'), fields)).toBe(true);
    expect(restylesField('.apps-hero', d('--input-fill', 'var(--bg)'), fields)).toBe(false);
    expect(restylesField('.apps-search', d('width', '260px'), fields)).toBe(false);
    expect(restylesField('.row input[type="checkbox"]', d('border', '1px solid red'), fields)).toBe(false);
    expect(restylesField('.wrap :is(input, textarea)', d('border-radius', 'var(--radius-md)'), fields)).toBe(true);
    // A text area's starting height is its lines, not a look; a one-line field's height is.
    expect(restylesField('.wrap textarea', d('min-height', '96px'), fields)).toBe(false);
    expect(restylesField('.wrap textarea', d('border', '1px solid var(--border)'), fields)).toBe(true);
    expect(restylesField('.wrap input', d('min-height', '44px'), fields)).toBe(true);
    expect(restylesField('.toggle:has(input:checked)::before', d('background', 'var(--accent)'), fields)).toBe(false);
    expect(restylesField('.chat-input-textarea::selection', d('background', 'var(--accent)'), fields)).toBe(false);
    // A field's keys are its own (wn-field-key), not bare buttons.
    expect(buttonTags('<button type="button" className="wn-field-key x">c</button>').map(isBareButton)).toEqual([false]);
  });

  it('the standard it enforces exists and names this test', () => {
  const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
  expect(text).toContain('tests/web/ui-standard-ratchet.test.ts');
  expect(text).toContain(FAMILY_HOME.replace('components/', 'web/src/components/'));
    expect(text).toContain(`web/src/${LABEL_HOME}`);
  });
});
