#!/usr/bin/env bun
/**
 * Everything a release publishes, built from this checkout at one version (the
 * release jobs in .github/workflows/release.yml run it after `bun install`):
 *
 *   bun scripts/release-build.mjs --version 0.7.0 --out <dir>
 *
 *   1. stamps the version into package.json (the file reports what it says)
 *   2. compiles every target: `bun scripts/build-binary.mjs --all` -> dist-bin/
 *   3. runs this machine's file: its --version must start with the version
 *   4. <dir>/assets   the GitHub Release files (release-files.mjs)
 *      <dir>/npm      the launcher and platform packages (npm-packages.mjs)
 *
 * `BUN` names the bun to build with (default: `bun` on PATH).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPackages } from './npm-packages.mjs'
import { TARGETS, assertVersion, builtName, stamp, writeAssets } from './release-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** This machine's target, when a release ships one for it (a glibc Linux runner, a Mac). */
export function hostTarget(platform = process.platform, arch = process.arch) {
  return TARGETS.find((t) => t.os === platform && t.cpu === arch && t.libc !== 'musl')?.target ?? null
}

export async function releaseBuild({ version, out, bun = process.env.BUN || 'bun', log = (l) => process.stdout.write(`${l}\n`) }) {
  assertVersion(version)
  stamp(version)
  log(`building every target at ${version}`)
  // The stamp is the only edit; the build must not call itself dirty.
  execFileSync(bun, ['scripts/build-binary.mjs', '--all'], { cwd: root, stdio: 'inherit', env: { ...process.env, WALNUT_VERSION_STAMPED: '1' } })
  const files = path.join(root, 'dist-bin')
  const host = hostTarget()
  if (host) {
    const env = { ...process.env }
    delete env.BUN_BE_BUN
    const printed = execFileSync(path.join(files, builtName(host)), ['--version'], { env, encoding: 'utf8', timeout: 120_000 }).trim()
    if (printed.split(/\s/)[0] !== version) throw new Error(`${builtName(host)} --version printed "${printed}", not ${version}`)
    log(`${builtName(host)} --version: ${printed}`)
  }
  await writeAssets({ files, version, out: path.join(out, 'assets') })
  const dirs = buildPackages({ files, version, out: path.join(out, 'npm') })
  log(`release assets in ${path.join(out, 'assets')}, npm packages in ${path.dirname(dirs.launcher)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const version = at('--version')
  const out = at('--out')
  if (!version || !out) {
    process.stderr.write('usage: release-build.mjs --version <x.y.z> --out <dir>\n')
    process.exit(2)
  }
  releaseBuild({ version, out: path.resolve(out) }).catch((err) => {
    process.stderr.write(`release-build: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
