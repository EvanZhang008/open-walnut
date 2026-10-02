/**
 * scripts/test-baseline.mjs cuts a --shard slice the way vitest does, checked
 * against the REAL vitest: CI's quick and e2e legs each require every file of
 * their own slice to report, so a vitest upgrade that changed the cut would
 * otherwise turn into a gate that judges the wrong files. (The gate falls back
 * to counting when the cut disagrees and says so; this test catches it first.)
 *
 * A tiny fixture tier (seven files that each log their own name) runs through
 * the real script with the real vitest, one leg at a time: each leg passes,
 * never reports a file outside its slice, and the legs together ran every file
 * exactly once.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../..')
const SCRIPT = path.join(REPO, 'scripts/test-baseline.mjs')
const FILES = Array.from({ length: 7 }, (_, i) => `tests/f${i + 1}.test.mjs`)

let tmp: string

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shard-cut-')))
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'))
  fs.mkdirSync(path.join(tmp, 'tests'))
  for (const f of FILES) {
    fs.writeFileSync(
      path.join(tmp, f),
      `import fs from 'node:fs'\nimport { it } from 'vitest'\nit('runs', () => { fs.appendFileSync(process.env.SHARD_CUT_LOG, '${f}\\n') })\n`,
    )
  }
  // Keep vitest's results cache out of the shared node_modules.
  fs.writeFileSync(
    path.join(tmp, 'vitest.fixture.config.mjs'),
    "export default { cacheDir: '.vite-cache', test: { include: ['tests/**/*.test.mjs'] } }\n",
  )
  fs.writeFileSync(path.join(tmp, 'baseline.json'), JSON.stringify({ count: 0, failures: [] }))
})

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** The real script, real vitest, on one leg of the fixture tier. */
function leg(shard: string): Promise<{ code: number; out: string }> {
  // A nested vitest must not believe it is a worker of this one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_OPTIONS'))
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, 'check', `--shard=${shard}`], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...env,
        TMPDIR: tmp,
        WALNUT_BASELINE_CONFIG: 'vitest.fixture.config.mjs',
        WALNUT_BASELINE_FILE: 'baseline.json',
        WALNUT_BASELINE_MIN_FILES: String(FILES.length),
        SHARD_CUT_LOG: path.join(tmp, 'ran.log'),
      },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

describe('the --shard cut matches vitest', () => {
  it('every leg passes holding only its own slice, and the legs cover the tier once', async () => {
    // Serial on purpose: three nested vitest runs at once would compete with
    // this tier's own worker.
    for (const shard of ['1/3', '2/3', '3/3']) {
      const r = await leg(shard)
      expect(r.code, `${shard}\n${r.out}`).toBe(0)
      expect(r.out, shard).not.toContain('outside the computed --shard slice')
      expect(r.out, shard).not.toContain('never reported')
    }
    const ran = fs.readFileSync(path.join(tmp, 'ran.log'), 'utf8').trim().split('\n').sort()
    expect(ran).toEqual([...FILES].sort())
  }, 120_000)
})
