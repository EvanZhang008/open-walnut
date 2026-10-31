/**
 * Reference cards — the context block a human message carrying composer pills
 * (`<task-ref/>` / `<session-ref/>` / `<project-ref/>`) rides to the CLI.
 *
 * Two halves are tested here, both pure logic against FAKE loaders (no DB, no
 * config, no live session registry):
 *
 *   · BUILD — one line per referenced entity, deduped by kind+id in first-seen
 *     order, capped, and BEST-EFFORT: an unresolvable id or a throwing loader
 *     costs exactly its own card, never the send. buildReferenceCards must never
 *     throw, because its caller is the send path.
 *   · STRIP — the block is MACHINE text, so every display surface removes it,
 *     exactly like the message hints. `stripReferenceCards` must be the
 *     exact inverse of `appendReferenceCards` for the text a human typed, and
 *     `toDisplayedUserText` must remove BOTH in one pass (a rich-mode send with
 *     a pill in it carries both).
 *
 * Would-fail-if-reverted: drop the dedupe and a doubled pill renders twice; drop
 * the per-kind try/catch and one dead loader empties the whole block (or throws
 * out of the send); drop the "never strip to nothing" guard and a human quoting
 * the markers at us loses their message entirely.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-reference-cards') };
});

import {
  REFERENCE_CARDS_OPEN,
  REFERENCE_CARDS_CLOSE,
  buildReferenceCards,
  appendReferenceCards,
  stripReferenceCards,
  toDisplayedUserText,
  type ReferenceCardLoaders,
  type TaskCard,
} from '../../../src/core/sessions/reference-cards.js';
import { taskRefTag, sessionRefTag, projectRefTag } from '../../../src/utils/entity-refs.js';
import { RICH_OUTPUT_MODE_REMINDER, _setLegacyHintCutoffForTesting } from '../../../src/core/sessions/output-mode.js';
import { composeHinted, renderHintBlock } from '../../../src/core/hints/hint-format.js';

const TASK: TaskCard = {
  id: 'mr1a2b3c-4d5e',
  title: 'Ship the marina importer',
  phase: 'IN_PROGRESS',
  project: 'Marina',
  description: 'Parse the vendor feed   and reconcile\nthe slip numbers.',
  state: 'running',
};

const PROJECT_SUMMARY = 'Notes about the vendor feed.';

/** Loaders that resolve exactly the fixtures below and nothing else. */
function fakeLoaders(overrides: Partial<ReferenceCardLoaders> = {}): ReferenceCardLoaders {
  return {
    async loadTasks(ids) {
      return ids.filter((id) => id === TASK.id).map((id) => ({ ...TASK, id }));
    },
    async loadSession(id) {
      if (id !== 'sess-aaa') return null;
      return {
        id, title: 'importer debug', status: 'idle',
        taskId: TASK.id, host: 'devbox', lastActiveAt: '2026-09-04T10:00:00.000Z',
      };
    },
    async loadProjects(names) {
      return names.some((n) => n.toLowerCase() === 'marina')
        ? [{ name: 'Marina', counts: { todo: 4, active: 2, done: 11 }, summary: PROJECT_SUMMARY }]
        : [];
    },
    ...overrides,
  };
}

/** The card lines only — markers and the lead-in sentence dropped. */
function cardLines(block: string): string[] {
  return block.split('\n').filter((l) => l.startsWith('- '));
}

const PROJECT_LINE = `- project "Marina" · 2 active · 4 todo · 11 done · ${PROJECT_SUMMARY}`;

