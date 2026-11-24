/**
 * A service set's runtime (WALNUT_SERVICE_SET, service-set.ts) is a real install in the session
 * daemon: its sessions outlive it (shouldReapOnExit false, no isolated-dir test knobs), its registry,
 * streams, journal and vitals live under its own install root (so a restart adopts exactly its own
 * sessions, and no other set's), while the machine's single copies (the user PATH shim, the legacy
 * streams dir) stay the default set's.
 *
 * The daemon is exercised from its own text: the constants are sliced out of daemon-standalone.ts
 * and evaluated with every free identifier injected. No process, file or socket is touched.
 */
import { describe, expect, it } from 'vitest'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'

const REPO_ROOT = nodePath.resolve(__dirname, '../..')
const HOME = '/home/walnut'
const ID = '0123456789abcdef'
const R = `${HOME}/.open-walnut-host/walnuts/${ID}`

const DAEMON = nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

function between(src: string, start: RegExp, end: RegExp, name: string): string {
  const at = src.search(start)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  const rel = src.slice(at).search(end)
  expect(rel, `${name}: end not found`).toBeGreaterThan(0)
  return src.slice(at, at + rel)
}

function line(src: string, re: RegExp, name: string): string {
  const m = re.exec(src)
  expect(m, `${name} not found`).not.toBeNull()
  return m![0]
}

interface Runtime {
  IS_PROD_DAEMON_DIR: boolean
  SET_ID: string
  KEEPS_SESSIONS: boolean
  STREAMS_DIR: string
  JOURNAL_ROOT: string
  HOST_VITALS_DIR: string
  REGISTRY_FILE: string
  reap: boolean
}

function runtime(o: { dir: string; stateDir?: string; service: boolean; env?: Record<string, string> }): Runtime {
  const src = DAEMON
  const code = [
    between(src, /const IS_PROD_DAEMON_DIR = /, /\n\/\/ demo\.quiesce/, 'IS_PROD_DAEMON_DIR..STREAMS_DIR'),
    line(src, /^const REGISTRY_FILE = .*$/m, 'REGISTRY_FILE'),
    between(src, /const JOURNAL_PROD_STATE_DIR = /, /\nconst OFFLINE_HOST_DIR/, 'journal root'),
    between(src, /const HOST_VITALS_DIR = /, /\nconst hostVitals/, 'HOST_VITALS_DIR'),
    between(src, /function shouldReapOnExit\(/, /\n}\n/, 'shouldReapOnExit') + '\n}',
    'return { IS_PROD_DAEMON_DIR, SET_ID, KEEPS_SESSIONS, STREAMS_DIR, JOURNAL_ROOT, HOST_VITALS_DIR, REGISTRY_FILE, reap: shouldReapOnExit() };',
  ].join('\n')
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const env = { HOME, ...(o.stateDir ? { WALNUT_DAEMON_STATE_DIR: o.stateDir } : {}), WALNUT_DAEMON_DIR: o.dir, ...o.env }
  const injected: Record<string, unknown> = {
    path: nodePath,
    daemonEnv: env,
    process: { env },
    DAEMON_DIR: o.dir,
    DAEMON_STATE_DIR: o.stateDir,
    SERVICE_MODE: o.service,
    PROD_DAEMON_DIR: '/tmp/open-walnut',
    FALLBACK_DAEMON_DIR: `${HOME}/.cache/open-walnut`,
    PROD_STREAMS_DIR: `${HOME}/.open-walnut/tmp/streams`,
    HOME_DIR: HOME,
    handoverPrepared: false,
    KEEP_SESSIONS_ON_EXIT: false,
  }
  const names = Object.keys(injected)
  return new Function(...names, js)(...names.map((n) => injected[n])) as Runtime
}

