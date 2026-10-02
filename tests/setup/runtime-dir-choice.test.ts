/**
 * Every test worker gets its own runtime dir (tests/setup/runtime-dir-choice.ts,
 * applied by runtime-dir-isolation.ts).
 *
 * What matters: whatever WALNUT_DAEMON_DIR the run inherits (none, the
 * production default, the runner's, or one CI chose), each worker ends up in a
 * dir named for its own pid, so no two workers share a local daemon. A shared
 * dir let one e2e file's server adopt the daemon another file had spawned and
 * read that file's home (2026-10-02). A dir the caller chose still holds the
 * run's files, and the runner sweeps what dead workers left there.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_DIR_PREFIX, isCallerChosenRuntime, workerRuntimeDir } from './runtime-dir-choice.js'
import { sweepStaleTmpDirs } from './stale-tmp.js'

const TMP = '/var/scratch-tmp'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('the dir a worker runs in', () => {
  it('this worker runs in a dir of its own', () => {
    expect(path.basename(process.env.WALNUT_DAEMON_DIR ?? '')).toBe(`${RUNTIME_DIR_PREFIX}${process.pid}`)
  })

  it('a dir the caller chose holds one subdir per worker', () => {
    const chosen = '/runner/_temp/open-walnut-e2e'
    expect(workerRuntimeDir(chosen, 101, TMP)).toBe(`${chosen}/${RUNTIME_DIR_PREFIX}101`)
    expect(workerRuntimeDir(chosen, 102, TMP)).toBe(`${chosen}/${RUNTIME_DIR_PREFIX}102`)
    expect(workerRuntimeDir(`${chosen}/`, 101, TMP)).toBe(`${chosen}/${RUNTIME_DIR_PREFIX}101`)
  })

  it('no dir, the production default, or another process\'s harness dir becomes a temp dir of its own', () => {
    for (const inherited of [undefined, '', '/tmp/open-walnut', '/tmp/open-walnut/sub', `${TMP}/${RUNTIME_DIR_PREFIX}1`, `/runner/_temp/x/${RUNTIME_DIR_PREFIX}7`]) {
      expect(workerRuntimeDir(inherited, 101, TMP), String(inherited)).toBe(`${TMP}/${RUNTIME_DIR_PREFIX}101`)
    }
  })

  it('a dir already its own is kept, wherever it lives', () => {
    expect(workerRuntimeDir(`${TMP}/${RUNTIME_DIR_PREFIX}101`, 101, TMP)).toBeNull()
    expect(workerRuntimeDir(`/runner/_temp/open-walnut-e2e/${RUNTIME_DIR_PREFIX}101`, 101, TMP)).toBeNull()
    // Never the production tree, even under a name that looks like ours.
    expect(workerRuntimeDir(`/tmp/open-walnut/${RUNTIME_DIR_PREFIX}101`, 101, TMP)).toBe(`${TMP}/${RUNTIME_DIR_PREFIX}101`)
  })

  it('tells a caller\'s dir from the harness\'s own', () => {
    expect(isCallerChosenRuntime('/runner/_temp/open-walnut-e2e')).toBe(true)
    expect(isCallerChosenRuntime(undefined)).toBe(false)
    expect(isCallerChosenRuntime('/tmp/open-walnut')).toBe(false)
    expect(isCallerChosenRuntime(`${TMP}/${RUNTIME_DIR_PREFIX}5`)).toBe(false)
  })
})

describe('what dead workers leave in a caller\'s dir', () => {
  it('is swept by pid; a live worker\'s dir stays', () => {
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ci-chosen-'))
    tmpDirs.push(chosen)
    const dead = 2 ** 22 + 12345 // above any pid_max this suite runs on
    for (const name of [`${RUNTIME_DIR_PREFIX}${dead}`, `${RUNTIME_DIR_PREFIX}${dead}-streams`, `${RUNTIME_DIR_PREFIX}${process.pid}`, 'ci-artifact']) {
      fs.mkdirSync(path.join(chosen, name))
    }
    const removed = sweepStaleTmpDirs([{ prefix: RUNTIME_DIR_PREFIX, pidFrom: 'name' }], chosen)
    expect(removed.map((d) => path.basename(d)).sort()).toEqual([`${RUNTIME_DIR_PREFIX}${dead}`, `${RUNTIME_DIR_PREFIX}${dead}-streams`])
    expect(fs.readdirSync(chosen).sort()).toEqual(['ci-artifact', `${RUNTIME_DIR_PREFIX}${process.pid}`])
  })
})