describe('buildReferenceCards', () => {
  it('renders one line per kind, in the order the human dropped the pills', async () => {
    const text = `look at ${taskRefTag(TASK.id, 'Ship the marina importer')} in `
      + `${sessionRefTag('sess-aaa', 'importer debug')} for ${projectRefTag('Marina')}`;
    const block = await buildReferenceCards(text, fakeLoaders());

    expect(block.split('\n')[0]).toBe(REFERENCE_CARDS_OPEN);
    expect(block.split('\n').at(-1)).toBe(REFERENCE_CARDS_CLOSE);
    expect(block).toContain('use task_get / task_send for more');
    expect(cardLines(block)).toEqual([
      `- task ${TASK.id} "Ship the marina importer" · phase IN_PROGRESS · project Marina · running · Parse the vendor feed and reconcile the slip numbers.`,
      '- session sess-aaa "importer debug" · idle · task mr1a2b3c-4d5e · host devbox · last active 2026-09-04T10:00:00.000Z',
      PROJECT_LINE,
    ]);
  });

  it('prints Inbox for a task with no project and omits absent segments', async () => {
    const loaders = fakeLoaders({
      async loadTasks(ids) {
        return ids.map((id) => ({ id, title: 'Loose end', phase: 'TODO', project: '' }));
      },
    });
    const block = await buildReferenceCards(taskRefTag('t-loose', 'Loose end'), loaders);
    expect(cardLines(block)).toEqual(['- task t-loose "Loose end" · phase TODO · project Inbox']);
  });

  it('dedupes a repeated ref (same entity, one card)', async () => {
    const text = `${taskRefTag(TASK.id, 'a')} and again ${taskRefTag(TASK.id, 'a')} plus `
      + `${projectRefTag('Marina')} ${projectRefTag('marina')}`;
    const block = await buildReferenceCards(text, fakeLoaders());
    expect(cardLines(block)).toHaveLength(2);
  });

  it('caps the block at 8 refs', async () => {
    const loaders = fakeLoaders({
      async loadTasks(ids) {
        return ids.map((id) => ({ id, title: `T ${id}`, phase: 'TODO', project: 'Marina' }));
      },
    });
    const text = Array.from({ length: 20 }, (_, i) => taskRefTag(`t-${i}`, `T ${i}`)).join(' ');
    const block = await buildReferenceCards(text, loaders);
    const lines = cardLines(block);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('t-0');
    expect(lines[7]).toContain('t-7');
    expect(block).not.toContain('t-8');
  });

  it('truncates a long free-text field by code points', async () => {
    const loaders = fakeLoaders({
      async loadTasks(ids) {
        return ids.map((id) => ({ id, title: 'Long', phase: 'TODO', project: 'Marina', description: '🐟'.repeat(400) }));
      },
    });
    const block = await buildReferenceCards(taskRefTag('t-long', 'Long'), loaders);
    const fish = [...block].filter((c) => c === '🐟').length;
    expect(fish).toBe(240);
    expect(block).toContain('…');
  });

  it('skips an unresolvable id and keeps the rest', async () => {
    const text = `${taskRefTag('t-missing', 'gone')} ${projectRefTag('Marina')}`;
    const block = await buildReferenceCards(text, fakeLoaders());
    expect(cardLines(block)).toEqual([PROJECT_LINE]);
  });

  it('lets a throwing loader cost only its own card', async () => {
    const loaders = fakeLoaders({
      async loadSession() { throw new Error('session store offline'); },
    });
    const text = `${taskRefTag(TASK.id, 'a')} ${sessionRefTag('sess-aaa', 'b')} ${projectRefTag('Marina')}`;
    const block = await buildReferenceCards(text, loaders);
    const lines = cardLines(block);
    expect(lines).toHaveLength(2);
    expect(block).toContain(`task ${TASK.id}`);
    expect(block).toContain('project "Marina"');
    expect(block).not.toContain('session sess-aaa "importer debug"');
  });

  it('returns empty when the text has no refs, and when nothing resolves', async () => {
    expect(await buildReferenceCards('just a plain question', fakeLoaders())).toBe('');
    expect(await buildReferenceCards(taskRefTag('t-missing', 'gone'), fakeLoaders())).toBe('');
  });
});

