/**
 * Each feature works from its downloaded component: the real archives
 * (scripts/components/recipes.ts, built here from this machine's node_modules
 * for this machine's platform), served by a local release server, installed
 * into a temp data home through the same calls the settings rows make, then the
 * feature's own code runs on them with node_modules out of the picture
 * (WALNUT_COMPONENTS_FROM=download).
 *
 * The real embed worker embeds text with a model when WALNUT_COMPONENTS_MODEL_TEST=1
 * (it fetches a 17 MB model from Hugging Face into a temp cache once); without
 * it, the embedding case runs the component's onnxruntime on a one-node model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharpForTest from 'sharp';
import { buildArchive, nodeModulesSource, RECIPES } from '../../../scripts/components/recipes.js';
import { smokeComponent } from '../../../src/core/components/smoke.js';
import {
  componentStatus, ensureComponent, initComponents, resetComponentsForTests, resolveComponent,
} from '../../../src/core/components/index.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { currentPlatform, resetPlatformForTests } from '../../../src/core/components/platform.js';
import type { ComponentName, ComponentsManifest, Platform } from '../../../src/core/components/types.js';
import { startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const ENV = ['WALNUT_COMPONENTS_DIR', 'WALNUT_COMPONENTS_FROM', 'WALNUT_COMPONENTS_BASE_URL'];
const saved: Record<string, string | undefined> = {};
let srv: ReleaseServer;
let platform: Platform | null = null;
const built = new Set<ComponentName>();

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  srv = await startReleaseServer();
  platform = await currentPlatform();
  const empty = { version: '0.0.0', tag: 'none', entry: '', packages: {}, platforms: {} };
  const manifest: ComponentsManifest = { schema: 1, repo: 'example/none', components: { embedding: empty, images: empty, 'audio-capture': empty } };
  const source = nodeModulesSource(path.join(REPO, 'node_modules'));
  for (const name of ['embedding', 'images', 'audio-capture'] as const) {
    const recipe = RECIPES[name];
    if (!platform || !recipe.platforms.includes(platform)) continue;
    const b = await buildArchive(recipe, platform, source);
    srv.serve(b.asset, b.archive);
    manifest.components[name] = { version: b.version, tag: `component-${name}-${b.version}`, entry: recipe.entry, packages: {}, platforms: { [platform]: b.entry } };
    built.add(name);
  }
  setManifestForTests(manifest);
  process.env.WALNUT_COMPONENTS_DIR = tmpDir('walnut-comp-home-');
  process.env.WALNUT_COMPONENTS_FROM = 'download';
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
  resetComponentsForTests({ backoffMs: 50 });
  await initComponents();
}, 180_000);

afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setManifestForTests(undefined);
  resetComponentsForTests();
  resetPlatformForTests();
  await srv?.close();
});

describe('image resizing from the images component', () => {
  it('the first image that needs resizing downloads it, and is resized by it', async () => {
    if (!built.has('images')) return;
    expect(componentStatus('images').state).toBe('missing');
    const { compressForApi, MAX_IMAGE_DIMENSION } = await import('../../../src/utils/image-compress.js');
    const png = await sharpForTest({ create: { width: 3000, height: 2000, channels: 3, background: '#2a6' } }).png().toBuffer();
    const out = await compressForApi(png, 'image/png');
    expect(out.mimeType).toBe('image/jpeg');
    const meta = await sharpForTest(out.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(MAX_IMAGE_DIMENSION);
    // It was the component's sharp, not the repo's.
    const loaded = resolveComponent('images');
    expect(loaded?.source).toBe('installed');
    if (loaded?.source !== 'installed') return;
    expect(fs.realpathSync(loaded.require.resolve('sharp')).startsWith(fs.realpathSync(loaded.dir))).toBe(true);
    expect(srv.requests.filter((r) => r.url.includes('walnut-images-'))).toHaveLength(1);
  }, 120_000);
});

describe('search by meaning from the embedding component', () => {
  it('installs when turned on, and its onnxruntime runs a model', async () => {
    if (!built.has('embedding')) return;
    expect(componentStatus('embedding').state).toBe('missing');
    expect(await ensureComponent('embedding', 'user')).toMatchObject({ state: 'ready', source: 'installed' });
    const loaded = resolveComponent('embedding');
    if (loaded?.source !== 'installed') throw new Error('embedding is not installed');
    expect(await smokeComponent('embedding', loaded)).toMatch(/onnxruntime ran a model/);
  }, 120_000);

  it.runIf(process.env.WALNUT_COMPONENTS_MODEL_TEST === '1')('the real embed worker embeds text with the component as its library', async () => {
    const loaded = resolveComponent('embedding');
    if (loaded?.source !== 'installed') throw new Error('embedding is not installed');
    const { createEmbedder, cosineInt8 } = await import('../../../src/lib/hybrid-search/embedder.js');
    const onBun = !!process.versions.bun;
    const embedder = createEmbedder({
      modelId: 'Xenova/paraphrase-MiniLM-L3-v2',
      dims: 384,
      cacheDir: path.join(os.tmpdir(), 'walnut-components-model-cache'),
      workerPath: path.join(REPO, 'src', 'lib', 'hybrid-search', 'embed-worker.ts'),
      // The worker entry is TypeScript here: bun runs it as is, node through tsx.
      workerLauncher: { execPath: process.execPath, execArgv: onBun ? [] : ['--import', 'tsx'] },
      moduleUrl: () => resolveComponent('embedding')?.source === 'installed' ? loaded.entryUrl : null,
    }, () => {});
    try {
      expect(embedder.available()).toBe(true);
      const [cat, kitten, invoice] = await embedder.embedPassages(['a cat sleeps on the sofa', 'a kitten naps on the couch', 'quarterly invoice totals']);
      expect(cat.length).toBe(384);
      expect(cosineInt8(cat, kitten)).toBeGreaterThan(cosineInt8(cat, invoice));
    } finally {
      await embedder.dispose();
    }
  }, 300_000);

  it('before its component is there, the embedder starts no worker and says it is unavailable', async () => {
    const { createEmbedder } = await import('../../../src/lib/hybrid-search/embedder.js');
    const embedder = createEmbedder({ modelId: 'none', dims: 4, moduleUrl: () => null, workerPath: path.join(REPO, 'nope.js') }, () => {});
    expect(embedder.available()).toBe(false);
    expect(await embedder.embedQuery('anything', 200)).toBeNull();
    await expect(embedder.embedPassages(['x'])).rejects.toMatchObject({ embedFailure: 'unavailable' });
    await embedder.dispose();
  });
});

describe('audio capture from the audio-capture component', () => {
  it('is unavailable until downloaded, then the capture addon loads from it', async () => {
    if (!built.has('audio-capture')) return;
    const { audioCaptureService } = await import('../../../src/core/audio-capture.js');
    expect(audioCaptureService.isAvailable()).toBe(false);
    expect((await ensureComponent('audio-capture', 'user')).state).toBe('ready');
    expect(audioCaptureService.isAvailable()).toBe(true);
    const loaded = resolveComponent('audio-capture');
    if (loaded?.source !== 'installed') throw new Error('audio capture is not installed');
    expect(fs.realpathSync(loaded.require.resolve('screencapturekit-audio-capture')).startsWith(fs.realpathSync(loaded.dir))).toBe(true);
  }, 60_000);
});

describe('the compiled file\'s selftest lines (src/core/components/selftest.ts)', () => {
  it('each installed component answers one real call through its feature', async () => {
    const { componentSelftest } = await import('../../../src/core/components/selftest.js');
    // The real embed worker, run the way the embedder runs it (TypeScript here: bun as is, node through tsx).
    const embedWorker = {
      path: path.join(REPO, 'src', 'lib', 'hybrid-search', 'embed-worker.ts'),
      execPath: process.execPath,
      execArgv: process.versions.bun ? [] : ['--import', 'tsx'],
    };
    for (const name of built) {
      const said = await componentSelftest(name, { embedWorker });
      const loaded = resolveComponent(name);
      if (loaded?.source !== 'installed') throw new Error(`${name} is not installed`);
      expect(said.startsWith(loaded.dir)).toBe(true);
      if (name === 'embedding') expect(said).toMatch(/the embed worker loads it and ran a model/);
      if (name === 'images') expect(said).toMatch(/compressForApi made 1568x\d+ image\/jpeg/);
      if (name === 'audio-capture') expect(said).toMatch(/its probe child/);
    }
  }, 60_000);
});

describe('the data home', () => {
  it('holds only finished installs, one version each, and no leftover archives', () => {
    const root = process.env.WALNUT_COMPONENTS_DIR!;
    for (const name of built) {
      const versions = fs.readdirSync(path.join(root, name));
      expect(versions).toHaveLength(1);
      expect(fs.existsSync(path.join(root, name, versions[0], platform!, '.component.json'))).toBe(true);
    }
    expect(fs.readdirSync(path.join(root, '.downloads'))).toEqual([]);
  });
});
