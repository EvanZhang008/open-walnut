/**
 * One machine under two host keys, every piece a real process (docs/plan/one-service-every-host.md,
 * phase 2): the cluster of tests/helpers/host-judge-cluster.ts, whose Mac config names the host
 * twice: `devbox` (the row its one service goes by, as a box that joined the host network) and
 * `devbox-ssh` (another row reaching the same daemon, as an ssh row of that box does). The Mac
 * links the alias with its own daemon connection to the same door, so it reads both names as one
 * machine from the daemon's own hellos (revoked-hosts.ts sameMachine), as it does in production.
 *
 *   A1 start   a start on `devbox-ssh` goes to the machine's one service, under the name the
 *              service goes by: the session's row is the host's (judge 'host', host `devbox`), two
 *              turns are judged on the host, and every fact of it reaches the Mac once, in order,
 *              over the `devbox` channel; nothing of it is refused
 *   A2 other   a session handed to a name that is not this machine (`farbox`, a row with no link):
 *              a born row of it from the `devbox` channel is refused, no row made
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { factsAtBothEnds, startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'
const ALIAS = 'devbox-ssh'
const FAR = 'farbox'

/**
 * The Mac's second link to the host's daemon, under the alias, once the test drops `alias-on` in the
 * cluster's base: its own connection to the same door (another address of it), redialed each second
 * as the main link is (replica-cluster.ts macBoot). Not at boot, so the host's one service is set
 * up under `devbox` first, as it was before the alias was found.
 */
const ALIAS_LINK = `
{
  const npath = await import('node:path')
  const nfs = await import('node:fs')
  const base = npath.dirname(npath.dirname(c.WALNUT_HOME))
  let aliasConn = null
  const aliasLink = async () => {
    if (!nfs.existsSync(npath.join(base, 'alias-on'))) return
    const port = String(nfs.readFileSync(npath.join(base, 'hd', 'daemon.port'), 'utf8')).trim()
    const conn = await dcm.getDirectDaemonConnection(${JSON.stringify(ALIAS)}, 'ws://127.0.0.1:' + port + '/')
    if (aliasConn && aliasConn !== conn) aliasConn.disconnect()
    aliasConn = conn
    dcm.setPooledConnectionForTest(${JSON.stringify(ALIAS)}, conn)
  }
  setInterval(() => { void aliasLink().catch(() => {}) }, 1000).unref()
}
`

describe.skipIf(!RUN)('one machine under two host keys: a start on either name is the machine\'s', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let sid = ''

  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${s}`)) as ProbeEvent[]
  const channelEvents = async (s: string) => (await macEvents(s)).filter((e) => e.source === 'host-channel')
  const hostFacts = async (after = 0): Promise<{ head: number; logId: string; recs: HostFactRecord[] }> => h.host(`/facts?after=${after}`)
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-8000)}\n--- replica ---\n${h.c.logs().replica.slice(-4000)}`

  beforeAll(async () => {
    h = await startHostJudgeCluster({
      // Two more rows of the Mac's hosts (indented as hosts, not as fields of devbox's row).
      macHostExtra: [`  ${ALIAS}:`, `    hostname: ${ALIAS}.invalid`, `  ${FAR}:`, `    hostname: ${FAR}.invalid`],
      macBootExtra: ALIAS_LINK,
    })
    process.stdout.write(`host-judged-alias-cluster-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Alias judged run', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-alias: logs at ${writeClusterLogs(h.c, 'host-judged-alias')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('A1: a start on the ssh name runs in the machine\'s one service; two turns judged there; its facts reach the Mac once, none refused', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel')
    // Today's start probe for the alias: no service of its own, so legacy until the Mac reads it as devbox's machine.
    expect((await h.mac(`/side?host=${ALIAS}`)).judges).toBe(false)
    fs.writeFileSync(path.join(h.c.base, 'alias-on'), '1')
    await waitFor(async () => (await h.mac(`/side?host=${ALIAS}`)).startKey === HOST_KEY, 120_000, 'the Mac to read the alias as the same machine').catch((err) => { throw new Error(say(String(err))) })
    expect((await h.mac(`/side?host=${FAR}`)).startKey).toBeNull()

    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: ALIAS, cwd: hostCwd, mode: 'bypass', message: 'ALIAS one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    expect(sid).toBeTruthy()
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ALIAS one'), 120_000, 'the first answer on the Mac').catch((err) => { throw new Error(say(String(err))) })
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ALIAS two' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(async () => resultOn(await channelEvents(sid), 'echo: ALIAS two'), 120_000, 'the second answer on the Mac').catch((err) => { throw new Error(say(String(err))) })

    // The row: the host's, under the name its service goes by.
    const row = (await h.mac(`/row?sid=${sid}`)).row as Record<string, unknown>
    expect(row).toMatchObject({ claudeSessionId: sid, judge: 'host', host: HOST_KEY, taskId })
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    // Both turns were the host's (parsed there, none here), and the send was its runner's.
    expect((await h.mac(`/parses?sid=${sid}`)).parses).toBe(0)
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:send' && String(e.data?.message ?? '').includes('ALIAS two'))).toBe(true)

    // Every fact once, in the host's order; session:started once (the Mac's own word for its start).
    let last = -1
    let since = 0
    await waitFor(async () => {
      const head = (await hostFacts(0)).head
      if (head !== last) { last = head; since = Date.now(); return false }
      return Date.now() - since >= 1_000 && ((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= head
    }, 60_000, 'the host\'s log to be still and the Mac\'s cursor at its head', 200)
    const f = factsAtBothEnds((await hostFacts(0)).recs, await macEvents(sid), sid)
    expect(f.started.map((e) => e.source), JSON.stringify(f.started)).toHaveLength(1)
    expect(f.seen, `host: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    // Nothing of it was refused or skipped as another host's, and no hand of it is left.
    const mac = h.c.logs().mac
    for (const line of mac.split('\n').filter((l) => l.includes(sid))) {
      expect(line).not.toMatch(/were not said|not this host's rows|a row change was refused|not its own/)
    }
    expect((await h.mac('/hands')).hands.filter((x: { sid: string | null }) => x.sid === sid)).toEqual([])
  }, 400_000)

  it('A2: a session handed to another machine\'s name: a born row of it from this machine\'s channel is refused', async () => {
    const forged = '70000000-0000-4000-8000-0000000000f1'
    await h.mac(`/hand?host=${FAR}&sid=${forged}`)
    const { seq } = await h.host(`/forge?sid=${forged}`)
    await waitFor(async () => ((await h.mac(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= seq, 60_000, 'the Mac to apply the forged record')
    expect((await h.mac(`/row?sid=${forged}`)).row).toBeNull()
    // Still handed to the other machine: nothing of it was taken.
    expect((await h.mac('/hands')).hands).toContainEqual({ host: FAR, sid: forged })
    await waitFor(() => h.c.logs().mac.split('\n').some((l) => l.includes(forged) && l.includes('not its own')), 30_000, 'the refusal in the Mac log')
  }, 120_000)
})
