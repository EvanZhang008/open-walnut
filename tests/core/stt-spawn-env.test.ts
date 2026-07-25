/**
 * spawn-env: augmented PATH for STT child processes.
 *
 * Regression guard for the launchd incident — when Walnut runs under a
 * process manager the inherited PATH is minimal (/usr/bin:/bin:...) and
 * whisper-server's internal `sh -c ffmpeg` probe fails, making the daemon
 * exit code 0 within ~1s. The augmented PATH must add the configured
 * binary's own prefix + common install dirs without disturbing the
 * inherited order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { augmentedPath, sttSpawnEnv } from '../../src/core/stt/spawn-env.js';

const ORIGINAL_PATH = process.env.PATH;

describe('stt spawn-env', () => {
  beforeEach(() => {
    // Simulate the launchd-minimal PATH that triggered the incident.
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  });

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  it('appends common install prefixes missing from a minimal PATH', () => {
    const path = augmentedPath();
    const parts = path.split(':');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
    expect(parts).toContain(join(homedir(), '.local', 'bin'));
  });

  it('keeps the inherited PATH first so explicit user setup wins', () => {
    const parts = augmentedPath().split(':');
    expect(parts.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('prepends extraDirs (binary prefix) before common dirs, without duplicates', () => {
    const parts = augmentedPath(['/custom/prefix/bin', '/opt/homebrew/bin']).split(':');
    expect(parts).toContain('/custom/prefix/bin');
    // No duplicate even though /opt/homebrew/bin is both extra and common.
    expect(parts.filter(p => p === '/opt/homebrew/bin')).toHaveLength(1);
    // extraDirs come before the common prefixes.
    expect(parts.indexOf('/custom/prefix/bin')).toBeLessThan(parts.indexOf('/usr/local/bin'));
  });

  it('does not duplicate dirs already present in the inherited PATH', () => {
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    const parts = augmentedPath().split(':');
    expect(parts.filter(p => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('sttSpawnEnv returns a full env copy with the augmented PATH', () => {
    const env = sttSpawnEnv(['/custom/bin']);
    expect(env.PATH).toContain('/custom/bin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.HOME).toBe(process.env.HOME);
    // Must be a copy — mutating it must not touch process.env.
    env.PATH = 'clobbered';
    expect(process.env.PATH).not.toBe('clobbered');
  });

  it('handles an empty PATH gracefully', () => {
    delete process.env.PATH;
    const parts = augmentedPath().split(':');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts[0]).not.toBe(''); // no leading empty segment
  });
});
