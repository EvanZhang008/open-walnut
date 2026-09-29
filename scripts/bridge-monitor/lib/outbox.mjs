/**
 * Letter delivery with a durable outbox. A letter that cannot be posted
 * (server restarting, Mac just woke) is written to <stateDir>/outbox/ and the
 * collector retries it every 10 minutes until `inbox.retryHours` pass.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { postLetter } from './letter.mjs'

function outboxDir(cfg) {
  return path.join(cfg.stateDir, 'outbox')
}

async function park(cfg, letter) {
  const dir = outboxDir(cfg)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  await fsp.writeFile(file, JSON.stringify({ letter, firstMs: Date.now(), tries: 1 }), { mode: 0o600 })
  return file
}

/** Post now; park it in the outbox when that fails. */
export async function deliverLetter(cfg, letter, { fetchImpl } = {}) {
  if (!cfg.inbox?.enabled) return { ok: false, error: 'inbox disabled' }
  const res = await postLetter(cfg.inbox.api, letter, fetchImpl ? { fetchImpl } : {})
  if (!res.ok) res.parked = await park(cfg, letter)
  return res
}

/** Retry every parked letter; drop the ones older than retryHours. */
export async function retryOutbox(cfg, record = async () => {}, { fetchImpl, nowMs = Date.now() } = {}) {
  const dir = outboxDir(cfg)
  let names = []
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')) } catch { return { sent: 0, dropped: 0, left: 0 } }
  let sent = 0
  let dropped = 0
  for (const name of names.sort()) {
    const file = path.join(dir, name)
    let item
    try { item = JSON.parse(await fsp.readFile(file, 'utf-8')) } catch { await fsp.rm(file, { force: true }); continue }
    if (nowMs - (item.firstMs ?? 0) > (cfg.inbox.retryHours ?? 12) * 3_600_000) {
      await fsp.rm(file, { force: true })
      dropped++
      await record({ kind: 'letter', subject: item.letter?.subject, delivered: false, error: 'gave up after retry window' })
      continue
    }
    const res = await postLetter(cfg.inbox.api, item.letter, fetchImpl ? { fetchImpl } : {})
    if (res.ok) {
      await fsp.rm(file, { force: true })
      sent++
      await record({ kind: 'letter', subject: item.letter?.subject, delivered: true, letterId: res.id, tries: (item.tries ?? 1) + 1 })
    } else {
      await fsp.writeFile(file, JSON.stringify({ ...item, tries: (item.tries ?? 1) + 1, lastError: res.error }), { mode: 0o600 })
    }
  }
  return { sent, dropped, left: names.length - sent - dropped }
}
