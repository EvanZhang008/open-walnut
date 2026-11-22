/**
 * The world behind the proof video of the phone's "Received ... when your Mac is back" line
 * (ios-native/WalnutUITests/LetterHeldForMacUITests.swift). Not a tier test: the file name ends in
 * `.local.ts`, which no vitest config includes; run it only with its own config, naming this file.
 *
 * It boots the world of tests/e2e/letter-reply-mac-away-live-e2e.test.ts (tests/helpers/live-twin-mac.ts:
 * a real companion, a real primary, a real daemon running session S), writes ONE action_required
 * letter from S, puts the Mac to sleep (SIGSTOP), and then serves a small marker endpoint on
 * loopback for the UI test:
 *   GET  /world           the companion URL, the phone token minted in this world, the letter id
 *   POST /mark?event=..   a step of the UI test, kept with the host clock in markers.jsonl;
 *                         `begin` answers only once `rec-started` exists in the output dir (the
 *                         driver starts the screen recording on the `begin` line)
 * When the UI test reports `received-shown`, the Mac comes back (SIGCONT) a few seconds later;
 * when it reports `done`, the world is torn down.
 *
 * WALNUT_LETTER_VIDEO_DIR (required): where world.json, markers.jsonl and rec-started live.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { inboxOf } from '../helpers/live-daemon.js'
import {
  S, companionHearsMac, linkBothAliases, macGoes, macHoldsDevboxAgain, macIsUp, macReturns, phone,
  setupTwinMac, sleep, teardownTwinMac, waitFor, world,
} from '../helpers/live-twin-mac.js'

const OUT = process.env.WALNUT_LETTER_VIDEO_DIR ?? ''
const TASK_TITLE = 'Fix the flaky build on the dev box'

const FIRST_BOOT = `
  const store = await import(src('src/core/human-inbox/store.ts'))
  const sender = { sessionId: ${JSON.stringify(S)}, host: 'devbox', taskId: task.id, taskTitle: task.title, project: 'Acme' }
  const actions = [{ id: 'short', label: 'Use the short wording' }, { id: 'long', label: 'Use the long wording' }]
  const letter = await store.sendLetter({ subject: 'Release notes wording', type: 'action_required', markdown: 'Which wording should the release notes use? Reply with any change you want.', actions, sender })
  out.letterId = letter.id
`

type Turn = { from: string; text: string; clientId?: string; delivery?: { status: string; held?: true } }
const humanTurns = async (id: string): Promise<Turn[]> => {
  const r = await phone(`/api/v1/human-inbox/${id}`)
  const letter = (r.json.letter ?? r.json) as { thread?: Turn[] }
  return (letter.thread ?? []).filter((t) => t.from === 'human')
}

const markers: Array<{ at: number; event: string; [k: string]: unknown }> = []
const mark = (event: string, extra: Record<string, unknown> = {}) => {
  const m = { at: Date.now(), event, ...extra }
  markers.push(m)
  fs.appendFileSync(path.join(OUT, 'markers.jsonl'), JSON.stringify(m) + '\n')
}
const seen = (event: string) => markers.some((m) => m.event === event)

function serveMarkers(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/world') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ letterId: world.primary.out.letterId, recipient: TASK_TITLE }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/mark') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        let extra: Record<string, unknown> = {}
        try { extra = body ? JSON.parse(body) : {} } catch { /* plain */ }
        const event = url.searchParams.get('event') ?? 'unnamed'
        mark(event, extra)
        // The recording must be running before the app launches.
        if (event === 'begin') {
          const end = Date.now() + 30_000
          while (!fs.existsSync(path.join(OUT, 'rec-started')) && Date.now() < end) await sleep(200)
        }
        res.end('ok')
      })
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

describe.skipIf(!OUT)('the world of the held-for-Mac letter video', () => {
  let markerServer: http.Server | null = null
  beforeAll(() => setupTwinMac('wlv-', FIRST_BOOT), 400_000)
  afterAll(async () => { markerServer?.close(); await teardownTwinMac() }, 600_000)

  it('serves the phone while the Mac sleeps, and brings the Mac back after the Received line', async () => {
    fs.mkdirSync(OUT, { recursive: true })
    for (const f of ['markers.jsonl', 'rec-started', 'world.json']) fs.rmSync(path.join(OUT, f), { force: true })
    const letterId = world.primary.out.letterId as string
    expect(letterId).toBeTruthy()
    await macIsUp()
    await linkBothAliases()
    await waitFor(async () => (await phone(`/api/v1/human-inbox/${letterId}`)).status === 200, 180_000, 'the letter on the companion')

    await macGoes('asleep')
    await waitFor(async () => !(await companionHearsMac()), 120_000, 'the companion to know the Mac does not answer')
    mark('mac-asleep')
    markerServer = await serveMarkers()
    const markerPort = (markerServer.address() as { port: number }).port
    fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify({
      server: `http://127.0.0.1:${world.companion.port}`, token: world.tokens.phone,
      markerUrl: `http://127.0.0.1:${markerPort}`, letterId, recipient: TASK_TITLE,
    }, null, 2))

    // The phone's reply, held by the companion.
    const held = await waitFor(async () => {
      const turns = await humanTurns(letterId)
      return turns.find((t) => t.delivery?.held === true) ?? null
    }, 45 * 60_000, 'the phone\'s reply')
    mark('reply-held', { text: held.text, delivery: held.delivery })

    // The UI test shows the Received line and holds; then the Mac comes back.
    await waitFor(() => seen('received-shown') || seen('done'), 5 * 60_000, 'the UI test to show Received')
    await sleep(4_000)
    await macReturns('asleep')
    mark('mac-back')
    await macHoldsDevboxAgain()
    await waitFor(() => inboxOf(world.devbox, S).some((m) => m.includes(held.text)), 180_000, 'the reply at S\'s CLI')
    mark('reply-at-cli')
    await waitFor(async () => {
      const t = (await humanTurns(letterId)).find((x) => x.clientId === held.clientId)
      return t && t.delivery && t.delivery.status !== 'pending' && t.delivery.held === undefined ? t : null
    }, 180_000, 'the companion to read the reply delivered')
    mark('companion-delivered')
    await waitFor(() => seen('done'), 10 * 60_000, 'the UI test to finish')
  }, 60 * 60_000)
})
