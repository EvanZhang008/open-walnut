/**
 * The Microsoft To Do sign-in cache lives in secrets/, which git-sync never
 * commits. It used to live in sync/, where its atomic-write temp reached the
 * data repo on 2026-07-26. A cache an older Walnut wrote in sync/ is still read,
 * and the newer of the two wins, so neither an upgrade nor a downgrade signs out.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mstodo-tokens-test'));

import { WALNUT_HOME, SYNC_DIR } from '../../src/constants.js';
import { readMsTodoTokenCacheForTest } from '../../src/integrations/microsoft-todo.js';

const legacy = () => path.join(SYNC_DIR, 'ms-todo-tokens.json');
const current = () => path.join(WALNUT_HOME, 'secrets', 'ms-todo-tokens.json');
const cache = (n: number) => ({ accessToken: `opaque-${n}`, expiresAt: '2030-01-01T00:00:00.000Z', msalCache: '{}' });
function writeAt(file: string, data: unknown, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe('Microsoft To Do sign-in cache location', () => {
  it('an upgrade copies the sync/ cache into secrets/ (owner-only) and leaves the old file for a downgrade', async () => {
    writeAt(legacy(), cache(1), Date.now() - 60_000);

    expect(await readMsTodoTokenCacheForTest()).toEqual(cache(1));

    expect(JSON.parse(fs.readFileSync(current(), 'utf-8'))).toEqual(cache(1));
    expect(fs.statSync(current()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.readdirSync(path.dirname(current())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(SYNC_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the newer cache wins: secrets/ normally, sync/ after a downgrade wrote it', async () => {
    writeAt(legacy(), cache(1), Date.now() - 120_000);
    writeAt(current(), cache(2), Date.now() - 60_000);
    expect(await readMsTodoTokenCacheForTest()).toEqual(cache(2));

    writeAt(legacy(), cache(3), Date.now());
    expect(await readMsTodoTokenCacheForTest()).toEqual(cache(3));
    expect(JSON.parse(fs.readFileSync(current(), 'utf-8'))).toEqual(cache(3));
  });

  it('reads nothing when neither place has a cache', async () => {
    fs.rmSync(legacy(), { force: true });
    fs.rmSync(current(), { force: true });
    expect(await readMsTodoTokenCacheForTest()).toBeNull();
  });
});
