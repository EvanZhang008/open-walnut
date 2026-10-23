/**
 * What goes into each component archive, and how one is packed
 * (scripts/components/build.ts is the command; src/core/components/ installs them).
 *
 * An archive is a small node_modules tree holding only what the feature loads
 * at runtime for ONE platform: no type declarations, maps, docs, sources,
 * install scripts, or another platform's binaries. Packages come from the npm
 * registry at pinned versions, checked against the registry's integrity hash,
 * so any machine builds every platform's archive. The tar is reproducible (fixed
 * headers, sorted entries), and the manifest pins its SHA-256, so a rebuild in
 * CI verifies against the hash committed here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packTar, readTar, type TarEntry } from '../../src/lib/tar.js';
import type { ComponentName, ManifestComponent, ManifestPlatformEntry, Platform } from '../../src/core/components/types.js';

export interface PackageFile { path: string; mode: number; data: Buffer }

export interface PackageSpec {
  name: string;
  version: string;
  /** Which files of the package ship (paths relative to the package root). */
  keep?: (rel: string, platform: Platform) => boolean;
}

export interface Recipe {
  name: ComponentName;
  /** Bumped when the packing changes but the packages do not. */
  revision: number;
  /** The package whose version names the component. */
  main: string;
  entry: string;
  platforms: Platform[];
  packages: (platform: Platform) => PackageSpec[];
  /** Extra files (stubs) written into the tree, by path under node_modules/. */
  extra?: Record<string, string>;
}

const nodeOs = (p: Platform) => p.split('-')[0];
const nodeArch = (p: Platform) => p.split('-')[1];
/** sharp's platform package suffix: linux musl is `linuxmusl-<arch>`. */
const sharpPlatform = (p: Platform) => (p.endsWith('-musl') ? `linuxmusl-${nodeArch(p)}` : `${nodeOs(p)}-${nodeArch(p)}`);

