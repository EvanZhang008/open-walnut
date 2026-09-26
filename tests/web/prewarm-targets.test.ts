/**
 * C88: opening the folder picker dials only hosts a redial can help. A host
 * that failed on auth or an expired certificate is left to its schedule (a
 * hardware key or a prompting agent would ask on every open); an unreachable
 * host is still warmed. Off, connected, connecting, removed, disabled: never.
 */
import { describe, it, expect } from 'vitest';
import type { HostStatus } from '@/api/hosts';
import { prewarmTargets } from '@/api/sessions';

function s(host: string, o: Partial<HostStatus>): HostStatus {
  return {
    host, label: host, hostname: `${host}.example.com`, connected: false, phase: 'idle', phaseLabel: '',
    steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1, ...o,
  };
}

const candidates: Array<[string, string]> = [
  ['keybox', '~/'], ['certbox', '~/'], ['netbox', '~/work'], ['devbox', '~/'], ['newbox', '~/'],
  ['busybox', '~/'], ['backbox', '~/'], ['testbox', '~/'], ['dnsbox', '~/'], ['timebox', '~/'],
];
const statuses = [
  s('keybox', { phase: 'failed', kind: 'auth', retryable: false }),
  s('certbox', { phase: 'failed', kind: 'cert_expired', retryable: false }),
  s('netbox', { phase: 'failed', kind: 'unreachable', retryable: true }),
  s('devbox', { phase: 'connected', connected: true }),
  s('busybox', { phase: 'ssh' }),
  s('backbox', { phase: 'reconnecting' }),
  s('testbox', { phase: 'queued' }),
  s('dnsbox', { phase: 'failed', kind: 'dns', retryable: false }),
  s('timebox', { phase: 'failed', kind: 'timeout', retryable: true }),
];

describe('prewarmTargets', () => {
  it('skips standing failures and live attempts; warms retryable failures and never-seen hosts', () => {
    expect(prewarmTargets(candidates, statuses, false).map(([h]) => h)).toEqual(['netbox', 'newbox', 'timebox']);
  });

  it('three opens in a row never target keybox or certbox (pure: same answer every time)', () => {
    for (let i = 0; i < 3; i++) {
      const hosts = prewarmTargets(candidates, statuses, false).map(([h]) => h);
      expect(hosts).not.toContain('keybox');
      expect(hosts).not.toContain('certbox');
      expect(hosts).toContain('netbox');
    }
  });

  it('keeps the cwd each host is warmed at', () => {
    expect(prewarmTargets(candidates, statuses, false).find(([h]) => h === 'netbox')).toEqual(['netbox', '~/work']);
  });

  it('a replica never dials, and a server whose remotes are all off dials nothing', () => {
    expect(prewarmTargets(candidates, statuses, true)).toEqual([]);
    const off = candidates.map(([h]) => s(h, { phase: 'off' }));
    expect(prewarmTargets(candidates, off, false)).toEqual([]);
  });

  it('an off host alone is skipped; hosts outside the configured set (removed / disabled) are skipped', () => {
    const mixed = [s('netbox', { phase: 'off' })];
    expect(prewarmTargets([['netbox', '~/'], ['newbox', '~/']], mixed, false)).toEqual([]);
    expect(prewarmTargets([['netbox', '~/'], ['newbox', '~/']], [], false, new Set(['newbox']))).toEqual([['newbox', '~/']]);
    expect(prewarmTargets([['gone', '~/']], [s('gone', { removed: true })], false)).toEqual([]);
  });

  it('accepts a Map of statuses as well as an array', () => {
    const map = new Map(statuses.map((x) => [x.host, x] as const));
    expect(prewarmTargets(candidates, map, false).map(([h]) => h)).toEqual(['netbox', 'newbox', 'timebox']);
  });
});
