/**
 * Where an external plugin's `../../core/x.js` imports get rebased.
 *
 * The running package is not always next to a `src/` tree: a production deploy runs a
 * STAGED copy of dist/ on the temp volume with a `.walnut-source-root` marker pointing at
 * the checkout. The loader used to derive the source tree from its own location and fail
 * every parent import on that shape (an external tracker plugin sat quarantined for two
 * weeks). These pin the candidate order and the validation of each candidate.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePluginSourceTree } from '../../src/core/plugins/plugin-source-tree.js';

let tmp: string;

async function mkCheckout(name: string): Promise<string> {
  const root = path.join(tmp, name);
  await fsp.mkdir(path.join(root, 'src', 'integrations'), { recursive: true });
  return root;
}

async function mkStage(name: string, sourceRoot?: string): Promise<string> {
  const root = path.join(tmp, name);
  await fsp.mkdir(path.join(root, 'dist', 'integrations'), { recursive: true });
  if (sourceRoot !== undefined) await fsp.writeFile(path.join(root, '.walnut-source-root'), `${sourceRoot}\n`);
  return root;
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-src-tree-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('resolvePluginSourceTree', () => {
  it('dev checkout: the running package is the source tree', async () => {
    const repo = await mkCheckout('repo');
    expect(resolvePluginSourceTree(repo, null)).toEqual({
      srcIntegrationsDir: path.join(repo, 'src', 'integrations'),
      nodeModulesRoot: repo,
    });
  });

  it('staged deploy: follows the .walnut-source-root marker to the checkout', async () => {
    const repo = await mkCheckout('repo');
    const stage = await mkStage('open-walnut-stage.123', repo);
    expect(resolvePluginSourceTree(stage, null)).toEqual({
      srcIntegrationsDir: path.join(repo, 'src', 'integrations'),
      // The bundle still lands in the stage: that is where node_modules is reachable
      // from at runtime (the deploy symlinks it in).
      nodeModulesRoot: stage,
    });
  });

  it('compiled runtime: a checkout with its own node_modules takes the bundle, so its npm imports resolve', async () => {
    const repo = await mkCheckout('repo');
    await fsp.mkdir(path.join(repo, 'node_modules', 'chalk'), { recursive: true });
    // The runtime tree of a compiled file: a few packages of its own, none of the checkout's.
    const runtime = await mkStage('runtime-0.6.19-abc', repo);
    await fsp.mkdir(path.join(runtime, 'node_modules', 'diff'), { recursive: true });
    expect(resolvePluginSourceTree(runtime, null)).toEqual({
      srcIntegrationsDir: path.join(repo, 'src', 'integrations'),
      nodeModulesRoot: repo,
    });
    // The install dir route picks the same.
    const bare = await mkStage('runtime-no-marker');
    expect(resolvePluginSourceTree(bare, repo).nodeModulesRoot).toBe(repo);
  });

  // 2026-10-30: plugins bundled against the checkout read a peer's half-written file and
  // failed; a committed deploy stages its own src/ and names it in .walnut-plugin-source.
  it("committed deploy: the stage's own copy of the source wins over the checkout, from the runtime tree under it", async () => {
    const repo = await mkCheckout('repo');
    const stage = await mkStage('open-walnut-stage.456', repo);
    const committed = path.join(stage, 'plugin-source');
    await fsp.mkdir(path.join(committed, 'src', 'integrations'), { recursive: true });
    await fsp.mkdir(path.join(committed, 'node_modules'), { recursive: true });
    await fsp.writeFile(path.join(stage, '.walnut-plugin-source'), `${committed}\n`);
    const runtime = path.join(stage, 'runtime', '0.6.19-abc');
    await fsp.mkdir(path.join(runtime, 'dist', 'integrations'), { recursive: true });
    await fsp.writeFile(path.join(runtime, '.walnut-source-root'), `${repo}\n`);
    expect(resolvePluginSourceTree(runtime, repo)).toEqual({
      srcIntegrationsDir: path.join(committed, 'src', 'integrations'),
      nodeModulesRoot: committed,
    });
    // A marker naming a copy that is gone falls back to the checkout, as before.
    await fsp.rm(committed, { recursive: true, force: true });
    expect(resolvePluginSourceTree(runtime, repo).srcIntegrationsDir).toBe(path.join(repo, 'src', 'integrations'));
  });

  it('a marker naming a directory without src/ is skipped, not trusted', async () => {
    const repo = await mkCheckout('repo');
    const stage = await mkStage('stage', path.join(tmp, 'moved-away'));
    expect(resolvePluginSourceTree(stage, repo).srcIntegrationsDir).toBe(path.join(repo, 'src', 'integrations'));
  });

  it('falls back to the install dir when there is no marker', async () => {
    const repo = await mkCheckout('repo');
    const stage = await mkStage('stage');
    expect(resolvePluginSourceTree(stage, repo).srcIntegrationsDir).toBe(path.join(repo, 'src', 'integrations'));
  });

  it('the marker wins over the install dir when both are usable', async () => {
    const markerRepo = await mkCheckout('marker-repo');
    const otherRepo = await mkCheckout('other-repo');
    const stage = await mkStage('stage', markerRepo);
    expect(resolvePluginSourceTree(stage, otherRepo).srcIntegrationsDir).toBe(path.join(markerRepo, 'src', 'integrations'));
  });

  it('npm install or cloud bundle: no source tree anywhere reports null instead of guessing', async () => {
    const stage = await mkStage('node_modules-open-walnut');
    expect(resolvePluginSourceTree(stage, null)).toEqual({ srcIntegrationsDir: null, nodeModulesRoot: stage });
  });
});
