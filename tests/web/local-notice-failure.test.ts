/**
 * The red Errors badge counts failures, not first-run steps (local-claude-banner.ts
 * localNoticeIsFailure; 2026-11-11 review: the very first open read "Errors 1" for "Claude Code is
 * not installed").
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { localNoticeIsFailure, localNoticeShows } from '@/utils/local-claude-banner';
import type { SystemHealth } from '@/hooks/useSystemHealth';

const problem = (kind: string, fix?: { state: 'running' | 'failed' }) => ({
  kind, message: kind, commands: ['claude'], ...(fix ? { fix: { action: 'install', text: 'x', ...fix } } : {}),
});
const health = (problems: ReturnType<typeof problem>[], extra: Partial<SystemHealth> = {}): SystemHealth => ({
  hasReadyProvider: true, claudeCliAvailable: problems.every((p) => p.kind !== 'claude_missing'),
  localClaude: { checkedAt: 1, claude: { found: true }, problems },
  ...extra,
} as unknown as SystemHealth);

describe('which local notices are errors', () => {
  it('not installed and not signed in are first-run steps, not errors', () => {
    for (const h of [health([problem('claude_missing')]), health([problem('claude_needs_node')]), health([problem('claude_not_logged_in')])]) {
      const kind = localNoticeShows(h, []);
      expect(kind).not.toBeNull();
      expect(localNoticeIsFailure(h, kind!)).toBe(false);
    }
  });

  it('a Claude Code that cannot start, a fix that failed, or a provider that stopped answering is', () => {
    const cannot = health([problem('claude_error')]);
    expect(localNoticeIsFailure(cannot, localNoticeShows(cannot, [])!)).toBe(true);
    const failedFix = health([problem('claude_missing', { state: 'failed' })]);
    expect(localNoticeIsFailure(failedFix, localNoticeShows(failedFix, [])!)).toBe(true);
    expect(localNoticeIsFailure(health([]), 'provider')).toBe(true);
  });

  it('guard: the Errors badge counts the local notice only through the rule', () => {
    const panel = fs.readFileSync(path.join(__dirname, '../../web/src/components/common/NotificationPanel.tsx'), 'utf8');
    const badge = panel.split('\n').filter((l) => l.includes('errorsBadgeCount('));
    expect(badge).toHaveLength(1);
    expect(badge[0]).toMatch(/localClaude: localClaudeFailing/);
    expect(panel).toMatch(/const localClaudeFailing = localNotice !== null && localNoticeIsFailure\(health, localNotice\);/);
  });
});
