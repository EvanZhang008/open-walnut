/**
 * The stale-write-back incident, reproduced end to end.
 *
 * Five times (2026-09-05 x4, 2026-09-08 x1) an open Files tab replaced a newer
 * design doc with an older copy of itself. Both times the optimistic lock was in
 * place and the server accepted the write, because the token described the file on
 * disk while the TEXT came from somewhere else:
 *
 *   1. a copy of the file was painted into the editor provisionally (the IndexedDB
 *      content cache, three days old on 2026-09-08),
 *   2. the conditional read answered with the real, newer bytes, and the pane moved
 *      its lock AND its buffer generation to them,
 *   3. the editor was still holding the cached text (it is reseeded by a remount,
 *      one render later), and a doc-change echo armed an automatic write from it,
 *   4. the write quoted the lock out of a ref, so it carried the NEW hash with the
 *      OLD text, and the server had nothing to refuse.
 *
 * This file drives the real client-side decision functions and the real express
 * write route with the incident's own shape, and asserts the newer bytes survive.
 * It is deliberately NOT a mock of either side: the bug lived exactly in the seam
 * between them, which is the one place a unit test of either half cannot see.
 *
 * SAFETY: every path written here is inside the mkdtemp directory from beforeEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'

import { fileContentRouter } from '../../src/web/routes/file-content.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { computeContentHash } from '../../src/utils/file-ops.js'
import { planLiveWrite } from '../../web/src/hooks/useLiveEdit'
import { computeContentHashClient } from '../../web/src/utils/content-hash'

/** The restructured document that must survive (the real one was 40,063 bytes). */
const FRESH = `# Design v2\n\n${'A section the other writer restructured this morning.\n'.repeat(760)}`
/** The copy the tab had been holding since Friday (the real one was 28,896 bytes). */
const STALE = `# Design\n\n${'An older section, from before the restructure.\n'.repeat(600)}`

let work: string
let app: express.Express
let file: string

function createApp() {
  const a = express()
  a.use(express.json({ limit: '10mb' }))
  a.use('/api/file-content', fileContentRouter)
  a.use(errorHandler)
  return a
}

/** Exactly what the hook's writeOnce sends, so the test cannot drift from it. */
const put = (body: Record<string, unknown>) =>
  request(app).put('/api/file-content').send({ path: file, ...body })

const onDisk = () => fs.readFile(file, 'utf-8')

beforeEach(async () => {
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-swb-')))
  file = path.join(work, 'final-design-v2.md')
  await fs.writeFile(file, FRESH, 'utf-8')
  app = createApp()
})

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true }) // mkdtemp dir from beforeEach
})

