/**
 * The words of the session header's live-resource pills (SessionBrowserChip.tsx,
 * SessionServersChip.tsx): what a session holds live shows only there (2026-11-09).
 */
import { describe, expect, it } from 'vitest';
import { browserChipLook } from '../../web/src/components/sessions/SessionBrowserChip';
import { serversChipLabel } from '../../web/src/components/sessions/SessionServersChip';

describe('browser pill', () => {
  it('shows nothing while no tab is used', () => {
    expect(browserChipLook([])).toBeNull();
  });
  it('names one tab, counts several', () => {
    expect(browserChipLook([{ tab: 3, title: 'Statement' }])).toMatchObject({ label: 'Browser', tone: 'live' });
    expect(browserChipLook([{ tab: 3, title: 'Statement' }])!.title).toContain('Statement');
    expect(browserChipLook([{ tab: 3 }, { tab: 4 }])).toMatchObject({ label: 'Browser 2', tone: 'live' });
  });
  it('asks for a sign-in before anything else, and says when the person has the tab', () => {
    const signIn = { id: 'r1', at: '2026-11-09T00:00:00Z' };
    expect(browserChipLook([{ tab: 1 }, { tab: 2, signIn }])).toMatchObject({ label: 'Sign in', tone: 'ask' });
    expect(browserChipLook([{ tab: 2, signIn, driving: true }])).toMatchObject({ label: 'Yours', tone: 'yours' });
    expect(browserChipLook([{ tab: 1, driving: true }, { tab: 2 }])).toMatchObject({ label: 'Yours 2', tone: 'yours' });
  });
});

describe('servers pill', () => {
  it('counts web pages first, else every server', () => {
    expect(serversChipLabel([{ port: 5173 }], [{ port: 5173 }, { port: 2014 }])).toBe(':5173');
    expect(serversChipLabel([{ port: 1 }, { port: 2 }])).toBe('Web 2');
    expect(serversChipLabel([], [{ port: 2014 }])).toBe(':2014');
    expect(serversChipLabel([], [{ port: 2014 }, { port: 9000 }])).toBe('2 servers');
  });
});
