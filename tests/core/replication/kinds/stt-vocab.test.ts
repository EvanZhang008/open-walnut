/**
 * The `stt-vocab` copy kind (stage 4d of docs/plan/walnut-companion-unified-replica.md):
 * the Mac's speech vocabulary as one row of its words (the file's comments left out, a
 * secret-shaped word never sent), a round soon after a word is added, and a follower that
 * stores the words and refuses a malformed row. The leader reads the real vocabulary
 * file; the follower is the real route of a host replica, and the reads over the copy
 * (the transcriber's prompt, GET /stt/vocab) are the ones a server that keeps the copy
 * answers. The companion's side is pinned on a real server by
 * tests/web/routes/companion-away-reads-cloud.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-stt-vocab', { CLOUD_MODE: false }))

import { STT_VOCAB_FILE, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound } from '../../../../src/core/replication/kinds/copy-kind.js'
import { STT_VOCAB_KIND, readSttVocabCopy, _resetSttVocabCopyForTesting } from '../../../../src/core/replication/kinds/stt-vocab.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { followerStep } from '../../../../src/core/replication/kind-follower.js'
import { _resetReplicaStatusForTesting } from '../../../../src/core/replication/replica-status.js'
import { loadVocabPrompt, _resetSttVocabMigrationForTest } from '../../../../src/core/stt/index.js'
import { addSttVocabWord, readSttVocab } from '../../../../src/web/routes/stt.js'
import { isNeedsLeaderError } from '../../../../src/core/replication/needs-leader.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
/** Opaque, mixed case and digits, 40+ characters: what the config copy refuses as a key. */
const OPAQUE = 'Zq8Lm2Np4Rt6Vx9Bc1Df3Gh5Jk7Mn0Pq2Rs4Tu6Wy8'

async function round() {
  const kind = { ...STT_VOCAB_KIND, watch: () => () => {} }
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

async function writeVocab(text: string): Promise<void> {
  await fsp.mkdir(path.dirname(STT_VOCAB_FILE), { recursive: true })
  await fsp.writeFile(STT_VOCAB_FILE, text)
}

function asHostReplica(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  else for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  asHostReplica(true)
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  asHostReplica(true)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  _resetSttVocabCopyForTesting()
  _resetSttVocabMigrationForTest()
  _resetReplicaStatusForTesting()
})

describe('the leader', () => {
  it('sends the words as the readers see them: no comments or blank lines, no secret-shaped word', async () => {
    await writeVocab(`# names I say\nAcme\n\n  Kubernetes  \n${OPAQUE}\nMarina\n`)
    expect(await STT_VOCAB_KIND.rows()).toEqual([{ key: 'vocab', words: ['Acme', 'Kubernetes', 'Marina'] }])
  })

  it('a missing file is no words, still one row (the copy then says so)', async () => {
    expect(await STT_VOCAB_KIND.rows()).toEqual([{ key: 'vocab', words: [] }])
  })

  it('a file it cannot read is not "no words": the round skips the kind', async () => {
    await fsp.mkdir(STT_VOCAB_FILE, { recursive: true }) // a directory: EISDIR, not ENOENT
    await expect(STT_VOCAB_KIND.rows()).rejects.toThrow()
  })

  it('a word added on the Mac brings a round', async () => {
    asHostReplica(false)
    const soon = vi.fn()
    const stop = STT_VOCAB_KIND.watch(soon)
    expect(await addSttVocabWord('Acme')).toMatchObject({ added: true })
    expect(soon).toHaveBeenCalledTimes(1)
    // Already there: no write, no round.
    expect(await addSttVocabWord('acme')).toMatchObject({ added: false })
    expect(soon).toHaveBeenCalledTimes(1)
    stop()
    await addSttVocabWord('Marina')
    expect(soon).toHaveBeenCalledTimes(1)
  })
})

describe('a server that keeps the copy', () => {
  it('reads its own file before the first round, the Mac\'s words after it', async () => {
    await writeVocab('BeforeRound\n')
    expect(await readSttVocabCopy()).toBeNull()
    expect(await loadVocabPrompt()).toBe('BeforeRound')
    expect(await round()).toMatchObject({ kind: 'stt-vocab', action: 'synced', sent: 1 })
    // The words the round took; the file then changes under the copy, which keeps the Mac's.
    await writeVocab('# changed by git sync\nStale\n')
    expect(await readSttVocabCopy()).toEqual({ words: ['BeforeRound'], asOf: expect.any(Number) })
    expect(await loadVocabPrompt()).toBe('BeforeRound')
    expect(await readSttVocab()).toMatchObject({ words: ['BeforeRound'], copyAsOf: expect.any(Number) })
  })

  it('a word added where the copy answers needs the Mac, and the file is not written', async () => {
    await writeVocab('Acme\n')
    await round()
    const err = await addSttVocabWord('Marina').catch((e: unknown) => e)
    expect(isNeedsLeaderError(err) && err.why).toBe('stt_vocab_writes_need_mac')
    expect(await fsp.readFile(STT_VOCAB_FILE, 'utf8')).toBe('Acme\n')
  })

  it('the Mac (no copy kept) always reads and writes its own file', async () => {
    await writeVocab('Acme\n')
    await round()
    asHostReplica(false)
    expect(await readSttVocabCopy()).toBeNull()
    await writeVocab('Acme\nMarina\n')
    expect(await loadVocabPrompt()).toBe('Acme, Marina')
    expect(await readSttVocab()).toMatchObject({ words: ['Acme', 'Marina'], copyAsOf: null })
  })

  it('refuses a malformed or secret-carrying row, and stores nothing of that put', async () => {
    for (const row of [
      { key: 'vocab', words: 'Acme' },
      { key: 'vocab', words: [1, 2] },
      { key: 'words', words: ['Acme'] },
      { key: 'vocab', words: ['Acme'], extra: true },
    ]) {
      expect(await followerStep({ op: 'put', kind: 'stt-vocab', rows: [row], last: true, schemaVersion: 1 })).toMatchObject({ ok: false, status: 400, error: 'bad_rows' })
    }
    expect(await readSttVocabCopy()).toBeNull()
    // A well-formed row with a secret-shaped word is skipped by the follower's own check
    // (counted as held, so the leader sends its manifest again).
    const put = await followerStep({ op: 'put', kind: 'stt-vocab', rows: [{ key: 'vocab', words: ['Acme', OPAQUE] }], last: true, schemaVersion: 1 })
    expect(put).toMatchObject({ ok: true, stored: 0, held: 1 })
    expect((await readSttVocabCopy())?.words ?? []).toEqual([])
  })
})
