/**
 * The leader's `walnut daemon` lines and update scripts with service sets (src/providers/
 * service-set-leader.ts; the experiment host_service_sets).
 *
 * Flag off: every line and script is byte for byte the one HEAD da1aecd54a rendered (the sha256
 * values below came from that commit's own code, extracted with `git archive` and rendered by the
 * same steps as render() here; notes/ab-leader/render.ts in the task's notes). Flag on: the lines
 * name the Walnut (`--walnut <id> --walnut-home <home>`), the scripts watch the set's own service,
 * and a host that prints no `service set:` line keeps today's path (nothing is recorded).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRemoteDaemonService, updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { reviveScript, tailFunctionLines, updateSnapshotLines, updateTailLines } from '../../src/providers/daemon-update-tail.js'
import { standInScript, standInStartLines } from '../../src/providers/daemon-update-standin.js'
import { probingCheckScript } from '../../src/providers/daemon-update-probation.js'
import { managedUpdateScope, remoteServiceProbePaths, reviveScopeOf } from '../../src/providers/daemon-connection.js'
import {
  helloServiceSet, hostServiceSets, hostServiceSetsWanted, linkStanding, recordServiceSetFrom, serviceSetWords, setServiceConfigPaths,
} from '../../src/providers/service-set-leader.js'
import { updateStoresSettled } from '../../src/providers/daemon-update-store.js'

const EXE = '/home/u/.local/share/open-walnut/daemon/versions/x/walnut-daemon-linux-x64'
const V = 'walnut-daemon-abc123'
const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const HOME_DIR = '/home/u/.open-walnut'
const sha = (t: string) => createHash('sha256').update(t).digest('hex')

/** A host that answers like the real CLI would; `head` is what the CLI printed before its JSON. */
function fakeIo(head = '') {
  const lines: string[] = []
  const specs: Array<Record<string, unknown>> = []
  const io = {
    run: async (c: string) => {
      lines.push(c)
      if (c.includes('__daemon --version')) return V
      return head + (c.includes(' status') ? '{"installed":true,"scope":"user"}' : '{"ok":false,"failure":{"message":"x"}}')
    },
    chunk: async () => true,
    serviceUpdate: async (u: Record<string, unknown>) => {
      lines.push(`UPDATE ${JSON.stringify(u)}`)
      specs.push(u)
      return { output: '{"ok":true}', tail: null, ...(head ? { head } : {}) }
    },
  }
  return { io, lines, specs }
}

let env: Record<string, string | undefined>
beforeEach(() => {
  env = { L: process.env.WALNUT_SERVICE_LAUNCHER, S: process.env.WALNUT_HOST_SERVICE_SETS, F: process.env.WALNUT_SERVICE_SET_FILE }
  process.env.WALNUT_SERVICE_LAUNCHER = '0'
})
afterEach(() => {
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  put('WALNUT_SERVICE_LAUNCHER', env.L); put('WALNUT_HOST_SERVICE_SETS', env.S); put('WALNUT_SERVICE_SET_FILE', env.F)
})

/** The same steps notes/ab-leader/render.ts ran on HEAD. */
async function render(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const { io, lines } = fakeIo()
  await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'user', {})
  await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'cron', { overBusy: true, serve: { home: HOME_DIR, on: false } })
  await installRemoteDaemonService({ existing: EXE, binary: null }, V, io)
  out.lines = lines.join('\n')
  for (const scope of ['user', 'cron'] as const) {
    out[`tail-${scope}`] = updateTailLines({ scope }).join('\n')
    out[`snap-${scope}`] = updateSnapshotLines({ scope }).join('\n')
    out[`fns-${scope}`] = tailFunctionLines({ scope }).join('\n')
    out[`revive-${scope}`] = reviveScript({ scope })
    out[`probing-${scope}`] = probingCheckScript(scope)
  }
  out.standin = standInScript(30)
  out.standinStart = standInStartLines(30).join('\n')
  out.probe = remoteServiceProbePaths().join('\n') + '|' + remoteServiceProbePaths('/x').join('\n')
  const p = remoteServiceProbePaths()
  out.scopes = JSON.stringify([[p[1]], [p[3]], [p[4]], [p[1], p[3]], [p[2]]].map((x) => [reviveScopeOf(x!), managedUpdateScope(x!)]))
  return out
}

