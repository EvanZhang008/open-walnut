/**
 * Word-level A/B transcription diff — mixed zh-en tokenization, trivial
 * punctuation downgrade, stats.
 */
import { describe, it, expect } from 'vitest';
import { tokenizeSpeech, diffSpeech, diffStats } from '../../web/src/utils/stt-diff.js';

describe('tokenizeSpeech', () => {
  it('keeps latin words whole and splits CJK into words', () => {
    const tokens = tokenizeSpeech('我们用DynamoDB做存储');
    expect(tokens.join('')).toBe('我们用DynamoDB做存储');
    expect(tokens).toContain('DynamoDB'); // not shredded into chars
    expect(tokens.length).toBeGreaterThan(3); // CJK actually segmented
  });
});

describe('diffSpeech', () => {
  it('flags a word one engine dropped', () => {
    // Real pattern from the benchmark: whisper drops filler words qwen keeps
    const a = '嗯，他们可以把DB放上来什么的';
    const b = '他们可以把DB放上来什么的';
    const segs = diffSpeech(a, b);
    const aOnly = segs.filter(s => s.kind === 'a' && !s.trivial).map(s => s.text).join('');
    expect(aOnly).toContain('嗯');
    // The shared tail is marked same
    expect(segs.some(s => s.kind === 'same' && s.text.includes('放上来'))).toBe(true);
  });

  it('downgrades punctuation-only changes to trivial', () => {
    const segs = diffSpeech('他们可以，把DB放上来。', '他们可以,把DB放上来.');
    const realChanges = segs.filter(s => s.kind !== 'same' && !s.trivial);
    expect(realChanges).toEqual([]); // ，vs , and 。vs . are noise
    expect(segs.some(s => s.trivial)).toBe(true);
  });

  it('reports substantive difference stats excluding trivial', () => {
    const segs = diffSpeech('我带了一个组，', '我待了一个组.');
    const { aOnly, bOnly } = diffStats(segs);
    expect(aOnly).toBe(1); // 带
    expect(bOnly).toBe(1); // 待
  });

  it('identical texts produce a single same segment', () => {
    const segs = diffSpeech('hello 世界', 'hello 世界');
    expect(segs).toEqual([{ text: 'hello 世界', kind: 'same' }]);
  });
});
