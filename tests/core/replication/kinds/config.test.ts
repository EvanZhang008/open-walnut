/**
 * The `config` copy kind (docs/plan/walnut-replica-servers-impl.md, WP5): the Mac's
 * config.yaml through the allowlist to a host replica, whose getConfig() reads the
 * copy and whose config writes answer needs_leader. Real config.yaml on disk, real
 * route, real follower, real round; the acceptance grep walks the replica's data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'
import { fullConfigFixture, PLANTED_SECRETS } from '../../../helpers/full-config-fixture.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-config', { CLOUD_MODE: false }))

import { CONFIG_FILE, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound, syncCopyKinds } from '../../../../src/core/replication/kinds/copy-kind.js'
import { CONFIG_KIND, readConfigCopy, _resetConfigCopyForTesting } from '../../../../src/core/replication/kinds/config.js'
import { buildKindManifest, confirmKindRemoval } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests, peekKindState } from '../../../../src/core/replication/replica-status.js'
import * as cm from '../../../../src/core/config-manager.js'
import { maskSecretTail } from '../../../../src/core/config-secret-shape.js'
import { CONFIG_COPY_ALLOWLIST } from '../../../../src/core/replication/config-allowlist.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
const kind = { ...CONFIG_KIND, watch: () => () => {} }
const copyFile = () => path.join(WALNUT_HOME, 'cache', 'replica', 'config.json')

async function writeMacConfig(c: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(CONFIG_FILE, yaml.dump(c), 'utf8')
}

async function round() {
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

/** Every file of the replica's data dir but the Mac's own config.yaml (a test stand-in: one home for both sides). */
function replicaFiles(dir = WALNUT_HOME): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...replicaFiles(p))
    else if (!p.startsWith(CONFIG_FILE)) out.push(p)
  }
  return out
}

function setReplica(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  else for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  setReplica(true)
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  setReplica(true)
  _resetConfigCopyForTesting()
  _resetReplicaStatusForTesting()
  cm._resetWriteLockForTest()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  h.calls.length = 0
  await writeMacConfig(fullConfigFixture())
})

describe('a round of the full fixture config', () => {
  it('copies only allowlisted keys; no planted secret is anywhere in the replica data dir', async () => {
    const n = Object.keys(CONFIG_COPY_ALLOWLIST).length
    expect(await round()).toMatchObject({ action: 'synced', sent: n })
    expect(stepsSince(h.calls)).toEqual(['sync:config', `put:config:${n}`])
    expect(fs.statSync(copyFile()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(copyFile())).mode & 0o777).toBe(0o700)
    const files = replicaFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      for (const s of PLANTED_SECRETS) expect([path.relative(WALNUT_HOME, f), s, text.includes(s)]).toEqual([path.relative(WALNUT_HOME, f), s, false])
    }
    // What crossed the link: the bytes of every step, not only how many there were.
    // The host checks each row again before it writes, so the data dir alone would
    // not show a secret the Mac sent and the host then refused.
    expect(h.calls.map((c) => `${c.op}:${c.kind}`)).toEqual(['sync:config', 'put:config'])
    for (const c of h.calls) {
      for (const s of PLANTED_SECRETS) expect([c.op, s, c.text.includes(s)]).toEqual([c.op, s, false])
      // No masked value (a client view's bullets) either.
      expect(c.text).not.toContain('\u2022')
    }
    // The bytes are the real rows (the scan above is not reading an empty body).
    expect(h.calls[1]!.text).toContain('acme-model-large')
    expect(h.calls[1]!.text).toContain('devbox.example.com')
  })

  it('getConfig() on the replica reads the copy: the views get their settings, never a secret', async () => {
    await round()
    const c = await cm.getConfig()
    expect(c.provider).toEqual({ type: 'bedrock', model: 'acme-model-large', bedrock_region: 'us-west-2' })
    expect(c.hosts?.devbox).toEqual({ hostname: 'devbox.example.com', user: 'marina', port: 22, label: 'Dev box', enabled: true })
    expect(c.defaults.project).toBe('Acme')
    expect(c.plugins).toBeUndefined()
    expect(c.providers).toBeUndefined()
    expect(c.favorites).toBeUndefined()
    const text = JSON.stringify(c) + JSON.stringify(await cm.readStoredConfig())
    for (const s of PLANTED_SECRETS) expect([s, text.includes(s)]).toEqual([s, false])
    // A second round converges: nothing is asked again.
    forgetKindManifests(['config'])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:config'])
  })

  it('before the first round the replica reads the defaults (its own config.yaml is never read)', async () => {
    await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), yaml.dump({ version: 1, user: { name: 'Replica own' } }))
    const c = await cm.getConfig()
    expect(c.user?.name).not.toBe('Replica own')
    expect(await readConfigCopy()).toBeNull()
  })
})

