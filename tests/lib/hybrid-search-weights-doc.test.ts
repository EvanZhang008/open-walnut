/**
 * The README documents the BM25 field weights verbatim, and nothing gated it:
 * `npm run docs:check` only covers the generated ops docs, so the numbers were
 * free to drift away from the code. This turns "keep the README in step" from a
 * hope into a failing test.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BM25_FIELD_WEIGHTS,
  BM25_SUB_RATIO,
  RELEVANCE_MASS,
  W_BODY_COVERAGE,
  W_COVERAGE,
  W_RELAXED,
  W_STRICT,
} from '../../src/lib/hybrid-search/query.js';

const README = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/hybrid-search/README.md'),
  'utf8',
);

describe('hybrid-search README stays in step with the weights', () => {
  it('documents the current orig weights', () => {
    const { title, summary, note, meta } = BM25_FIELD_WEIGHTS;
    expect(README).toContain(
      `one orig stream per field (title ${title}, summary ${summary}, note ${note}, meta ${meta})`,
    );
  });

  it('documents the derived sub weights', () => {
    const subs = Object.values(BM25_FIELD_WEIGHTS)
      .map((w) => Number((w * BM25_SUB_RATIO).toFixed(2)))
      .map((w) => String(w))
      .join(' / ');
    expect(README).toContain(subs);
  });

  it('sub weights are derived, not typed in twice', () => {
    // Guards the invariant the comment claims: a subword title hit must outrank
    // a whole-word body hit, i.e. title*ratio > note.
    expect(BM25_FIELD_WEIGHTS.title * BM25_SUB_RATIO)
      .toBeGreaterThan(BM25_FIELD_WEIGHTS.note);
  });

  it('documents the current component weights', () => {
    expect(README).toContain(
      `normalized BM25 (both lanes) ${W_STRICT} / ${W_RELAXED}, term coverage ${W_COVERAGE}, `
      + `**body coverage ${W_BODY_COVERAGE}**`,
    );
    expect(README).toContain(`The first four sum to ${RELEVANCE_MASS}.`);
  });

  it('the four match components sum to the documented relevance mass', () => {
    // index.ts's demotion cap, span confidence and recall slot cap were tuned
    // against this sum. Moving mass between the components is safe; changing the
    // total silently rescales three unrelated thresholds.
    const sum = W_STRICT + W_RELAXED + W_COVERAGE + W_BODY_COVERAGE;
    expect(Number(sum.toFixed(4))).toBe(RELEVANCE_MASS);
  });
});