describe('the 2026-09-08 stale-write-back, replayed', () => {
  it('sizes match the real incident closely enough to be recognisable', () => {
    // Not an assertion about the product — a guard that the fixtures still
    // represent "a much SHORTER stale copy replacing a longer restructured doc",
    // which is what makes the shrink visible in the logs and in this test.
    expect(Buffer.byteLength(FRESH)).toBeGreaterThan(Buffer.byteLength(STALE) + 10_000)
  })

  it('the armed write carries the STALE text and therefore a stale token, so the file survives', async () => {
    const freshHash = computeContentHash(FRESH)

    // Step 2/3: the pane read the fresh bytes and advanced BOTH the lock and the
    // generation, while the editor still held the cached copy. This is the state
    // that made a generation check useless: armed and current agree.
    const plan = planLiveWrite({
      armedText: STALE,
      armedGen: 2,
      currentGen: 2,
      // The editor reports the bytes IT was seeded from, which are the cached ones.
      armedBaseText: STALE,
      bufferText: STALE,
      baseContent: STALE,
    })
    expect(plan).toEqual({ action: 'write', text: STALE, baseText: STALE })

    // Step 4, as the fix does it: the token is hashed from the base bytes, so a
    // stale base produces a stale token no matter what any ref believes.
    const expectedHash = computeContentHashClient(plan.action === 'write' ? plan.baseText! : '')
    expect(expectedHash).not.toBe(freshHash)

    const res = await put({ content: STALE, writer: 'live', expectedHash, baseFrom: 'content' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'conflict', reason: 'stale-lock', currentHash: freshHash })
    expect(await onDisk()).toBe(FRESH)
  })

  it('the OLD pairing (fresh token, stale text) is what used to be accepted', async () => {
    // The exact bytes-and-token pair the incident sent. Recorded here so the
    // regression is unmistakable: this pairing IS acceptable to a hash check,
    // which is why the client must never be able to produce it.
    const res = await put({
      content: STALE, writer: 'live', expectedHash: computeContentHash(FRESH), baseFrom: 'content',
    })
    expect(res.status).toBe(200)
    expect(await onDisk()).toBe(STALE)
    // ⚠️ The server guard is a FENCE, not the guarantee. A client that lies about
    // where its token came from still gets through, and no server-side check can
    // tell a lie from the truth here (a matching hash is a matching hash). The
    // guarantee is that the client derives the token from the bytes it is sending
    // as its base — the test above. This one exists so nobody mistakes the fence
    // for the guarantee and removes the client-side half.
  })

  it('a tab running the OLD bundle cannot write at all, with no reload needed', async () => {
    // An old bundle quotes the lock out of its ref (so the token matches disk) and
    // knows nothing about `baseFrom`. That missing claim is the whole fence: the
    // server refuses every automatic write that cannot say its token came from the
    // bytes, which is the answer to "the fix must not depend on the browser
    // reloading". A tab left open across a deploy simply stops auto-writing.
    for (const writer of ['live', 'merge'] as const) {
      const res = await put({ content: STALE, writer, expectedHash: computeContentHash(FRESH) })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'conflict', reason: 'unverified-base' })
      expect(await onDisk()).toBe(FRESH)
    }
  })

  it('a human pressing Save is never blocked by the fence', async () => {
    // A person looking at the editor is allowed to replace the file, and the 409
    // conflict dialog is how they find out someone else changed it. The fence is
    // only about writes NOBODY asked for.
    const res = await put({ content: STALE, writer: 'user', expectedHash: computeContentHash(FRESH) })
    expect(res.status).toBe(200)
    expect(await onDisk()).toBe(STALE)
  })

  it('the honest automatic write still lands (the fix is not just "refuse everything")', async () => {
    // The editor holding the CURRENT bytes types one more line: base is fresh, so
    // the token matches disk and the write goes through. Without this the previous
    // assertions would also pass with live edit simply broken.
    const typed = `${FRESH}one more line the user typed\n`
    const res = await put({
      content: typed, writer: 'live', expectedHash: computeContentHashClient(FRESH), baseFrom: 'content',
    })
    expect(res.status).toBe(200)
    expect(await onDisk()).toBe(typed)
  })

  it('a null base propagates to the plan, so writeOnce can refuse to invent a token', () => {
    // The plan's contract, not a state the current wiring can reach: `getBaseText`
    // returns null only when no editor is mounted, and then `bufferText` is null
    // too and the plan skips with `buffer-gone`. The `baseText == null` drop in
    // writeOnce is a BACKSTOP, kept because the alternative if it ever becomes
    // reachable is a write with a made-up token. What it is NOT is the stale-draft
    // path: a restored draft gives the editor a base of its own text, which simply
    // fails to match disk and 409s (see resolveConflict's `base == null` give-up).
    const plan = planLiveWrite({
      armedText: STALE,
      armedGen: 1,
      currentGen: 3,
      armedBaseText: null,
      bufferText: STALE,
      baseContent: null,
    })
    expect(plan).toEqual({ action: 'write', text: STALE, baseText: null })
  })
})

/**
 * A ratchet on the ONE line the incident turned on.
 *
 * The tests above pin the decision functions and the server. What neither can see
 * is the line inside `writeOnce` that turns a decision into a request: for five
 * incidents it read the token out of `lockHashRef`, and the whole fix is that it
 * now hashes the base bytes instead. That line lives inside a React hook with no
 * test seam, so it is pinned textually, the same way the repo pins "no sync work on
 * the event loop". A source check is weak evidence in general; here the invariant
 * IS textual, and the regression it guards against is somebody restoring the ref
 * because it looks simpler.
 */
describe('the write token is derived from bytes, not quoted from a ref', () => {
  const src = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'web', 'src', 'hooks', 'useLiveEdit.ts'),
    'utf-8',
  )

  it('hashes the base text and says so, on the write that goes out', () => {
    expect(src).toMatch(/const expectedHash = computeContentHashClient\(baseText\)/)
    expect(src).toMatch(/baseFrom: 'content'/)
  })

  it('does not read lockHashRef AT ALL while composing a write', () => {
    // Deliberately stricter than "no `expectedHash: ...lockHashRef` on one line":
    // that shape is trivially evaded by assigning the ref to a local first, which
    // restores the bug while keeping the ratchet green. Inside writeOnce the ref is
    // only ever WRITTEN (advanced after a successful write, which the pane's
    // explicit-Save path still needs), never read, so the ratchet can demand that
    // every mention is an assignment.
    const send = src.slice(
      src.indexOf('const writeOnce = useCallback'),
      src.indexOf('writeOnceRef.current = writeOnce'),
    )
    // Comments are stripped first: this file explains the bug by NAME, and a
    // ratchet that counts prose would fire on its own documentation.
    const code = send
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join('\n')
    expect(code).toContain('lockHashRef.current = res.contentHash') // the one legitimate mention
    expect(code.match(/lockHashRef/g) ?? []).toHaveLength(1)
  })

  it('drops the write when there is no base to hash', () => {
    expect(src).toMatch(/if \(baseText == null\) \{[\s\S]{0,500}?\breturn;/)
  })
})
