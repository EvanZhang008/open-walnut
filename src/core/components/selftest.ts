/**
 * The component lines of `walnut __selftest` (src/binary/selftest.ts): where a
 * feature loads its package from in this process and, once the component is
 * installed, one real call through the feature's own load path. Nothing is
 * downloaded and nothing asks for a permission.
 */

import { spawn } from 'node:child_process';
import { componentStatus, holdComponentInstalls, loadComponent } from './index.js';
import { embeddingThroughWorker, type EmbedWorkerChoice } from './selftest-embedding.js';
import { smokeComponent } from './smoke.js';
import type { ComponentName } from './types.js';

export interface SelftestOptions {
  /** The embed worker to probe, and what runs it (default: this Walnut's own). */
  embedWorker?: EmbedWorkerChoice;
}

/** Throws (a missing component, a failed call) or resolves with what worked. */
export async function componentSelftest(name: ComponentName, opts: SelftestOptions = {}): Promise<string> {
  // A selftest reports; it never starts a download, an upgrade or a repair.
  holdComponentInstalls();
  const loaded = await loadComponent(name);
  if (!loaded) {
    const s = componentStatus(name);
    throw new Error(s.state === 'missing' ? `missing: downloaded the first time ${s.label} is needed` : `${s.state}: ${s.error ?? s.label}`);
  }
  if (loaded.source === 'bundled') return 'from node_modules';
  const said = [await smokeComponent(name, loaded)];
  if (name === 'embedding') said.push(await embeddingThroughWorker(loaded.entryUrl, opts.embedWorker));
  if (name === 'images') said.push(await imagesThroughFeature(loaded.require));
  if (name === 'audio-capture') said.push(await audioThroughFeature(loaded.require));
  return `${loaded.dir}: ${said.join('; ')}`;
}

async function imagesThroughFeature(req: NodeJS.Require): Promise<string> {
  const sharp = req('sharp') as typeof import('sharp');
  const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#2a6' } }).png().toBuffer();
  const { compressForApi, MAX_IMAGE_DIMENSION } = await import('../../utils/image-compress.js');
  const out = await compressForApi(png, 'image/png');
  const meta = await sharp(out.buffer).metadata();
  if (Math.max(meta.width ?? 0, meta.height ?? 0) !== MAX_IMAGE_DIMENSION) throw new Error(`compressForApi left ${meta.width}x${meta.height}`);
  return `compressForApi made ${meta.width}x${meta.height} ${out.mimeType}`;
}

async function audioThroughFeature(req: NodeJS.Require): Promise<string> {
  const { audioCaptureService, addonProbeEnv } = await import('../audio-capture.js');
  if (!audioCaptureService.isAvailable()) throw new Error('the capture service does not load the addon');
  // The permission and app probes run `<execPath> -e <script> <addon>`; the same shape, asking nothing.
  const addon = req.resolve('screencapturekit-audio-capture');
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(typeof require(process.argv[1]).AudioCapture)', addon], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: addonProbeEnv(),
    });
    let text = '';
    child.stdout.on('data', (d: Buffer) => { text += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { text += d.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(text.trim()));
  });
  if (out !== 'function') throw new Error(`the probe child answered ${out.slice(0, 200)}`);
  return 'the capture service loads it, and so does its probe child';
}
