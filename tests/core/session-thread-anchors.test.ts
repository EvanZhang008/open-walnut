/**
 * `thread_anchors` PATCH normaliser (src/core/sessions/session-lifecycle.ts).
 *
 * Thread anchors are Walnut-owned navigation metadata over ONE linear transcript:
 * a user message hangs off a passage of an earlier reply. The record field is the
 * only durable half, so this normaliser is the whole server-side contract.
 *
 * Posture mirrors `pinned_messages`: reject the WHOLE patch on a malformed entry
 * rather than dropping it, because every write PATCHes the whole list and an
 * anchor the client believes it saved but that vanished on reload is worse than a
 * visible error. The one repair is `at` (see the last test).
 */
import { describe, it, expect } from 'vitest';
import { normalizeThreadAnchors } from '../../src/core/sessions/session-lifecycle.js';

const anchor = (over: Record<string, unknown> = {}) => ({
  msgId: '11111111-2222-4333-8444-555555555555',
  parent: 'msg_abc123',
  source: 'selection',
  at: '2026-09-02T10:00:00.000Z',
  ...over,
});

describe('normalizeThreadAnchors', () => {
  it('round-trips a well-formed list, in order, dropping nothing', () => {
    const out = normalizeThreadAnchors([
      anchor(),
      anchor({ msgId: 'm2', source: 'sticky' }),
      anchor({ msgId: 'm3', source: 'manual' }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      msgId: '11111111-2222-4333-8444-555555555555',
      parent: 'msg_abc123',
      source: 'selection',
      at: '2026-09-02T10:00:00.000Z',
    });
    expect(out.map((a) => a.source)).toEqual(['selection', 'sticky', 'manual']);
  });

  it('accepts an empty list (clearing every anchor)', () => {
    expect(normalizeThreadAnchors([])).toEqual([]);
  });

  it('keeps two anchors that share a parent (two questions about one reply)', () => {
    // Deliberately NOT deduped: collapsing here would be the silent drop this
    // normaliser exists to avoid.
    const out = normalizeThreadAnchors([
      anchor({ msgId: 'a', quote: { exact: 'first passage' } }),
      anchor({ msgId: 'b', quote: { exact: 'second passage' } }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.quote?.exact)).toEqual(['first passage', 'second passage']);
  });

  it('validates the quote selector with the pin-quote rules', () => {
    const out = normalizeThreadAnchors([
      anchor({ quote: { exact: 'the passage', prefix: 'before ', suffix: ' after' } }),
    ]);
    expect(out[0].quote).toEqual({ exact: 'the passage', prefix: 'before ', suffix: ' after' });

    expect(() => normalizeThreadAnchors([anchor({ quote: { exact: '   ' } })]))
      .toThrow(/thread_anchors\[\]\.quote\.exact/);
    expect(() => normalizeThreadAnchors([anchor({ quote: 'a string' })]))
      .toThrow(/thread_anchors\[\]\.quote must be an object/);
    expect(() => normalizeThreadAnchors([anchor({ quote: { exact: 'ok', prefix: 'x'.repeat(65) } })]))
      .toThrow(/thread_anchors\[\]\.quote\.prefix/);
  });

  it('reads a null quote as absent (whole-reply anchor), not malformed', () => {
    const out = normalizeThreadAnchors([anchor({ quote: null })]);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toBeUndefined();
  });

  it('rejects an unknown source', () => {
    expect(() => normalizeThreadAnchors([anchor({ source: 'rail' })]))
      .toThrow(/thread_anchors\[\]\.source must be one of/);
    expect(() => normalizeThreadAnchors([anchor({ source: undefined })]))
      .toThrow(/thread_anchors\[\]\.source/);
  });

  it('rejects a missing / empty / oversized msgId or parent', () => {
    for (const key of ['msgId', 'parent']) {
      expect(() => normalizeThreadAnchors([anchor({ [key]: undefined })]))
        .toThrow(new RegExp(`thread_anchors\\[\\]\\.${key}`));
      expect(() => normalizeThreadAnchors([anchor({ [key]: '   ' })]))
        .toThrow(new RegExp(`thread_anchors\\[\\]\\.${key}`));
      expect(() => normalizeThreadAnchors([anchor({ [key]: 'x'.repeat(129) })]))
        .toThrow(new RegExp(`thread_anchors\\[\\]\\.${key}`));
      expect(() => normalizeThreadAnchors([anchor({ [key]: 42 })]))
        .toThrow(new RegExp(`thread_anchors\\[\\]\\.${key}`));
    }
    // 128 is the boundary and must pass.
    expect(normalizeThreadAnchors([anchor({ msgId: 'x'.repeat(128) })])).toHaveLength(1);
  });

  it('rejects a non-array and non-object entries', () => {
    expect(() => normalizeThreadAnchors('nope')).toThrow(/thread_anchors must be an array/);
    expect(() => normalizeThreadAnchors({})).toThrow(/thread_anchors must be an array/);
    expect(() => normalizeThreadAnchors([null])).toThrow(/each thread_anchors entry must be an object/);
    expect(() => normalizeThreadAnchors([['msgId', 'm1']]))
      .toThrow(/each thread_anchors entry must be an object/);
  });

  it('rejects a list over 500 entries and accepts exactly 500', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => anchor({ msgId: `m${i}` }));
    expect(normalizeThreadAnchors(many(500))).toHaveLength(500);
    expect(() => normalizeThreadAnchors(many(501)))
      .toThrow(/thread_anchors holds at most 500 entries/);
  });

  it('repairs a missing or unparseable `at` to now instead of rejecting', () => {
    // The timestamp only orders the rail; losing the whole list over one clock
    // quirk is the worse failure.
    const before = Date.now();
    const out = normalizeThreadAnchors([anchor({ at: undefined }), anchor({ msgId: 'm2', at: 'yesterday' })]);
    for (const a of out) {
      const ms = Date.parse(a.at);
      expect(Number.isNaN(ms)).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
    }
  });
});
