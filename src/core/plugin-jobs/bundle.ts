/**
 * A plugin's job code as one file: its server module bundled with every package it
 * imports (integration-loader.ts bundlePluginForJobs), so the daemon of any machine
 * can run it with nothing installed there. Named by its sha256 in
 * `<data dir>/cache/plugin-jobs/`, which is what the daemons' `bundles/` dirs key on.
 *
 * One build per plugin at a time; an answer is reused for a few seconds, so a burst
 * of reconciles (every host connecting after a deploy) bundles each plugin once.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface JobBundleSource { id: string; dir: string; entry: string }

export type JobBundle = { sha256: string; data: Buffer; file: string } | { error: string }

export interface JobBundlerDeps {
  cacheDir: string
  /** Bundle `entry` of the plugin in `dir` into `outfile` (integration-loader.ts bundlePluginForJobs). */
  bundle(dir: string, entry: string, outfile: string): Promise<{ error?: string }>
  now(): number
}

const REUSE_MS = 20_000
const KEEP_FILES = 20

export function createJobBundler(deps: JobBundlerDeps) {
  const inflight = new Map<string, Promise<JobBundle>>()
  const recent = new Map<string, { at: number; key: string; result: JobBundle }>()

  async function build(src: JobBundleSource): Promise<JobBundle> {
    await fs.mkdir(deps.cacheDir, { recursive: true, mode: 0o700 })
    const tmp = path.join(deps.cacheDir, `${src.id}-${crypto.randomUUID()}.tmp.mjs`)
    try {
      const r = await deps.bundle(src.dir, src.entry, tmp)
      if (r.error) return { error: r.error }
      const data = await fs.readFile(tmp)
      const sha256 = crypto.createHash('sha256').update(data).digest('hex')
      const file = path.join(deps.cacheDir, `${sha256}.mjs`)
      await fs.rename(tmp, file)
      void prune(file)
      return { sha256, data, file }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fs.unlink(tmp).catch(() => undefined)
    }
  }

  /** The newest bundles stay (the daemons hold their own copies; these only feed uploads). */
  async function prune(keep: string): Promise<void> {
    try {
      const names = (await fs.readdir(deps.cacheDir)).filter((n) => /^[0-9a-f]{64}\.mjs$/.test(n))
      if (names.length <= KEEP_FILES) return
      const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(deps.cacheDir, n)).catch(() => null))?.mtimeMs ?? 0 })))
      stats.sort((a, b) => b.t - a.t)
      for (const { n } of stats.slice(KEEP_FILES)) {
        const f = path.join(deps.cacheDir, n)
        if (f !== keep) await fs.unlink(f).catch(() => undefined)
      }
    } catch { /* hygiene only */ }
  }

  return {
    async bundle(src: JobBundleSource): Promise<JobBundle> {
      const key = `${src.dir}|${src.entry}`
      const hit = recent.get(src.id)
      if (hit && hit.key === key && deps.now() - hit.at < REUSE_MS) return hit.result
      const running = inflight.get(src.id)
      if (running) return running
      const p = build(src).then((result) => {
        recent.set(src.id, { at: deps.now(), key, result })
        return result
      }).finally(() => inflight.delete(src.id))
      inflight.set(src.id, p)
      return p
    },
    /** Tests: forget what was built. */
    clear(): void { recent.clear() },
  }
}
