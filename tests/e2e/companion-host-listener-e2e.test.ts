/**
 * The Mac away, the phone sees and operates a session its host judges, through the cloud companion
 * (land 5b; src/core/session-channel/companion-dialer.ts on the host, listener-door.ts,
 * companion-listener.ts and companion-host-ops.ts on the companion), every piece a real process:
 * the cluster of tests/helpers/host-judge-cluster.ts with its companion (a real companion paired
 * with the Mac; the Mac configures the host's bridge itself and its heartbeat names its switch).
 *
 *   P1 linked   a host-judged session runs on the host; the host's service dials the companion's
 *               listener door with its bridge token, and the companion's phone API lists the session
 *   P2 away     the Mac stopped (SIGSTOP of its server and daemon): past the takeover window the
 *               companion answers from the host's word (detail `viaHost`), and the list still shows it
 *   P3 stream   a send from the phone is queued on the host under the phone's id and answered; its
 *               stream shows the turn's text and its end; a retry of the same id is queued once
 *   P4 stop     an interrupt from the phone stops a running turn on the host
 *   P5 prompt   a permission prompt the host's session raises shows in the phone's detail, and the
 *               phone's answer reaches the host, which runs the tool
 *   P5b pictures  a send with 1 and with 3 pictures (land 8): each saved on the host byte for byte by
 *               its daemon's `image.save`, the CLI's words name them under the images header (as a
 *               legacy send's do), and each answer comes back once
 *   P5c too big a picture past the host's cap is refused as on every path, and nothing is sent
 *   P6 back     the Mac woken: it has every fact of the session once and in order (the phone's
 *               turns included), its history shows the pictures as a legacy send's, and the
 *               companion relays to the Mac again (no `viaHost`)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IMAGES_ATTACHED_LINE } from '../../src/lib/attachment-headers.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, WINDOWS, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { factsAtBothEnds, startHostJudgeCluster, untilFactsStill, type HostFactRecord, type HostJudgeCluster, type PhoneStream, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('the phone operates a host-judged session through the companion while the Mac is away', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let sid = ''
  let stream: PhoneStream | null = null

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const hostFacts = async (): Promise<{ head: number; recs: HostFactRecord[] }> => h.host('/facts?after=0')
  const resultsOf = (recs: HostFactRecord[], s: string, text: string) => recs.filter((r) => r.sid === s && r.name === 'session:result' && String(r.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- companion ---\n${h.companion?.log().slice(-6000)}\n--- mac ---\n${h.c.logs().mac.slice(-3000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const textOn = (s: PhoneStream) => s.frames.filter((f) => f.event === 'text-delta').map((f) => String(f.data?.delta ?? '')).join('')
  const mid = () => `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
  /** A picture the daemon takes (a PNG's signature first), its bytes its own. */
  const png = (size = 64) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), crypto.randomBytes(Math.max(0, size - 16))])
  /** The saved paths a turn's words name under the images header. */
  const namedPictures = (text: string) => {
    const at = text.indexOf(IMAGES_ATTACHED_LINE)
    if (at < 0) return []
    const out: string[] = []
    for (const line of text.slice(at + IMAGES_ATTACHED_LINE.length).split('\n').slice(1)) {
      if (!line.startsWith('- ')) break
      out.push(line.slice(2).trim())
    }
    return out
  }
  /** Each picture sent, in order, with the file its turn named on the host. */
  const pictureSends: Array<{ words: string; files: string[] }> = []

  beforeAll(async () => {
    h = await startHostJudgeCluster({ companion: true })
    process.stdout.write(`companion-host-listener-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Phone run on the host', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) {
      const file = writeClusterLogs(h.c, 'companion-listener')
      fs.appendFileSync(file, `--- companion ---\n${h.companion?.log() ?? ''}\n`)
      // Every process's own Walnut log in the cluster (the host service's runner lines among them).
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /^open-walnut-.*\.log$/.test(e.name) ? [path.join(d, e.name)] : [])
      for (const f of walk(h.c.base)) fs.appendFileSync(file, `--- ${path.relative(h.c.base, f)} ---\n${fs.readFileSync(f, 'utf8').slice(-400_000)}\n`)
      process.stdout.write(`companion-listener: logs at ${file}\n`)
    }
  })
  afterAll(async () => { stream?.close(); await h?.stop() }, 180_000)

  it('P1: a host-judged session runs on the host, the host links the companion\'s listener door, and the phone lists the session', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    // A prompt needs a mode that asks: default.
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'default', message: 'ROUND before' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await waitFor(async () => (await channelEvents(sid)).some((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes('echo: ROUND before')), 120_000, 'the first answer on the Mac').catch(fail)
    await waitFor(async () => (await h.host('/companion')).linked, 180_000, 'the host to link the companion\'s listener door').catch(fail)
    const list = await waitFor(async () => { const r = await h.phone('GET', '/api/v1/sessions'); return r.status === 200 && r.json.sessions?.some((s: any) => s.id === sid) ? r.json.sessions : null }, 120_000, 'the phone\'s list to show the session').catch(fail)
    expect(list.find((s: any) => s.id === sid)).toMatchObject({ host: HOST_KEY })
    // While the Mac answers, the detail is the Mac's (relayed), never the host's word.
    const d = await h.phone('GET', `/api/v1/sessions/${sid}`)
    expect(d.status, JSON.stringify(d.json)).toBe(200)
    expect(d.json.viaHost).toBeUndefined()
  }, 600_000)

  it('P2: the Mac stopped, the companion answers from the host\'s word, and the list still shows the session', async () => {
    h.c.sleepMac()
    const d = await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.status === 200 && r.json.viaHost === true ? r.json : null }, WINDOWS.takeoverMs + 60_000, 'the companion to answer from the host').catch(fail)
    expect(d.session).toMatchObject({ claudeSessionId: sid, host: HOST_KEY, judge: 'host' })
    expect(d.pendingPermissions).toEqual([])
    const list = await h.phone('GET', '/api/v1/sessions')
    expect(list.status, JSON.stringify(list.json)).toBe(200)
    expect(list.json.sessions.find((s: any) => s.id === sid)).toMatchObject({ host: HOST_KEY })
  }, 300_000)

  it('P3: a send from the phone is queued on the host and answered on its stream; a retry of the same id is queued once', async () => {
    stream = await h.phoneStream(sid)
    await waitFor(() => stream!.frames.some((f) => f.event === 'bridge-online'), 30_000, 'the stream to open')
    const id = mid()
    const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND phone', messageId: id })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    expect(sent.json).toMatchObject({ messageId: id, viaHost: true })
    await waitFor(() => textOn(stream!).includes('echo: ROUND phone') && stream!.frames.some((f) => f.event === 'turn-end'), 120_000, 'the answer on the phone\'s stream').catch(fail)
    // The retry the phone makes after a lost answer: the same id, queued once on the host, answered once.
    const again = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND phone', messageId: id })
    expect(again.status, JSON.stringify(again.json)).toBe(202)
    await new Promise((r) => setTimeout(r, 3_000))
    const queue = (await h.host(`/queue?sid=${sid}`)) as Array<{ id: string }>
    expect(queue.filter((q) => q.id === id).length).toBeLessThanOrEqual(1)
    expect(resultsOf((await hostFacts()).recs, sid, 'echo: ROUND phone')).toHaveLength(1)
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.filter((e) => e.name === 'session:send').map((e) => e.source)).toContain('mobile')
  }, 300_000)

  it('P4: an interrupt from the phone stops a running turn on the host', async () => {
    const gate = path.join(h.c.base, 'never-released')
    const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: `please hold until ${gate}`, messageId: mid() })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.json.session?.process_status === 'running' }, 60_000, 'the held turn to run').catch(fail)
    const stop = await h.phone('POST', `/api/v1/sessions/${sid}/interrupt`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ status: 'interrupted', sessionId: sid, viaHost: true })
    await waitFor(async () => resultsOf((await hostFacts()).recs, sid, 'echo: interrupted').length === 1, 60_000, 'the held turn to end on the interrupt').catch(fail)
    const onHost = (await h.host(`/events?sid=${sid}`)) as ProbeEvent[]
    expect(onHost.some((e) => e.name === 'session:interrupt' && e.source === 'mobile')).toBe(true)
    expect(fs.existsSync(gate)).toBe(false)
  }, 300_000)

  it('P5: a prompt the host\'s session raises shows on the phone, and the phone\'s answer reaches the host', async () => {
    const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'please run make check', messageId: mid() })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    const d = await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.json.pendingPermissions?.length ? r.json : null }, 60_000, 'the prompt on the phone').catch(fail)
    const prompt = d.pendingPermissions[0]
    expect(prompt).toMatchObject({ toolName: 'Bash' })
    // A request the session does not hold is refused by the host's own proof.
    const forged = await h.phone('POST', `/api/v1/sessions/${sid}/permission`, { requestId: 'req-forged', allow: true })
    expect(forged.status, JSON.stringify(forged.json)).toBe(404)
    const a = await h.phone('POST', `/api/v1/sessions/${sid}/permission`, { requestId: prompt.requestId, allow: true })
    expect(a.status, JSON.stringify(a.json)).toBe(200)
    expect(a.json).toMatchObject({ status: 'resolved', requestId: prompt.requestId, allow: true, viaHost: true })
    await waitFor(async () => resultsOf((await hostFacts()).recs, sid, 'echo: ran make check').length === 1, 60_000, 'the host to run the tool').catch(fail)
    await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.json.pendingPermissions?.length === 0 }, 30_000, 'the prompt to leave the phone').catch(fail)
  }, 300_000)

  it('P5b: a send with 1 and with 3 pictures: saved on the host byte for byte, named to the CLI, answered once', async () => {
    for (const n of [1, 3]) {
      const words = `PICTURES ${n}`
      const bytes = Array.from({ length: n }, (_, i) => png(64 + i))
      const id = mid()
      const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: words, messageId: id, images: bytes.map((b) => ({ data: b.toString('base64'), mediaType: 'image/png' })) })
      expect(sent.status, JSON.stringify(sent.json)).toBe(202)
      expect(sent.json).toMatchObject({ messageId: id, viaHost: true })
      const result = await waitFor(async () => resultsOf((await hostFacts()).recs, sid, words)[0] ?? null, 120_000, `the answer to ${words} on the host`).catch(fail)
      const said = String(result.data?.result ?? '')
      const files = namedPictures(said)
      expect(files, said).toHaveLength(n)
      files.forEach((f, i) => expect(fs.readFileSync(f).equals(bytes[i]!), f).toBe(true))
      // The legacy folder and names: the daemon's own images/mobile, a generated name.
      for (const f of files) expect(path.basename(path.dirname(f))).toBe('mobile')
      expect(said.endsWith(words), said).toBe(true)
      await waitFor(() => textOn(stream!).includes(words), 60_000, `${words} on the phone's stream`).catch(fail)
      // A retry of the same id: queued once on the host, answered once.
      const again = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: words, messageId: id, images: bytes.map((b) => ({ data: b.toString('base64'), mediaType: 'image/png' })) })
      expect(again.status, JSON.stringify(again.json)).toBe(202)
      await new Promise((r) => setTimeout(r, 2_000))
      expect(resultsOf((await hostFacts()).recs, sid, words)).toHaveLength(1)
      pictureSends.push({ words, files })
    }
  }, 300_000)

  it('P5c: a picture past the host\'s cap is refused as on every path, and nothing is sent', async () => {
    const sends = async () => ((await h.host(`/events?sid=${sid}`)) as ProbeEvent[]).filter((e) => e.name === 'session:send').length
    const before = await sends()
    const big = png(10 * 1024 * 1024 + 1)
    const r = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'PICTURES too big', messageId: mid(), images: [{ data: big.toString('base64'), mediaType: 'image/png' }] })
    // The send route shrinks a picture to the host's cap or refuses it before anything goes, on
    // every path (images.ts fitsImageSaveLimits); this one cannot shrink (not a real image).
    expect(r.status, JSON.stringify(r.json)).toBe(413)
    expect(r.json.error).toMatchObject({ code: 'image_too_large' })
    await new Promise((res) => setTimeout(res, 2_000))
    expect(await sends()).toBe(before)
    expect(resultsOf((await hostFacts()).recs, sid, 'PICTURES too big')).toEqual([])
  }, 120_000)

  it('P6: the Mac woken has every fact once and in order, and the companion relays to it again', async () => {
    h.c.wakeMac()
    await untilFactsStill(h, { timeoutMs: 120_000 }).catch(fail)
    const f = factsAtBothEnds((await hostFacts()).recs, await h.mac(`/events?sid=${sid}`), sid)
    expect(f.started.map((e) => e.source), JSON.stringify(f.started)).toHaveLength(1)
    expect(f.seen, `host: ${f.host.join(' ')}\nmac:  ${f.seen.join(' ')}`).toEqual(f.host)
    const mac = f.mac
    for (const text of ['echo: ROUND phone', 'echo: interrupted', 'echo: ran make check', ...pictureSends.map((p) => p.words)]) {
      expect(mac.filter((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text)), text).toHaveLength(1)
    }
    // The transcript is the truth: the Mac's history shows each picture send as a legacy send's, its
    // words under the images header that names the host's files (the UI draws the pictures from it).
    expect(pictureSends.map((p) => p.files.length)).toEqual([1, 3])
    const history = await waitFor(async () => {
      const r = await h.c.mac('GET', `/api/sessions/${sid}/history`)
      const users = r.status === 200 ? (r.json.messages as Array<{ role: string; text: string }>).filter((m) => m.role === 'user') : []
      return pictureSends.every((p) => users.some((u) => u.text.includes(p.words))) ? users : null
    }, 60_000, 'the picture sends in the Mac\'s history').catch(fail)
    for (const p of pictureSends) {
      const turns = history.filter((u: { text: string }) => u.text.includes(p.words))
      expect(turns, p.words).toHaveLength(1)
      expect(namedPictures(turns[0].text).map((f) => path.basename(f).replace(/^[0-9a-f]+-(?=\d+-[0-9a-f]+\.png$)/, '')), turns[0].text).toEqual(p.files.map((f) => path.basename(f)))
    }
    // The companion hears the Mac again: one path at a time, the Mac's.
    await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.status === 200 && r.json.viaHost === undefined }, 60_000, 'the companion to relay to the Mac again').catch(fail)
    const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND after', messageId: mid() })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    expect(sent.json.viaHost).toBeUndefined()
    await waitFor(async () => (await channelEvents(sid)).some((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes('echo: ROUND after')), 120_000, 'the relayed send\'s answer on the Mac').catch(fail)
  }, 400_000)
})
