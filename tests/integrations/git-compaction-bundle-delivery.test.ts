/**
 * Compaction delivers its rewritten chain to a Walnut hub as a THIN bundle.
 *
 * 2026-11-25: the data repo passed 4 GB and compaction failed every day with
 * "HTTP 413 bundle exceeds size budget". The new chain shares no commit with
 * the hub, so the bundle carried every blob again, although every tree it
 * points at was already on the hub. These tests run the REAL hub router and a
 * real compaction, and check the bundle carries only what the hub lacks.
 *
 * The class guard at the end: every non-fast-forward (rewrite) bundle push in
 * src/ must say what the hub already holds, or a new rewrite path would ship
 * the whole repo again.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

const execFileAsync = promisify(execFile);

vi.mock('../../src/constants.js', () => createMockConstants('walnut-compact-bundle'));

import { WALNUT_HOME } from '../../src/constants.js';
import { compactGitHistory } from '../../src/integrations/git-compaction.js';
import { pushViaBundle } from '../../src/integrations/git-bundle-client.js';
import { createDevice, _resetDeviceAuthForTesting } from '../../src/core/device-auth.js';
import { _resetBundlePushForTesting } from '../../src/web/routes/git-bundle-push.js';

let server: HttpServer;
let tmpRoot: string;
let remoteUrl: string;
let hubRepo: string;
const declaredBytes: number[] = [];

const BLOB_BYTES = 40_000;
const COMMITS = 120;

async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
  });
  return stdout.trim();
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-compact-bundle-'));
  const hubDir = path.join(tmpRoot, 'hub');
  hubRepo = path.join(hubDir, 'walnut-data.git');
  await fs.mkdir(hubDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', hubRepo], tmpRoot);
  // The production condition: a full-history push never lands.
  await git(['-C', hubRepo, 'config', 'http.receivepack', 'false'], tmpRoot);
  process.env.WALNUT_GIT_HUB_DIR = hubDir;

  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();
  await git(['init', '-b', 'main'], WALNUT_HOME);
  await git(['config', 'user.email', 't@t'], WALNUT_HOME);
  await git(['config', 'user.name', 't'], WALNUT_HOME);
  // Incompressible blobs over 60 days, so a full bundle is ~COMMITS * BLOB_BYTES.
  for (let i = 0; i < COMMITS; i++) {
    const iso = new Date(Date.now() - (60 - (i * 60) / COMMITS) * 86_400_000).toISOString();
    await fs.writeFile(path.join(WALNUT_HOME, `f${i}.bin`), crypto.randomBytes(BLOB_BYTES));
    await git(['add', '-A'], WALNUT_HOME);
    await git(['commit', '-q', '-m', `c${i}`], WALNUT_HOME, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  }
  await git(['push', '-q', hubRepo, 'main'], WALNUT_HOME);

  const { default: express } = await import('express');
  const { gitHttpRouter } = await import('../../src/web/routes/git-http.js');
  const app = express();
  // Record what each bundle declares at start: the size the hub is asked to take.
  app.use('/git/data', (req, _res, next) => {
    if (req.path.endsWith('/bundle/start') && req.query.bytes) declaredBytes.push(Number(req.query.bytes));
    next();
  });
  app.use('/git/data', gitHttpRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const device = await createDevice('compact-bundle-test');
  remoteUrl = `http://walnut:${device.token}@127.0.0.1:${addr.port}/git/data`;
  await git(['remote', 'add', 'origin', remoteUrl], WALNUT_HOME);
  await git(['fetch', '-q', 'origin', 'main'], WALNUT_HOME);
  await git(['branch', '-u', 'origin/main', 'main'], WALNUT_HOME);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await _resetBundlePushForTesting();
  delete process.env.WALNUT_GIT_HUB_DIR;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('compaction delivery to a Walnut hub', () => {
  it('ships only new commit objects and local-only blobs, and the hub takes the rewritten chain', async () => {
    // One commit the hub does not have yet: its blob must travel.
    await fs.writeFile(path.join(WALNUT_HOME, 'local-only.bin'), crypto.randomBytes(BLOB_BYTES));
    await git(['add', '-A'], WALNUT_HOME);
    await git(['commit', '-q', '-m', 'local only'], WALNUT_HOME);
    const localOnlyBlob = await git(['rev-parse', 'main:local-only.bin'], WALNUT_HOME);

    const { log } = await import('../../src/logging/index.js');
    const said: unknown[] = [];
    vi.spyOn(log.git, 'warn').mockImplementation((...a: unknown[]) => { said.push(a); });
    vi.spyOn(log.git, 'info').mockImplementation((...a: unknown[]) => { said.push(a); });
    const result = await compactGitHistory(WALNUT_HOME);
    if (result.skipped || result.error) throw new Error(`compaction did not run: ${JSON.stringify({ result, said })}`);

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(result.after).toBeLessThan(result.before);
    const head = await git(['rev-parse', 'main'], WALNUT_HOME);
    expect(await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot)).toBe(head);
    // The hub's new main is complete: every object reachable from it is there.
    await git(['-C', hubRepo, 'fsck', '--connectivity-only', '--no-dangling', 'main'], tmpRoot);
    expect(await git(['-C', hubRepo, 'cat-file', '-t', localOnlyBlob], tmpRoot)).toBe('blob');

    // One bundle: the local-only blob plus commits and small trees, never the
    // ~COMMITS * BLOB_BYTES a self-contained bundle carries (the 413 cause).
    expect(declaredBytes).toHaveLength(1);
    expect(declaredBytes[0]).toBeLessThan(BLOB_BYTES * 3);
    expect(declaredBytes[0]).toBeGreaterThan(BLOB_BYTES); // the local-only blob did travel
  }, 120_000);
});

describe('a wrong claim of what the hub holds', () => {
  it('is refused by the hub: its main does not move to a chain missing objects', async () => {
    // A commit whose tree the hub has never seen, claimed as if it had it.
    await fs.writeFile(path.join(WALNUT_HOME, 'never-sent.bin'), crypto.randomBytes(BLOB_BYTES));
    await git(['add', '-A'], WALNUT_HOME);
    await git(['commit', '-q', '-m', 'never sent'], WALNUT_HOME);
    const hubBefore = await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot);
    const tree = await git(['rev-parse', 'main^{tree}'], WALNUT_HOME);
    const orphan = await git(['commit-tree', tree, '-m', 'rewritten'], WALNUT_HOME);
    await git(['update-ref', 'refs/heads/claim-test', orphan], WALNUT_HOME);

    const res = await pushViaBundle({
      repoDir: WALNUT_HOME, branch: 'claim-test', remoteUrl,
      oldValue: '', remoteHas: [`${orphan}^{tree}`], allowNonFastForward: true,
    });

    expect(res.ok).toBe(false);
    expect(await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot)).toBe(hubBefore);
    await expect(git(['-C', hubRepo, 'rev-parse', '--verify', 'refs/heads/claim-test'], tmpRoot)).rejects.toThrow();
  }, 120_000);
});

describe('class guard: rewrite bundle pushes name what the hub holds', () => {
  it('every allowNonFastForward pushViaBundle call in src/ passes remoteHas', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          const src = fsSync.readFileSync(p, 'utf-8');
          // Comments stripped, so a mention in prose does not satisfy it.
          const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
          for (const m of code.matchAll(/(?<!function )pushViaBundle\(([^)]*)\)/g)) {
            const args = m[1];
            // Options passed as a variable or spread cannot be read here: name them inline.
            if (!/^\s*\{/.test(args) || /\.\.\./.test(args)) { offenders.push(`${path.relative(root, p)} (options not inline)`); continue; }
            if (/allowNonFastForward:\s*true/.test(args) && !/\bremoteHas\b(?!\s*:\s*\[\s*\])/.test(args)) {
              offenders.push(path.relative(root, p));
            }
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
