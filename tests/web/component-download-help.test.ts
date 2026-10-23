/**
 * The one sentence a settings row shows for a part Walnut downloads on first
 * use (web/src/components/settings/sections/component-download.tsx).
 */
import { describe, it, expect } from 'vitest';
import { componentBusy, componentHelp, componentPollMs } from '../../web/src/components/settings/sections/component-download';
import type { ComponentStatus } from '../../web/src/api/components';

const base: ComponentStatus = { name: 'embedding', label: 'search by meaning', state: 'missing', platform: 'darwin-arm64', version: '4.2.0-1', size: 10_144_816, updatedAt: '' };

describe('componentHelp', () => {
  it('says what turning it on costs, then how far the download is', () => {
    expect(componentHelp(base)).toBe('Needs a 10 MB download.');
    expect(componentHelp({ ...base, size: 101_424 })).toBe('Needs a 0.1 MB download.');
    expect(componentHelp({ ...base, state: 'downloading', progress: { done: 4_200_000, total: 10_144_816 } })).toBe('Downloading, 4.2 of 10 MB.');
    expect(componentHelp({ ...base, state: 'downloading', progress: { done: 0, total: null }, size: undefined })).toBe('Downloading...');
    expect(componentHelp({ ...base, state: 'installing' })).toBe('Installing...');
  });

  it('says so while another Walnut process holds the install, and stays busy (polling) meanwhile', () => {
    expect(componentHelp({ ...base, state: 'waiting' })).toBe('Another Walnut process is downloading it.');
    for (const state of ['waiting', 'downloading', 'installing'] as const) expect(componentBusy({ ...base, state })).toBe(true);
    for (const state of ['missing', 'ready', 'failed', 'unsupported'] as const) expect(componentBusy({ ...base, state })).toBe(false);
    expect(componentBusy(null)).toBe(false);
  });

  it('names the reason of a failure, and says nothing once ready', () => {
    expect(componentHelp({ ...base, state: 'failed', error: 'Download answered HTTP 404' })).toBe('The download failed: Download answered HTTP 404');
    expect(componentHelp({ ...base, state: 'unsupported' })).toBe('Not available on this system.');
    expect(componentHelp({ ...base, state: 'ready' })).toBe('');
    expect(componentHelp(null)).toBe('');
  });

  it('keeps asking while the state can change on its own: fast while downloading, slowly while missing or failed', () => {
    expect(componentPollMs({ ...base, state: 'downloading' })).toBe(1000);
    expect(componentPollMs({ ...base, state: 'waiting' })).toBe(1000);
    // The server starts a download itself when a feature needs it, and retries a failure.
    expect(componentPollMs({ ...base, state: 'missing' })).toBe(5000);
    expect(componentPollMs({ ...base, state: 'failed' })).toBe(5000);
    expect(componentPollMs({ ...base, state: 'ready' })).toBeNull();
    expect(componentPollMs({ ...base, state: 'unsupported' })).toBeNull();
    expect(componentPollMs(null)).toBeNull();
  });
});
