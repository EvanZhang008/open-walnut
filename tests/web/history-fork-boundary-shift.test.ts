/**
 * A fork boundary is counted from the payload's first row; a fold that keeps older held rows above
 * a windowed payload moves it down by them. Every site of web/src/hooks/useSessionHistory.ts that
 * stores a folded payload's boundary goes through shiftedForkBoundary (2026-11-08: Phase 1's kept
 * view now sits under every windowed refresh of a remote session, so an unshifted boundary drew the
 * fork divider rows too early on every open).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { foldFullPayload, shiftedForkBoundary } from '../../web/src/hooks/history-merge';

const row = (id: string) => ({ role: 'user', text: id, msgId: id, timestamp: '' });

describe('fork boundary after a fold', () => {
  it('moves down by the rows the fold kept above a windowed payload', () => {
    const held = ['a', 'b', 'c', 'd'].map(row);
    const payload = { messages: ['c', 'd', 'e'].map(row), cursor: 3, windowed: true, forkBoundaryIndex: 1 };
    const folded = foldFullPayload(held, payload);
    expect(folded.kept).toBe(2);
    const at = shiftedForkBoundary(payload.forkBoundaryIndex, folded.kept)!;
    expect(folded.messages[at]?.msgId).toBe(payload.messages[payload.forkBoundaryIndex]!.msgId);
    expect(shiftedForkBoundary(undefined, 2)).toBeUndefined();
  });

  it('every boundary stored after a fold or backfill in the hook is shifted', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/hooks/useSessionHistory.ts'), 'utf8').split('\n');
    const bad: string[] = [];
    src.forEach((line, i) => {
      if (!/foldFullPayload\(|mergeHistoryBackfill\(/.test(line)) return;
      for (let j = i + 1; j < Math.min(src.length, i + 30); j++) {
        if (/foldFullPayload\(|mergeHistoryBackfill\(/.test(src[j]!)) break;
        if (/forkBoundaryIndex/.test(src[j]!) && /\.forkBoundaryIndex\b/.test(src[j]!) && !/shiftedForkBoundary\(/.test(src[j]!)) {
          bad.push(`${j + 1}: ${src[j]!.trim()}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });
});
