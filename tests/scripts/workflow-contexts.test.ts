import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

// GitHub rejects a whole workflow file when an expression reads a context the key
// it sits in does not have, and then fails a run with no jobs on every push to main
// instead of running it (2026-11-09: a job-level env read runner.temp, and the
// nightly extra tests never ran, while each push added a red run). Nothing in CI
// lints workflows, so this checks every expression against GitHub's table of which
// contexts each key may read:
// https://docs.github.com/en/actions/learn-github-actions/contexts#context-availability
const ROOT = path.resolve(__dirname, '../..')
const WORKFLOWS = path.join(ROOT, '.github/workflows')

const CONTEXTS = ['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs']
const ALL_STEP = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs']
const JOB_BASE = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']

const WORKFLOW_KEYS: Record<string, string[]> = {
  'run-name': ['github', 'inputs', 'vars'],
  env: ['github', 'secrets', 'inputs', 'vars'],
  concurrency: ['github', 'inputs', 'vars'],
}
const JOB_KEYS: Record<string, string[]> = {
  if: ['github', 'needs', 'vars', 'inputs'],
  'runs-on': JOB_BASE,
  env: [...JOB_BASE, 'secrets'],
  environment: JOB_BASE,
  concurrency: JOB_BASE,
  'timeout-minutes': JOB_BASE,
  'continue-on-error': JOB_BASE,
  strategy: ['github', 'needs', 'vars', 'inputs'],
  container: [...JOB_BASE, 'secrets', 'env'],
  services: [...JOB_BASE, 'secrets', 'env'],
  with: JOB_BASE,
  secrets: [...JOB_BASE, 'secrets'],
  outputs: ALL_STEP,
  name: JOB_BASE,
  defaults: [...JOB_BASE, 'env'],
}
const STEP_KEYS: Record<string, string[]> = {
  if: ALL_STEP.filter((c) => c !== 'secrets'),
}

// The contexts an expression reads: a context name at the head of a property path,
// outside string literals.
export function contextsRead(expr: string): string[] {
  const bare = expr.replace(/'(?:[^']|'')*'/g, "''")
  const found = new Set<string>()
  for (const m of bare.matchAll(/(^|[^\w.-])([A-Za-z_][\w-]*)\s*(?=[.[])/g)) {
    if (CONTEXTS.includes(m[2])) found.add(m[2])
  }
  return [...found]
}

function expressions(value: unknown, wholeIsExpr: boolean): string[] {
  if (value == null) return []
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => expressions(v, false))
  }
  const s = String(value)
  const inside = [...s.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1])
  return inside.length || !wholeIsExpr ? inside : [s]
}

type Wf = { jobs?: Record<string, Record<string, unknown> & { steps?: Record<string, unknown>[] }> } & Record<string, unknown>

export function contextMisuse(file: string, wf: Wf): string[] {
  const bad: string[] = []
  const check = (where: string, value: unknown, allowed: string[], wholeIsExpr: boolean) => {
    for (const expr of expressions(value, wholeIsExpr)) {
      for (const ctx of contextsRead(expr)) {
        if (!allowed.includes(ctx)) bad.push(`${file} ${where}: "${ctx}" is not available there (${expr.trim()})`)
      }
    }
  }
  for (const [key, allowed] of Object.entries(WORKFLOW_KEYS)) check(key, wf[key], allowed, false)
  for (const [job, def] of Object.entries(wf.jobs ?? {})) {
    for (const [key, allowed] of Object.entries(JOB_KEYS)) check(`jobs.${job}.${key}`, def[key], allowed, key === 'if')
    ;(def.steps ?? []).forEach((step, i) => {
      for (const [key, value] of Object.entries(step)) {
        check(`jobs.${job}.steps[${i}].${key}`, value, STEP_KEYS[key] ?? ALL_STEP, key === 'if')
      }
    })
  }
  return bad
}

describe('workflow expressions read only the contexts GitHub gives their key', () => {
  it('holds for every workflow file', () => {
    const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
    expect(files.length).toBeGreaterThan(5)
    const bad = files.flatMap((f) => contextMisuse(f, parseYaml(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'))))
    expect(bad).toEqual([])
  })

  it('finds the runner context in a job env, the 2026-11-09 failure', () => {
    const wf = parseYaml(`
on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    env:
      DIR: \${{ runner.temp }}/x
    steps:
      - run: echo
        env:
          OK: \${{ runner.temp }}/y
`)
    expect(contextMisuse('t.yml', wf)).toEqual([
      't.yml jobs.a.env: "runner" is not available there (runner.temp)',
    ])
  })

  it('reads a bare if as an expression and skips string literals and functions', () => {
    expect(contextsRead("github.event.schedule != '17 8 * * 0'")).toEqual(['github'])
    expect(contextsRead("hashFiles('runner.temp') && 'env.X'")).toEqual([])
    expect(contextsRead('steps.a.outputs.x || needs.b.result')).toEqual(['steps', 'needs'])
    const wf = parseYaml(`
on: push
jobs:
  a:
    if: secrets.TOKEN != ''
    runs-on: ubuntu-24.04
    steps:
      - if: secrets.TOKEN != ''
        run: echo
`)
    expect(contextMisuse('t.yml', wf)).toEqual([
      `t.yml jobs.a.if: "secrets" is not available there (secrets.TOKEN != '')`,
      `t.yml jobs.a.steps[0].if: "secrets" is not available there (secrets.TOKEN != '')`,
    ])
  })
})
