/**
 * The UI standard's word rules (.claude/skills/walnut-ui-requirements/standard.md, "Words").
 *
 * 2026-11-21, the UI audit on the user's data: the composer showed "btw" with no word on what it
 * does, the same drawer was "Side thread" in the + menu and "Side threads" in its own header beside
 * the user's Threads, and Settings named the tool "org_send". Three ways bad words get in, counted
 * per file by ui-words-scan.ts:
 *   - rawId: a tool, field or model id in UI text (snake_case, `opus-5-5`, `__local__`).
 *   - iconOnly: a <button> with no words, no aria-label and no title.
 *   - secondName: a second name for a concept of the word list ("side thread" for side chat).
 *   - longHelp: a setting's help line over HELP_MAX characters (2026-11-21, the user on the Org
 *     settings panel, a page of explanations: "the setting is shit", "no taste").
 * The counts that exist today are in ui-words-baseline.json and may only go down. A new file or a
 * higher count fails: name the thing in plain words. A lower count fails too until the baseline is
 * lowered with `UI_WORDS_RECORD=1` on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanAll, scanFile, hasRawId, secondNameOf, NOT_SHOWN, WEB_SRC, HELP_MAX, type WordCounts, type WordHit } from './ui-words-scan';
import { EXPERIMENTAL_FEATURES, experimentSummary } from '../../src/core/experimental';

const BASELINE = path.join(__dirname, 'ui-words-baseline.json');
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';
const KINDS = ['rawId', 'iconOnly', 'secondName', 'longHelp'] as const;

describe('UI standard: plain words', () => {
  const { counts: now, hits } = scanAll();
  if (process.env.UI_WORDS_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as WordCounts;
  const where = (kind: WordHit['kind'], file: string) =>
    (hits[file] ?? []).filter((h) => h.kind === kind).map((h) => `    web/src/${file}:${h.line}  ${h.text.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n');

  for (const kind of KINDS) {
    it(`${kind}: no new member`, () => {
      const grew = Object.entries(now[kind]).filter(([f, n]) => n > (was[kind][f] ?? 0))
        .map(([f, n]) => `${kind}: web/src/${f} has ${n} (was ${was[kind][f] ?? 0})\n${where(kind, f)}`);
      expect(grew, `Words a person cannot read, see "Words" in ${STANDARD}:\n${grew.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const fell = Object.entries(was[kind]).filter(([f, n]) => (now[kind][f] ?? 0) < n)
        .map(([f, n]) => `${kind}: web/src/${f} has ${now[kind][f] ?? 0} (baseline ${n})`);
      expect(fell, `Fewer than recorded: good. Lower the baseline with\nUI_WORDS_RECORD=1 bun --bun vitest run tests/web/ui-words-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  it('finds each shape of a bad word', () => {
    expect(hasRawId('Agents cannot reach them with org_send')).toBe(true);
    expect(hasRawId('Model opus-5-5 1M')).toBe(true);
    expect(hasRawId('Runs on __local__')).toBe(true);
    expect(hasRawId('Opus 5.5 with a 1M context')).toBe(false);
    expect(secondNameOf('Open side threads')).toBe('side chat');
    // "btw" is the side chat button's own name (the user, 2026-11-23), not a second name.
    expect(secondNameOf('btw')).toBeNull();
    expect(secondNameOf('Builtin (read-only)')).toBe('Built-in');
    expect(secondNameOf('Built-in apps')).toBeNull();
    const kinds = (src: string) => scanFile('x.tsx', src).map((h) => h.kind);
    expect(kinds('const a = <button onClick={f}><svg /></button>;')).toEqual(['iconOnly']);
    expect(kinds('const a = <button onClick={f}><CloseIcon /></button>;')).toEqual(['iconOnly']);
    expect(kinds('const X = <svg />; const a = <button onClick={f}>{X}</button>;')).toEqual(['iconOnly']);
    expect(kinds('const a = <button title="Close" onClick={f}><svg /></button>;')).toEqual([]);
    expect(kinds('const a = <button aria-label="Close"><svg /></button>;')).toEqual([]);
    expect(kinds('const T = "Not right?"; const a = <button>{T}</button>;')).toEqual([]);
    expect(kinds('const words = (<><b>Waiting</b> <i>3</i></>); const a = <button>{words}</button>;')).toEqual([]);
    expect(kinds('const a = <button><svg /><span>Back</span></button>;')).toEqual([]);
    expect(kinds('const a = <button>{label}</button>;')).toEqual([]);
    expect(kinds('const a = <span title="Stops org_send">x</span>;')).toEqual(['rawId']);
    expect(kinds("const o = [{ value: 'chips', label: 'Side thread' }];")).toEqual(['secondName']);
    expect(kinds("const lines = ['Agents cannot reach them with org_send'];")).toEqual(['rawId']);
    expect(kinds("const controls = [{ id: 'btw', name: 'Side thread' }];")).toEqual(['secondName']);
    expect(kinds("setError(sid, 'No side threads to restore here');")).toEqual(['secondName']);
    expect(kinds("const a = <p>{'Use org_send now'}</p>;")).toEqual(['rawId']);
    expect(kinds('const a = <p>Run <code>walnut tools call task_send</code></p>;')).toEqual([]);
    expect(kinds("log.info('ui', 'sent with task_send now');")).toEqual([]);
    expect(kinds(`const a = <Row label="Org" help="${'x'.repeat(121)}" />;`)).toEqual(['longHelp']);
    expect(kinds(`const a = <Row label="Org" help="${'x'.repeat(120)}" />;`)).toEqual([]);
  });

  // The Experimental page draws each registry entry's line (experimentSummary): a literal the
  // source scan never sees (2026-11-22 audit: forty three-line paragraphs).
  it('every experiment shows a help line of at most HELP_MAX characters', () => {
    const long = EXPERIMENTAL_FEATURES
      .filter((f) => experimentSummary(f).length > HELP_MAX)
      .map((f) => `${f.id}: ${experimentSummary(f).length} chars (give it a summary)`);
    expect(long).toEqual([]);
  });

  it('every file it leaves out exists, and the standard names this test', () => {
    for (const file of Object.keys(NOT_SHOWN)) expect(fs.existsSync(path.join(WEB_SRC, file)), file).toBe(true);
    const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
    expect(text).toContain('tests/web/ui-words-ratchet.test.ts');
    expect(text).toContain('## Words');
  });
});
