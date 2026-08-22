/**
 * Sync-tick bundle fallback (T65): when `git push origin` fails
 * PUSH_FAILURES_FOR_BUNDLE times in a row, the delta is delivered through the
 * chunked bundle channel instead of retrying into the same wall forever.
 *
 * Real everything: a real express server mounting the REAL gitHttpRouter
 * (auth + bundle routes), a real bare hub, and real sync() runs on a real
 * client repo. The dead-push-channel condition is simulated the honest way:
 * `http.receivepack=false` on the hub refuses every smart-HTTP push (exactly
 * what a TLS-filter kill looks like to the client: push never lands), while
 * the bundle channel — which imports via `git fetch` + `update-ref`, not
 * receive-pack — keeps working. That asymmetry IS the production scenario.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const execFileAsync = promisify(execFile);

vi.mock('../../src/constants.js', () => createMockConstants('walnut-sync-bundle-fb'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  sync,
  resetSyncGuardForTest,
  PUSH_FAILURES_FOR_BUNDLE,
} from '../../src/integrations/git-sync.js';
import { createDevice, _resetDeviceAuthForTesting } from '../../src/core/device-auth.js';
import { _resetBundlePushForTesting } from '../../src/web/routes/git-bundle-push.js';

let server: HttpServer;
let port: number;
let tmpRoot: string;
let hubRepo: string;
let deviceToken: string;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return stdout.trim();
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-sync-bundle-'));
  const hubDir = path.join(tmpRoot, 'hub');
  hubRepo = path.join(hubDir, 'walnut-data.git');
  await fs.mkdir(hubDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', hubRepo], tmpRoot);
  // The dead push channel: smart-HTTP receive-pack refused for everyone.
  await git(['-C', hubRepo, 'config', 'http.receivepack', 'false'], tmpRoot);
  process.env.WALNUT_GIT_HUB_DIR = hubDir;

  // Client repo = WALNUT_HOME (what sync() operates on).
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();
  await git(['init', '-b', 'main'], WALNUT_HOME);
  await git(['config', 'user.email', 't@t'], WALNUT_HOME);
  await git(['config', 'user.name', 't'], WALNUT_HOME);
  await fs.writeFile(path.join(WALNUT_HOME, 'seed.md'), 'seed\n');
  await git(['add', '-A'], WALNUT_HOME);
  await git(['commit', '-q', '-m', 'seed'], WALNUT_HOME);
  // Seed the hub over the FILE protocol (http.receivepack only gates HTTP),
  // so pulls have a main to track from the first sync cycle.
  await git(['push', hubRepo, 'main'], WALNUT_HOME);

  // Slim harness: the REAL router (auth included), none of the server loops.
  const { default: express } = await import('express');
  const { gitHttpRouter } = await import('../../src/web/routes/git-http.js');
  const app = express();
  app.use('/git/data', gitHttpRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;

  const device = await createDevice('sync-bundle-fb-test');
  deviceToken = device.token;
  await git(['remote', 'add', 'origin', `http://walnut:${deviceToken}@127.0.0.1:${port}/git/data`], WALNUT_HOME);
  await git(['fetch', 'origin', 'main'], WALNUT_HOME);
  await git(['branch', '-u', 'origin/main', 'main'], WALNUT_HOME);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await _resetBundlePushForTesting();
  delete process.env.WALNUT_GIT_HUB_DIR;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('sync push-failure streak → bundle fallback', () => {
  it(`delivers via bundle after ${PUSH_FAILURES_FOR_BUNDLE} consecutive push failures`, async () => {
    resetSyncGuardForTest();

    // Below the streak threshold: pushes fail, hub must NOT move.
    const hubTipBefore = await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot);
    for (let i = 1; i < PUSH_FAILURES_FOR_BUNDLE; i++) {
      await fs.writeFile(path.join(WALNUT_HOME, `change-${i}.md`), `edit ${i}\n`);
      await sync();
      expect(await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot)).toBe(hubTipBefore);
    }

    // The streak-completing cycle: fallback fires, delta lands on the hub.
    await fs.writeFile(path.join(WALNUT_HOME, 'change-final.md'), 'final edit\n');
    await sync();

    const localTip = await git(['rev-parse', 'main'], WALNUT_HOME);
    const hubTipAfter = await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot);
    expect(hubTipAfter).toBe(localTip);
    expect(hubTipAfter).not.toBe(hubTipBefore);
    // The delivered history contains the seed — the bundle was a proper delta
    // on top of the hub's existing chain, not a divergent rewrite.
    await git(['-C', hubRepo, 'merge-base', '--is-ancestor', hubTipBefore, 'main'], tmpRoot);
  }, 60_000);

  it('a successful cycle resets the streak (no bundle spam once pushes recover)', async () => {
    // Re-enable receive-pack: pushes work again.
    await git(['-C', hubRepo, 'config', 'http.receivepack', 'true'], tmpRoot);
    await fs.writeFile(path.join(WALNUT_HOME, 'recovered.md'), 'normal push again\n');
    const result = await sync();
    expect(result.pushed).toBe(1);
    expect(await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot))
      .toBe(await git(['rev-parse', 'main'], WALNUT_HOME));
  }, 60_000);
});

describe('compaction force-push → bundle fallback (the weekly production scenario)', () => {
  it('delivers the rewritten history via bundle when the push channel is dead', async () => {
    // A dedicated repo with enough compactable history (≥50 commits, >10% cut).
    const repo = path.join(tmpRoot, 'compact-client');
    await fs.mkdir(repo, { recursive: true });
    await git(['init', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t'], repo);
    await git(['config', 'user.name', 't'], repo);
    for (let i = 0; i < 120; i++) {
      const daysAgo = 60 - (i * 60) / 120;
      const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      await fs.writeFile(path.join(repo, 'data.txt'), `v${i}\n`);
      await execFileAsync('git', ['add', '-A'], { cwd: repo });
      await execFileAsync('git', ['commit', '-q', '-m', `c${i}`], {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
    }
    // Seed the hub with this history over file:// (last test re-enabled
    // receivepack but we're about to kill it again anyway).
    await git(['push', '--force', hubRepo, 'main'], repo);
    await git(['remote', 'add', 'origin', `http://walnut:${deviceToken}@127.0.0.1:${port}/git/data`], repo);
    await git(['fetch', 'origin', 'main'], repo);
    // Kill the push channel — the TLS-filter scenario (push can never land).
    await git(['-C', hubRepo, 'config', 'http.receivepack', 'false'], tmpRoot);

    // Compaction is execSync-based, and the hub server lives in THIS process:
    // a synchronous `git fetch` would block the event loop while git waits for
    // our own HTTP response (deadlock → bogus "remote unreachable" defer). So
    // run it in a child process — exactly how production runs it (the
    // compaction worker is a forked child; see src/workers/).
    const runner = path.join(tmpRoot, 'run-compaction.mts');
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    await fs.writeFile(runner, [
      `import { compactGitHistory } from '${repoRoot}/src/integrations/git-compaction.js';`,
      `const result = await compactGitHistory(process.argv[2]);`,
      `console.log('RESULT:' + JSON.stringify(result));`,
    ].join('\n'));
    const { stdout } = await execFileAsync(
      path.join(repoRoot, 'node_modules', '.bin', 'tsx'), [runner, repo],
      { encoding: 'utf-8', timeout: 100_000, env: { ...process.env, OPEN_WALNUT_HOME: path.join(tmpRoot, 'worker-home') } },
    );
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`no RESULT line in worker output: ${stdout.slice(-500)}`);
    const result = JSON.parse(line.slice('RESULT:'.length)) as { skipped?: boolean; before: number; after: number; error?: string };

    // Compaction SUCCEEDED (no rollback) even though `git push` was refused.
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeFalsy();
    expect(result.after).toBeLessThan(result.before);
    // The hub adopted the rewritten chain, byte-identical tree, tips agree.
    const localTip = await git(['rev-parse', 'main'], repo);
    expect(await git(['-C', hubRepo, 'rev-parse', 'main'], tmpRoot)).toBe(localTip);
    expect(await git(['-C', hubRepo, 'rev-parse', 'main^{tree}'], tmpRoot))
      .toBe(await git(['rev-parse', 'main^{tree}'], repo));
  }, 120_000);
});
