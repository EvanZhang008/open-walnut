/**
 * Append-only files (marked in the home manifest) are taken up to their size just before the
 * batch's moment, so a writer the write gate does not hold, appending all the time, no longer
 * voids every batch; and one that rewrites such a file in place, cuts it or rewrites its tail
 * still voids the batch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isAppendOnlyHomePath } from '../../../src/core/home-manifest/index.js'
import { snapshotTo, verifyStandby } from '../../../src/core/standby/index.js'
import { sandbox, seedHome, write, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})
const LOG = 'session-audit.jsonl'
const home = (rel: string) => path.join(sb.home, rel)
const copy = (rel: string) => fs.readFileSync(path.join(sb.target, 'copy', rel), 'utf8')
const settle = () => new Promise((r) => setTimeout(r, 30))

async function first(): Promise<void> {
  dbs.push(...seedHome(sb.home).dbs)
  // Past the 4 KiB tail the mark hashes, so a rewrite at the start is outside it.
  write(sb.home, LOG, `{"n":0,"pad":"${'p'.repeat(6000)}"}\n`)
  await settle()
  const out = await snapshotTo(sb.home, sb.target)
  expect(out.ok, out.ok ? '' : out.reason).toBe(true)
}

/** Rewrite `rel` in place (same inode) with `content`. */
function rewriteInPlace(rel: string, content: string): void {
  const fd = fs.openSync(home(rel), 'r+')
  fs.writeSync(fd, content, 0)
  fs.closeSync(fd)
}

describe('an append-only file', () => {
  it('is marked so in the manifest', () => {
    expect(isAppendOnlyHomePath(LOG)).toBe(true)
    expect(isAppendOnlyHomePath('memory/MEMORY.md')).toBe(false)
  })

  it('appended every few ms by a writer the gate does not hold: batches go on, each copy a prefix', async () => {
    sb = await sandbox('append-busy')
    await first()
    let on = true
    let n = 1
    const writer = (async () => {
      while (on) {
        await fsp.appendFile(home(LOG), `{"n":${n++}}\n`)
        await new Promise((r) => setTimeout(r, 2))
      }
    })()
    let ok = 0
    try {
      for (let i = 0; i < 8; i++) {
        const out = await snapshotTo(sb.home, sb.target)
        if (!out.ok) continue
        ok++
        expect(fs.readFileSync(home(LOG), 'utf8').startsWith(copy(LOG))).toBe(true)
      }
    } finally {
      on = false
      await writer
    }
    expect(ok).toBe(8)
    expect((await verifyStandby(sb.target)).drift).toEqual([])
  })

  it('caught in the middle of a line: the batch ends at its last whole line, and the next takes the rest', async () => {
    sb = await sandbox('append-half-line')
    await first()
    fs.appendFileSync(home(LOG), '{"n":1}\n{"n":2,"half')
    await settle()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(copy(LOG).endsWith('{"n":1}\n')).toBe(true)
    fs.appendFileSync(home(LOG), '":true}\n')
    await settle()
    expect((await snapshotTo(sb.home, sb.target)).ok).toBe(true)
    expect(copy(LOG).endsWith('{"n":1}\n{"n":2,"half":true}\n')).toBe(true)
    expect(copy(LOG)).toBe(fs.readFileSync(home(LOG), 'utf8'))
  })

  it('rewritten in place at its start after the moment voids the batch', async () => {
    sb = await sandbox('append-rewrite-late')
    await first()
    fs.appendFileSync(home(LOG), '{"n":1}\n')
    await settle()
    const out = await snapshotTo(sb.home, sb.target, { hooks: { afterHold: () => rewriteInPlace(LOG, '{"n":X}') } })
    expect(out.ok, out.ok ? `took ${JSON.stringify(copy(LOG))}` : '').toBe(false)
    expect(!out.ok && out.reason).toMatch(/late|changed/)
  })

  it('rewritten in place before the moment and quiet since: taken as rewritten, and appends go on after', async () => {
    sb = await sandbox('append-rewrite-quiet')
    await first()
    rewriteInPlace(LOG, '{"n":Y}\n{"n":1}\n')
    await settle()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(out.ok && out.stats.appendFallbacks).toBe(1)
    const rewritten = fs.readFileSync(home(LOG), 'utf8')
    expect(rewritten.startsWith('{"n":Y}\n{"n":1}\n')).toBe(true)
    expect(copy(LOG)).toBe(rewritten)
    fs.appendFileSync(home(LOG), '{"n":2}\n')
    await settle()
    const next = await snapshotTo(sb.home, sb.target)
    expect(next.ok && next.stats.appendFallbacks).toBe(0)
    expect(copy(LOG)).toBe(`${rewritten}{"n":2}\n`)
  })

  it('cut shorter than in the last batch and quiet since: taken as cut', async () => {
    sb = await sandbox('append-cut')
    await first()
    fs.truncateSync(home(LOG), 3)
    await settle()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(copy(LOG)).toBe('{"n')  // cut to 3 bytes
  })

  it('its tail rewritten in place after it was marked fails the round (void in a batch of one round)', async () => {
    sb = await sandbox('append-tail')
    await first()
    fs.appendFileSync(home(LOG), '{"n":1}\n')
    await settle()
    const size = fs.statSync(home(LOG)).size
    const rewriteTail = (byte: string) => () => { const fd = fs.openSync(home(LOG), 'r+'); fs.writeSync(fd, byte, size - 3); fs.closeSync(fd) }
    const out = await snapshotTo(sb.home, sb.target, { maxRounds: 1, hooks: { afterHold: rewriteTail('Z') } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/late|changed/)
    // With rounds: the second round's mark comes after the rewrite, and the same byte written
    // again after it changes nothing in the file, so the second round takes it as rewritten.
    const next = await snapshotTo(sb.home, sb.target, { hooks: { afterHold: rewriteTail('Y') } })
    expect(next.ok, next.ok ? '' : next.reason).toBe(true)
    expect(next.ok && next.stats.rounds).toBe(2)
    expect(copy(LOG)).toBe(fs.readFileSync(home(LOG), 'utf8'))
    expect(copy(LOG).at(-3)).toBe('Y')
  })

  it('replaced by a new file (rotated) is taken as the new file', async () => {
    sb = await sandbox('append-rotate')
    await first()
    fs.writeFileSync(`${home(LOG)}.next`, '{"rotated":true}\n')
    fs.renameSync(`${home(LOG)}.next`, home(LOG))
    await settle()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(copy(LOG)).toBe('{"rotated":true}\n')
  })
})
