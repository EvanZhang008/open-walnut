/**
 * `walnut daemon net-route` (src/providers/net-route.ts): one leader's walnut-net link on this
 * machine is pointed at its own service set's daemon, with a put-back that fires unless the
 * route is confirmed (net-route-record.ts, net-core.ts confirmRoutes, both twins at
 * leader.configure).
 *
 * Real files under a temp HOME (the net state dir is the one every service computes under it),
 * and a stand-in walnut-net on the real control socket path that records each reload. One test
 * runs the real detached put-back child (this same CLI, started again) and waits for it.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import ts from 'typescript'
import { netControlPath, netStateDir, createNetSupervisor } from '../../src/providers/net-core.js'
import { netRoute, parseNetRouteArgs, runNetRouteArgs, walnutCommandPrefix, type NetRouteDeps } from '../../src/providers/net-route.js'
import { netRouteFile, readNetRoute } from '../../src/providers/net-route-record.js'
import { serviceSet } from '../../src/providers/service-set.js'
import { DAEMON_OWNERSHIP_NAME } from '../../src/providers/daemon-service-files.js'
import { SET_OWNER_FILE } from '../../src/providers/service-set-choice.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { netKey } from '../helpers/net-keys.js'

const REPO = path.resolve(__dirname, '../..')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-route-')))
afterAll(() => { if (root.includes('wn-net-route-')) fs.rmSync(root, { recursive: true, force: true }) })

const WALNUT = '0123456789abcdef' + 'fedcba9876543210'
const SET = WALNUT.slice(0, 16)
const OTHER_WALNUT = 'aaaabbbbccccdddd' + '0000111122223333'
const LEADER = netKey('route-leader')
const OTHER = netKey('route-other')
const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
const uid = process.getuid?.() ?? 0

let n = 0
const servers: net.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

/** A temp HOME with this Walnut's set installed, a walnut-net config with two members, and the paths. */
function world(o: { installed?: boolean } = {}) {
  const home = path.join(root, `h${++n}`)
  fs.mkdirSync(home, { recursive: true })
  const set = serviceSet(platform, home, SET, { uid })
  if (o.installed !== false) {
    fs.mkdirSync(set.installRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(set.installRoot, DAEMON_OWNERSHIP_NAME), '{}\n')
  }
  const netDir = netStateDir({ serviceStateDir: set.installRoot, prodDaemon: true, daemonDir: set.runtimeDir, home })
  fs.mkdirSync(netDir, { recursive: true, mode: 0o700 })
  const config = path.join(netDir, 'config.json')
  const text = JSON.stringify({
    version: 1, key: path.join(netDir, 'net.key'), relayMode: 'public', relays: [], relayRoots: [],
    members: [{ id: OTHER, name: 'other-mac', accept: true }, { id: LEADER, name: 'mac', accept: true, addrs: ['10.0.0.9:4100'] }],
    daemonPortFile: '/tmp/open-walnut/daemon.port', control: netControlPath(netDir),
  }, null, 2) + '\n'
  fs.writeFileSync(config, text, { mode: 0o600 })
  const deps: NetRouteDeps = { home, platform, uid, defaultRuntimeDir: path.join(home, 'default-rt'), commandPrefix: ['/bin/true'], reloadTimeoutMs: 500 }
  return { home, set, netDir, config, text, deps, portFile: path.join(set.runtimeDir, 'daemon.port'), record: netRouteFile(netDir, SET, LEADER) }
}

/** A stand-in walnut-net on the control socket: answers reload (or stays silent) and counts them. */
async function fakeNet(netDir: string, o: { silent?: boolean } = {}) {
  const sock = netControlPath(netDir)
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 })
  fs.rmSync(sock, { force: true })
  const seen = { reloads: 0 }
  const server = net.createServer((c) => {
    let buf = ''
    c.setEncoding('utf8')
    c.on('data', (d: string) => {
      buf += d
      if (!buf.includes('\n') || o.silent) return
      const req = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { op: string }
      if (req.op === 'reload') seen.reloads++
      c.end(JSON.stringify(req.op === 'reload' ? { ok: true, restart: false } : { ok: false, error: 'unknown op' }) + '\n')
    })
    c.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(sock, r))
  return seen
}

