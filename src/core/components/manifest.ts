/**
 * The pinned manifest: which version of each component this Walnut uses, per
 * platform, and the hash its archive must match. Compiled in (manifest-data.ts),
 * so a component is trusted because this file names it, never because a server
 * said so.
 *
 * Two knobs, for tests and for a machine that cannot reach GitHub:
 *   WALNUT_COMPONENTS_MANIFEST  a JSON file used instead of the compiled one
 *   WALNUT_COMPONENTS_BASE_URL  where the assets are fetched from (`<base>/<asset>`)
 */

import { readFile } from 'node:fs/promises';
import { COMPONENTS_MANIFEST } from './manifest-data.js';
import { COMPONENT_NAMES, PLATFORMS, type ComponentName, type ComponentsManifest, type ManifestComponent, type ManifestPlatformEntry, type Platform } from './types.js';

let active: ComponentsManifest = COMPONENTS_MANIFEST;
let overrideLoaded: Promise<void> | null = null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * The reason `value` is not a complete components manifest, or null when it is.
 * Every field a reader touches is checked, so nothing downstream meets a hole.
 */
export function manifestProblem(value: unknown): string | null {
  if (!isObject(value) || value.schema !== 1) return 'schema is not 1';
  if (typeof value.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value.repo)) return 'repo is not owner/name';
  if (!isObject(value.components)) return 'components is not an object';
  for (const name of COMPONENT_NAMES) {
    const c = value.components[name];
    if (!isObject(c)) return `${name} is missing`;
    for (const key of ['version', 'tag'] as const) if (typeof c[key] !== 'string' || !c[key]) return `${name}.${key} is not a string`;
    if (typeof c.entry !== 'string') return `${name}.entry is not a string`;
    if (c.entry && (c.entry.startsWith('/') || c.entry.split('/').includes('..'))) return `${name}.entry leaves its dir`;
    if (!isObject(c.packages)) return `${name}.packages is not an object`;
    if (!isObject(c.platforms)) return `${name}.platforms is not an object`;
    for (const [platform, e] of Object.entries(c.platforms)) {
      if (!(PLATFORMS as readonly string[]).includes(platform)) return `${name}: unknown platform ${platform}`;
      if (!isObject(e)) return `${name}.${platform} is not an object`;
      if (typeof e.asset !== 'string' || !/^[\w.-]+\.tar\.gz$/.test(e.asset)) return `${name}.${platform}.asset is not an archive name`;
      if (!isCount(e.size) || !isCount(e.tarSize)) return `${name}.${platform} sizes are not positive integers`;
      if (typeof e.tarSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.tarSha256)) return `${name}.${platform}.tarSha256 is not a SHA-256`;
    }
  }
  return null;
}

/** Read WALNUT_COMPONENTS_MANIFEST once (async); a bad file keeps the compiled manifest (and rejects, saying why). */
export function loadManifestOverride(): Promise<void> {
  overrideLoaded ??= (async () => {
    const file = process.env.WALNUT_COMPONENTS_MANIFEST;
    if (!file) return;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const problem = manifestProblem(parsed);
    if (problem) throw new Error(`${file} is not a components manifest: ${problem}`);
    active = parsed as ComponentsManifest;
  })();
  return overrideLoaded;
}

export function getManifest(): ComponentsManifest {
  return active;
}

/** Test seam: use this manifest (undefined restores the compiled one). */
export function setManifestForTests(manifest: ComponentsManifest | undefined): void {
  active = manifest ?? COMPONENTS_MANIFEST;
  overrideLoaded = manifest ? Promise.resolve() : null;
}

export function manifestComponent(name: ComponentName, manifest = active): ManifestComponent | undefined {
  return manifest.components[name];
}

export function manifestEntry(name: ComponentName, platform: Platform | null, manifest = active): ManifestPlatformEntry | undefined {
  if (!platform) return undefined;
  const c = manifest.components[name];
  return c?.entry ? c.platforms[platform] : undefined;
}

export function assetUrl(name: ComponentName, entry: ManifestPlatformEntry, manifest = active): string {
  const base = process.env.WALNUT_COMPONENTS_BASE_URL;
  if (base) return `${base.replace(/\/+$/, '')}/${encodeURIComponent(entry.asset)}`;
  const c = manifest.components[name];
  return `https://github.com/${manifest.repo}/releases/download/${encodeURIComponent(c.tag)}/${encodeURIComponent(entry.asset)}`;
}
