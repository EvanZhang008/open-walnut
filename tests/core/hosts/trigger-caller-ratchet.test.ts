/**
 * Ratchet for "a trigger check's call is refused as not a session" (2026-11-14: ~50 refusals an
 * hour, triggers that never fired; core/hosts/trigger-caller.ts). The fix has two ends, and each
 * fails again the moment a NEW member is added without it:
 *
 * 1. Every op that runs only for a task finds its caller with callerOf (host-exec-target.ts), and a
 *    check's caller reaches callerOf only inside withTriggerCaller. So every way in from the web
 *    layer to a module that calls callerOf must run its work under withTriggerCaller. A new route
 *    file (or a new host op module reached from one) without it is a check refused again.
 * 2. Every place the daemon starts a check gives the run its token (checkCallers.mint), or that
 *    run's calls go up as nobody's again.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(rel))
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out
}

describe('a trigger check acts for its task wherever a task-only op is reached', () => {
  // The host op modules that call callerOf (the definition itself aside).
  const callerModules = filesUnder('src/core/hosts')
    .filter((f) => !f.endsWith('host-exec-target.ts') && /\bcallerOf\(/.test(read(f)))
    .map((f) => path.basename(f).replace(/\.ts$/, ''))

  it('finds the host ops that run only for a task', () => {
    expect(callerModules).toEqual(expect.arrayContaining(['host-exec', 'host-exec-jobs', 'host-http', 'host-mcp', 'host-copy']))
  })

  it('every file outside core/hosts that reaches one runs it under withTriggerCaller', () => {
    const importRe = new RegExp(`core/hosts/(${callerModules.map((m) => m.replace(/[-]/g, '\\-')).join('|')})\\.js`)
    const entrances = [...filesUnder('src/web'), ...filesUnder('src/ops'), ...filesUnder('src/core').filter((f) => !f.startsWith('src/core/hosts/'))]
      .filter((f) => importRe.test(read(f)))
    expect(entrances.length).toBeGreaterThan(0)
    const missing = entrances.filter((f) => !/\bwithTriggerCaller\(/.test(read(f)))
    expect(missing, 'these reach a task-only host op without the trigger caller in scope (core/hosts/trigger-caller.ts)').toEqual([])
  })
})

describe('every task-only host route is one a check reaches', () => {
  const ROUTERS = ['src/web/routes/host-exec-v1.ts', 'src/web/routes/host-copy-v1.ts']
  const norm = (p: string) => p.replace(/:[A-Za-z_]+/g, ':p')
  /** Each handler of a router file: its method, path and body. */
  const handlers = (file: string) => read(file).split(/\n(?=\w+Router\.(?:get|post|put|delete|patch)\()/).slice(1).map((block) => {
    const m = /^\w+Router\.(get|post|put|delete|patch)\('([^']+)'/.exec(block)!
    return { file, method: m[1]!.toUpperCase(), path: m[2]!, body: block }
  })
  const all = ROUTERS.flatMap(handlers)
  // A person-only admin route (humanOnly: grants, closing a host) acts for no task.
  const runsHostOp = (h: { body: string }) => /core\/hosts\/(host-exec|host-exec-jobs|host-http|host-mcp|host-copy|host-daemon-update)\.js/.test(h.body)
    && !/\bhumanOnly\(req, res\)/.test(h.body)

  it('every handler that runs a host op runs it through answer() (where withTriggerCaller is)', () => {
    const hostOps = all.filter(runsHostOp)
    expect(hostOps.length).toBeGreaterThanOrEqual(10)
    expect(hostOps.filter((h) => !/\banswer\(req, res, next/.test(h.body)).map((h) => `${h.method} ${h.path}`)).toEqual([])
  })

  it('the CLI and the relay name exactly those routes (lib/task-host-ops.ts)', async () => {
    const { isTaskHostOpPath } = await import('../../../src/lib/task-host-ops.js')
    await import('../../../src/ops/index.js')
    const { listOps } = await import('../../../src/ops/registry.js')
    const ops = listOps() as Array<{ name: string; bind?: { method: string; path: string } }>
    const served = new Set(all.filter(runsHostOp).map((h) => `${h.method} ${norm(h.path)}`))
    const bound = ops.filter((o) => o.bind && served.has(`${o.bind.method} ${norm(o.bind.path)}`))
    expect(bound.length).toBeGreaterThanOrEqual(10)
    expect(bound.filter((o) => !isTaskHostOpPath(o.bind!.path)).map((o) => o.name), 'a task-only host op the CLI would send over HTTP from a check').toEqual([])
    const named = ops.filter((o) => isTaskHostOpPath(o.bind?.path))
    expect(named.filter((o) => !served.has(`${o.bind!.method} ${norm(o.bind!.path)}`)).map((o) => o.name), 'named task-only, but no host route runs it').toEqual([])
  })
})

describe('every check the daemon starts carries its run\'s token', () => {
  it('src/providers/daemon-standalone.ts', () => {
    const file = 'src/providers/daemon-standalone.ts'
    const lines = read(file).split('\n')
    const starts = lines.flatMap((l, i) => (/runCheckProcess\(/.test(l) && !/function runCheckProcess/.test(l) ? [i] : []))
    expect(starts.length, 'the daemon runs checks').toBeGreaterThanOrEqual(2)
    const bare = starts.filter((i) => !lines.slice(Math.max(0, i - 6), i + 1).some((l) => /checkCallers\.mint\(/.test(l)))
    expect(bare.map((i) => `${file}:${i + 1}`), 'a check started here has no token (trigger-check-core.ts checkCallers)').toEqual([])
  })
})
