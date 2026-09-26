/**
 * POST /api/test/host-fixture {action, ...}  and  GET /api/test/host-fixture/counters
 *
 * Mounted ONLY when WALNUT_TEST_HOST_FIXTURE_MODE=1 on an ephemeral, non-cloud
 * server (hostFixtureRouteAllowed; the Playwright fixture server,
 * tests/e2e/browser/test-server.ts). Drives core/hosts/host-fixture.ts: fixture
 * hosts are written into the test config's `hosts` and their frames are the
 * real buildHostStatus over fixture inputs. No action dials ssh (see the
 * host-fixture.ts header for the DaemonConnections that do get built).
 * WALNUT_TEST_HOST_FIXTURE=<name or json path> preloads one at boot.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import {
  advanceFixtureClock, connectFixtureHost, failFixtureHost, fixtureCounters, fixtureFile, fixtureFloor, fixtureHost,
  fixtureHostDef, fixtureHosts, forgetFixtureHost, healthyFixtureClaude, injectFixtureFailure, loadFixtureState, resetFixtureState,
  seedFixtureReadiness, setFixtureFloor, startFixtureReconnect, type FixtureClaude, type FixtureFile, type FixtureHost,
} from '../../core/hosts/host-fixture.js'
import { cancelFixtureAutofix } from '../../core/hosts/host-fixture-autofix.js'
import { clearHostReadiness, recomputeHostReadinessFloors } from '../../core/hosts/host-readiness.js'
import { pushHostFrame, pushHostRemoved } from '../../core/hosts/host-connect-action.js'
import type { HostDef } from '../../core/hosts/host-status.js'

export const testHostFixtureRouter = Router()

const FIXTURE_DIR_TAIL = path.join('tests', 'e2e', 'browser', 'fixtures')

/** Where the named fixtures live (test-server.ts sets it; the repo path is the fallback). Never anywhere else. */
function fixtureDir(): string {
  const dir = path.resolve(process.env.WALNUT_TEST_HOST_FIXTURE_DIR || path.resolve(process.cwd(), FIXTURE_DIR_TAIL))
  if (!dir.endsWith(path.sep + FIXTURE_DIR_TAIL)) throw new FixtureError(400, `the host fixture dir must be ${FIXTURE_DIR_TAIL}`)
  return dir
}

/**
 * A fixture by name ("host-problems") or by a .json path inside the fixture dir.
 * Any other path is refused: this route writes what it reads into config.hosts,
 * so it must never become a way to read an arbitrary file off the machine.
 */
export async function readFixture(nameOrPath: string): Promise<FixtureFile> {
  const dir = fixtureDir()
  let file: string
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(nameOrPath)) file = path.join(dir, `${nameOrPath}.json`)
  else if (nameOrPath.endsWith('.json')) file = path.resolve(dir, nameOrPath)
  else throw new FixtureError(400, `not a fixture name: ${nameOrPath}`)
  // realpath: a symlink inside the dir must not lead out of it either.
  const real = await fs.realpath(file).catch(() => file)
  const realDir = await fs.realpath(dir).catch(() => dir)
  if (path.dirname(real) !== realDir) throw new FixtureError(400, `a fixture path must be inside ${FIXTURE_DIR_TAIL}`)
  return JSON.parse(await fs.readFile(real, 'utf-8')) as FixtureFile
}

type ConfigHosts = NonNullable<Awaited<ReturnType<typeof getConfig>>['hosts']>

/** Rewrite config.hosts: every non-fixture host stays (fixture-remote included), fixture hosts are replaced. */
async function writeHosts(update: (hosts: ConfigHosts) => void): Promise<void> {
  const current = { ...((await getConfig()).hosts ?? {}) } as ConfigHosts
  for (const [key, def] of Object.entries(current)) if ((def as { discovered?: boolean }).discovered) delete current[key]
  update(current)
  await updateConfig({ hosts: current })
  bus.emit(EventNames.CONFIG_CHANGED, { config: { hosts: current } } as never, ['web-ui'], { source: 'test-host-fixture' })
}

function defOf(host: string): HostDef | undefined {
  const h = fixtureHost(host)
  return h ? fixtureHostDef(h.spec, fixtureFile()?.user) : undefined
}

function pushAll(): void {
  for (const host of fixtureHosts()) pushHostFrame(host, defOf(host))
}

function push(host: string): void {
  pushHostFrame(host, defOf(host))
}

/** Replace the fixture: config hosts and readiness store, then one frame per host (the MockDaemon reads the tree via fixtureFsLs). */
export async function loadHostFixture(file: FixtureFile): Promise<string[]> {
  cancelFixtureAutofix()
  const previous = fixtureHosts()
  for (const host of previous) clearHostReadiness(host)
  loadFixtureState(file)
  const hosts = fixtureHosts()
  await writeHosts((cfg) => {
    for (const host of previous) delete cfg[host]
    for (const [key, spec] of Object.entries(file.hosts)) cfg[key] = fixtureHostDef(spec, file.user) as ConfigHosts[string]
  })
  for (const host of hosts) seedFixtureReadiness(host)
  pushAll()
  log.web.info('host fixture loaded', { hosts, ephemeral: !!file.ephemeral })
  return hosts
}

