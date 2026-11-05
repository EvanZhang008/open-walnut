/**
 * Tree Mode's split: the left half is a second view of the panel's timeline and
 * fetches nothing itself (web/src/components/sessions/timeline-share.ts). The
 * review found the left half ran its own history request per mount and its own
 * turn-start / turn-end / reconnect refetches, and that both halves shared one
 * `runWhenVisible` key, so after a hidden-tab reconnect only one of them
 * refetched and the other missed turns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTimelineShare, shareStoreArgs, type SharedTimeline } from '@/components/sessions/timeline-share';

const ROOT = join(__dirname, '..', '..');
const SCH = readFileSync(join(ROOT, 'web/src/components/sessions/SessionChatHistory.tsx'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web/src/components/sessions/SessionPanel.tsx'), 'utf8');

describe('the timeline share', () => {
  it('hands the reader what the publisher set, and tells it only on a change', () => {
    const share = createTimelineShare();
    let calls = 0;
    const off = share.subscribe(() => { calls += 1; });
    expect(share.get()).toBeNull();
    const a = { history: {}, stream: { blocks: [], isStreaming: false, completedLen: 0 } } as unknown as SharedTimeline;
    share.set(a);
    share.set(a);
    expect(share.get()).toBe(a);
    expect(calls).toBe(1);
    off();
    share.set({ ...a });
    expect(calls).toBe(1);
  });

  it('a view with no share subscribes to nothing', () => {
    const [subscribe, get] = shareStoreArgs(undefined);
    expect(get()).toBeNull();
    expect(typeof subscribe(() => {})).toBe('function');
  });
});

describe('the left half reads the panel\'s timeline and fetches nothing', () => {
  it('a reader opens no history request and no stream of its own', () => {
    expect(SCH).toMatch(/useSessionHistory\(readTimeline \? null : sessionId, historyVersion\)/);
    expect(SCH).toMatch(/useSessionStream\(readTimeline \? null : sessionId\)/);
  });

  it('every refetch goes through bumpHistory, which a reader ignores', () => {
    const direct = SCH.match(/setHistoryVersion\(\(/g) ?? [];
    // The one call left is bumpHistory's own.
    expect(direct.length).toBe(1);
    expect(SCH).toMatch(/const bumpHistory = useCallback\(\(\) => \{ if \(!readingRef\.current\) setHistoryVersion\(\(v\) => v \+ 1\); \}, \[\]\);/);
  });

  it('a hidden-tab reconnect refetches in every mounted timeline (its key is per mount)', () => {
    const keys = [...SCH.matchAll(/runWhenVisible\(`([^`]*)`/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, `runWhenVisible key ${k}`).toMatch(/\$\{instanceUid\.current\}/);
  });

  it('the panel publishes only while the left half shows, and passes the left half a stable history prop', () => {
    expect(PANEL).toMatch(/publishTimeline=\{treeGrid \? timelineShare : undefined\}/);
    expect(PANEL).toMatch(/const leftHistory = useMemo\(/);
    expect(PANEL).toMatch(/history=\{leftHistory\}/);
  });
});
