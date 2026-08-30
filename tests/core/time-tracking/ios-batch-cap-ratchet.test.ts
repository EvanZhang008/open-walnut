/**
 * Cross-language ratchet: the iOS queue's batch cap must equal the server's.
 *
 * Both edges cap a batch and still answer 204, so if the client ever sent MORE
 * than the server accepts, the tail would be silently dropped and the client would
 * commit it as delivered. Nothing in either language can see the other's constant,
 * so this test is the only thing holding the two numbers together.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SAMPLES_PER_REQUEST } from '../../../src/core/time-tracking/rollup.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SWIFT = path.join(REPO, 'ios-native/Walnut/Core/TimeSampleQueue.swift');

describe('iOS ↔ server batch cap', () => {
  it('TimeSampleQueue.maxBatch equals MAX_SAMPLES_PER_REQUEST', (ctx) => {
    if (!fs.existsSync(SWIFT)) {
      // The client half may not have landed yet; this becomes a real assertion the
      // moment it does. Never silently pass on a file that exists but changed shape.
      ctx.skip();
      return;
    }
    const source = fs.readFileSync(SWIFT, 'utf-8');
    const match = /static\s+let\s+maxBatch\s*=\s*(\d+)/.exec(source);
    expect(match, `no \`static let maxBatch = <n>\` in ${SWIFT}`).not.toBeNull();
    expect(Number(match![1])).toBe(MAX_SAMPLES_PER_REQUEST);
  });
});
