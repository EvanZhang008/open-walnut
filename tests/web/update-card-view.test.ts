/**
 * The words and tones of the Open Walnut card and the Settings build line
 * segment, one per update state. Pinned so the two surfaces keep agreeing and
 * so "not reaching npm" never dresses as a Walnut problem (no amber tone).
 */
import { describe, it, expect } from 'vitest';
import { updateCardView } from '@/components/common/update-card-view';
import { formatUpdateSegment } from '@/components/settings/build-line';
import { updateAvailable } from '@/hooks/useUpdateStatus';
import type { UpdateStatus } from '@/api/update';

const NPM = { kind: 'npm' as const, sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm' as const, updateCommand: 'npm install -g open-walnut@latest' };

function status(over: Partial<UpdateStatus>): UpdateStatus {
  return {
    enabled: true, install: NPM, current: '0.5.1', latest: '0.5.1', available: false,
    checkedAt: new Date(Date.now() - 90_000).toISOString(), error: null, checking: false,
    packageUrl: 'https://www.npmjs.com/package/open-walnut', ...over,
  };
}

describe('updateCardView', () => {
  it('a newer release: accent tone, the version, the install command, the restart note, Check now', () => {
    const v = updateCardView(status({ latest: '0.6.0', available: true }));
    expect(v).toMatchObject({ tone: 'update', statusLabel: 'Update', status: '0.6.0 available', statusClass: 'accent', command: 'npm install -g open-walnut@latest', note: 'Restart Walnut after installing', canCheck: true });
  });

  it('a newer release with no manager: the package page instead of a command', () => {
    const v = updateCardView(status({ latest: '0.6.0', available: true, install: { ...NPM, kind: 'other', manager: null, updateCommand: null } }));
    expect(v.command).toBeUndefined();
    expect(v.note).toContain('https://www.npmjs.com/package/open-walnut');
  });

  it('up to date: green, with when it was checked', () => {
    const v = updateCardView(status({}));
    expect(v).toMatchObject({ tone: 'ok', status: 'Up to date', statusClass: 'ok', canCheck: true });
    expect(v.note).toMatch(/^Checked 1m ago$/);
  });

  it('up to date but the last attempt failed: still green, the failure in the note', () => {
    const v = updateCardView(status({ error: 'fetch failed' }));
    expect(v.tone).toBe('ok');
    expect(v.note).toContain('the last check failed (fetch failed)');
  });

  it('never reached the registry: quiet, never amber, the reason as the note', () => {
    const v = updateCardView(status({ latest: null, checkedAt: null, error: 'registry answered HTTP 503' }));
    expect(v).toMatchObject({ tone: 'unreachable', status: 'Registry unreachable', statusClass: '', note: 'registry answered HTTP 503', canCheck: true });
  });

  it('not checked yet', () => {
    expect(updateCardView(status({ latest: null, checkedAt: null }))).toMatchObject({ tone: 'neutral', status: 'Not checked yet', canCheck: true });
  });

  it('a source checkout names the folder and offers no check', () => {
    const v = updateCardView(status({ enabled: false, reason: 'source', latest: null, install: { kind: 'source', sourceDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut', manager: null, updateCommand: null } }));
    expect(v).toMatchObject({ tone: 'neutral', status: 'Source checkout', note: 'Updates with git pull in /Users/alice/open-walnut', canCheck: false });
  });

  it('a replica and an opt-out say so without a check', () => {
    expect(updateCardView(status({ enabled: false, reason: 'replica', latest: null }))).toMatchObject({ status: 'Cloud replica', canCheck: false });
    expect(updateCardView(status({ enabled: false, reason: 'opted-out', latest: null }))).toMatchObject({ status: 'Check turned off', note: 'WALNUT_NO_UPDATE_CHECK is set', canCheck: false });
  });
});

describe('formatUpdateSegment and updateAvailable', () => {
  it('only a newer release on an enabled check produces the segment and the dot', () => {
    const newer = status({ latest: '0.6.0', available: true });
    expect(formatUpdateSegment(newer)).toEqual({ text: '0.6.0 available', title: 'Update with: npm install -g open-walnut@latest' });
    expect(updateAvailable(newer)).toBe(true);
    expect(formatUpdateSegment(status({}))).toBeNull();
    expect(updateAvailable(status({}))).toBe(false);
    expect(formatUpdateSegment(null)).toBeNull();
    expect(updateAvailable(null)).toBe(false);
    // A disabled check never claims an update even if a stale `available` rides along.
    expect(formatUpdateSegment(status({ enabled: false, reason: 'source', available: true, latest: '0.6.0' }))).toBeNull();
    expect(updateAvailable(status({ enabled: false, reason: 'source', available: true, latest: '0.6.0' }))).toBe(false);
  });

  it('without a manager the title points at the package page', () => {
    const seg = formatUpdateSegment(status({ latest: '0.6.0', available: true, install: { ...NPM, kind: 'other', manager: null, updateCommand: null } }));
    expect(seg?.title).toBe('A newer Open Walnut is published: https://www.npmjs.com/package/open-walnut');
  });
});
