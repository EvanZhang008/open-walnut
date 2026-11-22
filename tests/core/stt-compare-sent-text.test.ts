/**
 * What the user sent after a dictation is kept beside its take, only while
 * Voice Accuracy is on: the dictation remembers its recording when its text is
 * written, and a person's send that carries it (as heard, or edited by hand)
 * writes sentText into the comparison store. Off, nothing is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const constants = vi.hoisted(() => ({ home: '' }))
vi.mock('../../src/constants.js', async () => {
  const c = (await import('../helpers/mock-constants.js')).createMockConstants('stt-compare-sent')
  constants.home = c.WALNUT_HOME as string
  return c
})
const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => structuredClone(state.config),
  migrateStoredConfig: async () => false,
}))
vi.mock('../../src/core/server-role.js', () => ({ isFollower: () => false }))

const { noteDictation, sentDictation, startLearningFromSends, _resetLearningForTest } = await import('../../src/core/stt/learn-from-sends.js')
const { compareStore } = await import('../../src/core/stt/compare/store.js')
const { recordSentText } = await import('../../src/core/stt/compare/sent-text.js')
const { bus, EventNames } = await import('../../src/core/event-bus.js')

const REC = '2026-11-21T08-00-00-000Z'
const DICTATED = 'please restart the cloud companion before the demo'

async function seedRecording(): Promise<void> {
  const dir = join(constants.home, 'tmp', 'stt-recordings')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${REC}.webm`), Buffer.from('audio'))
  await writeFile(join(dir, `${REC}.json`), JSON.stringify({ timestamp: '2026-11-21T08:00:01.000Z', format: 'webm', result: { text: DICTATED, durationMs: 5 } }))
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20))
}

let n = 0
function send(message: string): void {
  bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'sid-1', message, sentBy: 'person', messageId: `m-${++n}` }, ['*'], { source: 'ui' })
}

beforeEach(async () => {
  _resetLearningForTest()
  await rm(join(constants.home, 'stt-compare'), { recursive: true, force: true })
  compareStore._forget()
  state.config = { experimental: { stt_compare: true } }
  await seedRecording()
  await startLearningFromSends()
})

describe('sent text beside its take', () => {
  it('finds the dictation a send carries: as heard, or edited by hand; not an unrelated send', () => {
    noteDictation(DICTATED, Date.now(), { kind: 'recording', id: REC })
    expect(sentDictation(DICTATED)?.source).toEqual({ kind: 'recording', id: REC })
    expect(sentDictation('please restart the cloud companion before the demo today')?.source).toEqual({ kind: 'recording', id: REC })
    expect(sentDictation('what is the weather like')).toBeNull()
    // How close the pairing is: 1 for the same text, less for one edited by hand.
    expect(sentDictation(DICTATED)?.similarity).toBe(1)
    const edited = sentDictation('please restart the cloud companion before the demo today')!.similarity
    expect(edited).toBeGreaterThanOrEqual(0.6)
    expect(edited).toBeLessThan(1)
  })

  it('keeps the send as the person sent it, never trimmed, only without Walnut\'s hint blocks', async () => {
    noteDictation(DICTATED, Date.now(), { kind: 'recording', id: REC })
    send(`<system-reminder>a hint</system-reminder>\n\n  ${DICTATED}\n`)
    await until(async () => !!(await compareStore.get(`rec-${REC}`))?.sentText)
    const take = (await compareStore.get(`rec-${REC}`))!
    expect(take.sentText).toBe(`  ${DICTATED}\n`)
    expect(take).toMatchObject({ sentMatch: 'text-similarity', sentSimilarity: 1 })
  })

  it('a dictation noted again without its recording keeps the recording it named', () => {
    noteDictation(DICTATED, Date.now(), { kind: 'recording', id: REC })
    noteDictation(DICTATED)
    expect(sentDictation(DICTATED)?.source).toEqual({ kind: 'recording', id: REC })
  })

  it('a person\'s send writes sentText into the take, made when missing, also when it equals the dictation', async () => {
    noteDictation(DICTATED, Date.now(), { kind: 'recording', id: REC })
    send(DICTATED)
    await until(async () => !!(await compareStore.get(`rec-${REC}`))?.sentText)
    const take = (await compareStore.get(`rec-${REC}`))!
    expect(take).toMatchObject({ sentText: DICTATED, source: 'web', format: 'webm', inUseText: DICTATED, sentMatch: 'text-similarity', sentSimilarity: 1 })
    expect(take.sentAt).toBeTruthy()
  })

  it('writes nothing while the experiment is off', async () => {
    state.config = {}
    expect(await recordSentText({ kind: 'recording', id: REC }, DICTATED)).toBe(false)
    compareStore._forget()
    expect(await compareStore.count()).toBe(0)
  })
})
