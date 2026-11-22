/**
 * One empty, loading and unavailable state everywhere (standard.md, "Empty, loading and
 * unavailable states"): web/src/components/common/EmptyState.tsx.
 *
 * 2026-11-21 UI audit: 124 hand-made empty classes in 11 to 15 px, centred or left, and about 400
 * bare "No ..." / "Loading..." lines; a chat with no history showed one grey "No conversation history
 * found" in a huge white pane that did not say whether it was new, lost or still loading.
 *
 * Counted per file (empty-state-scan.ts): ownEmptyClass (a CSS state class with a look of its own)
 * and bareEmptyText (a state's words written as bare TSX text, or a word-less LoadingSpinner).
 * The counts in empty-state-baseline.json may only go down. A new file or a higher count fails: use
 * <EmptyState>, <LoadingState> or <UnavailableState>. A lower count fails too until the baseline is
 * lowered with `EMPTY_STATE_RECORD=1` on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countEmpty, bareEmptyLines, isOwnEmptyClass, WEB_SRC, HOME_CSS, type EmptyCounts } from './empty-state-scan';
import { walk } from './css-scan';

const BASELINE = path.join(__dirname, 'empty-state-baseline.json');
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';

function compare(kind: keyof EmptyCounts, now: Record<string, number>, was: Record<string, number>) {
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

describe('one empty, loading and unavailable state everywhere', () => {
  const now = countEmpty();
  if (process.env.EMPTY_STATE_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as EmptyCounts;

  for (const kind of ['ownEmptyClass', 'bareEmptyText'] as const) {
    it(`${kind}: no new hand-made state`, () => {
      const { grew } = compare(kind, now[kind], was[kind]);
      expect(grew, `A state drawn by hand. Use <EmptyState>, <LoadingState> or <UnavailableState> (${STANDARD}):\n${grew.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const { fell } = compare(kind, now[kind], was[kind]);
      expect(fell, `Fewer hand-made states than recorded: good. Lower the baseline with\nEMPTY_STATE_RECORD=1 bun --bun vitest run tests/web/empty-state-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  it('finds each shape of a hand-made state', () => {
    expect(isOwnEmptyClass('.todo-empty-board')).toBe(true);
    expect(isOwnEmptyClass('.mail-app .mail-reader-empty-title')).toBe(true);
    expect(isOwnEmptyClass('.session-history-loading-line')).toBe(true);
    expect(isOwnEmptyClass('.chat-input.is-empty')).toBe(false);
    expect(isOwnEmptyClass('.row:empty')).toBe(false);
    expect(isOwnEmptyClass('.card-title')).toBe(false);
    const src = [
      '<p className="x">No tasks yet</p>',
      "{n === 0 ? 'Nothing here' : null}",
      '<div>Loading…</div>',
      '<LoadingSpinner />',
      '<EmptyState title="No tasks yet" />',
      "<LoadingState title={busy ? 'Loading models…' : 'Loading…'} />",
      '<option>No limit</option> {/* empty-state-ok: option label */}',
      '// No comment lines',
      "<span>{'No tasks'}</span>",
      '            No tasks match this filter',
      '<SettingsRow label="No secret yet" />',
      "action={{ label: 'Clear search', onClick }}",
      '<UnavailableState title="Couldn\'t load" hint={error} />',
      '<UnavailableState title="Couldn\'t load" detail={error} />',
    ].join('\n');
    expect(bareEmptyLines(src)).toEqual([1, 2, 3, 4, 9, 10, 11, 13]);
  });

  // 2026-11-22 review: the failure's triangle was orange on Home and grey in every chat, because
  // the chat pane tones its own --warning down. The state reads the root's warning colour.
  it('a failure draws the same warning colour on every surface', () => {
    const css = fs.readFileSync(path.join(WEB_SRC, HOME_CSS), 'utf8');
    expect(css).toMatch(/:root\s*\{\s*--empty-state-warning:\s*var\(--warning\);\s*\}/);
    expect(css).toMatch(/\[data-kind='unavailable'\] \.empty-state-icon\s*\{\s*color:\s*var\(--empty-state-warning\);/);
    const others = walk(WEB_SRC, ['.css']).filter((f) => path.relative(WEB_SRC, f) !== HOME_CSS && /--empty-state-warning\s*:/.test(fs.readFileSync(f, 'utf8')));
    expect(others.map((f) => path.relative(WEB_SRC, f))).toEqual([]);
  });

  it('the standard names the component and this test', () => {
    const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
    expect(text).toContain('web/src/components/common/EmptyState.tsx');
    expect(text).toContain('tests/web/empty-state-ratchet.test.ts');
  });
});
