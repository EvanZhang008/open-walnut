/**
 * With the experiment switchable_leader off, no permit code is reached: the server and every
 * outward door reach the switchable leader only through modules that import nothing of the
 * permit (doors.ts) or through a dynamic import behind the experiment (boot.ts).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const staticImports = (text: string) => [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!)

describe('the switchable leader with the experiment off', () => {
  it('doors.ts imports nothing at all', () => {
    expect(staticImports(read('src/core/leader/switch/doors.ts'))).toEqual([])
  })

  it('boot.ts imports nothing at load: the settings, the machine id and the runtime come behind the checks', () => {
    expect(staticImports(read('src/core/leader/switch/boot.ts'))).toEqual([])
  })

  it('no file outside the switch imports its permit side statically, except through doors.ts', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.tsx?$/.test(e.name) || rel.startsWith(path.join('src', 'core', 'leader'))) continue
        for (const spec of staticImports(read(rel))) {
          if (/leader\/switch\/(?!doors\.js)/.test(spec) || /leader\/permit\//.test(spec)) offenders.push(`${rel}: ${spec}`)
        }
      }
    }
    walk('src')
    // The CLI command and the status route are only loaded by their own dynamic imports.
    expect(offenders.filter((o) => !o.startsWith(path.join('src', 'web', 'routes', 'leader-switch.ts')))).toEqual([])
  })

  it('the server reaches the switch only behind the experiment', () => {
    const server = read('src/web/server.ts')
    const at = server.indexOf("import('../core/leader/switch/boot.js')")
    expect(at).toBeGreaterThan(0)
    const before = server.slice(Math.max(0, at - 300), at)
    // The experiment with witnesses set up, or a home a switch marked: nothing else reaches boot.ts.
    expect(before).toMatch(/if \(\(flagOn && witnessesSet\) \|\| switchMarked \|\| switchStart\)/)
    expect(server).toMatch(/if \(leaderPermitHandle\) app\.use\('\/api\/leader'/)
  })
})