/** WALNUT_TEST_HOST_FIXTURE=<name or path>: load at boot. Never throws. */
export async function preloadHostFixture(): Promise<void> {
  const name = process.env.WALNUT_TEST_HOST_FIXTURE
  if (!name) return
  try { await loadHostFixture(await readFixture(name)) } catch (err) {
    log.web.warn('host fixture preload failed', { fixture: name, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Drop every fixture host: config rows, readiness answers, then one tombstone each. */
export async function resetHostFixture(): Promise<string[]> {
  cancelFixtureAutofix()
  const previous = fixtureHosts()
  for (const host of previous) clearHostReadiness(host)
  resetFixtureState()
  if (previous.length) await writeHosts((cfg) => { for (const host of previous) delete cfg[host] })
  for (const host of previous) pushHostRemoved(host)
  return previous
}

type Body = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

class FixtureError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function hostOf(body: Body): { host: string; h: FixtureHost } {
  const host = str(body.host)
  const h = host ? fixtureHost(host) : undefined
  if (!host || !h) throw new FixtureError(404, `not a fixture host: ${String(body.host)}`)
  return { host, h }
}

/** Every action answers the fixture hosts it touched; each touched host also gets one fresh frame. */
async function runAction(action: string, body: Body): Promise<Record<string, unknown>> {
  switch (action) {
    case 'load': {
      const file = (body.file as FixtureFile | undefined) ?? await readFixture(str(body.fixture) ?? 'host-problems')
      return { hosts: await loadHostFixture(file) }
    }
    case 'reset':
      return { removed: await resetHostFixture() }
    case 'set-status': {
      const { host } = hostOf(body)
      const phase = str(body.phase)
      if (phase === 'connected') { connectFixtureHost(host); seedFixtureReadiness(host) }
      else if (phase === 'failed') failFixtureHost(host, { kind: str(body.kind), text: str(body.text) })
      else if (phase === 'reconnecting') startFixtureReconnect(host)
      else throw new FixtureError(400, `unknown phase: ${String(body.phase)}`)
      push(host)
      return { host }
    }
    case 'clear-problems': {
      const { host, h } = hostOf(body)
      h.nextCheck = { claude: healthyFixtureClaude() }
      seedFixtureReadiness(host)
      push(host)
      return { host }
    }
    case 'set-check-result': {
      const { host, h } = hostOf(body)
      h.nextCheck = { claude: (body.claude as FixtureClaude | undefined) ?? healthyFixtureClaude() }
      return { host }
    }
    case 'set-floor': {
      const minVersion = str(body.minVersion)
      if (!minVersion) throw new FixtureError(400, 'minVersion is required')
      const current = fixtureFloor()
      setFixtureFloor({ minVersion, model: str(body.model) ?? current?.model ?? 'the default model' }, str(body.forModel))
      await recomputeHostReadinessFloors(fixtureFloor())
      pushAll()
      return { floor: fixtureFloor() }
    }
    case 'renew-credential': {
      const { host, h } = hostOf(body)
      h.renewed = true
      return { host }
    }
    case 'set-next-connect': {
      const { host, h } = hostOf(body)
      h.nextConnect = str(body.result) ?? 'ok'
      return { host }
    }
    case 'start-reconnect': {
      const { host } = hostOf(body)
      startFixtureReconnect(host, typeof body.since === 'number' ? body.since : undefined)
      push(host)
      return { host }
    }
    case 'inject-failure': {
      const { host } = hostOf(body)
      const kind = str(body.kind)
      if (!kind) throw new FixtureError(400, 'kind is required')
      injectFixtureFailure(host, kind, body.afterWake === true)
      push(host)
      return { host }
    }
    case 'set-shell-setup': {
      const { host, h } = hostOf(body)
      h.shellSetupVersion = str(body.claudeVersion)
      return { host }
    }
    case 'autofix-slow': {
      // How long the next automatic fix (an Update click) runs.
      const { host, h } = hostOf(body)
      h.autofixSlowMs = typeof body.ms === 'number' ? body.ms : 0
      return { host }
    }
    case 'check-slow': {
      // How long a Check again takes to answer.
      const { host, h } = hostOf(body)
      h.checkDelayMs = typeof body.ms === 'number' ? body.ms : 0
      return { host }
    }
    case 'remove-host':
    case 'disable-host': {
      const { host } = hostOf(body)
      cancelFixtureAutofix(host)
      clearHostReadiness(host)
      forgetFixtureHost(host)
      await writeHosts((cfg) => {
        if (action === 'remove-host') delete cfg[host]
        else if (cfg[host]) cfg[host] = { ...cfg[host], enabled: false }
      })
      pushHostRemoved(host)
      return { host }
    }
    case 'advance-clock': {
      advanceFixtureClock(typeof body.ms === 'number' ? body.ms : 0)
      pushAll()
      return { ok: true }
    }
    default:
      throw new FixtureError(400, `unknown action: ${action}`)
  }
}

testHostFixtureRouter.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Body
  const action = str(body.action) ?? ''
  try {
    const result = await runAction(action, body)
    log.web.info('host fixture action', { action, host: str(body.host) })
    res.json({ ok: true, ...result })
  } catch (err) {
    const status = err instanceof FixtureError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('host fixture action failed', { action, host: str(body.host), error: message })
    res.status(status).json({ ok: false, error: message })
  }
})

testHostFixtureRouter.get('/counters', (_req: Request, res: Response) => {
  res.json(fixtureCounters())
})
