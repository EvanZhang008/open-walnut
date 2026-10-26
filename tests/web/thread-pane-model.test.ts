/**
 * The letter reader's split between its document and its conversation
 * (web/src/components/inbox/thread-pane-model.ts). The browser flow lives in
 * tests/e2e/browser/human-inbox-thread-scroll.spec.ts; this pins the numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  clampShare, distanceFromEnd, docPaneMax, DOC_SHARE, DOC_SHARE_MAX, DOC_SHARE_MIN, FOLLOW_WITHIN,
} from '../../web/src/components/inbox/thread-pane-model';

describe('docPaneMax', () => {
  it('gives the document its share when both panes have more than fits', () => {
    expect(docPaneMax(500, 2000)).toBe(Math.round(500 * DOC_SHARE));
  });

  it('gives the document what a short conversation leaves free', () => {
    expect(docPaneMax(500, 120)).toBe(380);
  });

  it('never gives the conversation more than it needs at the cost of the document share', () => {
    // A conversation that needs almost everything still leaves the document its share.
    expect(docPaneMax(500, 480)).toBe(200);
  });

  it('uses a dragged share as given, clamped', () => {
    expect(docPaneMax(500, 2000, 0.7)).toBe(350);
    expect(docPaneMax(500, 2000, 0.01)).toBe(Math.round(500 * DOC_SHARE_MIN));
    expect(docPaneMax(500, 2000, 2)).toBe(Math.round(500 * DOC_SHARE_MAX));
  });

  it('is zero when there is no room', () => {
    expect(docPaneMax(0, 100)).toBe(0);
    expect(docPaneMax(-5, 100)).toBe(0);
  });
});

describe('following the end', () => {
  it('measures the distance from the end, never negative', () => {
    expect(distanceFromEnd({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(0);
    expect(distanceFromEnd({ scrollHeight: 1000, scrollTop: 400, clientHeight: 300 })).toBe(300);
    expect(distanceFromEnd({ scrollHeight: 1000, scrollTop: 710, clientHeight: 300 })).toBe(0);
  });

  it('keeps a small tolerance so a sub-pixel end still follows', () => {
    expect(FOLLOW_WITHIN).toBeGreaterThan(1);
    expect(FOLLOW_WITHIN).toBeLessThan(100);
  });

  it('clamps shares into the allowed band', () => {
    expect(clampShare(0.5)).toBe(0.5);
    expect(clampShare(0)).toBe(DOC_SHARE_MIN);
    expect(clampShare(1)).toBe(DOC_SHARE_MAX);
  });
});
