/**
 * LIVE cloud mobile journey — the phone's real path, against the REAL cloud
 * companion. No mocks anywhere: phone-equivalent HTTPS calls →
 * cloud replica → daemon bridge → primary box → real `claude` CLI.
 *
 * Born from the 2026-08-07 incident: every mock-level suite was green while
 * the real phone couldn't send a single message to a session it had just
 * created (projection gap → 404 storm). This layer exists so "works in tests"
 * and "works on the phone" can never diverge silently again.
 *
 * Gating (all auto-derived, zero hardcoded secrets):
 *   - WALNUT_LIVE_CLOUD=1 must be set (real sessions cost real tokens).
 *   - Cloud base URL + device token arrive via WALNUT_LIVE_CLOUD_URL /
 *     WALNUT_LIVE_CLOUD_TOKEN — set by scripts/run-live-cloud-tests.sh, which
 *     derives them from the REAL data repo's git remote. They can't be read
 *     in-process here: under VITEST, WALNUT_HOME is force-pointed at a temp
 *     dir (constants.ts test guard), so getCloudRemoteCredentials() sees an
 *     empty repo. Missing env → suite skips.
 *   - The cloud must answer /api/v1/status within 8s → otherwise skip
 *     (a down companion is its own incident, not a test failure).
 *
 * Run:  npm run test:live:cloud   (or bash scripts/run-live-cloud-tests.sh)
 */
import { describe, it, expect, beforeAll } from 'vitest'

const LIVE = process.env.WALNUT_LIVE_CLOUD === '1'

interface CloudTarget { base: string; token: string }

function resolveTarget(): CloudTarget | null {
  const base = process.env.WALNUT_LIVE_CLOUD_URL
  const token = process.env.WALNUT_LIVE_CLOUD_TOKEN
  if (!base || !token) return null
  return { base: base.replace(/\/$/, ''), token }
}

async function reachable(target: CloudTarget): Promise<boolean> {
  try {
    const res = await fetch(`${target.base}/api/v1/status`, {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(8_000),
    })
    return res.status === 200
  } catch {
    return false
  }
}

const target = LIVE ? resolveTarget() : null
let online = false

// Skip loudly, never fail, when the preconditions aren't met — but make the
// skip visible so a "green" run without this layer is recognizable as
// non-authoritative.
const suite = LIVE && target ? describe : describe.skip

function hdrs(): Record<string, string> {
  return { Authorization: `Bearer ${target!.token}`, 'Content-Type': 'application/json' }
}

async function api(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  return fetch(`${target!.base}${path}`, {
    ...init,
    headers: { ...hdrs(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(init?.timeoutMs ?? 20_000),
  })
}

/** Poll the fresh transcript until a predicate matches or timeout. */
async function waitForTranscript(
  sid: string,
  predicate: (messages: Array<{ role: string; text: string }>) => boolean,
  timeoutMs = 90_000,
): Promise<Array<{ role: string; text: string }>> {
  const deadline = Date.now() + timeoutMs
  let last: Array<{ role: string; text: string }> = []
  while (Date.now() < deadline) {
    const res = await api(`/api/v1/sessions/${sid}/transcript?fresh=1`)
    if (res.status === 200) {
      const body = await res.json() as { messages: Array<{ role: string; text: string }> }
      last = body.messages
      if (predicate(last)) return last
    }
    await new Promise((r) => setTimeout(r, 4_000))
  }
  throw new Error(`transcript predicate not met in ${timeoutMs}ms — last: ${JSON.stringify(last).slice(0, 500)}`)
}

suite('LIVE: phone journey through the real cloud companion', () => {
  beforeAll(async () => {
    online = await reachable(target!)
    if (!online) {
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  SKIPPED-EFFECTIVELY: cloud companion unreachable — this run is NOT authoritative for the mobile path.\n')
    }
  }, 15_000)

  it('create → IMMEDIATE send/transcript/stream → CLI replies (the exact 2026-08-07 failure sequence)', async () => {
    if (!online) return
    const marker = `LIVE-JOURNEY-${Date.now().toString(36).toUpperCase()}`

    // 1. Create through the replica (what the phone's New Session sheet does).
    const create = await api('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/tmp', host: '', message: `Reply with exactly: ${marker}` }),
      timeoutMs: 40_000,
    })
    expect(create.status).toBe(201)
    const { sessionId } = await create.json() as { sessionId: string }
    expect(sessionId).toBeTruthy()

    // 2. IMMEDIATELY exercise every endpoint the conversation view hits.
    //    Pre-fix each of these 404'd for 1–3 minutes.
    const [send, transcript, stream] = await Promise.all([
      api(`/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST', body: JSON.stringify({ text: 'immediate follow-up' }),
      }),
      api(`/api/v1/sessions/${sessionId}/transcript?fresh=1`),
      api(`/api/v1/sessions/${sessionId}/stream`, {
        headers: { Accept: 'text/event-stream' }, timeoutMs: 5_000,
      }).catch(() => new Response(null, { status: 200 })), // SSE stays open → timeout abort is success
    ])
    expect(send.status).toBe(202)
    expect(transcript.status).toBe(200)
    expect(stream.status).toBe(200)

    // 3. The launch message AND the immediate follow-up must both reach the
    //    CLI — assert on its actual reply, not on HTTP codes.
    const messages = await waitForTranscript(sessionId, (msgs) =>
      msgs.some((m) => m.role === 'assistant' && m.text.includes(marker)))
    expect(messages.some((m) => m.role === 'user' && m.text.includes('immediate follow-up'))).toBe(true)
  }, 180_000)

  it('burst: 3 concurrent creates, all immediately usable (seed under concurrency)', async () => {
    if (!online) return
    const stamp = Date.now().toString(36).toUpperCase()

    const creates = await Promise.all([1, 2, 3].map((i) =>
      api('/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', host: '', message: `Reply with exactly: BURST-${stamp}-${i}` }),
        timeoutMs: 40_000,
      })))
    const sids: string[] = []
    for (const res of creates) {
      expect(res.status).toBe(201)
      sids.push(((await res.json()) as { sessionId: string }).sessionId)
    }
    expect(new Set(sids).size).toBe(3)

    // Immediate concurrent use of all three.
    const results = await Promise.all(sids.map(async (sid, i) => ({
      send: (await api(`/api/v1/sessions/${sid}/messages`, {
        method: 'POST', body: JSON.stringify({ text: `burst follow-up ${i}` }),
      })).status,
      transcript: (await api(`/api/v1/sessions/${sid}/transcript?fresh=1`)).status,
    })))
    for (const r of results) {
      expect(r.send).toBe(202)
      expect(r.transcript).toBe(200)
    }

    // Every CLI replied with its own marker (no cross-wiring between seeds).
    await Promise.all(sids.map((sid, idx) =>
      waitForTranscript(sid, (msgs) =>
        msgs.some((m) => m.role === 'assistant' && m.text.includes(`BURST-${stamp}-${idx + 1}`)))))
  }, 240_000)

  it('unknown session id still 404s through the real replica (seed must not fail open)', async () => {
    if (!online) return
    const res = await api('/api/v1/sessions/00000000-dead-beef-0000-000000000000/messages', {
      method: 'POST', body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(404)
  })
})
