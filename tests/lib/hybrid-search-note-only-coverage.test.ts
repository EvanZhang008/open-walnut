/**
 * `noteOnlyCoverage`: a query term a doc holds ONLY in its note counts a share toward coverage,
 * for the kinds that ask for it (Walnut: tasks, 0.5). 2026-10-28: "the Walnut tunnel and server
 * replica redesign tasks" missed the two tasks whose SUMMARIES named tunnels and replica servers,
 * under tasks whose 27-33KB notes held every word somewhere. Coverage is what the merge ranks by
 * first (src/core/search.ts), so a long note that happens to hold the words beat the task that is
 * about them.
 *
 * Ranking on real data lives in the golden eval (scripts/search-eval.mjs); this pins the
 * component's contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type KindConfig, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

const FILLER = 'The crate rides the pallet and the dock crew stacks it before the round. ';

function seeded(kinds: Record<string, KindConfig>): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds });
  opened.push(index);
  // A representative corpus, so the query terms pass the df gate (see hybrid-search-body-coverage).
  for (let i = 0; i < 14; i++) {
    index.upsert({ kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`, note: `${FILLER}${i}`, updatedAt: Date.parse('2026-01-01') });
  }
  for (let i = 0; i < 6; i++) {
    index.upsert({ kind: 'task', ref: `log-${i}`, title: `shift handover ${i}`, note: FILLER.repeat(60) + i, updatedAt: Date.parse('2026-01-02') });
  }
  // About the query: its summary says so. Its name no longer does (the title kept the first goal).
  index.upsert({
    kind: 'task', ref: 'about', title: 'API inventory for daemon takeover',
    summary: 'Keeps the app usable while its main computer sleeps: tunnels, replica servers and failover.',
    note: FILLER.repeat(20), updatedAt: Date.parse('2026-10-26'),
  });
  // Mentions every word somewhere in a long note, about something else.
  index.upsert({
    kind: 'task', ref: 'mentions', title: 'Archive and auto title',
    summary: 'Archives finished chats and names them.',
    note: `${FILLER.repeat(30)}The tunnel was slow that day. ${FILLER.repeat(30)}A replica of the old server sat idle. ${FILLER.repeat(30)}A redesign of the menu came later.`,
    updatedAt: Date.parse('2026-10-26'),
  });
  // The same long note on a session: its transcript IS its content.
  index.upsert({
    kind: 'session', ref: 'transcript', title: 'Chat about menus',
    note: `${FILLER.repeat(30)}The tunnel was slow that day. ${FILLER.repeat(30)}A replica of the old server sat idle. ${FILLER.repeat(30)}A redesign of the menu came later.`,
    updatedAt: Date.parse('2026-10-26'),
  });
  return index;
}

const QUERY = 'tunnel server replica redesign';
const coverage = (index: SearchIndex, ref: string) => {
  const hit = index.search(QUERY, { limit: 30 }).find((h) => h.ref === ref);
  if (!hit) throw new Error(`${ref} not found`);
  return hit.components.coverage;
};

describe('noteOnlyCoverage', () => {
  it('off by default: a term counts wherever it is', () => {
    const index = seeded({ task: { weight: 1 }, session: { weight: 1 } });
    expect(coverage(index, 'mentions')).toBeCloseTo(1, 5);
    expect(coverage(index, 'mentions')).toBeGreaterThan(coverage(index, 'about'));
  });

  it('a task that holds the words only in its note gets the share; one whose summary says them keeps full credit', () => {
    const off = seeded({ task: { weight: 1 }, session: { weight: 1 } });
    const on = seeded({ task: { weight: 1, noteOnlyCoverage: 0.5 }, session: { weight: 1 } });
    expect(coverage(on, 'mentions')).toBeCloseTo(coverage(off, 'mentions') * 0.5, 5);
    expect(coverage(on, 'about')).toBeCloseTo(coverage(off, 'about'), 5);
    expect(coverage(on, 'about')).toBeGreaterThan(coverage(on, 'mentions'));
    // Another kind keeps full credit for its body.
    expect(coverage(on, 'transcript')).toBeCloseTo(coverage(off, 'transcript'), 5);
  });

  it('the merge\'s coverage tier (search.ts: round(coverage x 4)) no longer puts the mention above the described task', () => {
    const tier = (index: SearchIndex, ref: string) => Math.round(coverage(index, ref) * 4);
    const off = seeded({ task: { weight: 1 }, session: { weight: 1 } });
    expect(tier(off, 'mentions')).toBeGreaterThan(tier(off, 'about'));
    const on = seeded({ task: { weight: 1, noteOnlyCoverage: 0.5 }, session: { weight: 1 } });
    // The mention drops out of the tier above; the score decides between the two from there.
    expect(tier(on, 'mentions')).toBeLessThanOrEqual(tier(on, 'about'));
    expect(tier(on, 'about')).toBe(tier(off, 'about'));
  });

  it('a term in the title counts in full too', () => {
    const on = seeded({ task: { weight: 1, noteOnlyCoverage: 0.5 }, session: { weight: 1 } });
    on.upsert({ kind: 'task', ref: 'titled', title: 'Tunnel server replica redesign', note: FILLER.repeat(5), updatedAt: Date.parse('2026-10-27') });
    expect(coverage(on, 'titled')).toBeCloseTo(1, 5);
  });

  it('CJK terms and split compounds use the same focus test', () => {
    const on = seeded({ task: { weight: 1, noteOnlyCoverage: 0.5 }, session: { weight: 1 } });
    on.upsert({ kind: 'task', ref: 'cjk-sum', title: 'Plain name', summary: '\u81ea\u52a8\u91cd\u8bd5 for the queue', note: FILLER, updatedAt: Date.parse('2026-10-27') });
    on.upsert({ kind: 'task', ref: 'cjk-note', title: 'Other name', summary: 'Nothing here.', note: `${FILLER}\u81ea\u52a8\u91cd\u8bd5 for the queue`, updatedAt: Date.parse('2026-10-27') });
    const cov = (q: string, ref: string) => on.search(q, { limit: 40 }).find((h) => h.ref === ref)?.components.coverage ?? -1;
    expect(cov('\u81ea\u52a8\u91cd\u8bd5', 'cjk-sum')).toBeCloseTo(1, 5);
    expect(cov('\u81ea\u52a8\u91cd\u8bd5', 'cjk-note')).toBeCloseTo(0.5, 5);
    on.upsert({ kind: 'task', ref: 'split-sum', title: 'Plain name', summary: 'The Dock Hub sync broke.', note: FILLER, updatedAt: Date.parse('2026-10-27') });
    on.upsert({ kind: 'task', ref: 'split-note', title: 'Other name', summary: 'Nothing here.', note: `${FILLER}The Dock Hub sync broke.`, updatedAt: Date.parse('2026-10-27') });
    expect(cov('dockhub', 'split-sum')).toBeCloseTo(1, 5);
    expect(cov('dockhub', 'split-note')).toBeCloseTo(0.5, 5);
  });
});