describe('a secret-shaped value lands in an allowlisted key on the Mac', () => {
  it('that row is refused: not sent, and the copy drops what it held of it', async () => {
    await round()
    expect((await readConfigCopy())?.ui).toEqual({ session_panels: 'auto', show_priority: true })
    const c = fullConfigFixture()
    c.ui = { show_priority: true, session_panels: 'Bearer acmeUiPlantedToken0123456789XYZ' }
    await writeMacConfig(c)
    const r = await round()
    expect(r).toMatchObject({ action: 'synced', removed: 1 })
    const copy = await readConfigCopy()
    expect(copy?.ui).toBeUndefined()
    expect(copy?.version).toBe(1)
    expect(fs.readFileSync(copyFile(), 'utf8')).not.toContain('acmeUiPlantedToken')
  })

  it('the host refuses such a row if one ever arrives (a put that skips the allowlist)', async () => {
    await round()
    const { followerStep } = await import('../../../../src/core/replication/kind-follower.js')
    const bad = { key: 'ui', value: { session_panels: maskSecretTail('a-hidden-secret') } }
    const evil = { key: 'providers', value: { acme: { api_key: 'sk-acmeEvilPut0123456789abcdefgh' } } }
    const r = await followerStep({ op: 'put', kind: 'config', schemaVersion: 1, rows: [bad, evil], last: true })
    expect(r).toMatchObject({ ok: true, stored: 0 })
    const text = fs.readFileSync(copyFile(), 'utf8')
    expect(text).not.toContain('acmeEvilPut')
    expect(text).not.toContain('\u2022')
  })
})

describe('config writes on the replica', () => {
  it('every writer refuses with needs_leader and writes nothing; a masked value is never written back', async () => {
    await round()
    const before = fs.readFileSync(CONFIG_FILE, 'utf8')
    const masked = maskSecretTail(PLANTED_SECRETS[0])
    const writes: Array<() => Promise<unknown>> = [
      () => cm.updateConfig({ provider: { type: 'bedrock', bedrock_bearer_token: masked } }),
      () => cm.saveConfig({ ...(fullConfigFixture() as never), provider: { type: 'bedrock', bedrock_bearer_token: masked } }),
      () => cm.updatePluginConfig('mailbox', { password: masked }),
      () => cm.updateHostServerConfig('devbox', { enabled: false } as never),
      () => cm.removePluginConfig('mailbox'),
      () => cm.updatePushTokens((t) => t),
    ]
    for (const w of writes) await expect(w()).rejects.toMatchObject({ code: 'needs_leader', status: 503, why: 'config_writes_need_mac' })
    // The replica's boot steps are no-ops, not failures.
    await expect(cm.seedConfigDefaults()).resolves.toBeUndefined()
    await expect(cm.migrateConfigFileToProjectOnly()).resolves.toBe(false)
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(before)
    expect(fs.existsSync(`${CONFIG_FILE}.bak`)).toBe(false)
  })

  it("the boot's plugin-config migration (a direct writer of config.yaml) writes nothing on the replica", async () => {
    // A section an old migration swept into plugins.*: the Mac's boot moves it back and rewrites the file.
    const legacy = yaml.dump({ version: 1, plugins: { ui: { enabled: true, session_panels: '2' } } })
    await fsp.writeFile(CONFIG_FILE, legacy)
    const { migrateConfigToPlugins } = await import('../../../../src/core/integration-loader.js')
    await expect(migrateConfigToPlugins()).resolves.toBe(false)
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(legacy)
    // The same boot step on the Mac does write (the test can see a write).
    setReplica(false)
    await expect(migrateConfigToPlugins()).resolves.toBe(true)
    expect((yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) as { ui?: unknown }).ui).toEqual({ session_panels: '2' })
  })

  it('on the leader the same writers write as before', async () => {
    setReplica(false)
    await cm.updateConfig({ ui: { session_panels: '3' } } as never)
    expect((yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) as { ui: unknown }).ui).toEqual({ session_panels: '3' })
  })
})