function members(config: string): Array<Record<string, unknown>> {
  return (JSON.parse(fs.readFileSync(config, 'utf8')) as { members: Array<Record<string, unknown>> }).members
}

async function run(args: string[], deps: NetRouteDeps): Promise<{ code: number; line: string; answer: Record<string, unknown> }> {
  let text = ''
  const code = await runNetRouteArgs(args, { ...deps, out: (t) => { text += t } })
  const lines = text.trim().split('\n')
  return { code, line: lines.length > 1 ? lines[0]! : '', answer: JSON.parse(lines[lines.length - 1]!) as Record<string, unknown> }
}

const FLIP = ['--walnut', WALNUT, '--member', LEADER]

describe('walnut daemon net-route', () => {
  it('a flip writes the member\'s route to the set\'s daemon, records the entry before it, asks a reload and starts the put-back', async () => {
    const w = world()
    const seen = await fakeNet(w.netDir)
    const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
    const spawn: NetRouteDeps['spawn'] = (cmd, args, opts) => { spawned.push({ cmd, args, opts: opts as Record<string, unknown> }); return { pid: 4242, unref() {}, on() { return this } } }
    const r = await run([...FLIP.slice(0, 3), LEADER.toUpperCase(), '--revert-after', '30'], { ...w.deps, spawn, commandPrefix: ['/opt/walnut', 'walnut'], now: () => 1_000 })
    expect(r.code).toBe(0)
    expect(r.line).toBe(`service set: ${SET}`)
    expect(r.answer).toMatchObject({ ok: true, action: 'flip', state: 'pending', reload: 'ok', walnut: SET, member: LEADER, record: w.record, revertAt: 31_000, revertChild: 4242 })
    expect(seen.reloads).toBe(1)
    const after = members(w.config)
    expect(after[0]).toEqual({ id: OTHER, name: 'other-mac', accept: true })
    expect(after[1]).toEqual({ id: LEADER, name: 'mac', accept: true, addrs: ['10.0.0.9:4100'], walnut: SET, daemonPortFile: w.portFile })
    expect(w.portFile).toBe(path.join(w.set.runtimeDir, 'daemon.port'))
    expect((fs.statSync(w.config).mode & 0o777)).toBe(0o600)
    const rec = await readNetRoute(w.record)
    expect(rec).toMatchObject({ v: 1, walnut: SET, member: LEADER, state: 'pending', at: 1_000, revertAt: 31_000, daemonPortFile: w.portFile })
    expect(rec!.previous).toEqual({ id: LEADER, name: 'mac', accept: true, addrs: ['10.0.0.9:4100'] })
    expect((fs.statSync(w.record).mode & 0o777)).toBe(0o600)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.cmd).toBe('/opt/walnut')
    expect(spawned[0]!.args).toEqual(['walnut', 'daemon', 'net-route', '--walnut', WALNUT, '--member', LEADER, '--revert', '--if-pending', rec!.token, '--revert-after', '30'])
    expect(spawned[0]!.opts).toMatchObject({ detached: true, stdio: 'ignore' })
  })

  it('confirmed: the put-back of that flip does nothing', async () => {
    const w = world()
    await fakeNet(w.netDir)
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    const flipped = fs.readFileSync(w.config, 'utf8')
    const token = (await readNetRoute(w.record))!.token
    const c = await run([...FLIP, '--confirm'], w.deps)
    expect(c.answer).toMatchObject({ ok: true, action: 'confirm', state: 'confirmed' })
    expect(await run([...FLIP, '--confirm'], w.deps)).toMatchObject({ code: 0, answer: { state: 'confirmed' } })
    const back = await run([...FLIP, '--revert', '--if-pending', token], { ...w.deps, waitMs: 0 })
    expect(back.answer).toMatchObject({ ok: true, action: 'revert', state: 'not_pending', reload: 'none' })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(flipped)
    expect((await readNetRoute(w.record))!.state).toBe('confirmed')
  })

  it('not confirmed: the put-back restores the entry byte for byte and reloads', async () => {
    const w = world()
    const seen = await fakeNet(w.netDir)
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    const token = (await readNetRoute(w.record))!.token
    // Another flip's child (an older token) does nothing.
    expect((await run([...FLIP, '--revert', '--if-pending', '0000000000000000'], { ...w.deps, waitMs: 0 })).answer.state).toBe('not_pending')
    const back = await run([...FLIP, '--revert', '--if-pending', token], { ...w.deps, waitMs: 0 })
    expect(back.answer).toMatchObject({ ok: true, state: 'reverted', reload: 'ok' })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
    expect(fs.existsSync(w.record)).toBe(false)
    expect(seen.reloads).toBe(2)
  })

  it('the real detached put-back child outlives the CLI and puts the route back', async () => {
    const w = world()
    await fakeNet(w.netDir)
    const entry = path.join(root, `child-entry-${n}.ts`)
    fs.writeFileSync(entry, [
      `const { runDaemonServiceArgs } = await import(${JSON.stringify(path.join(REPO, 'src/providers/daemon-service-cli.ts'))})`,
      'process.exit(await runDaemonServiceArgs(process.argv.slice(3)))',
      '',
    ].join('\n'))
    const r = await run([...FLIP, '--revert-after', '10'], {
      ...w.deps, commandPrefix: walnutCommandPrefix([process.argv0, entry, 'daemon', 'net-route'], process.execPath),
      env: { ...process.env, HOME: w.home },
    })
    expect(r.answer).toMatchObject({ ok: true, state: 'pending' })
    const pid = r.answer.revertChild as number
    if (process.platform === 'linux') {
      // Its own session (setsid): the CLI's group or the daemon's never reaches it.
      const sid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/, '').split(' ')[3])
      expect(sid).toBe(pid)
    }
    expect(fs.readFileSync(w.config, 'utf8')).not.toBe(w.text)
    const until = Date.now() + 40_000
    while (fs.existsSync(w.record) && Date.now() < until) await new Promise((res) => setTimeout(res, 250))
    expect(fs.existsSync(w.record)).toBe(false)
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
    const log = fs.readFileSync(path.join(w.netDir, 'routes', 'put-back.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(log.at(-1)).toMatchObject({ ok: true, action: 'revert', state: 'reverted', reload: 'ok' })
  }, 60_000)

  it('an explicit revert puts the previous entry back byte for byte; again it finds nothing', async () => {
    const w = world()
    await fakeNet(w.netDir)
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    // A flip again keeps the entry from before the first one.
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    expect((await readNetRoute(w.record))!.previous).toEqual({ id: LEADER, name: 'mac', accept: true, addrs: ['10.0.0.9:4100'] })
    expect((await run([...FLIP, '--revert'], w.deps)).answer).toMatchObject({ ok: true, state: 'reverted', reload: 'ok' })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
    expect((await run([...FLIP, '--revert'], w.deps))).toMatchObject({ code: 0, answer: { ok: true, state: 'none', reload: 'none' } })
    expect((await run([...FLIP, '--confirm'], w.deps)).answer).toMatchObject({ ok: true, state: 'none' })
  })

  it('a member another writer changed since is left as it is', async () => {
    const w = world()
    await fakeNet(w.netDir)
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    // An older Walnut's whole-file write puts the member back without the set's route.
    const theirs = w.text.replace('"name": "mac"', '"name": "mac-renamed"')
    fs.writeFileSync(w.config, theirs)
    const r = await run([...FLIP, '--revert'], w.deps)
    expect(r.answer).toMatchObject({ ok: true, state: 'left', reload: 'none' })
    expect((r.answer.entry as Record<string, unknown>).name).toBe('mac-renamed')
    expect(fs.readFileSync(w.config, 'utf8')).toBe(theirs)
    expect(fs.existsSync(w.record)).toBe(false)
  })

  it('refuses: no such member, no config, a member of another set, the default set, bad words', async () => {
    const w = world()
    const stranger = netKey('route-stranger')
    expect(await run(['--walnut', WALNUT, '--member', stranger], w.deps)).toMatchObject({ code: 1, answer: { ok: false, action: 'flip', code: 'no_member' } })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
    expect(fs.existsSync(w.record)).toBe(false)

    const other = w.text.replace(`"name": "other-mac",`, `"name": "other-mac",\n      "walnut": "1111222233334444",`)
    fs.writeFileSync(w.config, other)
    expect((await run(['--walnut', WALNUT, '--member', OTHER], w.deps)).answer).toMatchObject({ ok: false, code: 'other_set' })
    fs.rmSync(w.config)
    expect((await run(FLIP, w.deps)).answer).toMatchObject({ ok: false, code: 'no_config' })

    // This Walnut holds the default set on this machine: its leader needs no flip.
    const d = world({ installed: false })
    const defaultRoot = serviceSet(platform, d.home, '').installRoot
    fs.mkdirSync(defaultRoot, { recursive: true })
    fs.writeFileSync(path.join(defaultRoot, SET_OWNER_FILE), JSON.stringify({ v: 1, walnutId: WALNUT }) + '\n')
    const def = await run(FLIP, d.deps)
    expect(def).toMatchObject({ code: 1, line: 'service set: default', answer: { ok: false, code: 'default_set' } })
    expect(fs.readFileSync(d.config, 'utf8')).toBe(d.text)

    for (const words of [['--walnut', WALNUT, '--member', 'abc'], ['--member', LEADER], [...FLIP, '--confirm', '--revert'], [...FLIP, '--revert-after', '5'], [...FLIP, '--if-pending', '0123456789abcdef'], ['--walnut', 'xyz', '--member', LEADER]]) {
      expect((await run(words, w.deps)).answer, words.join(' ')).toMatchObject({ ok: false, code: 'bad_args' })
    }
  })

  it('a silent walnut-net is reported and the write stays; with none running the answer says none', async () => {
    const w = world()
    expect((await run(FLIP, w.deps)).answer).toMatchObject({ ok: true, state: 'pending', reload: 'none' })
    await run([...FLIP, '--revert'], w.deps)
    await fakeNet(w.netDir, { silent: true })
    const r = await run(FLIP, { ...w.deps, reloadTimeoutMs: 200 })
    expect(r.answer).toMatchObject({ ok: true, state: 'pending', reload: 'failed' })
    expect(String(r.answer.reloadError)).toMatch(/did not answer/)
    expect(members(w.config)[1]).toMatchObject({ walnut: SET, daemonPortFile: w.portFile })
  })

  it('no put-back child, no flip: a route nothing would put back is undone at once', async () => {
    const w = world()
    await fakeNet(w.netDir)
    const spawn: NetRouteDeps['spawn'] = () => ({ pid: undefined, unref() {}, on() { return this } })
    const r = await run(FLIP, { ...w.deps, spawn })
    expect(r.answer).toMatchObject({ ok: false, code: 'no_revert_child', state: 'reverted' })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
    expect((await run(FLIP, { ...w.deps, commandPrefix: null })).answer).toMatchObject({ ok: false, code: 'no_revert_child' })
    expect(fs.readFileSync(w.config, 'utf8')).toBe(w.text)
  })

  it('the put-back runs walnut the way this process was started', () => {
    const x = '/usr/bin/self'
    expect(walnutCommandPrefix(['bun', '/$bunfs/root/walnut', 'walnut', 'daemon', 'net-route', '--walnut'], x)).toEqual([x, 'walnut'])
    expect(walnutCommandPrefix(['bun', '/$bunfs/root/walnut', 'daemon', 'net-route'], x)).toEqual([x])
    expect(walnutCommandPrefix(['node', '/d/daemon.js', 'walnut', 'daemon', 'net-route'], x)).toEqual([x, '/d/daemon.js', 'walnut'])
    expect(walnutCommandPrefix(['node', '/n/dist/cli.js', 'daemon', 'net-route'], x)).toEqual([x, '/n/dist/cli.js'])
    expect(walnutCommandPrefix(['node', '/n/dist/cli.js', 'daemon', 'status'], x)).toBeNull()
  })
})

