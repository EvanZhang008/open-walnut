/**
 * A fingerprint of what chunk.ts makes of a fixed set of generated docs under
 * one passage policy: sha256 over every PassageSet, in order. The passage
 * policy ratchet (tests/core/search-v2-passage-policy-ratchet.test.ts) records
 * one per kind for each PASSAGE_POLICY_VERSION.
 *
 * The docs cover each rule of the splitter: a doc that fits one passage, an
 * empty one, a head too long for seq 0, many tiny paragraphs, CJK and astral
 * CJK text, an unbroken wall, single and triple newlines, and a doc past the
 * per-doc cap (where `tail` and `spread` keep different chunks).
 */
import { createHash } from 'node:crypto';
import type { PassagePolicy, PassageSet } from '../../src/lib/hybrid-search/index.js';

export interface FingerprintDoc { title: string; summary?: string; note?: string }
export type PassagesFn = (doc: FingerprintDoc, policy?: Partial<PassagePolicy>) => PassageSet;

const WORDS = 'retry window worker budget passage vector index marina cedar lantern harvest orbit'.split(' ');
// Test data: CJK text and an astral CJK character (U+20000).
const CJK = '\u4e2d\u6587\u641c\u7d22\u6d4b\u8bd5\u6bb5\u843d\u5185\u5bb9\u91cd\u8bd5\u7a97\u53e3';
const ASTRAL = '\u{20000}';

function words(seed: number, chars: number): string {
  let s = '';
  for (let i = 0; s.length < chars; i++) s += (s ? ' ' : '') + WORDS[(seed * 7 + i * 3) % WORDS.length];
  return s;
}

function paras(seed: number, count: number, chars: number, joiner = '\n\n'): string {
  return Array.from({ length: count }, (_, i) => `p${seed}.${i} ${words(seed + i, chars)}`).join(joiner);
}

function fill(unit: string, chars: number): string {
  let s = '';
  while (s.length + unit.length <= chars) s += unit;
  return s;
}

export function fingerprintDocs(): FingerprintDoc[] {
  return [
    { title: 'Short task', summary: 'one line', note: 'a body that fits one passage' },
    { title: '', summary: '', note: '' },
    { title: 'Only a title' },
    { title: 'Summary only', summary: words(1, 2_000) },
    { title: words(2, 600), summary: words(3, 3_000), note: paras(4, 12, 700) },
    { title: 'Tiny paragraphs', note: fill('x\n\n', 20_000) },
    { title: 'Short lines', note: fill('ok\n', 9_000) },
    { title: 'CJK', note: Array.from({ length: 40 }, (_, i) => CJK.repeat(1 + (i % 9))).join('\n\n') },
    { title: 'Astral', note: `${ASTRAL.repeat(700)}\n\n${words(5, 300)}` },
    { title: 'Wall', note: 'w'.repeat(10_000) },
    { title: 'Code', note: paras(6, 30, 120, '\n') + '\n\n\n' + paras(7, 10, 400, '\n\n\n\n') },
    { title: 'Over the cap', summary: 'a long log', note: paras(8, 60, 900) },
    { title: 'Mixed', note: [paras(9, 5, 1_300), CJK.repeat(60), 'z'.repeat(1_500), paras(10, 3, 50)].join('\n\n') },
  ];
}

export function passageFingerprint(passagesFor: PassagesFn, policy?: Partial<PassagePolicy>): string {
  const h = createHash('sha256');
  for (const doc of fingerprintDocs()) h.update(JSON.stringify(passagesFor(doc, policy))).update('\u0000');
  return h.digest('hex');
}
