/**
 * What the external-session scan costs the event loop it runs on
 * (src/providers/external-session-scan-core.ts). The Mac's daemon runs inside the server and
 * restarts with every land; in the live stall profiles of 2026-11-25 the scan was 14 s of 395 s
 * of loop CPU: sync stat, readdir and read calls (about 6,000 a scan), and after every restart a
 * read of every transcript head in its 30-day window. So:
 *  - the walk and the head reads use async I/O: no sync fs call outside the spawn journal;
 *  - verdicts outlive a restart (verdictFile): an unchanged transcript is not read again;
 *  - a kept file made by other rules, or one that is not JSON, is ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanExternalSessions, _forgetScanVerdictsForTesting } from '../../src/providers/external-session-scan-core.js'

let home: string
let verdictFile: string

function claudeSession(sid: string, entrypoint: string, i: number): void {
  const cwd = `/Users/dev/proj-${i % 7}`
  const filePath = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    { type: 'user', message: { role: 'user', content: `task number ${i}` }, uuid: 'u1', timestamp: '2026-11-20T10:00:00.000Z', cwd, sessionId: sid, entrypoint, isSidechain: false },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-11-20T10:00:05.000Z' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-scan-cost-'))
  verdictFile = path.join(home, 'daemon', 'external-scan-verdicts.json')
  _forgetScanVerdictsForTesting()
  // People's sessions and programs' runs, the mix a real host has.
  for (let i = 0; i < 40; i++) claudeSession(`s-${i}`, i % 4 === 0 ? 'cli' : 'sdk-cli', i)
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const scan = () => scanExternalSessions({ sinceMs: 365 * 24 * 60 * 60_000, homeDir: home, spawnJournal: path.join(home, 'none.jsonl'), verdictFile })

describe('the external-session scan on the event loop', () => {
  it('reads no unchanged transcript again after a restart', async () => {
    const first = await scan()
    expect(first.parsed).toBe(40)
    expect(first.candidates).toHaveLength(10)
    _forgetScanVerdictsForTesting() // what a restart leaves: nothing in memory
    const again = await scan()
    expect(again.parsed).toBe(0)
    expect(again.candidates.map((c) => c.sessionId).sort()).toEqual(first.candidates.map((c) => c.sessionId).sort())
    // A transcript that grew is read again.
    fs.appendFileSync(path.join(home, '.claude', 'projects', '-Users-dev-proj-0', 's-0.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Named later', sessionId: 's-0' }) + '\n')
    _forgetScanVerdictsForTesting()
    const third = await scan()
    expect(third.parsed).toBe(1)
    expect(third.candidates.find((c) => c.sessionId === 's-0')?.title).toBe('Named later')
  })

  it('stats a program\'s transcript only on a full pass, and still forgets it once deleted', async () => {
    const statted = (await import('node:fs/promises')).default
    await scan()
    let stats = 0
    const real = statted.stat
    ;(statted as { stat: unknown }).stat = (...args: Parameters<typeof real>) => { stats++; return real(...args) }
    try {
      const warm = await scan()
      // 7 project dirs and the 10 people's transcripts; none of the 30 program runs.
      expect(stats).toBe(17)
      expect(warm.scanned).toBe(40)
      fs.rmSync(path.join(home, '.claude', 'projects', '-Users-dev-proj-1', 's-1.jsonl'))
      expect((await scan()).scanned).toBe(39)
    } finally {
      ;(statted as { stat: unknown }).stat = real
    }
  })

  it('ignores a kept file made by other rules or not JSON', async () => {
    await scan()
    const kept = JSON.parse(fs.readFileSync(verdictFile, 'utf8'))
    fs.writeFileSync(verdictFile, JSON.stringify({ ...kept, rules: 'older-rules' }))
    _forgetScanVerdictsForTesting()
    expect((await scan()).parsed).toBe(40)
    fs.writeFileSync(verdictFile, '{torn')
    _forgetScanVerdictsForTesting()
    expect((await scan()).parsed).toBe(40)
  })

  it('makes no sync fs call outside the spawn journal (ratchet)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/external-session-scan-core.ts'), 'utf8')
    const calls = [...src.matchAll(/\bfs\.(\w+Sync)\(/g)].map((m) => m[1])
    // readSpawnJournal and walnutSpawnedIds: small, and shared with sync callers.
    expect(calls).toEqual(['readFileSync', 'readdirSync'])
  })
})