describe('the Mac cannot read its config.yaml', () => {
  it('the round skips the kind and the copy stays as it was', async () => {
    await round()
    const held = fs.readFileSync(copyFile(), 'utf8')
    await fsp.rm(CONFIG_FILE)
    // A file that does not open (a link to itself: ELOOP), standing in for EACCES or EMFILE.
    await fsp.symlink('config.yaml', CONFIG_FILE)
    await expect(kind.rows()).rejects.toThrow(/ELOOP/)
    h.calls.length = 0
    expect(await syncCopyKinds([kind], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
    expect(fs.readFileSync(copyFile(), 'utf8')).toBe(held)
  })

  it('a config.yaml that is not a mapping, or empty, is not an empty config either', async () => {
    await fsp.writeFile(CONFIG_FILE, '- a\n- b\n')
    await expect(kind.rows()).rejects.toThrow(/not a mapping/)
    await fsp.writeFile(CONFIG_FILE, '   \n')
    await expect(kind.rows()).rejects.toThrow(/empty/)
  })
})

describe('the half rule (floor 0) and the confirm', () => {
  it('a config that lost most sections is refused three rounds, then the confirm the user gave removes them', async () => {
    await round()
    const all = Object.keys((await readConfigCopy())!).length
    await writeMacConfig({ version: 1, ui: { session_panels: 'auto', show_priority: true } })
    for (let i = 0; i < 3; i++) await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect(Object.keys((await readConfigCopy())!).length).toBe(all)
    const st = peekKindState(h.target.id, 'config')!
    expect(st.refusals).toBe(3)
    expect(confirmKindRemoval(h.target, 'config', { entries: 2 })).toBe(true)
    expect(await round()).toMatchObject({ action: 'synced', removed: all - 2 })
    expect(Object.keys((await readConfigCopy())!).sort()).toEqual(['ui', 'version'])
  })
})

describe('the host turned the config copy off', () => {
  it('drops the copy, keeps an off marker, reads the defaults; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:config-off', copies: async () => choice })
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect((await cm.getConfig()).defaults.project).toBe('Acme')
      choice = { config: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:config'])
      expect(JSON.parse(fs.readFileSync(copyFile(), 'utf8'))).toMatchObject({ v: 1, off: true })
      expect(await readConfigCopy()).toBeNull()
      expect((await cm.getConfig()).defaults.project).toBeUndefined()
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:config')
      expect((await cm.getConfig()).defaults.project).toBe('Acme')
    } finally { await host.close() }
  })
})

describe('PUT /api/config on the replica', () => {
  it('a settings save carrying a masked secret answers 503 needs_leader; nothing is written back', async () => {
    await round()
    const [{ default: express }, { configRouter }, { errorHandler }] = await Promise.all([
      import('express'), import('../../../../src/web/routes/config.js'), import('../../../../src/web/middleware/error-handler.js'),
    ])
    const app = express()
    app.use(express.json())
    app.use('/api/config', configRouter)
    app.use(errorHandler)
    const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
      const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/config`
      const before = fs.readFileSync(CONFIG_FILE, 'utf8')
      const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: { type: 'bedrock', bedrock_bearer_token: maskSecretTail(PLANTED_SECRETS[0]) } }) })
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: 'needs_leader', why: 'config_writes_need_mac' } })
      expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(before)
      expect(fs.readFileSync(copyFile(), 'utf8')).not.toContain('\u2022')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('GET /api/config on the replica', () => {
  it('with no copy yet it says so (configCopied: false, the defaults are not the user settings); with one, the copy', async () => {
    const [{ default: express }, { configRouter }, { errorHandler }] = await Promise.all([
      import('express'), import('../../../../src/web/routes/config.js'), import('../../../../src/web/middleware/error-handler.js'),
    ])
    const app = express()
    app.use('/api/config', configRouter)
    app.use(errorHandler)
    const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
      const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/config`
      // Still a 200: the route carries the page's role and placement, the replica's first answer at boot.
      const none = await fetch(url)
      expect(none.status).toBe(200)
      const noneBody = await none.json() as { configCopied?: boolean; config: { defaults: { project?: string } } }
      expect(noneBody.configCopied).toBe(false)
      expect(noneBody.config.defaults.project).toBeUndefined()
      // Internal callers still read the defaults.
      expect((await cm.getConfig()).version).toBe(1)
      await round()
      const got = await fetch(url)
      expect(got.status).toBe(200)
      const body = await got.json() as { configCopied?: boolean; config: { defaults: { project?: string } } }
      expect(body.configCopied).toBe(true)
      expect(body.config.defaults.project).toBe('Acme')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('the replica reads the copied config the way the Mac reads its yaml', () => {
  it('a legacy priority in the copy is mapped as the Mac maps it in memory', async () => {
    const c = fullConfigFixture()
    c.defaults = { ...(c.defaults as Record<string, unknown>), priority: 'high' }
    await writeMacConfig(c)
    await round()
    expect((await readConfigCopy())?.defaults).toMatchObject({ priority: 'high' })
    expect((await cm.getConfig()).defaults.priority).toBe('immediate')
  })
})