describe('a service set\'s runtime', () => {
  const set = { dir: `${R}/rt`, stateDir: `${R}/daemon`, service: true, env: { WALNUT_SERVICE_SET: ID } }

  it('is a real install: its sessions are kept across a restart, and every durable dir is under its own root', () => {
    const r = runtime(set)
    expect(r.SET_ID).toBe(ID)
    expect(r.KEEPS_SESSIONS).toBe(true)
    expect(r.IS_PROD_DAEMON_DIR).toBe(false)
    expect(r.reap).toBe(false)
    expect(r.REGISTRY_FILE).toBe(`${R}/daemon/sessions.json`)
    expect(r.STREAMS_DIR).toBe(`${R}/daemon/streams`)
    expect(r.JOURNAL_ROOT).toBe(`${R}/daemon`)
    expect(r.HOST_VITALS_DIR).toBe(`${R}/daemon/host-vitals`)
    // The /tmp fallback runtime dir changes none of them: they stay under the install root.
    const tmp = runtime({ ...set, dir: `/tmp/open-walnut-set-1000-${ID}` })
    expect([tmp.REGISTRY_FILE, tmp.STREAMS_DIR, tmp.JOURNAL_ROOT]).toEqual([r.REGISTRY_FILE, r.STREAMS_DIR, r.JOURNAL_ROOT])
  })

  it('two sets never share a registry or a streams dir with each other or the default (no cross adoption)', () => {
    const other = 'fedcba9876543210'
    const OR = `${HOME}/.open-walnut-host/walnuts/${other}`
    const a = runtime(set)
    const b = runtime({ dir: `${OR}/rt`, stateDir: `${OR}/daemon`, service: true, env: { WALNUT_SERVICE_SET: other } })
    const d = runtime({ dir: '/tmp/open-walnut', stateDir: `${HOME}/.local/share/open-walnut/daemon`, service: true })
    const paths = [a, b, d].map((x) => [x.REGISTRY_FILE, x.STREAMS_DIR, x.JOURNAL_ROOT, x.HOST_VITALS_DIR])
    for (let i = 0; i < 4; i++) expect(new Set(paths.map((p) => p[i])).size, `column ${i}`).toBe(3)
  })

  it('the set is read only from a service with a state dir, and only as 16 hex digits', () => {
    for (const bad of [
      { ...set, service: false },
      { ...set, stateDir: undefined },
      { ...set, env: { WALNUT_SERVICE_SET: 'ABCDEF0123456789' } },
      { ...set, env: { WALNUT_SERVICE_SET: '../../etc' } },
      { ...set, env: {} },
    ]) {
      const r = runtime(bad)
      expect(r.SET_ID, JSON.stringify(bad)).toBe('')
      expect(r.KEEPS_SESSIONS).toBe(false)
      expect(r.STREAMS_DIR).toBe(`${R}/rt-streams`)
    }
    // An isolated test daemon on a set-looking dir still reaps its sessions when it is no service.
    expect(runtime({ ...set, service: false }).reap).toBe(true)
  })

  it('the default set is as before: the production dir, the home streams and journal', () => {
    const d = runtime({ dir: '/tmp/open-walnut', stateDir: `${HOME}/.local/share/open-walnut/daemon`, service: true })
    expect(d.SET_ID).toBe('')
    expect(d.KEEPS_SESSIONS).toBe(true)
    expect(d.STREAMS_DIR).toBe(`${HOME}/.open-walnut/tmp/streams`)
    expect(d.JOURNAL_ROOT).toBe(`${HOME}/.open-walnut/tmp`)
    expect(d.HOST_VITALS_DIR).toBe(`${HOME}/.open-walnut/tmp/host-vitals`)
    expect(d.REGISTRY_FILE).toBe(`${HOME}/.local/share/open-walnut/daemon/sessions.json`)
  })

  it('the machine\'s single copies stay the default set\'s; the hello names the set; a set has its own walnut-net identity', () => {
    const src = DAEMON
    const shim = between(src, /function installUserWalnutShim\(\)/, /\n}\n/, 'installUserWalnutShim')
    expect(shim).toMatch(/if \(!IS_PROD_DAEMON_DIR\) return/)
    expect(src).toMatch(/if \(IS_PROD_DAEMON_DIR \|\| daemonEnv\.WALNUT_LEGACY_STREAMS_DIR\) out\.push\(LEGACY_STREAMS_DIR\)/)
    // skills.sync is the daemon's skills module (daemon-skills.ts), handed the runtime's KEEPS_SESSIONS.
    expect(src).toMatch(/createDaemonSkills\(\{[^}]*\bKEEPS_SESSIONS\b/)
    expect(nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-skills.ts'), 'utf-8'))
      .toMatch(/if \(!KEEPS_SESSIONS\) \{\s*return sendOk\(ws, id, \{ applied: true, changed: false, skipped: 'non-prod' \}\)/)
    expect(src).toContain('...(SET_ID ? { serviceSet: SET_ID } : {}),')
    // Option B: the set's net state dir is its own (net-config-core.ts netStateDirOf), the supervisor is today's.
    expect(src).toMatch(/NET_STATE_DIR = [\s\S]{0,1500}?home: HOME_DIR, setId: SET_ID[ ,]/)
    expect(src).not.toMatch(/setId: SET_ID,\n/)
    expect(src).not.toContain('confirmRoutes')
  })
})
