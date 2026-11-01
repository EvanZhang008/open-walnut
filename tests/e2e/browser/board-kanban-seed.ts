/**
 * The rows the kanban fixture adopts that no route can make (an old completion,
 * a 3 day stall), seeded into tasks.json before boot by test-server.ts, one copy
 * per Playwright worker (claimSeedSlot), and the ticket and summary words they
 * share with the team board-kanban-fixture.ts builds. Split out of that file to
 * keep each under the kanban hygiene line cap.
 *
 * No @playwright/test import at runtime: test-server.ts imports this file.
 * Neutral invented names only.
 */
import fs from 'node:fs'
import path from 'node:path'

export const KANBAN_SEED_ENGINES = ['chromium', 'webkit'] as const
/** Ticket numbers start here and count up. */
export const KANBAN_FIRST_TICKET = 1000000101
export const DAY = 86_400_000

const SUMMARY_PARTS = [
  'Checkout latency rose after the last config push; the worker traced it to a retry storm between the gateway and the',
  'ledger service, rolled the retry budget back and is watching p99 recover before it closes the incident.',
]

/** A plain summary of 200 to 300 characters, distinct per index. */
export function summaryFor(i: number, label: string): string {
  const s = `${label}: ${SUMMARY_PARTS.join(' ')} Step ${i + 1} of the runbook is next.`
  return s.length > 300 ? s.slice(0, 300) : s
}

export const ticketOf = (n: number) => `V${KANBAN_FIRST_TICKET + n}`

/**
 * Copies of the seeded rows per engine, one per Playwright worker (CI runs 4): each team adopts
 * its rows, so two kanban files running at once on one copy took them from each other
 * (2026-10-31: a team read `Resolved 13` for 23, and its stall was "not on this board's team").
 */
export const KANBAN_SEED_SLOTS = 4

/** The seeded ids of one engine's slot: 10 old completions and one 3 day stall. Slot 0 keeps the first names. */
export function kanbanSeedIds(engine: string, slot = 0): { oldDone: string[]; stale: string; staleSession: string } {
  const e = engine.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const p = slot ? `pw-kanban-${e}-s${slot}` : `pw-kanban-${e}`
  return {
    oldDone: Array.from({ length: 10 }, (_, k) => `${p}-olddone-${String(k + 1).padStart(2, '0')}`),
    stale: `${p}-stale`,
    staleSession: `${p}-stale-session`,
  }
}

const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Takes a free seed slot of `engine` for this worker process, under the fixture root, so every
 * worker of the run sees the same claims. A worker runs one file at a time: it gives back what
 * its previous file held first, and a claim whose process is gone is free.
 */
export async function claimSeedSlot(fixtureRoot: string, engine: string): Promise<number> {
  const dir = path.join(fixtureRoot, 'kanban-seed-claims')
  fs.mkdirSync(dir, { recursive: true })
  const file = (slot: number) => path.join(dir, `${engine.replace(/[^a-z0-9]/gi, '')}-${slot}.json`)
  const end = Date.now() + 300_000
  for (;;) {
    for (let slot = 0; slot < KANBAN_SEED_SLOTS; slot++) {
      let holder = 0
      try { holder = Number(JSON.parse(fs.readFileSync(file(slot), 'utf8')).pid) } catch { /* free or half written */ }
      if (holder === process.pid || (holder && !pidAlive(holder))) fs.rmSync(file(slot), { force: true })
    }
    for (let slot = 0; slot < KANBAN_SEED_SLOTS; slot++) {
      try {
        fs.writeFileSync(file(slot), JSON.stringify({ pid: process.pid }), { flag: 'wx' })
        return slot
      } catch { /* taken */ }
    }
    if (Date.now() > end) throw new Error(`no free kanban seed slot of ${engine} in ${dir}: more than ${KANBAN_SEED_SLOTS} workers?`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Ticket index of the seeded rows: the old completions are the last 10 of 37, the stall is #6. */
export const OLD_DONE_FIRST_TICKET = 27
export const STALE_TICKET = 6

/**
 * Rows test-server.ts writes into tasks.json before boot, per engine: 10
 * completions 8 to 10 days old (past the store's 7 day window, G8) and one
 * NEED_ACTION task whose last progress was 3 days ago (C29). Each sits in a
 * holding project until a run adopts it under its leader.
 */
export function kanbanSeedTasks(agoIso: (msAgo: number) => string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const engine of KANBAN_SEED_ENGINES) for (let slot = 0; slot < KANBAN_SEED_SLOTS; slot++) {
    const ids = kanbanSeedIds(engine, slot)
    const base = { priority: 'none', source: 'local', project: `Kanban seed ${engine}`, active_session_ids: [], description: '', note: '', subtasks: [] }
    ids.oldDone.forEach((id, k) => {
      const n = OLD_DONE_FIRST_TICKET + k
      rows.push({
        ...base, id, title: `${ticketOf(n)} settled ${engine} payout mismatch`, status: 'done', phase: 'COMPLETE',
        session_ids: [], tags: [`ticket:${ticketOf(n)}`, 'sev:2'], summary: summaryFor(n, ticketOf(n)),
        created_at: agoIso(14 * DAY), updated_at: agoIso(8 * DAY + k * 4 * 3_600_000),
        phase_changed_at: agoIso(8 * DAY + k * 4 * 3_600_000), completed_at: agoIso(8 * DAY + k * 4 * 3_600_000),
      })
    })
    rows.push({
      ...base, id: ids.stale, title: `${ticketOf(STALE_TICKET)} card reader timeouts ${engine}`, status: 'in_progress',
      phase: 'NEED_ACTION', session_id: ids.staleSession, session_ids: [ids.staleSession], unread: true,
      tags: [`ticket:${ticketOf(STALE_TICKET)}`, 'sev:2'], summary: summaryFor(STALE_TICKET, ticketOf(STALE_TICKET)),
      created_at: agoIso(6 * DAY), updated_at: agoIso(3 * DAY), phase_changed_at: agoIso(3 * DAY),
      last_session_update: agoIso(3 * DAY),
    })
  }
  return rows
}
