/**
 * The launch of a detached daemon update (src/providers/daemon-net-update-io.ts launcherScript)
 * and the record its runner leaves (answerOfRecord), run for real in /bin/sh.
 *
 * MACHINE SAFETY: the launch dirs are /tmp/open-walnut-update.* dirs and a marker dir this file
 * makes and removes; the only process is the runner the launcher starts, a script that writes its
 * pid and ends within 10 s; nothing is signalled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { answerOfRecord, launcherScript, NetUpdateHeldError } from '../../src/providers/daemon-net-update-io.js'

// 2026-11-04 review: with one try, a CLI that gave up on the install lock another `walnut daemon`
// held read as a failed update (a cooldown and a failure on the host's status), though it changed nothing.
describe('the record of a run whose CLI gave up on the install lock', () => {
  const lockErr = 'Error: File lock timeout: /home/u/.local/state/open-walnut/daemon-service/service-configs.json.lock'
  it('is a hold, asked again later', () => {
    expect(() => answerOfRecord({ done: 'rc=1 tries=1 tail=serving', out: '', err: lockErr, tail: { outcome: 'serving', words: 'a daemon answers' } })).toThrow(NetUpdateHeldError)
  })
  it('is a failure when the tail had to step in afterwards, or the CLI said something else', () => {
    expect(() => answerOfRecord({ done: 'rc=1 tries=1 tail=restored', out: '', err: lockErr, tail: { outcome: 'restored', words: 'put back' } })).toThrow(/gave no answer Walnut could read/)
    expect(() => answerOfRecord({ done: 'rc=1 tries=1 tail=serving', out: '', err: 'Error: boom', tail: { outcome: 'serving', words: 'a daemon answers' } })).toThrow(/gave no answer Walnut could read/)
  })
})

// 2026-11-04 review: a launch lock still held after the wait was let go of (two runners started
// side by side), and one a launcher left empty (killed between its mkdir and its pid) held every
// later launch for its whole wait.
describe('the launch lock', () => {
  const made: string[] = []
  afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })
  function launchDir(): { dir: string; marker: string; lock: string } {
    const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launch-lock-'))
    made.push(dir, base)
    // A runner that writes its pid and ends once told go or no go.
    fs.writeFileSync(path.join(dir, 'update.sh'), `echo $$ > '${dir}/update.pid'\nk=0; while [ ! -e '${dir}/update.go' ] && [ ! -e '${dir}/update.nogo' ] && [ $k -lt 100 ]; do k=$((k+1)); sleep 0.1; done\n`)
    const marker = path.join(base, 'latest')
    return { dir, marker, lock: `${marker}.lock` }
  }

  it('held by a live launcher past the wait: busy, nothing started, the lock left to its holder', () => {
    const { dir, marker, lock } = launchDir()
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const started = Date.now()
    const out = spawnSync('/bin/sh', ['-c', launcherScript(dir, marker)], { encoding: 'utf8', timeout: 60_000 })
    expect(out.stdout).toContain(`walnut-update-busy dir=launch-lock pid=${process.pid}`)
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000)
    expect(fs.existsSync(path.join(dir, 'update.nogo'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'update.pid'))).toBe(false)
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8')).toBe(String(process.pid))
  }, 60_000)

  // 2026-11-04 review: a lock whose launcher's pid was reused by a live process held every update for good.
  it('older than two minutes: stale whatever its pid, taken at once', () => {
    const { dir, marker, lock } = launchDir()
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const old = new Date(Date.now() - 3 * 60_000)
    fs.utimesSync(lock, old, old)
    const started = Date.now()
    const out = spawnSync('/bin/sh', ['-c', launcherScript(dir, marker)], { encoding: 'utf8', timeout: 60_000 })
    expect(out.stdout).toContain('walnut-update-started')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(fs.existsSync(lock)).toBe(false)
  }, 60_000)

  it('left empty for over a minute: taken at once, and the launch goes ahead', () => {
    const { dir, marker, lock } = launchDir()
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 2 * 60_000)
    fs.utimesSync(lock, old, old)
    const started = Date.now()
    const out = spawnSync('/bin/sh', ['-c', launcherScript(dir, marker)], { encoding: 'utf8', timeout: 60_000 })
    expect(out.stdout).toContain('walnut-update-started')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(fs.existsSync(lock)).toBe(false)
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(dir)
  }, 60_000)
})

// 2026-11-04 review (reproduced): a host whose ps has no -p (busybox) or no ps at all read every
// launch as "not detached" and exited 1, every 10 min for good. The process groups come from
// /proc/<pid>/stat there.
describe.runIf(process.platform === 'linux')('the launch on a host without a full ps', () => {
  const made: string[] = []
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
  it.each([
    ['a busybox ps (no -p)', ['for a in "$@"; do [ "$a" = -p ] && { echo "ps: invalid option -- \'p\'" >&2; echo "BusyBox v1.36.1 multi-call binary." >&2; exit 1; }; done', 'echo "PID   USER     TIME  COMMAND"']],
    ['no ps at all', ['echo "sh: ps: not found" >&2', 'exit 127']],
  ] as const)('%s: the runner is still proven detached, and starts', (_what, body) => {
    const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launch-ps-'))
    made.push(dir, base)
    const bin = path.join(base, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'ps'), ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'update.sh'), `echo $$ > '${dir}/update.pid'\nk=0; while [ ! -e '${dir}/update.go' ] && [ ! -e '${dir}/update.nogo' ] && [ $k -lt 100 ]; do k=$((k+1)); sleep 0.1; done\n`)
    const out = spawnSync('/bin/sh', ['-c', launcherScript(dir, path.join(base, 'latest'))], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(out.stdout).toContain('walnut-update-started')
    expect(out.status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'update.go'))).toBe(true)
  }, 60_000)
})