/** Runtime files of an ordinary package: code, JSON, native binaries, the license. */
export function runtimeFile(rel: string): boolean {
  if (rel === 'package.json') return true;
  if (!rel.includes('/') && /^(licen[cs]e|notice|copying)(\.|$)/i.test(rel)) return true;
  if (/(^|\/)(test|tests|__tests__|example|examples|docs|src|bin|install|\.github)\//.test(rel)) return false;
  if (/\.(d\.[cm]?ts|map|md|markdown|ts|tsx|cc|cpp|c|h|hpp|gyp|gypi|mm|txt)$/i.test(rel)) return false;
  return /\.(js|cjs|mjs|json|node|dylib)$/.test(rel) || /\.so(\.\d+)*$/.test(rel);
}

/** The GPU execution providers onnxruntime-node may carry; Walnut embeds on the CPU. */
const GPU_LIBS = /providers_(cuda|tensorrt|rocm|migraphx|openvino|dnnl)|DirectML|dxil|dxcompiler/i;

export const RECIPES: Record<ComponentName, Recipe> = {
  embedding: {
    name: 'embedding',
    revision: 1,
    main: '@huggingface/transformers',
    entry: 'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
    // onnxruntime-node 1.24 ships no macOS x64 and no musl binary.
    platforms: ['darwin-arm64', 'linux-x64', 'linux-arm64'],
    packages: () => [
      {
        name: '@huggingface/transformers',
        version: '4.2.0',
        // One bundle: the Node ESM build (onnxruntime-web is inlined in it, never loaded on Node).
        keep: (rel) => rel === 'package.json' || rel === 'LICENSE' || rel === 'dist/transformers.node.mjs',
      },
      {
        name: 'onnxruntime-node',
        version: '1.24.3',
        keep: (rel, p) => rel === 'package.json' || rel === 'LICENSE'
          || /^dist\/[^/]+\.js$/.test(rel)
          || (rel.startsWith(`bin/napi-v6/${nodeOs(p)}/${nodeArch(p)}/`) && !GPU_LIBS.test(rel)),
      },
      { name: 'onnxruntime-common', version: '1.24.3' },
    ],
    // transformers imports sharp at load for image input; text embedding never
    // calls it, so a stub keeps libvips (16 MB) out of this archive.
    extra: {
      'sharp/package.json': `${JSON.stringify({ name: 'sharp', version: '0.0.0-walnut-stub', main: 'index.js' }, null, 2)}\n`,
      'sharp/index.js': "'use strict';\n// Walnut's embedding component embeds text only; images are the images component's.\nmodule.exports = function sharp() { throw new Error('image input is not part of the embedding component'); };\n",
    },
  },
  images: {
    name: 'images',
    revision: 1,
    main: 'sharp',
    entry: 'node_modules/sharp/lib/index.js',
    platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl'],
    packages: (p) => [
      { name: 'sharp', version: '0.34.5' },
      { name: `@img/sharp-${sharpPlatform(p)}`, version: '0.34.5' },
      { name: `@img/sharp-libvips-${sharpPlatform(p)}`, version: '1.2.4' },
      { name: '@img/colour', version: '1.0.0' },
      { name: 'detect-libc', version: '2.1.2' },
      { name: 'semver', version: '7.7.4' },
    ],
  },
  'audio-capture': {
    name: 'audio-capture',
    revision: 1,
    main: 'screencapturekit-audio-capture',
    entry: 'node_modules/screencapturekit-audio-capture/dist/index.js',
    // The package publishes a prebuilt addon for Apple silicon only.
    platforms: ['darwin-arm64'],
    packages: (p) => [
      {
        name: 'screencapturekit-audio-capture',
        version: '1.3.6',
        keep: (rel) => (rel.startsWith('prebuilds/') ? rel.startsWith(`prebuilds/${nodeOs(p)}-${nodeArch(p)}/`) && rel.endsWith('.node') : runtimeFile(rel)),
      },
      { name: 'node-gyp-build', version: '4.8.4' },
      { name: 'ws', version: '8.19.0' },
    ],
  },
};

export function componentVersion(recipe: Recipe): string {
  const main = recipe.packages(recipe.platforms[0]).find((p) => p.name === recipe.main);
  if (!main) throw new Error(`${recipe.name}: main package ${recipe.main} is not in its package list`);
  return `${main.version}-${recipe.revision}`;
}

export function assetName(name: ComponentName, version: string, platform: Platform): string {
  return `walnut-${name}-${version}-${platform}.tar.gz`;
}

// ── Where package files come from ──

export interface PackageSource {
  files(name: string, version: string): Promise<PackageFile[]>;
}

function stripRoot(p: string): string {
  // npm tarballs put the package under one top dir (usually `package/`).
  const i = p.indexOf('/');
  return i === -1 ? '' : p.slice(i + 1);
}

/** The npm registry, each tarball checked against the registry's integrity hash and cached. */
export function registrySource(cacheDir = process.env.WALNUT_COMPONENTS_NPM_CACHE || path.join(os.homedir(), '.cache', 'walnut-components', 'npm')): PackageSource {
  return {
    async files(name, version) {
      const file = path.join(cacheDir, `${name.replace('/', '__')}-${version}.tgz`);
      let tgz: Buffer | null = await fsp.readFile(file).catch(() => null);
      const metaRes = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`);
      if (!metaRes.ok) throw new Error(`npm registry: ${name}@${version} answered ${metaRes.status}`);
      const meta = await metaRes.json() as { dist: { tarball: string; integrity: string } };
      const [algo, b64] = meta.dist.integrity.split('-');
      const matches = (buf: Buffer) => createHash(algo).update(buf).digest('base64') === b64;
      if (!tgz || !matches(tgz)) {
        const res = await fetch(meta.dist.tarball);
        if (!res.ok) throw new Error(`npm registry: ${meta.dist.tarball} answered ${res.status}`);
        tgz = Buffer.from(await res.arrayBuffer());
        if (!matches(tgz)) throw new Error(`${name}@${version}: the tarball does not match the registry's integrity hash`);
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(file, tgz);
      }
      const out: PackageFile[] = [];
      for (const e of readTar(gunzipSync(tgz))) {
        if (e.type !== 'file') continue;
        const rel = stripRoot(e.path);
        if (rel) out.push({ path: rel, mode: e.mode, data: e.data });
      }
      return out;
    },
  };
}

