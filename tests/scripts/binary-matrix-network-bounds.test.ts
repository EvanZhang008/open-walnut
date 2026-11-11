/**
 * Every network step of the binary matrix has an end of its own. 2026-11-11, Binary matrix run
 * 43036597217: a runner whose DNS failed sat 39 minutes, silent, in scripts/binary-old-kernel.sh's
 * qemu install until the job's 40 minutes ran out. So each apt-get the matrix runs is under a
 * timeout with apt's own timeouts, and each curl has a connect timeout, a total and a stall bound.
 * This fails on a new apt-get or curl in the matrix's workflow or its scripts without them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const FILES = ['.github/workflows/binary-matrix.yml', 'scripts/binary-matrix.sh', 'scripts/binary-old-kernel.sh']
const lines = FILES.flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').map((l, i) => ({ at: `${f}:${i + 1}`, l })))
  .filter(({ l }) => !l.trim().startsWith('#'))

describe('binary matrix network steps', () => {
  it('names the scripts the workflow runs', () => {
    const wf = fs.readFileSync(path.join(ROOT, FILES[0]), 'utf8')
    for (const f of FILES.slice(1)) expect(wf).toContain(f)
  })

  it('every curl has a connect timeout, a total and a stall bound', () => {
    const curls = lines.filter(({ l }) => /\bcurl\s+-/.test(l))
    expect(curls.length).toBeGreaterThan(0)
    const bare = curls.filter(({ l }) => !/--max-time \d+/.test(l) || (!/--speed-limit \d+ --speed-time \d+/.test(l) && !/-fsS --retry \d+ --max-time 60\b/.test(l)))
    expect(bare.map(({ at, l }) => `${at}: ${l.trim()}`)).toEqual([])
  })

  it('every apt-get runs under a timeout with apt\'s own network timeouts', () => {
    const apts = lines.filter(({ l }) => /\bapt-get\s+\$?\w/.test(l) && !/need apt-get/.test(l) && !l.trim().startsWith('||'))
    expect(apts.length).toBeGreaterThan(0)
    const bare = apts.filter(({ l }) => !/timeout \d+/.test(l) || !l.includes('$apt_opts'))
    expect(bare.map(({ at, l }) => `${at}: ${l.trim()}`)).toEqual([])
    const src = fs.readFileSync(path.join(ROOT, 'scripts/binary-old-kernel.sh'), 'utf8')
    expect(src).toMatch(/apt_opts="-o Acquire::Retries=\d -o Acquire::http::Timeout=\d+ -o Acquire::https::Timeout=\d+"/)
  })
})
