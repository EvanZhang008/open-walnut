import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// 2026-10-29: Docker Hub answered two rows' image pulls with a 500, and `docker run`
// failed them before the file ran. The script pulls a missing image first, three tries.
const SCRIPT = path.resolve(__dirname, '../../scripts/binary-matrix.sh')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A docker stand-in: no image is local, a pull fails `failPulls` times, a run passes. */
function fakeDocker(failPulls: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-pull-'))
  dirs.push(dir)
  const calls = path.join(dir, 'calls.log')
  const count = path.join(dir, 'pulls')
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  image) exit 1 ;;
  pull) n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${count}"
        [ $n -gt ${failPulls} ] || { echo 'received unexpected HTTP status: 500 Internal Server Error' >&2; exit 1; } ;;
  run) exit 0 ;;
esac
`, { mode: 0o755 })
  const bin = path.join(dir, 'walnut-linux-x64')
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  const run = () => spawnSync('sh', [SCRIPT, bin, 'ubuntu:24.04'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BINARY_MATRIX_PULL_DELAY: '0' },
  })
  const lines = () => fs.readFileSync(calls, 'utf8').trim().split('\n')
  return { run, lines }
}

describe('binary matrix pulls an image again when the registry fails', () => {
  it('a pull that fails twice is tried a third time, and the row runs', () => {
    const d = fakeDocker(2)
    const r = d.run()
    expect(r.stdout, r.stderr).toContain('PASS ubuntu:24.04')
    expect(r.status).toBe(0)
    expect(d.lines().filter((l) => l.startsWith('pull')).length).toBe(3)
    expect(d.lines().some((l) => l.startsWith('run'))).toBe(true)
  })

  it('a registry that never answers fails the row by name, without running it', () => {
    const d = fakeDocker(99)
    const r = d.run()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL ubuntu:24.04 (could not pull the image: the registry, not Walnut)')
    expect(d.lines().filter((l) => l.startsWith('pull')).length).toBe(3)
    expect(d.lines().some((l) => l.startsWith('run'))).toBe(false)
  })
})
