/**
 * A daemon spawned before Claude Code is installed is a new user's first run, not an error:
 * error-level logs reach the notification center, and a fresh Walnut's bell read "Errors 2"
 * before the user did anything (2026-11-09 review). A claude the server finds but the daemon's
 * environment would not is still the error it was (the 2026-08-28 outage).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeMissingAtSpawn } from '../../src/providers/local-daemon';

describe('claudeMissingAtSpawn', () => {
  it('resolves in the daemon env: nothing to say, and the server is not asked', () => {
    let asked = false;
    expect(claudeMissingAtSpawn(true, () => { asked = true; return false; })).toBeNull();
    expect(asked).toBe(false);
  });
  it('found nowhere: not installed yet (a warning, Home installs it)', () => {
    expect(claudeMissingAtSpawn(false, () => false)).toBe('not-installed');
  });
  it('found by the server only: the daemon env is wrong (an error)', () => {
    expect(claudeMissingAtSpawn(false, () => true)).toBe('env');
  });
  it('the spawn logs an error only for the env case', () => {
    const src = readFileSync(new URL('../../src/providers/local-daemon.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/log\.session\[missing === 'not-installed' \? 'warn' : 'error'\]/);
    expect(src).not.toMatch(/log\.session\.error\(\s*'spawning the local daemon with an environment/);
  });
});