/** HEAD da1aecd54a's renderings (flag off). */
const HEAD_SHA: Record<string, string> = {
  lines: '7f611c3b8d8e05a560b0f5ba9291ac0c250579001da6ab71af7991e5190688cf',
  'tail-user': 'e49df00453b900064c74a2890899466e12b922f9e670f832efd1f47ebdde3506',
  'snap-user': '7ccf82425909a13681c8722b5c663e2b3e1a2ebb30cc49273de030d9b0ed18ae',
  'fns-user': 'b23cc385a2b7cdba2b32b3b198f059d66989998f24e84cd2498f9ef098a71a2d',
  'revive-user': 'bdd9fc05aa811998e28dad857b9e04038a1454c61e3fa26131ba1a203bcb3d51',
  'probing-user': '47800463b34995f056e43945e7a9409a25c5669e2fa91610487da43f7503ae52',
  'tail-cron': 'f9fce507e603945f8a47c024297bc0ba2975cf022a13491454248495aa26ab59',
  'snap-cron': '6a38626ae2e46b176808ca0fa1371112157dd3ab6e5a16946463bab77200964b',
  'fns-cron': 'f2a3983a757d7f2444e71e29a4879e11a4294636fad6df05b451dacecc1d34a0',
  'revive-cron': '85425d74b917382774ba685cddc7a9e0b1d183c28155a0647c1a0c7c40457da6',
  'probing-cron': 'e9f2899b5a121b1d5bba48fc920eb8ffdb2958460dd2f82da1edb69b6e793a40',
  standin: '435562ece5523eb8d4c9dece6445e3925ad5345e0b2f30f79d739d3c6b5e4c2b',
  standinStart: 'c5224daa061f0897637c1688fe2d393263a08588ef5cd41524a8503d0eb082e9',
  probe: '488c8b569cfc1dd66ecf0d61dad08804e628371323350726400b0a4fd37ae6f7',
  scopes: '105fbc2db8ecd7837242bbf0118c89255c2ddc8ac47d11e73e55c2474259df84',
}

describe('service sets on the leader: flag off', () => {
  it('every line and script is byte for byte HEAD\'s', async () => {
    const out = await render()
    expect(Object.fromEntries(Object.entries(out).map(([k, t]) => [k, sha(t)]))).toEqual(HEAD_SHA)
  })

  it('the update and install lines, spelled out', async () => {
    const { io, lines } = fakeIo()
    await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'user', {})
    await installRemoteDaemonService({ existing: EXE, binary: null }, V, io)
    const cmds = lines.filter((l) => l.startsWith('UPDATE ') || l.includes('walnut daemon'))
    expect(cmds.map((l) => (l.startsWith('UPDATE ') ? (JSON.parse(l.slice(7)) as { command: string }).command : l))).toEqual([
      `${EXE} walnut daemon update --yes --scope user --executable ${EXE}`,
      `${EXE} walnut daemon install --yes --executable ${EXE} 2>/dev/null || true`,
      `${EXE} walnut daemon status 2>/dev/null || true`,
      `${EXE} walnut daemon uninstall --yes --scope user 2>/dev/null || true`,
    ])
    expect(lines.join('\n')).not.toMatch(/--walnut/)
  })

  it('the experiment reads off by default, and the words are empty without an ask', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    expect(await hostServiceSetsWanted()).toBe(false)
    expect(serviceSetWords(null)).toBe('')
    expect(linkStanding({ set: SET }, '', false)).toBe('unknown')
  })
})

