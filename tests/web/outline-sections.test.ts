/**
 * The outline's sections (web/src/utils/outline-sections.ts): the threshold,
 * the fallback label while a section is being named, the order beside pins, and
 * the question map's `<n> sections` group (thread-map.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  mergeOutline, outlineSections, railTicks, SECTION_LABEL_CHARS, SECTION_MIN_MESSAGES, SECTIONS_GROUP_KEY, sectionFallbackLabel,
  sectionKeyOf, sectionMsgIdOf, untitledSectionIds, type PlacedOutlineEntry, type SectionRowLike,
} from '@/utils/outline-sections';
import { buildThreadTree, type ThreadTreeMessage } from '@/utils/thread-tree';
import { indexMeta } from '@/utils/thread-meta';
import { mapHasContent, mapRows, sectionsGroupText } from '@/utils/thread-map';
import type { SessionPinnedMessage, SessionThreadAnchor, SessionThreadMeta } from '@/types/session';
import { buildDenseSession } from '../e2e/browser/threads-fixture';

const turns = (n: number): SectionRowLike[] => Array.from({ length: n }, (_, i) => [
  { role: 'user' as const, msgId: `u${i}`, text: `Message number ${i} about the cache`, timestamp: `2026-11-03T10:${String(i).padStart(2, '0')}:00Z` },
  { role: 'assistant' as const, msgId: `a${i}`, text: `Reply ${i}` },
]).flat();
const allMain = () => true;

describe('outlineSections', () => {
  it('needs SECTION_MIN_MESSAGES main-conversation messages', () => {
    expect(outlineSections(turns(SECTION_MIN_MESSAGES - 1), allMain, [])).toEqual([]);
    expect(outlineSections(turns(SECTION_MIN_MESSAGES), allMain, [])).toHaveLength(SECTION_MIN_MESSAGES);
  });

  it('counts only main rows: question rows, injected and queued rows do not make a conversation long', () => {
    const rows = [
      ...turns(SECTION_MIN_MESSAGES - 1),
      { role: 'user' as const, msgId: 'q1', text: 'A question about a passage' },
      { role: 'user' as const, msgId: 'inj', text: 'skill dump', injected: true },
      { role: 'user' as const, msgId: 'qd', text: 'not taken yet', queued: true },
    ];
    expect(outlineSections(rows, (id) => id !== 'q1', [])).toEqual([]);
    expect(outlineSections(rows, allMain, [])).toHaveLength(SECTION_MIN_MESSAGES);
  });

  it('labels with the AI title, else the cleaned first line, and says which are still untitled', () => {
    const rows = turns(SECTION_MIN_MESSAGES);
    rows[0].text = '<system-reminder>Walnut (hint): reply in English</system-reminder>## Fix the login flow\nmore words';
    const s = outlineSections(rows, allMain, [{ msgId: 'u1', title: 'Cache sizing', at: 'x' }, { msgId: 'u2', title: '  ', at: 'x' }]);
    expect(s[0]).toMatchObject({ msgId: 'u0', label: 'Fix the login flow', titled: false, at: 0 });
    expect(s[1]).toMatchObject({ msgId: 'u1', label: 'Cache sizing', titled: true, at: 2 });
    expect(s[2].titled).toBe(false);
    expect(untitledSectionIds(s)).not.toContain('u1');
    expect(untitledSectionIds(s)).toContain('u2');
  });
});

describe('sectionFallbackLabel', () => {
  it('cuts a long first line at a word with an ellipsis', () => {
    const label = sectionFallbackLabel('Please refactor the session history reader so that it streams the whole file');
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(SECTION_LABEL_CHARS + 1);
    expect(label).toBe('Please refactor the session history reader so…');
  });

  it('is empty for a message with no words', () => {
    expect(sectionFallbackLabel('<system-reminder>only a hint</system-reminder>\n  ')).toBe('');
  });
});

describe('section keys', () => {
  it('round-trip, and a pin key is not a section key', () => {
    expect(sectionMsgIdOf(sectionKeyOf('abc'))).toBe('abc');
    expect(sectionMsgIdOf('pin-uuid')).toBeNull();
    expect(sectionMsgIdOf('section:')).toBeNull();
  });
});

describe('mergeOutline', () => {
  const pin = (key: string, msgId: string, at: number, isQuote = false): PlacedOutlineEntry => ({
    key, msgId, label: key, role: 'assistant', at, ...(isQuote ? { isQuote: true } : {}),
  });

  it('reads in transcript order; a section heads its own message, a whole-message pin replaces it', () => {
    const sections = outlineSections(turns(SECTION_MIN_MESSAGES), allMain, []);
    const pins = [
      pin('quote-on-u1', 'u1', 2, true), // a passage of section u1's message
      pin('reply-pin', 'a1', 3),
      { ...pin('whole-u3', 'u3', 6), role: 'user' as const },
      pin('old-unloaded', 'gone', -0.5),
    ];
    const keys = mergeOutline(pins, sections).map((e) => e.key);
    expect(keys.slice(0, 6)).toEqual([
      'old-unloaded', sectionKeyOf('u0'), sectionKeyOf('u1'), 'quote-on-u1', 'reply-pin', sectionKeyOf('u2'),
    ]);
    expect(keys).toContain('whole-u3');
    expect(keys).not.toContain(sectionKeyOf('u3'));
    expect(keys.filter((k) => k.startsWith('section:'))).toHaveLength(SECTION_MIN_MESSAGES - 1);
  });

  it('with no sections, is the pins as they were', () => {
    const pins = [pin('p1', 'a1', 3)];
    expect(mergeOutline(pins, [])).toEqual(pins);
  });
});

describe('the question map\'s sections group', () => {
  const s = buildDenseSession(Date.parse('2026-09-26T12:00:00Z'));
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors as SessionThreadAnchor[]);
  const index = indexMeta(s.threadMeta as SessionThreadMeta[]);
  const pins = s.pinnedMessages as SessionPinnedMessage[];
  const sections = [{ msgId: 'm1', label: 'Cache sizing' }, { msgId: 'm2', label: 'Retry budget' }];
  const base = { tree, index, pins, currentKey: null };

  it('is one folded `<n> sections` row closing the main conversation, opened by its key', () => {
    const closed = mapRows({ ...base, doneGroupsOpen: new Set(), sections });
    const group = closed.filter((r) => r.kind === 'section-group');
    expect(group).toHaveLength(1);
    expect(group[0]).toMatchObject({ title: sectionsGroupText(2), expanded: false, depth: 1, parentRowId: 'root' });
    expect(closed.at(-1)!.kind).toBe('section-group');
    expect(closed.some((r) => r.kind === 'section')).toBe(false);

    const open = mapRows({ ...base, doneGroupsOpen: new Set([SECTIONS_GROUP_KEY]), sections });
    const rows = open.filter((r) => r.kind === 'section');
    expect(rows.map((r) => [r.title, r.pinKey, r.depth])).toEqual([
      ['Cache sizing', sectionKeyOf('m1'), 2], ['Retry budget', sectionKeyOf('m2'), 2],
    ]);
    // Everything the map had before is still there, in the same order.
    const without = mapRows({ ...base, doneGroupsOpen: new Set() });
    expect(open.filter((r) => !r.kind.startsWith('section')).map((r) => r.id)).toEqual(without.map((r) => r.id));
  });

  it('never makes a map on its own (sections are not questions)', () => {
    const lone = buildThreadTree(messages.slice(0, 2), []);
    const rows = mapRows({ tree: lone, index: indexMeta([]), pins: [], currentKey: null, doneGroupsOpen: new Set(), sections });
    expect(rows.some((r) => r.kind === 'section-group')).toBe(true);
    expect(mapHasContent(rows)).toBe(false);
  });
});

describe('the outline rail', () => {
  it('samples a long outline\'s sections but keeps every pin', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      key: i % 50 === 7 ? `pin-${i}` : sectionKeyOf(`u${i}`), msgId: `u${i}`, label: `e${i}`, role: 'user' as const,
      ...(i % 50 === 7 ? {} : { isSection: true }),
    }));
    const ticks = railTicks(entries);
    expect(ticks.length).toBeLessThanOrEqual(60);
    expect(ticks.filter((t) => !t.isSection).map((t) => t.key)).toEqual(['pin-7', 'pin-57', 'pin-107', 'pin-157']);
    // Transcript order holds.
    expect(ticks.map((t) => Number(t.msgId.slice(1)))).toEqual([...ticks.map((t) => Number(t.msgId.slice(1)))].sort((a, b) => a - b));
    expect(railTicks(entries.slice(0, 10))).toHaveLength(10);
  });
});
