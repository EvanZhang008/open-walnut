/**
 * A session its host runs and judges is read on its host (src/core/sessions/host-history-reads.ts;
 * docs/plan/one-service-every-host.md, phase 2, Done-when 2: "the Mac's main thread parses no line
 * of a session on another host"), every piece a real process: the cluster of
 * tests/helpers/host-judge-cluster.ts (the Mac with the switch on; the host's one Walnut service
 * running the session through its runtime, the mock CLI filing its own transcript there).
 *
 * In order, on one session:
 *   R1 history   the console's whole history and its first page (a tail): the host's rows, the
 *                Mac parses no line of the session (its line count, which counts transcript
 *                lines too, stays 0)
 *   R2 older     an older page (?before=, the bytes before the page in hand): the rows before it
 *   R3 tail      a new turn, then the tail again: the new answer is in it, still no line parsed
 *   R4 plan      GET /plan: the plan of the session's ExitPlanMode call, read on the host
 *   R5 search    the search index's read of the session (readSessionBody): the host's text
 *   R6 legacy    the same reads made the old way, the Mac fetching and parsing the host's lines
 *                itself: equal content, and the count now says the Mac parsed lines (so the
 *                0 above is the count seeing nothing, not a count that sees nothing)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

type Row = { role: string; text: string; timestamp?: string; msgId?: string }
/** What a reader shows of a row: who said it and what. */
const shown = (rows: Row[]) => rows.map((m) => `${m.role}: ${m.text}`)

describe.skipIf(!RUN)('a host-judged session is read and parsed on its host', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let sid = ''

  const parses = async () => (await h.mac(`/parses?sid=${sid}`)).parses as number
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const answered = async (text: string) => waitFor(async () => {
    const e = (await h.mac(`/events?sid=${sid}`)) as ProbeEvent[]
    return e.some((x) => x.source === 'host-channel' && x.name === 'session:result' && String(x.data?.result ?? '').includes(text))
  }, 120_000, `the answer "${text}" on the Mac`).catch((err) => { throw new Error(say(String(err))) })
  const history = async (query = '') => {
    const r = await h.c.mac('GET', `/api/sessions/${sid}/history${query}`)
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    return r.json as { messages: Row[]; windowed?: boolean; reachedStart?: boolean }
  }
  const read = async (what: string, legacy = false) => {
    const r = await h.mac(`/read?sid=${sid}&what=${what}${legacy ? '&legacy=1' : ''}`)
    expect(r.error, JSON.stringify(r)).toBeUndefined()
    return r.value
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judged-history-cluster-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Host judged reads', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel')
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'please plan Move the archive to the new disk' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await answered('echo: planned')
    for (const word of ['ROUND two', 'ROUND three']) {
      const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: word })
      expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
      await answered(`echo: ${word}`)
    }
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-history: logs at ${writeClusterLogs(h.c, 'host-judged-history')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('R1: the whole history and its first page are the host\'s rows, and the Mac parses no line', async () => {
    const full = await waitFor(async () => {
      const r = await history()
      return shown(r.messages).some((t) => t.includes('echo: ROUND three')) ? r : null
    }, 60_000, 'the whole history to hold the third answer')
    expect(shown(full.messages).some((t) => t.includes('please plan Move the archive'))).toBe(true)
    const first = await history('?tail=2')
    expect(first.messages.length).toBeGreaterThan(0)
    expect(first.messages.length).toBeLessThan(full.messages.length)
    expect(shown(first.messages).at(-1)).toBe(shown(full.messages).at(-1))
    expect(await parses()).toBe(0)
  }, 180_000)

  it('R2: an older page holds the rows before the page in hand', async () => {
    const first = await history('?tail=2')
    const head = first.messages[0]!
    expect(head.timestamp).toBeTruthy()
    const older = await history(`?before=${encodeURIComponent(head.timestamp!)}${head.msgId ? `&beforeId=${encodeURIComponent(head.msgId)}` : ''}`)
    expect(shown(older.messages).some((t) => t.includes('please plan Move the archive')), JSON.stringify(shown(older.messages))).toBe(true)
    expect(shown(older.messages)).not.toContain(shown(first.messages).at(-1))
    expect(await parses()).toBe(0)
  }, 180_000)

  it('R3: after a new turn the tail holds its answer, and still no line is parsed here', async () => {
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND four' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await answered('echo: ROUND four')
    const tail = await waitFor(async () => {
      const r = await history('?tail=2')
      return shown(r.messages).some((t) => t.includes('echo: ROUND four')) ? r : null
    }, 60_000, 'the tail to hold the fourth answer')
    expect(shown(tail.messages).at(-1)).toContain('echo: ROUND four')
    const readerTail = (await read('tail')) as Row[]
    expect(shown(readerTail).some((t) => t.includes('echo: ROUND four'))).toBe(true)
    expect(await parses()).toBe(0)
  }, 180_000)

  it('R4: the plan is read on the host', async () => {
    const r = await h.c.mac('GET', `/api/sessions/${sid}/plan`)
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.content).toContain('Move the archive to the new disk')
    expect(await parses()).toBe(0)
  }, 120_000)

  it('R5: the search index reads the host\'s text', async () => {
    const body = (await read('body')) as { body: string | null }
    expect(body.body).toContain('ROUND four')
    expect(await parses()).toBe(0)
  }, 120_000)

  it('R6: the old way, the Mac parsing the host\'s lines, shows the same content, and the count sees it', async () => {
    const routed = { full: await read('full') as Row[], tail: await read('tail') as Row[], plan: await read('plan'), body: await read('body') }
    expect(await parses()).toBe(0)
    const legacy = { full: await read('full', true) as Row[], tail: await read('tail', true) as Row[], plan: await read('plan', true), body: await read('body', true) }
    expect(shown(routed.full)).toEqual(shown(legacy.full))
    expect(shown(routed.tail)).toEqual(shown(legacy.tail))
    expect(routed.plan).toEqual(legacy.plan)
    expect(routed.body).toEqual(legacy.body)
    // The console's whole history equals the legacy read too.
    expect(shown((await history()).messages)).toEqual(shown(legacy.full))
    expect(await parses()).toBeGreaterThan(0)
  }, 180_000)
})
