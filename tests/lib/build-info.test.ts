/**
 * src/lib/build-info.ts: which build is running. package.json only moves on an
 * npm release, so the commit read from dist/build-info.json is what tells a
 * source checkout of main from the last npm install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILD_INFO_FILE,
  _resetBuildInfoForTest,
  findBuildInfoFile,
  formatBuildVersion,
  getBuildInfo,
  readBuildInfoFile,
} from '../../src/lib/build-info.js';
import { getVersion } from '../../src/core/version.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-info-'));
  _resetBuildInfoForTest();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  _resetBuildInfoForTest();
});

function writeInfo(dir: string, body: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, BUILD_INFO_FILE);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

describe('readBuildInfoFile', () => {
  it('falls back to the given version with nulls when the file is missing', () => {
    expect(readBuildInfoFile(path.join(tmp, BUILD_INFO_FILE), '1.2.3')).toEqual({
      version: '1.2.3', commit: null, branch: null, builtAt: null, dirty: false,
    });
  });

  it('reads every field of a present file', () => {
    const file = writeInfo(tmp, {
      version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: '2026-09-24T12:00:00.000Z', dirty: false,
    });
    expect(readBuildInfoFile(file, '9.9.9')).toEqual({
      version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: '2026-09-24T12:00:00.000Z', dirty: false,
    });
  });

  it('keeps the dirty flag only when it is literally true', () => {
    const base = { version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: '2026-09-24T12:00:00.000Z' };
    expect(readBuildInfoFile(writeInfo(path.join(tmp, 'a'), { ...base, dirty: true }), 'x').dirty).toBe(true);
    expect(readBuildInfoFile(writeInfo(path.join(tmp, 'b'), { ...base, dirty: 'yes' }), 'x').dirty).toBe(false);
    expect(readBuildInfoFile(writeInfo(path.join(tmp, 'c'), base), 'x').dirty).toBe(false);
  });

  it('degrades a malformed file or bad fields instead of throwing', () => {
    expect(readBuildInfoFile(writeInfo(path.join(tmp, 'a'), '{not json'), '1.0.0').version).toBe('1.0.0');
    expect(readBuildInfoFile(writeInfo(path.join(tmp, 'b'), '[1,2]'), '1.0.0').commit).toBeNull();
    const odd = readBuildInfoFile(
      writeInfo(path.join(tmp, 'c'), { version: 7, commit: '', branch: null, builtAt: 'yesterday' }),
      '1.0.0',
    );
    expect(odd).toEqual({ version: '1.0.0', commit: null, branch: null, builtAt: null, dirty: false });
  });
});

describe('findBuildInfoFile', () => {
  it('walks up from a nested bundle dir to dist/build-info.json', () => {
    const file = writeInfo(path.join(tmp, 'pkg', 'dist'), { version: '1.0.0' });
    fs.mkdirSync(path.join(tmp, 'pkg', 'dist', 'web'), { recursive: true });
    expect(findBuildInfoFile(path.join(tmp, 'pkg', 'dist', 'web'))).toBe(file);
    expect(findBuildInfoFile(path.join(tmp, 'pkg', 'dist'))).toBe(file);
  });

  it('stops at the package root, so a source run never reads a leftover dist', () => {
    const root = path.join(tmp, 'pkg');
    writeInfo(path.join(root, 'dist'), { version: '1.0.0', commit: 'stale00' });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'open-walnut' }));
    // A build-info.json ABOVE the package root must not be picked up either.
    writeInfo(tmp, { version: '0.0.1', commit: 'outside' });
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    expect(findBuildInfoFile(path.join(root, 'src', 'lib'))).toBeNull();
  });
});

describe('getBuildInfo', () => {
  it('running from source reports the package version and no build', () => {
    expect(getBuildInfo()).toEqual({
      version: getVersion(), commit: null, branch: null, builtAt: null, dirty: false,
    });
  });

  it('is read once per process', () => {
    expect(getBuildInfo()).toBe(getBuildInfo());
  });
});

describe('formatBuildVersion', () => {
  const info = { version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: '2026-09-24T12:00:00.000Z', dirty: false };

  it('prints version, commit and build date', () => {
    expect(formatBuildVersion(info)).toBe('0.4.5 (3942cf7, 2026-09-24)');
  });

  it('marks a dirty tree on the commit', () => {
    expect(formatBuildVersion({ ...info, dirty: true })).toBe('0.4.5 (3942cf7+dirty, 2026-09-24)');
  });

  it('drops what is unknown', () => {
    expect(formatBuildVersion({ ...info, commit: null })).toBe('0.4.5 (2026-09-24)');
    expect(formatBuildVersion({ ...info, commit: null, builtAt: null })).toBe('0.4.5');
  });
});
