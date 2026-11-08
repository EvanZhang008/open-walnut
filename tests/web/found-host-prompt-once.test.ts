/**
 * A host Home's found-host prompt shows is said once (2026-11-09 review: "Could not connect to
 * demo-devbox-c" read in the prompt and again in System attention). The prompt publishes its
 * hosts; the banner model gives them no row, whatever else is true of them. The first fix
 * filtered the `engaged` set, but a host the user said Connect to stops being `discovered`, so
 * its failure still took a row: the check here is on the model's own answer, for a host found
 * in ~/.ssh/config and for one the user already said Connect to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_BANNER_STATE, nextBanner, type BannerInput } from '../../web/src/utils/attention-banner-model';
import { hostAttentionOf } from '../../web/src/utils/host-banner-placement';
import { __resetUserRetryForTests, getPromptedHosts, getUserEngagedHosts, markUserRetry, setPromptedHosts } from '../../web/src/utils/host-user-retrying';
import type { HostStatusInput } from '../../src/core/hosts/host-problem';

afterEach(() => __resetUserRetryForTests());

const NOW = 1_000_000_000;
type S = HostStatusInput & { label: string; discovered?: boolean };
const failed = (host: string, extra: Partial<S> = {}): S => ({
  host, label: host, connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: connect refused',
  hint: 'Nothing is listening for SSH.', retryable: true, at: NOW, ...extra,
});
const rowsOf = (input: BannerInput) => nextBanner(input, EMPTY_BANNER_STATE).view.rows.map((r) => r.id);

describe('a host the found-host prompt shows takes no banner row', () => {
  for (const [name, host] of [
    ['found in ~/.ssh/config, the user pressed Connect on the prompt', failed('devbox', { discovered: true })],
    ['the user said Connect, so it is no longer discovered (the reported case)', failed('devbox')],
  ] as const) {
    it(name, () => {
      const base: BannerInput = { statuses: [host, failed('other')], dismissed: new Set(), now: NOW, engaged: new Set(['devbox']) };
      expect(rowsOf(base).sort()).toEqual(['host:devbox', 'host:other']);
      const prompted = new Set(['devbox']);
      expect(rowsOf({ ...base, prompted })).toEqual(['host:other']);
      // The rail dot (System attention's own light) reads the same model.
      expect(hostAttentionOf({ statuses: [host], dismissed: new Set(), now: NOW, engaged: new Set(['devbox']), prompted }).on).toBe(false);
      expect(hostAttentionOf({ statuses: [host], dismissed: new Set(), now: NOW, engaged: new Set(['devbox']) }).on).toBe(true);
    });
  }

  it('the prompt set is published as the prompt changes, and the engaged set stays the user\'s own', () => {
    markUserRetry(['devbox'])();
    setPromptedHosts(['devbox']);
    expect([...getPromptedHosts()]).toEqual(['devbox']);
    expect([...getUserEngagedHosts()]).toEqual(['devbox']);
    setPromptedHosts([]);
    expect([...getPromptedHosts()]).toEqual([]);
  });

  it('the prompt publishes the hosts it shows and clears them when it unmounts', () => {
    const src = readFileSync(new URL('../../web/src/components/common/FoundHostPrompts.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/setPromptedHosts\(rowHosts \? rowHosts\.split/);
    expect(src).toMatch(/\(\) => \(\) => setPromptedHosts\(\[\]\)/);
  });

  it('every caller of the banner model passes the prompted hosts', () => {
    const web = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = path.join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
    const callers = walk(web).filter((p) => !p.endsWith('attention-banner-model.ts'))
      .map((p) => ({ p: path.relative(web, p), s: readFileSync(p, 'utf8') }))
      .filter((f) => /\bnextBanner\(\{|engaged: getUserEngagedHosts\(\)/.test(f.s));
    expect(callers.map((f) => f.p).sort()).toEqual([
      'components/common/AttentionBanner.tsx', 'components/common/HostBannerAnnouncer.tsx', 'utils/host-banner-placement.ts',
    ]);
    for (const f of callers) expect(f.s, f.p).toMatch(/\bprompted\b/);
  });
});