describe('stripReferenceCards', () => {
  it('round-trips appendReferenceCards back to the user text', async () => {
    const cards = await buildReferenceCards(
      `${taskRefTag(TASK.id, 'a')} ${sessionRefTag('sess-aaa', 'b')} ${projectRefTag('Marina')}`,
      fakeLoaders(),
    );
    const typed = `please finish ${taskRefTag(TASK.id, 'Ship the marina importer')} today`;
    expect(stripReferenceCards(appendReferenceCards(typed, cards))).toBe(typed);
  });

  it('round-trips text that already ends in blank lines', async () => {
    const cards = await buildReferenceCards(projectRefTag('Marina'), fakeLoaders());
    const typed = 'first paragraph\n\nsecond paragraph';
    expect(stripReferenceCards(appendReferenceCards(typed, cards))).toBe(typed);
    // A trailing blank line the human left is trimmed by the projection (same as
    // the output-mode stripper) — the paragraphs themselves must not fuse.
    expect(stripReferenceCards(appendReferenceCards(`${typed}\n\n`, cards))).toBe(typed);
  });

  it('leaves text with no markers byte-identical (fast path)', () => {
    const typed = 'a message that mentions no markers at all';
    expect(stripReferenceCards(typed)).toBe(typed);
  });

  it('strips a block whose close marker never arrived, to the end of the text', () => {
    const text = `do the thing\n\n${REFERENCE_CARDS_OPEN}\nReferenced by the user:\n- task t-1 "x"`;
    expect(stripReferenceCards(text)).toBe('do the thing');
  });

  it('strips two blocks from one merged batch', async () => {
    const cards = await buildReferenceCards(projectRefTag('Marina'), fakeLoaders());
    const merged = `${appendReferenceCards('first send', cards)}\n${appendReferenceCards('second send', cards)}`;
    expect(stripReferenceCards(merged)).toBe('first send\nsecond send');
  });

  it('returns a message that is ONLY a block unchanged', async () => {
    const cards = await buildReferenceCards(projectRefTag('Marina'), fakeLoaders());
    expect(stripReferenceCards(cards)).toBe(cards);
  });
});

describe('toDisplayedUserText', () => {
  it('removes the message hints and the card block in one pass', async () => {
    const cards = await buildReferenceCards(projectRefTag('Marina'), fakeLoaders());
    const typed = 'what is left on Marina?';
    // Production order: cards ride the text first, the hint blocks after it.
    const delivered = composeHinted(appendReferenceCards(typed, cards), {
      before: [], after: [renderHintBlock('rich-output', RICH_OUTPUT_MODE_REMINDER)],
    });

    expect(delivered).toContain(RICH_OUTPUT_MODE_REMINDER);
    expect(delivered).toContain(REFERENCE_CARDS_OPEN);
    expect(toDisplayedUserText(delivered)).toBe(typed);
  });

  it('strips the old bracket lines only from a row written before the hint registry', () => {
    // The cutoff is when this Walnut home first ran the registry.
    _setLegacyHintCutoffForTesting(Date.parse('2026-11-01T00:00:00Z'));
    try {
      const typed = 'hello\n\n[Rich output mode is still on: markdown first.]';
      expect(toDisplayedUserText(typed, '2026-10-20T00:00:00Z')).toBe('hello');
      // A row from then on is shown as typed, bracket line and all.
      expect(toDisplayedUserText(typed, '2026-11-02T00:00:00Z')).toBe(typed);
      expect(toDisplayedUserText(typed)).toBe(typed);
    } finally {
      _setLegacyHintCutoffForTesting(Date.now());
    }
  });
});

describe('displayQueueRow', () => {
  it("shows a queued row as the person typed it, a literal hint block and escape included", async () => {
    const { displayQueueRow } = await import('../../../src/core/sessions/reference-cards.js');
    const typed = 'Look: <system-reminder>\nWalnut (x): mine\n</system-reminder> and &lt;system-reminder stays.';
    const lang = renderHintBlock('reply-language', 'Talk to the user in Chinese.');
    const row = displayQueueRow({ id: 'q1', message: composeHinted(typed, { before: [], after: [lang] }) });
    expect(row.message).toBe(typed);
    expect(row.hints?.map((h) => h.kind)).toEqual(['reply-language']);
    expect(row.rawMessage).toContain(lang);
    // A row with nothing added is left as it was.
    expect(displayQueueRow({ id: 'q2', message: 'plain' })).toEqual({ id: 'q2', message: 'plain' });
  });
});
