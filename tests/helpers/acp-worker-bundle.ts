/**
 * The ACP worker bundle, built from this checkout's source the way
 * scripts/build-daemon.sh builds dist/daemon-binaries/acp-worker.js.
 *
 * A test that starts a worker must not read the prebuilt file: a clean clone or a
 * fresh CI job has no dist/, so the worker exited at start ("worker died:
 * worker-exit"), and in the shared checkout dist/ is whatever the last deploy
 * published, not the source under test (2026-10-30: 16 browser specs failed this
 * way on HEAD in a clean clone). Building it takes about 30 ms, once per process.
 * tests/scripts/prebuilt-artifact-ratchet.test.ts keeps new tests on this helper.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ACP_WORKER_ENTRY = path.join(REPO_ROOT, 'src', 'providers', 'acp-worker', 'worker-main.ts')

let built: string | null = null

export function acpWorkerBundle(): string {
  if (built && fs.existsSync(built)) return built
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-acp-worker-'))
  const out = path.join(dir, 'acp-worker.js')
  const bun = process.versions.bun ? process.execPath : 'bun'
  const r = spawnSync(bun, ['build', '--minify', '--target=node', '--outfile', out, ACP_WORKER_ENTRY], { encoding: 'utf-8' })
  if (r.status !== 0 || !fs.existsSync(out)) {
    throw new Error(`could not build the ACP worker from ${ACP_WORKER_ENTRY}: ${r.error?.message ?? ''}${r.stderr ?? ''}`)
  }
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })
  built = out
  return out
}
