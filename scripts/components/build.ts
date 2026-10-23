#!/usr/bin/env bun
/**
 * Build the component archives (scripts/components/recipes.ts says what is in each).
 *
 *   bun scripts/components/build.ts                 every component, every platform -> dist-components/
 *   bun scripts/components/build.ts --component images --platform linux-x64
 *   bun scripts/components/build.ts --write         also pin the result in src/core/components/manifest-data.ts
 *                                                   (refused when it would change the bytes of a version already pinned:
 *                                                   bump the revision in recipes.ts instead, see pins.ts)
 *   bun scripts/components/build.ts --check         fail unless every tar matches the pinned hash
 *   bun scripts/components/build.ts --verify        install this machine's archives into a temp dir and smoke them
 *
 * Output per archive: `<asset>` and `<asset>.sha256`, plus `manifest.json` (the
 * manifest for what was built). The assets belong on the release tag named in
 * the manifest (`component-<name>-<version>`); .github/workflows/components.yml
 * attaches them. Packages come from the npm registry; WALNUT_COMPONENTS_NPM_CACHE
 * moves the tarball cache.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildArchive, manifestComponentOf, RECIPES, registrySource, writeArchive, type BuiltArchive,
} from './recipes.js';
import { repinProblems } from './pins.js';
import { smokeComponent } from '../../src/core/components/smoke.js';
import { COMPONENTS_MANIFEST } from '../../src/core/components/manifest-data.js';
import { installComponent } from '../../src/core/components/install.js';
import { currentPlatform } from '../../src/core/components/platform.js';
import { COMPONENT_NAMES, PLATFORMS, type ComponentName, type ComponentsManifest, type Platform } from '../../src/core/components/types.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function args(): { components: ComponentName[]; platforms: Platform[] | null; out: string; write: boolean; check: boolean; verify: boolean } {
  const a = process.argv.slice(2);
  const components: ComponentName[] = [];
  const platforms: Platform[] = [];
  let out = path.join(repoRoot, 'dist-components');
  const flags = new Set<string>();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--component') components.push(a[++i] as ComponentName);
    else if (a[i] === '--platform') platforms.push(a[++i] as Platform);
    else if (a[i] === '--out') out = path.resolve(a[++i]);
    else flags.add(a[i]);
  }
  for (const c of components) if (!COMPONENT_NAMES.includes(c)) throw new Error(`unknown component ${c}`);
  for (const p of platforms) if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p}`);
  return {
    components: components.length ? components : [...COMPONENT_NAMES],
    platforms: platforms.length ? platforms : null,
    out,
    write: flags.has('--write'),
    check: flags.has('--check'),
    verify: flags.has('--verify'),
  };
}

function mb(n: number): string {
  return `${(n / 1e6).toFixed(1)} MB`;
}

function manifestSource(m: ComponentsManifest): string {
  const body = JSON.stringify(m, null, 2);
  return `// Written by scripts/components/build.ts --write. Do not edit by hand.\nimport type { ComponentsManifest } from './types.js';\n\nexport const COMPONENTS_MANIFEST: ComponentsManifest = ${body};\n`;
}

async function verify(built: BuiltArchive[], manifest: ComponentsManifest): Promise<boolean> {
  const platform = await currentPlatform();
  const mine = built.filter((b) => b.platform === platform);
  if (!mine.length) { console.log(`verify: nothing built for this machine (${platform})`); return true; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-components-verify-'));
  let ok = true;
  try {
    for (const b of mine) {
      // The archive handed over in .downloads/ is what a host without internet gets: install from it.
      fs.mkdirSync(path.join(root, '.downloads'), { recursive: true });
      fs.writeFileSync(path.join(root, '.downloads', b.asset), b.archive);
      try {
        const inst = await installComponent(b.name, { root, platform: b.platform, manifest, retries: 0 });
        const said = await smokeComponent(b.name, {
          require: createRequire(path.join(inst.dir, 'index.js')),
          entryUrl: pathToFileURL(inst.entryPath).href,
        });
        console.log(`verify ${b.name} ${b.platform}: ${said}`);
      } catch (err) {
        ok = false;
        console.error(`verify ${b.name} ${b.platform}: FAILED ${err instanceof Error ? err.stack : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return ok;
}

async function main(): Promise<void> {
  const opt = args();
  const source = registrySource();
  const built: BuiltArchive[] = [];
  for (const name of opt.components) {
    const recipe = RECIPES[name];
    for (const platform of recipe.platforms) {
      if (opt.platforms && !opt.platforms.includes(platform)) continue;
      const b = await buildArchive(recipe, platform, source);
      writeArchive(opt.out, b);
      built.push(b);
      console.log(`${b.asset}  ${mb(b.entry.size)} compressed, ${mb(b.entry.tarSize)} unpacked, ${b.files} files  tar ${b.entry.tarSha256}`);
    }
  }

  const manifest: ComponentsManifest = structuredClone(COMPONENTS_MANIFEST);
  for (const name of opt.components) {
    const fresh = manifestComponentOf(RECIPES[name], built);
    const old = manifest.components[name];
    // A partial build (some platforms) keeps the pins of the platforms it did not build, at the same version.
    const keep = old?.version === fresh.version ? old.platforms : {};
    manifest.components[name] = { ...fresh, platforms: { ...keep, ...fresh.platforms } };
  }
  fs.writeFileSync(path.join(opt.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  let failed = false;
  if (opt.check) {
    for (const b of built) {
      const pinned = COMPONENTS_MANIFEST.components[b.name]?.platforms[b.platform];
      if (!pinned || pinned.tarSha256 !== b.entry.tarSha256 || pinned.tarSize !== b.entry.tarSize) {
        failed = true;
        console.error(`check ${b.asset}: built tar ${b.entry.tarSha256} (${b.entry.tarSize}) is not the pinned ${pinned?.tarSha256 ?? 'none'} (${pinned?.tarSize ?? '-'})`);
      } else {
        console.log(`check ${b.asset}: matches the pinned tar`);
      }
    }
  }
  if (opt.verify && !(await verify(built, manifest))) failed = true;
  if (opt.write) {
    const repins = repinProblems(COMPONENTS_MANIFEST, manifest);
    if (repins.length) {
      for (const p of repins) console.error(`write refused, ${p}`);
      console.error('A published version never changes its bytes: bump the revision in scripts/components/recipes.ts.');
      process.exit(1);
    }
    fs.writeFileSync(path.join(repoRoot, 'src', 'core', 'components', 'manifest-data.ts'), manifestSource(manifest));
    console.log('wrote src/core/components/manifest-data.ts');
  }
  if (failed) process.exit(1);
}

await main();