describe('the set\'s daemon confirms its routes when its own leader reaches it', () => {
  it('net-core confirmRoutes confirms this set\'s pending routes for its own Walnut only', async () => {
    const w = world()
    await fakeNet(w.netDir)
    await netRoute(parseNetRouteArgs(FLIP), w.deps)
    const sup = (setId: string) => createNetSupervisor({ spawn: () => { throw new Error('no spawn') }, stateDir: w.netDir, portFile: w.portFile, setId, bin: () => null })
    expect(await sup('').confirmRoutes(WALNUT)).toEqual([])
    expect(await sup(SET).confirmRoutes(OTHER_WALNUT)).toEqual([])
    expect(await sup(SET).confirmRoutes(undefined)).toEqual([])
    expect((await readNetRoute(w.record))!.state).toBe('pending')
    expect(await sup(SET).confirmRoutes(WALNUT)).toEqual([LEADER])
    expect((await readNetRoute(w.record))!.state).toBe('confirmed')
    expect(await sup(SET).confirmRoutes(WALNUT)).toEqual([])
    // A missing routes dir is nothing to confirm, never an error.
    expect(await createNetSupervisor({ spawn: () => { throw new Error('no spawn') }, stateDir: path.join(root, 'none'), portFile: w.portFile, setId: SET, bin: () => null }).confirmRoutes(WALNUT)).toEqual([])
  })

  /** cmdLeaderConfigure, sliced out of a twin and run with everything it names injected. */
  function leaderConfigureOf(twin: 'standalone' | 'template') {
    const src = twin === 'standalone' ? fs.readFileSync(path.join(REPO, 'src/providers/daemon-standalone.ts'), 'utf8') : getDaemonSource()
    const at = src.indexOf('function cmdLeaderConfigure(')
    expect(at, `${twin}: cmdLeaderConfigure`).toBeGreaterThan(-1)
    const body = src.slice(at, at + src.slice(at).indexOf('\n}\n') + 2)
    const js = twin === 'standalone' ? ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText : body
    const names = ['leaderBook', 'bindGatewayClientHome', 'moveNotTaken', 'homeNamedAs', 'sendOk', 'sendError', 'refuseForeignHome', 'LEADER_TAKEOVER_MS', 'SET_ID', 'netSupervisor']
    return (env: Record<string, unknown>) => new Function(...names, `${js}\nreturn cmdLeaderConfigure`)(...names.map((k) => env[k])) as (ws: unknown, id: number, cmd: Record<string, unknown>) => void
  }

  for (const twin of ['standalone', 'template'] as const) {
    it(`${twin}: leader.configure of the set's own Walnut confirms; the default set never asks`, () => {
      const make = leaderConfigureOf(twin)
      for (const setId of [SET, '']) {
        const asked: unknown[] = []
        const oks: unknown[] = []
        const fn = make({
          leaderBook: { configure: (o: { home: string; walnutId: string }) => ({ home: o.home, walnutId: o.walnutId, epoch: 1, holder: 'x', since: 0 }) },
          bindGatewayClientHome: () => {}, moveNotTaken: new WeakMap(), homeNamedAs: new WeakMap(),
          sendOk: (_ws: unknown, _id: number, v: unknown) => oks.push(v), sendError: (_ws: unknown, _id: number, m: string) => { throw new Error(m) },
          refuseForeignHome: () => false, LEADER_TAKEOVER_MS: 1, SET_ID: setId,
          netSupervisor: { confirmRoutes: (id: unknown) => { asked.push(id); return Promise.resolve([]) } },
        })
        fn({ data: {}, origin: 'local' }, 1, { cmd: 'leader.configure', home: '/h', walnutId: WALNUT })
        expect(oks, `${twin} ${setId || 'default'}`).toHaveLength(1)
        expect(asked, `${twin} ${setId || 'default'}`).toEqual(setId ? [WALNUT] : [])
      }
    })
  }
})
