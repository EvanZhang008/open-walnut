/**
 * Ask Walnut launch memory (src/core/sessions/ask-walnut-launch.ts).
 *
 * The Personal AI's first-run defaults (Auto model, medium effort) are just
 * that — first-run. Every pick the user makes FOR an Ask Walnut session moves
 * the memory this module owns, and the next launch starts on it. Pinned here:
 *   - each field is remembered independently; an omitted key is untouched
 *   - Auto ('default' / '' / undefined) CLEARS the model — remembering the reset
 *   - an unknown effort level is IGNORED (garbage must not wipe a pick)
 *   - a corrupt/garbage file reads as "no memory", never throws
 *   - an unchanged pick writes nothing (the file lives in the synced data dir)
 *   - the remembered effort only rides a launch whose model can take it
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-launch'));

const { ASK_WALNUT_LAUNCH_FILE, WALNUT_HOME } = await import('../../src/constants.js');
const {
  getAskWalnutLaunchPrefs, rememberAskWalnutLaunch, resolveAskWalnutEffort,
} = await import('../../src/core/sessions/ask-walnut-launch.js');

beforeEach(() => {
  fs.rmSync(ASK_WALNUT_LAUNCH_FILE, { force: true });
});

afterAll(() => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true });
});

describe('store', () => {
  it('is empty before any pick (first-run defaults apply)', async () => {
    expect(await getAskWalnutLaunchPrefs()).toEqual({});
  });

  it('remembers model and effort independently — an omitted key is untouched', async () => {
    await rememberAskWalnutLaunch({ model: 'sonnet' });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ model: 'sonnet' });
    await rememberAskWalnutLaunch({ effort: 'high' });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ model: 'sonnet', effort: 'high' });
    await rememberAskWalnutLaunch({ model: 'haiku' });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ model: 'haiku', effort: 'high' });
  });

  it("clears the model on an explicit Auto ('default' / '' / undefined) but keeps the effort", async () => {
    await rememberAskWalnutLaunch({ model: 'sonnet', effort: 'low' });
    await rememberAskWalnutLaunch({ model: 'default' });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ effort: 'low' });
    await rememberAskWalnutLaunch({ model: 'sonnet' });
    await rememberAskWalnutLaunch({ model: '' });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ effort: 'low' });
    await rememberAskWalnutLaunch({ model: 'sonnet' });
    await rememberAskWalnutLaunch({ model: undefined });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ effort: 'low' });
  });

  it('ignores an effort that is not a known level; only null/undefined clears', async () => {
    await rememberAskWalnutLaunch({ effort: 'high' });
    await rememberAskWalnutLaunch({ effort: 'turbo' as never });
    expect(await getAskWalnutLaunchPrefs()).toEqual({ effort: 'high' });
    await rememberAskWalnutLaunch({ effort: null });
    expect(await getAskWalnutLaunchPrefs()).toEqual({});
  });

  it('reads a corrupt or foreign-shaped file as no memory', async () => {
    fs.mkdirSync(WALNUT_HOME, { recursive: true });
    fs.writeFileSync(ASK_WALNUT_LAUNCH_FILE, '{ not json');
    expect(await getAskWalnutLaunchPrefs()).toEqual({});
    fs.writeFileSync(ASK_WALNUT_LAUNCH_FILE, JSON.stringify({ version: 7, model: 'x', effort: 'high' }));
    expect(await getAskWalnutLaunchPrefs()).toEqual({});
    fs.writeFileSync(ASK_WALNUT_LAUNCH_FILE, JSON.stringify({ version: 1, model: 42, effort: 'bogus' }));
    expect(await getAskWalnutLaunchPrefs()).toEqual({});
  });

  it('writes nothing when the pick changes nothing (no sync churn)', async () => {
    await rememberAskWalnutLaunch({ model: 'sonnet', effort: 'high' });
    const before = fs.readFileSync(ASK_WALNUT_LAUNCH_FILE, 'utf-8');
    await new Promise((r) => setTimeout(r, 5));
    await rememberAskWalnutLaunch({ model: 'sonnet' });
    await rememberAskWalnutLaunch({ effort: 'high' });
    expect(fs.readFileSync(ASK_WALNUT_LAUNCH_FILE, 'utf-8')).toBe(before);
    // An empty store stays absent — no file is minted just to say "nothing".
    fs.rmSync(ASK_WALNUT_LAUNCH_FILE);
    await rememberAskWalnutLaunch({ model: undefined, effort: undefined });
    expect(fs.existsSync(ASK_WALNUT_LAUNCH_FILE)).toBe(false);
  });

  it('serializes concurrent writers — neither field is lost to a stale read', async () => {
    await Promise.all([
      rememberAskWalnutLaunch({ model: 'opus' }),
      rememberAskWalnutLaunch({ effort: 'xhigh' }),
    ]);
    expect(await getAskWalnutLaunchPrefs()).toEqual({ model: 'opus', effort: 'xhigh' });
  });
});

describe('resolveAskWalnutEffort', () => {
  it('falls back to the lane default when nothing is remembered', () => {
    expect(resolveAskWalnutEffort(undefined, undefined, 'medium')).toBe('medium');
    expect(resolveAskWalnutEffort(undefined, 'sonnet', 'medium')).toBe('medium');
  });

  it('carries the remembered effort on Auto (the CLI resolves the model and downgrades itself if needed)', () => {
    expect(resolveAskWalnutEffort('xhigh', undefined, 'medium')).toBe('xhigh');
    expect(resolveAskWalnutEffort('max', undefined, 'medium')).toBe('max');
  });

  it('carries the remembered effort when the explicit model supports it', () => {
    expect(resolveAskWalnutEffort('high', 'sonnet', 'medium')).toBe('high');
    expect(resolveAskWalnutEffort('max', 'opus', 'medium')).toBe('max');
  });

  it('falls back when the explicit model cannot take the remembered level', () => {
    // xhigh arrived after Opus 4.6; max is not a Haiku thing.
    expect(resolveAskWalnutEffort('xhigh', 'claude-opus-4-6', 'medium')).toBe('medium');
    expect(resolveAskWalnutEffort('max', 'haiku', 'medium')).toBe('medium');
  });
});