describe('service sets on the leader: flag on', () => {
  const ask = { walnutId: WALNUT, home: HOME_DIR }

  it('the update line names the Walnut and its data dir, the tail watches the set, and the set the host named is told', async () => {
    const { io, specs } = fakeIo('service set: 0123456789abcdef\n')
    const told: Array<string | null> = []
    await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'user', { walnut: ask, set: SET, onServiceSet: (s) => { told.push(s) } })
    expect(specs[0]!.command).toBe(`${EXE} walnut daemon update --yes --scope user --executable ${EXE} --walnut ${WALNUT} --walnut-home ${HOME_DIR}`)
    expect(specs[0]!.set).toBe(SET)
    expect(told).toEqual([SET])
  })

  it('the serve words still come first, then the set words', async () => {
    process.env.WALNUT_SERVICE_LAUNCHER = '1'
    const { io, specs } = fakeIo('service set: default\n')
    const told: Array<string | null> = []
    await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'user', { serve: { home: HOME_DIR, on: true }, walnut: ask, onServiceSet: (s) => { told.push(s) } })
    expect(specs[0]!.command).toBe(`${EXE} walnut daemon update --yes --scope user --executable ${EXE} --launcher --serve ${HOME_DIR} --walnut ${WALNUT} --walnut-home ${HOME_DIR}`)
    expect(told).toEqual([''])
  })

  it('a host that prints no `service set:` line is told as null (nothing changes)', async () => {
    const { io } = fakeIo()
    const told: Array<string | null> = []
    await updateRemoteDaemonService({ existing: EXE, binary: null }, V, io, 'user', { walnut: ask, onServiceSet: (s) => { told.push(s) } })
    expect(told).toEqual([null])
  })

  it('the install, its status and its clean-up uninstall all name the Walnut; the set comes back', async () => {
    const { io, lines } = fakeIo('service set: 0123456789abcdef\n')
    const r = await installRemoteDaemonService({ existing: EXE, binary: null }, V, io, { walnut: ask })
    const cli = lines.filter((l) => l.includes('walnut daemon'))
    expect(cli.length).toBe(3)
    for (const l of cli) expect(l).toContain(` --walnut ${WALNUT} --walnut-home ${HOME_DIR} 2>/dev/null || true`)
    expect(r.serviceSet).toBe(SET)
  })

  it('the scripts name the set\'s own unit, label and install root; the default set renders as before', () => {
    const tail = updateTailLines({ scope: 'user', set: SET }).join('\n')
    expect(tail).toContain(`open-walnut-daemon-${SET}.service`)
    expect(tail).toContain(`dev.openwalnut.session-daemon.${SET}`)
    expect(tail).toContain(`.open-walnut-host/walnuts/${SET}/daemon`)
    expect(updateTailLines({ scope: 'user', set: '' }).join('\n')).toBe(updateTailLines({ scope: 'user' }).join('\n'))
    expect(standInScript(30, SET)).toContain(`walnut daemon handback --yes --scope user --walnut ${SET}`)
    expect(probingCheckScript('cron', SET)).toContain(`walnuts/${SET}/daemon`)
    expect(reviveScript({ scope: 'user', set: SET })).toContain(`dev.openwalnut.session-daemon.${SET}`)
  })

  it('the probe paths and scopes read the set\'s own config files', () => {
    const paths = remoteServiceProbePaths('/x', SET)
    expect(paths).toEqual(['/x/daemon.service', ...setServiceConfigPaths(SET).linux, ...setServiceConfigPaths(SET).darwin])
    expect(paths.join('\n')).toContain(`open-walnut-daemon-${SET}.service`)
    const { linux: [user, , cron] } = setServiceConfigPaths(SET)
    expect(managedUpdateScope([user!], SET)).toBe('user')
    expect(managedUpdateScope([cron!], SET)).toBe('cron')
    // The default's files say nothing about the set's service.
    expect(managedUpdateScope([remoteServiceProbePaths()[1]!], SET)).toBe(null)
    expect(reviveScopeOf([user!], SET)).toBe('user')
  })

  it('the words: a walnut id that names no set or a home that is not plain gives none', () => {
    expect(serviceSetWords(ask)).toBe(` --walnut ${WALNUT} --walnut-home ${HOME_DIR}`)
    expect(serviceSetWords({ walnutId: 'nothex', home: HOME_DIR })).toBe('')
    expect(serviceSetWords({ walnutId: WALNUT, home: 'relative' })).toBe('')
    expect(serviceSetWords({ walnutId: WALNUT, home: '/a\nb' })).toBe('')
    expect(serviceSetWords({ walnutId: WALNUT, home: "/it's" })).toBe(` --walnut ${WALNUT} --walnut-home '/it'\\''s'`)
  })

  it('standing: default, own, shared and unknown', () => {
    expect(linkStanding(null, '', true)).toBe('unknown')
    expect(linkStanding({ set: '' }, '', true)).toBe('default')
    expect(linkStanding({ set: SET }, SET, true)).toBe('own')
    expect(linkStanding({ set: SET }, '', true)).toBe('shared')
    expect(linkStanding({ set: SET }, 'fedcba9876543210', true)).toBe('shared')
    expect(helloServiceSet({ serviceSet: SET })).toBe(SET)
    expect(helloServiceSet({})).toBe('')
    expect(helloServiceSet({ serviceSet: 'BAD' })).toBe('')
  })

  it('the set a line named is kept per place; an older host\'s output keeps nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-store-'))
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
    try {
      expect(await recordServiceSetFrom('ssh:h', '{"ok":true}')).toBe(null)
      expect(await hostServiceSets.read('ssh:h')).toBe(null)
      expect(await recordServiceSetFrom('ssh:h', 'service set: 0123456789abcdef\n{}', '/home/u/.open-walnut-host/walnuts/0123456789abcdef/rt')).toBe(SET)
      // A later line of the same set keeps the runtime dir it learned.
      await recordServiceSetFrom('ssh:h', 'service set: 0123456789abcdef\n{}')
      await updateStoresSettled()
      expect(await hostServiceSets.read('ssh:h')).toMatchObject({ set: SET, runtimeDir: '/home/u/.open-walnut-host/walnuts/0123456789abcdef/rt' })
      await recordServiceSetFrom('ssh:h', 'service set: default\n{}')
      expect((await hostServiceSets.read('ssh:h'))?.set).toBe('')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
