/**
 * The specs that run under their own Playwright config in this directory
 * (replica.config.ts, cloud-host.config.ts, host-alone.config.ts, ...), each with
 * the fixture servers that config starts. The main config must not run them: a
 * project's own `testIgnore` replaces the top-level one, so its chromium project
 * ran 23 of them against the plain fixture, where their control servers do not
 * exist (2026-10-31: 13 of them were recorded as known failures, "fetch failed").
 * Read from each config's `testMatch`, so a new side config excludes its own specs.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The spec names a config file's `testMatch` names: one quoted name or an array of them. */
export function testMatchNames(configText: string): string[] {
  const m = configText.match(/^\s*testMatch:\s*(\[[^\]]*\]|'[^']+'|"[^"]+")/m)
  if (!m) return []
  return [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!)
}

/** `**\/<spec>` globs for every spec a side config in `dir` owns. */
export function sideConfigSpecs(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.config.ts'))
    .flatMap((f) => testMatchNames(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((name) => `**/${name}`)
}
