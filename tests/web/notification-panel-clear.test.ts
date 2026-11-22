/**
 * The notification center's Clear dismisses only what is settled: an ask still waiting for its
 * answer stays (2026-11-22 review: "Clear asks" dismissed pending permission requests, so the
 * session stayed stuck and its only card in the bell was gone). And a row's own key belongs to
 * the row: Enter or Space on a control inside it (its x, Details, a button) is that control's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearableKeys } from '../../web/src/contexts/notifications/settled-asks';
import type { Notification } from '../../web/src/contexts/notifications/types';

const WEB = path.resolve(__dirname, '../../web/src');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const n = (over: Partial<Notification>): Notification => ({
  id: over.dedupKey ?? 'x', kind: 'operation-error', severity: 'error', title: 't', timestamp: 0, read: true,
  dedupKey: 'x', ...over,
}) as Notification;

describe('Clear in the notification center', () => {
  it('keeps every ask still waiting, and clears the settled ones and everything else', () => {
    const list = [
      n({ kind: 'permission', severity: 'warning', dedupKey: 'perm:waiting' }),
      n({ kind: 'permission', severity: 'success', dedupKey: 'perm:allowed', resolved: 'allowed' }),
      n({ kind: 'permission', severity: 'info', dedupKey: 'perm:stale', resolved: 'stale' }),
      n({ kind: 'operation-error', dedupKey: 'error:disk' }),
      n({ kind: 'cron', severity: 'info', dedupKey: 'cron:nightly' }),
      n({ kind: 'letter', severity: 'info', dedupKey: 'letter:l1' }),
    ];
    expect(clearableKeys(list)).toEqual(['perm:allowed', 'perm:stale', 'error:disk', 'cron:nightly', 'letter:l1']);
    expect(clearableKeys([list[0]!])).toEqual([]);
  });

  it('every section\'s Clear goes through that rule, and the header shows Clear only when it would dismiss something', () => {
    const view = read('components/common/useNotificationFeedView.ts');
    const fn = view.slice(view.indexOf('const clearKeys = useMemo'), view.indexOf('return { hostCards'));
    const returns = [...fn.matchAll(/return ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(returns.length).toBeGreaterThanOrEqual(4);
    for (const r of returns) expect(r, r).toMatch(/^(\[\]|clearableKeys\()/);
    const panel = read('components/common/NotificationPanel.tsx');
    expect(panel).toContain('canClear={clearKeys.length > 0}');
    expect(panel).toContain('dismissFeed(clearKeys)');
    // No Clear dismisses the whole feed unfiltered (dismissFeed() with no keys).
    expect(panel).not.toMatch(/dismissFeed\(\s*(?:undefined)?\s*\)/);
  });
});

describe('a notice row\'s keys', () => {
  it('a card that opens on Enter or Space reacts only to its own key, never one from a control inside it', () => {
    const files = fs.readdirSync(path.join(WEB, 'components'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx$/.test(f)).map((f) => `components/${f}`);
    const offenders: string[] = [];
    let found = 0;
    for (const rel of files) {
      const src = read(rel);
      if (!src.includes('<NoticeCard')) continue;
      // A key handler handed to the card's element (NoticeCard's `handlers`).
      for (const m of src.matchAll(/handlers=\{\{([\s\S]*?)\n\s*\}\}/g)) {
        const block = m[1]!;
        if (!/onKeyDown\s*:/.test(block) || !/'Enter'|' '/.test(block)) continue;
        found += 1;
        if (!/e\.target !== e\.currentTarget/.test(block)) offenders.push(rel);
      }
    }
    expect(found, 'the scan finds the feed row\'s key handler').toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });
});
