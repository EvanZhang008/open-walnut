/**
 * A question's option row says "Recommended" once, at its right end, everywhere: an agent's
 * AskUserQuestion writes the mark into the label ("Oak (Recommended)"), and the web question card
 * showed it inside the words while the phone (WalnutOptionLabel.shown) and the Threads card showed
 * the mark at the right (2026-11-26: one kind of option row drawn two ways on web and phone).
 *
 * Every file that renders a question's options (it handles AskUserQuestion data, an ask form's
 * options or an AskOptions list) must show each option's label through OptionLabel or
 * shownOptionLabel (web/src/components/common/option-label.ts), never as `{opt.label}`. A new
 * renderer that shows the raw label fails here.
 *
 * The main action and the recommended option always stand out in the main colour, never one look
 * for every key (the user's rule, 2026-11-26, from the team's guidance): a recommended question row
 * is filled (data-recommended). A renderer that draws it like the others fails here. A prompt's
 * main action (strongChoiceId) has its own guard in tests/web/ios-ui-standard-ratchet.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shownOptionLabel } from '../../web/src/components/common/option-label';

const ROOT = path.join(__dirname, '../..');
const WEB_SRC = path.join(ROOT, 'web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files that hold a question's options: AskUserQuestion data, an ask form, or the shared choice buttons. */
const QUESTION_DATA = /\b(AskQuestion|AskQuestionOption|AskOption|parseAskUserQuestionInput|formOptions|AskOptions)\b/;

/** Each name a file maps a list of options with (`options.map((opt` → opt). */
function optionNames(src: string): string[] {
  return [...new Set([...src.matchAll(/options\.map\(\(?\s*(\w+)/g)].map((m) => m[1]!))];
}

/** Places a file shows one of its mapped options' label raw, as JSX text. */
export function rawLabels(src: string): string[] {
  const hits: string[] = [];
  for (const n of optionNames(src)) {
    const raw = new RegExp(`(>\\s*\\{${n}\\.label\\})|(\\{${n}\\.label\\}\\s*<)|(>\\s*:\\s*${n}\\.label\\s*\\})|(\\?\\s*${n}\\.label\\s*:)`, 'g');
    for (const m of src.matchAll(raw)) hits.push(m[0].replace(/\s+/g, ' '));
  }
  return hits;
}

const renderers = () => walk(WEB_SRC).filter((f) => QUESTION_DATA.test(fs.readFileSync(f, 'utf8')));

describe('a question option row says Recommended once, at its right end', () => {
  it('reads a trailing "(Recommended)" as the mark, as the phone does', () => {
    expect(shownOptionLabel('Oak (Recommended)')).toEqual({ text: 'Oak', recommended: true });
    expect(shownOptionLabel('Raised bed (recommended)  ')).toEqual({ text: 'Raised bed', recommended: true });
    expect(shownOptionLabel('Oak')).toEqual({ text: 'Oak', recommended: false });
    // Only a trailing mark counts, and a label that is only the mark keeps its words.
    expect(shownOptionLabel('(Recommended) Oak')).toEqual({ text: '(Recommended) Oak', recommended: false });
    expect(shownOptionLabel('(Recommended)')).toEqual({ text: '(Recommended)', recommended: false });
  });

  it('finds the known renderers, so the scan cannot pass empty', () => {
    const rel = renderers().map((f) => path.relative(ROOT, f));
    for (const known of [
      'web/src/components/sessions/PromptCards.tsx',
      'web/src/components/common/PermissionAnswerForm.tsx',
      'web/src/components/org/OrgInlineAnswer.tsx',
    ]) expect(rel).toContain(known);
  });

  it('every renderer shows an option label through OptionLabel or shownOptionLabel', () => {
    const offenders = renderers().flatMap((f) => rawLabels(fs.readFileSync(f, 'utf8')).map((h) => `${path.relative(ROOT, f)}: ${h}`));
    expect(offenders, 'show the label with <OptionLabel label={...} /> (components/common/OptionLabel.tsx)').toEqual([]);
  });

  it('the scan catches the raw label the question card used to show', () => {
    expect(rawLabels('{q.options.map((opt) => (<button>{phone ? <span>{opt.label}</span> : opt.label}</button>))}')).toHaveLength(2);
    expect(rawLabels('{options.map((o) => <button key={o.value}>{o.label}</button>)}')).toHaveLength(1);
    expect(rawLabels('{options.map((o) => <OptionLabel label={o.label} />)}')).toEqual([])
    // Building another list's data from the label is not showing it.
    expect(rawLabels('options={options.map((o) => ({ value: o.id, label: o.label }))}')).toEqual([]);
  });

  it("the Board's choice frame strips the mark the same way", () => {
    const frame = fs.readFileSync(path.join(WEB_SRC, 'components/board/board-items.frame.js'), 'utf8');
    expect(frame).toMatch(/\\\(recommended\\\)\\s\*\$\/i/);
  });

  it('every question option row marks its recommended choice for the fill', () => {
    const rows = renderers().filter((f) => /className=\{`(qp-option|nfc-answer-opt)\b/.test(fs.readFileSync(f, 'utf8')))
    expect(rows.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      'web/src/components/common/PermissionAnswerForm.tsx',
      'web/src/components/sessions/PromptCards.tsx',
    ])
    for (const f of rows) expect(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)).toMatch(/shownOptionLabel\(opt\.label\)\.recommended \? \{ 'data-recommended': 'true' \}/)
    const css = fs.readFileSync(path.join(WEB_SRC, 'components/common/option-label.css'), 'utf8')
    const fill = /:is\(\.qp-option, \.nfc-answer-opt\)\[data-recommended\] \{([^}]*)\}/.exec(css)
    expect(fill?.[1]).toMatch(/background: color-mix\(in srgb, var\(--accent\)/)
    expect(fill?.[1]).toMatch(/color: var\(--on-accent\)/)
  })
});