/** An installed node_modules (this machine's platform only): tests build from it offline. */
export function nodeModulesSource(dir: string): PackageSource {
  return {
    async files(name, version) {
      const root = path.join(dir, name);
      const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
      if (pkg.version !== version) throw new Error(`${name}: node_modules has ${pkg.version}, the recipe pins ${version}`);
      const out: PackageFile[] = [];
      const walk = async (rel: string): Promise<void> => {
        for (const ent of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) { if (ent.name !== 'node_modules' && !ent.name.startsWith('.')) await walk(r); }
          else if (ent.isFile()) {
            const full = path.join(root, r);
            out.push({ path: r, mode: (await fsp.stat(full)).mode & 0o777, data: await fsp.readFile(full) });
          }
        }
      };
      await walk('');
      return out;
    },
  };
}

// ── Packing ──

export interface BuiltArchive {
  name: ComponentName;
  version: string;
  platform: Platform;
  asset: string;
  /** The .tar.gz bytes. */
  archive: Buffer;
  entry: ManifestPlatformEntry;
  files: number;
}

export async function buildArchive(recipe: Recipe, platform: Platform, source: PackageSource): Promise<BuiltArchive> {
  if (!recipe.platforms.includes(platform)) throw new Error(`${recipe.name} is not built for ${platform}`);
  const version = componentVersion(recipe);
  const entries: TarEntry[] = [];
  for (const spec of recipe.packages(platform)) {
    const keep = spec.keep ?? runtimeFile;
    const files = (await source.files(spec.name, spec.version)).filter((f) => keep(f.path, platform));
    if (!files.some((f) => f.path === 'package.json')) throw new Error(`${spec.name}@${spec.version} has no package.json`);
    for (const f of files) {
      entries.push({ path: `node_modules/${spec.name}/${f.path}`, type: 'file', mode: f.mode & 0o111 ? 0o755 : 0o644, data: f.data });
    }
  }
  for (const [rel, text] of Object.entries(recipe.extra ?? {})) {
    entries.push({ path: `node_modules/${rel}`, type: 'file', mode: 0o644, data: Buffer.from(text) });
  }
  if (!entries.some((e) => e.path === recipe.entry)) throw new Error(`${recipe.name}: the entry ${recipe.entry} is not in the archive`);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) throw new Error(`${recipe.name}: ${e.path} twice`);
    seen.add(e.path);
  }
  // Byte order, not locale order: the same on every machine.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tar = packTar(entries);
  const archive = gzipSync(tar, { level: 9 });
  return {
    name: recipe.name,
    version,
    platform,
    asset: assetName(recipe.name, version, platform),
    archive,
    files: entries.length,
    entry: {
      asset: assetName(recipe.name, version, platform),
      size: archive.length,
      tarSize: tar.length,
      tarSha256: createHash('sha256').update(tar).digest('hex'),
    },
  };
}

export function manifestComponentOf(recipe: Recipe, built: BuiltArchive[]): ManifestComponent {
  const version = componentVersion(recipe);
  const packages: Record<string, string> = {};
  for (const p of recipe.packages(recipe.platforms[0])) {
    if (!p.name.startsWith('@img/sharp-')) packages[p.name] = p.version;
  }
  const platforms: ManifestComponent['platforms'] = {};
  for (const b of built.filter((x) => x.name === recipe.name).sort((x, y) => x.platform.localeCompare(y.platform))) {
    platforms[b.platform] = b.entry;
  }
  return { version, tag: `component-${recipe.name}-${version}`, entry: recipe.entry, packages, platforms };
}

/** Write one built archive and its `.sha256` (the compressed file's hash, for the release's checksums). */
export function writeArchive(outDir: string, built: BuiltArchive): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, built.asset);
  fs.writeFileSync(file, built.archive);
  fs.writeFileSync(`${file}.sha256`, `${createHash('sha256').update(built.archive).digest('hex')}  ${built.asset}\n`);
  return file;
}
