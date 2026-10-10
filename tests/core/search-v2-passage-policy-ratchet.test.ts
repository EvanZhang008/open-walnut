/**
 * Ratchet: what a kind's docs are split into changes only with a
 * PASSAGE_POLICY_VERSION bump (src/lib/hybrid-search/chunk.ts).
 *
 * A stored vector at seq i is the embedding of passage i under the policy it
 * was written with. db.ts drops every vector when the version moves; without a
 * bump the old vectors stay, and since the vector reuse (vector-reuse.ts) maps
 * them by the text the CURRENT rules give the old doc, a rule change carries
 * vectors onto passages they do not describe, change after change (the r1 gate
 * reused 32 vectors, 29 of 40 of them wrong, in its policy probe). Before the
 * reuse, one content change cleared them.
 *
 * So this pins a fingerprint of the passages of a fixed set of generated docs
 * (tests/lib/passage-fingerprint.ts) for every kind the server indexes, under
 * the policy it gets (SEARCH_V2_KIND_WEIGHTS), per version. A refactor that
 * keeps every passage byte-identical keeps every fingerprint.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSAGE_POLICY, passagesForDoc, PASSAGE_POLICY_VERSION,
} from '../../src/lib/hybrid-search/index.js';
import { estimateTokens, PASSAGE_TOKEN_BUDGET, splitToBudget } from '../../src/lib/hybrid-search/chunk.js';
import { SEARCH_V2_KIND_WEIGHTS } from '../../src/core/search/wiring.js';
import { passageFingerprint } from '../lib/passage-fingerprint.js';

const SPREAD = '2ac371857027d252a8a695881f013dfa7d22e83a84d1b0f57c5a036fdd3c9420';
const TAIL = 'a5021d71628c747e1e7ad5a5dc51b646e12e45e2935796dc53674585b5fa0f34';

/** Per version, per kind (plus the library default). Never edit a recorded
 *  version: a change to the splitting rules or to a kind's policy bumps
 *  PASSAGE_POLICY_VERSION and records the new fingerprints under it. A new kind
 *  has no stored vectors yet, so it is recorded under the current version. */
const RECORDED: Record<number, Record<string, string>> = {
  2: { default: SPREAD, task: SPREAD, memory: SPREAD, session: TAIL, note: SPREAD, skill: SPREAD },
};

const HOW = 'the passages changed: bump PASSAGE_POLICY_VERSION in src/lib/hybrid-search/chunk.ts '
  + 'and record the new fingerprints under the new version (db.ts then drops the old vectors)';

describe('passage policy ratchet', () => {
  it('records the current version, and only the newest one is current', () => {
    expect(RECORDED[PASSAGE_POLICY_VERSION], `no fingerprints for version ${PASSAGE_POLICY_VERSION}`).toBeDefined();
    expect(Math.max(...Object.keys(RECORDED).map(Number))).toBe(PASSAGE_POLICY_VERSION);
  });

  it('the library default policy splits as recorded', () => {
    expect(passageFingerprint(passagesForDoc, DEFAULT_PASSAGE_POLICY), HOW)
      .toBe(RECORDED[PASSAGE_POLICY_VERSION]?.default);
  });

  it.each(Object.entries(SEARCH_V2_KIND_WEIGHTS))('kind %s splits as recorded', (kind, config) => {
    const policy = { ...DEFAULT_PASSAGE_POLICY, ...('passages' in config ? config.passages : {}) };
    const recorded = RECORDED[PASSAGE_POLICY_VERSION]?.[kind];
    expect(recorded, `kind ${kind} has no fingerprint: record it under version ${PASSAGE_POLICY_VERSION}`).toBeDefined();
    expect(passageFingerprint(passagesForDoc, policy), `kind ${kind}: ${HOW}`).toBe(recorded);
  });

  it('the fingerprint sees a passage that changed by one character, and a smaller cap', () => {
    const shifted = (doc: Parameters<typeof passagesForDoc>[0], policy?: Parameters<typeof passagesForDoc>[1]) => {
      const set = passagesForDoc(doc, policy);
      return { ...set, passages: set.passages.map((p) => (p.length > 1_000 ? p.slice(0, -1) : p)) };
    };
    expect(passageFingerprint(shifted, DEFAULT_PASSAGE_POLICY)).not.toBe(SPREAD);
    expect(passageFingerprint(passagesForDoc, { ...DEFAULT_PASSAGE_POLICY, maxPassages: 39 })).not.toBe(SPREAD);
  });

  // splitToBudget keeps a running estimate as paragraphs join; a join must
  // estimate exactly as the joined text does. In mixed text the token budget,
  // not the 1400-character ceiling, decides: 400 CJK characters and 241 others
  // (the joiner's two included) are 481 tokens, 240 others are 480.
  it('the splitter joins two paragraphs exactly up to the token budget', () => {
    const para = (others: number): string => '\u4e2d'.repeat(200) + 'a'.repeat(others);
    expect(estimateTokens(`${para(120)}\n\n${para(119)}`)).toBe(PASSAGE_TOKEN_BUDGET + 1);
    expect(splitToBudget(`${para(120)}\n\n${para(119)}`)).toEqual([para(120), para(119)]);
    expect(estimateTokens(`${para(120)}\n\n${para(118)}`)).toBe(PASSAGE_TOKEN_BUDGET);
    expect(splitToBudget(`${para(120)}\n\n${para(118)}`)).toEqual([`${para(120)}\n\n${para(118)}`]);
  });
});
