/**
 * scripts/dev-prod.sh: the pre-kill plugin load check.
 *
 * 2026-10-25: a deploy came up with every external plugin failing to bundle
 * ("build2 is not a function"); the smoke boot runs on an empty data home, so it
 * never loads one. The deploy now loads the installed plugins with the new build,
 * without activating them, and aborts before the kill when a plugin the running
 * server has active fails to load.
 *
 * The gate runs here for real: the script's own block, executed by bash, with a
 * stand-in for the compiled file that runs the same check from source
 * (src/core/plugins/plugin-load-check.ts) and a stand-in for the running server's
 * /api/plugin-runtime. Fixture plugins: one that loads (and imports a Walnut source
 * module, as real plugins do), one that throws at load, one the running server has
 * disabled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { judgePluginLoads, parseProdRuntime } from '../../src/core/plugins/plugin-load-check.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')
const BUN = process.versions.bun ? process.execPath : 'bun'

const BLOCK_START = '# ── Pre-kill plugin load check'
const BLOCK_END = '# Said before the kill'

function gateBlock(): string {
  const start = script.indexOf(BLOCK_START)
  const end = script.indexOf(BLOCK_END)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end)
}

function bash(body: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', `set -euo pipefail\n${body}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (status) => resolve({ status, out }))
  })
}

let root: string
let marks: string

function manifest(id: string): string {
  return JSON.stringify({ id, name: id, version: '0.1.0', apiVersion: 1, engines: { walnut: '>=0.0.1' }, server: 'index.ts' })
}

function plugin(home: string, id: string, code: string): void {
  const dir = path.join(home, 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest(id))
  fs.writeFileSync(path.join(dir, 'index.ts'), code)
}

/** A data home with the given fixture plugins. */
function home(name: string, ids: Array<'loads' | 'throws' | 'disabled'>): string {
  const h = path.join(root, name)
  for (const id of ids) {
    if (id === 'loads') {
      plugin(h, 'loads-fixture', [
        "import fs from 'node:fs'",
        // A Walnut source module: resolves only through the rebase onto the checkout.
        "import { WALNUT_HOME } from '../../constants.js'",
        `export function activate() { fs.writeFileSync(${JSON.stringify(path.join(marks, 'activated'))}, String(WALNUT_HOME)) }`,
      ].join('\n'))
    } else if (id === 'throws') {
      plugin(h, 'throws-fixture', "throw new Error('fixture plugin throws at load')\nexport function activate() {}\n")
    } else {
      plugin(h, 'disabled-fixture', [
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(path.join(marks, 'disabled-evaluated'))}, '1')`,
        'export function activate() {}',
      ].join('\n'))
    }
  }
  return h
}

/** The running server's answer, served on a real port; `null` = nobody answers. */
async function prodServer(states: Record<string, string> | null): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/plugin-runtime' && states) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ plugins: Object.entries(states).map(([id, state]) => ({ id, state, builtin: false })) }))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const close = () => new Promise<void>((r) => server.close(() => r()))
  if (states === null) {
    await close()
    return { port, close: async () => {} }
  }
  return { port, close }
}

async function runGate(dataHome: string, states: Record<string, string> | null, extra: string[] = []) {
  const prod = await prodServer(states)
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-'))
  try {
    const r = await bash([
      'smoke_cleanup() { :; }; scratch_cleanup() { :; }; stage_cleanup() { :; }; release_lock() { :; }',
      `REHEARSAL_HOME='${dataHome}'`,
      `PORT=${prod.port}`,
      `SERVER_FILE='${path.join(root, 'walnut-file')}'`,
      `SERVE_ROOT='${REPO}'`,
      `TMPDIR='${tmp}'`,
      'WALNUT_DEVPROD_PLUGIN_CHECK_SECS=90',
      ...extra,
      gateBlock(),
      'echo GATE_PASSED',
    ].join('\n'))
    // Its scratch dir is removed on every path.
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('walnut-plugincheck.'))).toEqual([])
    return r
  } finally {
    await prod.close()
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-plugin-gate-'))
  marks = path.join(root, 'marks')
  fs.mkdirSync(marks)
  // Stand-in for the compiled file: the same subcommand, run from source.
  fs.writeFileSync(path.join(root, 'run-check.ts'), [
    `const m = await import(${JSON.stringify(path.join(REPO, 'src', 'core', 'plugins', 'plugin-load-check.ts'))})`,
    'process.exit(await m.runPluginLoadCheck(process.argv.slice(2)))',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'walnut-file'), [
    '#!/bin/sh',
    '[ "$1" = "__plugin-check" ] || exit 99',
    'shift',
    // The block unsets VITEST; the check's own data home is the temp one it was given.
    `exec '${BUN}' '${path.join(root, 'run-check.ts')}' "$@"`,
  ].join('\n'), { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('dev-prod.sh plugin load check: the gate, run for real', () => {
  it('passes when every plugin the running server loads also loads on the new build, and activates nothing', async () => {
    const h = home('pass', ['loads', 'disabled'])
    const r = await runGate(h, { 'loads-fixture': 'active', 'disabled-fixture': 'disabled' })
    expect(r.out).toContain('Plugin check: ok loads-fixture')
    expect(r.out).toContain('Plugin check: skip disabled-fixture (disabled on the running server)')
    expect(r.out).toContain('GATE_PASSED')
    expect(r.status).toBe(0)
    // Loaded, never activated; a plugin the server does not run is never evaluated.
    expect(fs.existsSync(path.join(marks, 'activated'))).toBe(false)
    expect(fs.existsSync(path.join(marks, 'disabled-evaluated'))).toBe(false)
  }, 120_000)

  it('aborts the deploy when a plugin active on the running server throws at load on the new build', async () => {
    const h = home('fail', ['loads', 'throws'])
    const r = await runGate(h, { 'loads-fixture': 'active', 'throws-fixture': 'active' })
    expect(r.out).toContain('Plugin check: FAIL throws-fixture')
    expect(r.out).toContain('fixture plugin throws at load')
    expect(r.out).toContain('Plugin check FAILED')
    expect(r.out).toContain('was NOT touched')
    expect(r.out).not.toContain('GATE_PASSED')
    expect(r.status).toBe(1)
  }, 120_000)

  it('only warns for a plugin that fails on the running server too', async () => {
    const h = home('also-broken', ['loads', 'throws'])
    const r = await runGate(h, { 'loads-fixture': 'active', 'throws-fixture': 'failed' })
    expect(r.out).toContain('Plugin check: skip throws-fixture (failed on the running server)')
    expect(r.out).toContain('GATE_PASSED')
    expect(r.status).toBe(0)
  }, 120_000)

  it('only warns when the running server does not answer', async () => {
    const h = home('no-prod', ['loads', 'throws'])
    const r = await runGate(h, null)
    expect(r.out).toContain('no answer from')
    expect(r.out).toContain('Plugin check: FAIL throws-fixture')
    expect(r.out).toContain('Plugin check: warning, throws-fixture fails to load here, not blocking')
    expect(r.out).toContain('GATE_PASSED')
    expect(r.status).toBe(0)
  }, 120_000)

  it('treats a check that cannot finish as undetermined: proceeds, or fails closed under STRICT', async () => {
    const h = home('hang', [])
    plugin(h, 'hangs-fixture', 'await new Promise(() => {})\nexport function activate() {}\n')
    const states = { 'hangs-fixture': 'active' }
    // The check's own deadline (1 s) fires before the evaluation timeout.
    const loose = await runGate(h, states, ['WALNUT_DEVPROD_PLUGIN_CHECK_SECS=1'])
    expect(loose.out).toContain('Plugin check UNDETERMINED')
    expect(loose.out).toContain('GATE_PASSED')
    const strict = await runGate(h, states, ['WALNUT_DEVPROD_PLUGIN_CHECK_SECS=1', 'WALNUT_DEVPROD_PLUGIN_STRICT=1'])
    expect(strict.out).toContain('deploy aborted')
    expect(strict.status).toBe(1)
  }, 120_000)

  it('is skipped when there is no plugins dir, or by the emergency knob', async () => {
    const none = await runGate(path.join(root, 'empty-home'), { x: 'active' })
    expect(none.out).not.toContain('Plugin check:')
    expect(none.out).toContain('GATE_PASSED')
    const h = home('skip', ['throws'])
    const skipped = await runGate(h, { 'throws-fixture': 'active' }, ['WALNUT_DEVPROD_SKIP_PLUGIN_CHECK=1'])
    expect(skipped.out).toContain('GATE_PASSED')
  }, 120_000)
})

describe('dev-prod.sh plugin load check: placement and isolation', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT])
  })

  it('runs after the smoke boot and before the prod-server kill, and its failure exits', () => {
    const smokeOk = script.indexOf('Smoke boot OK')
    const check = script.indexOf(BLOCK_START)
    const failed = script.indexOf('Plugin check FAILED')
    const kill = script.indexOf('kill -15 $existing_pids')
    expect(smokeOk).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(smokeOk)
    expect(failed).toBeGreaterThan(check)
    expect(kill).toBeGreaterThan(failed)
    expect(script.slice(failed, script.indexOf('elif', failed))).toMatch(/exit 1/)
  })

  it('runs the new file with its own temp data home, daemon dir and runtime tree', () => {
    const block = gateBlock()
    expect(block).toMatch(/env -u VITEST -u OPEN_WALNUT_EPHEMERAL -u WALNUT_STREAMS_DIR -u WALNUT_RUNTIME_DIR -u BUN_BE_BUN/)
    expect(block).toMatch(/OPEN_WALNUT_HOME="\$PLUGIN_CHECK_TMP\/home"/)
    expect(block).toMatch(/WALNUT_DAEMON_DIR="\$PLUGIN_CHECK_TMP\/daemon"/)
    expect(block).toMatch(/WALNUT_RUNTIME_DIR="\$PLUGIN_CHECK_TMP\/runtime"/)
    expect(block).toMatch(/"\$SERVER_FILE" __plugin-check --dir "\$PLUGINS_DIR"/)
    // Not named open-walnut-*: resolveOpenWalnutHome would revert it to the real data home.
    expect(block).toContain('walnut-plugincheck.XXXXXX')
    // bash 3.2 under set -u: an empty array expands only through the + form.
    expect(block).toContain('${plugin_prod_args[@]+"${plugin_prod_args[@]}"}')
  })

  it('the compiled file routes the subcommand', () => {
    const main = fs.readFileSync(path.join(REPO, 'src', 'binary', 'main.ts'), 'utf-8')
    expect(main).toMatch(/first === '__plugin-check'/)
  })
})

describe('plugin-load-check verdict', () => {
  it('reads the running server\'s states, and nothing from a body it cannot read', () => {
    expect(parseProdRuntime(null)).toBeNull()
    expect(parseProdRuntime('not json')).toBeNull()
    expect(parseProdRuntime('{"plugins":"x"}')).toBeNull()
    expect([...parseProdRuntime('{"plugins":[{"id":"a","state":"active"},{"id":2}]}')!]).toEqual([['a', 'active']])
  })

  it('blocks only a failure of a plugin active on the running server', () => {
    const results = [
      { id: 'a', dir: '/a', error: 'boom' },
      { id: 'b', dir: '/b', error: 'boom' },
      { id: 'c', dir: '/c' },
      { id: 'd', dir: '/d', error: 'boom' },
    ]
    const prod = new Map([['a', 'active'], ['b', 'failed'], ['c', 'active']])
    const v = judgePluginLoads(results, prod)
    expect(v.regressions.map((r) => r.id)).toEqual(['a'])
    expect(v.warnings.map((w) => [w.id, w.why])).toEqual([
      ['b', 'it is failed on the running server'],
      ['d', 'the running server does not load it'],
    ])
    const unknown = judgePluginLoads(results, null)
    expect(unknown.regressions).toEqual([])
    expect(unknown.warnings.map((w) => w.id)).toEqual(['a', 'b', 'd'])
  })
})
