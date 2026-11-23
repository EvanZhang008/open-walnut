/**
 * What the user sent after a dictation is kept beside its take, only while
 * Voice Accuracy is on. A send that names its recordings (`dictationIds`) pairs
 * with each exactly, and marks the take `edited` when the sent text is not the
 * engine's; a send naming none is matched by text to a recent dictation (as
 * heard, or edited by hand), and never replaces an exact pairing. Off, nothing
 * is written.
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
const { recordSentText, recordSentByIds, engineTextKept, forgetSentByIds } = await import('../../src/core/stt/compare/sent-text.js')
const { sentAgainstDictation } = await import('../../src/core/stt/learn-from-sends.js')
const { isTrainingPair } = await import('../../src/core/stt/compare/pairs.js')
const { bus, EventNames } = await import('../../src/core/event-bus.js')

const REC = '2026-11-21T08-00-00-000Z'
const DICTATED = 'please restart the cloud companion before the demo'

async function seedRecording(id = REC, text = DICTATED): Promise<void> {
  const dir = join(constants.home, 'tmp', 'stt-recordings')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.webm`), Buffer.from('audio'))
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ timestamp: '2026-11-21T08:00:01.000Z', format: 'webm', result: { text, durationMs: 5 } }))
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20))
}

let n = 0
/** A person's send as its queued event tells it: the message, the recordings it names, the composer's own text. */
function send(message: string, dictationIds?: string[], dictationText: string | null = message): void {
  bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
    sessionId: 'sid-1', message, sentBy: 'person', messageId: `m-${++n}`,
    ...(dictationIds ? { dictationIds, ...(dictationText !== null ? { dictationText } : {}) } : {}),
  }, ['*'], { source: 'ui' })
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

// Two takes alike enough that a guess by text could take either for the other.
const REC_A = '2026-11-21T09-00-00-000Z'
const REC_B = '2026-11-21T09-01-00-000Z'
const SAID_A = 'deploy the cloud companion to the staging box now'
const SAID_B = 'deploy the cloud companion to the staging box tonight'
const sentOf = async (rec: string) => (await compareStore.get(`rec-${rec}`))?.sentText

describe('a send that names its recordings pairs with each exactly', () => {
  beforeEach(async () => {
    await seedRecording(REC_A, SAID_A)
    await seedRecording(REC_B, SAID_B)
    noteDictation(SAID_A, Date.now(), { kind: 'recording', id: REC_A })
    noteDictation(SAID_B, Date.now(), { kind: 'recording', id: REC_B })
  })

  it.each([['A first', [REC_A, REC_B]], ['B first', [REC_B, REC_A]]])('two alike dictations sent one by one, %s, each get their own send', async (_name, order) => {
    const said = { [REC_A]: SAID_A, [REC_B]: SAID_B }
    // Each is sent edited to look MORE like the other one: a guess by text would swap them.
    const sent = { [REC_A]: `${SAID_B} please`, [REC_B]: `${SAID_A} please` }
    for (const rec of order) {
      send(sent[rec]!, [rec])
      await until(async () => (await sentOf(rec)) === sent[rec])
    }
    for (const rec of [REC_A, REC_B]) {
      expect(await compareStore.get(`rec-${rec}`)).toMatchObject({ sentText: sent[rec], sentMatch: 'recording-id', edited: true, inUseText: said[rec] })
      expect((await compareStore.get(`rec-${rec}`))!.sentSimilarity).toBe(0.8) // 8 of the 10 tokens of the longer text
    }
  })

  it('a send edited a lot, and one sent long after the dictation left the window, still pair', async () => {
    _resetLearningForTest() // nothing held: the dictation is gone from the text matcher (a late send, a restart)
    await startLearningFromSends()
    const rewritten = 'ship it tonight'
    send(rewritten, [REC_A])
    await until(async () => (await sentOf(REC_A)) === rewritten)
    expect(await compareStore.get(`rec-${REC_A}`)).toMatchObject({ sentText: rewritten, sentMatch: 'recording-id', edited: true })
  })

  it('sent as heard: not edited, also with typed words beside it', async () => {
    send(SAID_A, [REC_A])
    await until(async () => (await sentOf(REC_A)) === SAID_A)
    expect((await compareStore.get(`rec-${REC_A}`))!.edited).toBeUndefined()
    send(`${SAID_A}, and check the logs`, [REC_A])
    await until(async () => (await sentOf(REC_A)) === `${SAID_A}, and check the logs`)
    expect((await compareStore.get(`rec-${REC_A}`))!.edited).toBeUndefined()
  })

  it('judged on the composer\'s own text: attachment headers and thread lines Walnut added never make it edited', async () => {
    const framed = `<attachments>\n/tmp/shot.png\n</attachments>\n> Back to question 3\n\n${SAID_A}`
    send(framed, [REC_A], SAID_A)
    await until(async () => (await sentOf(REC_A)) === SAID_A)
    const take = (await compareStore.get(`rec-${REC_A}`))!
    expect(take).toMatchObject({ sentText: SAID_A, sentMatch: 'recording-id' })
    expect(take.edited).toBeUndefined()
    expect(take.sentFrom).toBeUndefined()
  })

  it('A edited and B untouched in one message: A edited, B not, both shared, neither exported', async () => {
    const box = `${SAID_A.replace('staging', 'production')}\n\n${SAID_B}`
    send(box, [REC_A, REC_B])
    await until(async () => (await sentOf(REC_B)) === box)
    const a = (await compareStore.get(`rec-${REC_A}`))!
    const b = (await compareStore.get(`rec-${REC_B}`))!
    expect(a).toMatchObject({ sentText: box, sentMatch: 'recording-id', edited: true, sentShared: true })
    expect(b).toMatchObject({ sentText: box, sentMatch: 'recording-id', sentShared: true })
    expect(b.edited).toBeUndefined()
    expect([a, b].filter(isTrainingPair)).toEqual([])
  })

  it('an older client that sends no composer text: paired from the message, marked so, never exported', async () => {
    send(`<system-reminder>hint</system-reminder>\n${SAID_A} now`, [REC_A], null)
    await until(async () => (await sentOf(REC_A)) === `${SAID_A} now`)
    const take = (await compareStore.get(`rec-${REC_A}`))!
    expect(take).toMatchObject({ sentFrom: 'message', sentMatch: 'recording-id' })
    expect(isTrainingPair(take)).toBe(false)
    // An edited take from one composer's own text is a training pair.
    const corrected = SAID_B.replace('box', 'host')
    send(corrected, [REC_B])
    await until(async () => (await sentOf(REC_B)) === corrected)
    expect(isTrainingPair((await compareStore.get(`rec-${REC_B}`))!)).toBe(true)
  })

  it('words typed before or after the dictation, or a rewrite, are kept but never exported', async () => {
    for (const box of [`Please check: ${SAID_A.replace('staging', 'production')}`, `${SAID_A.replace('staging', 'production')} and then tell me what the logs say`, 'ship it tonight']) {
      send(box, [REC_A])
      await until(async () => (await sentOf(REC_A)) === box)
      const take = (await compareStore.get(`rec-${REC_A}`))!
      expect(take).toMatchObject({ sentText: box, sentMatch: 'recording-id', edited: true })
      expect(isTrainingPair(take)).toBe(false)
    }
  })

  it('a guess written while an exact pairing lands never replaces it (judged in the write itself)', async () => {
    const exact = recordSentByIds([REC_A], { message: `${SAID_A} ok`, boxText: `${SAID_A} ok` })
    const guess = recordSentText({ kind: 'recording', id: REC_A }, SAID_A)
    await Promise.all([exact, guess])
    const take = (await compareStore.get(`rec-${REC_A}`))!
    expect(take).toMatchObject({ sentText: `${SAID_A} ok`, sentMatch: 'recording-id' })
  })

  it('a discard asked right after its send lands after that send\'s pairing, never before', async () => {
    const box = SAID_A.replace('staging', 'production')
    const pairing = recordSentByIds([REC_A], { message: box, boxText: box })
    const discard = forgetSentByIds([REC_A], box)
    await Promise.all([pairing, discard])
    expect(await sentOf(REC_A)).toBeUndefined()
  })

  it('a discarded send forgets what it paired, only while the take still holds that send', async () => {
    send(SAID_A.replace('staging', 'production'), [REC_A])
    await until(async () => (await sentOf(REC_A)) === SAID_A.replace('staging', 'production'))
    await forgetSentByIds([REC_A], 'some other send')
    expect(await sentOf(REC_A)).toBe(SAID_A.replace('staging', 'production'))
    await forgetSentByIds([REC_A], SAID_A.replace('staging', 'production'))
    const take = (await compareStore.get(`rec-${REC_A}`))!
    expect(take.sentText).toBeUndefined()
    expect(take.sentMatch).toBeUndefined()
    expect(take.edited).toBeUndefined()
  })

  it('an id that no longer resolves is skipped and changes nothing for the others', async () => {
    const box = `${SAID_A} ok`
    send(box, ['2026-11-21T00-00-00-000Z', REC_A])
    await until(async () => (await sentOf(REC_A)) === box)
    const take = (await compareStore.get(`rec-${REC_A}`))!
    expect(take.sentShared).toBeUndefined() // one take resolved: the text is that take's
    expect(take.edited).toBeUndefined()
    compareStore._forget()
    expect(await compareStore.has('rec-2026-11-21T00-00-00-000Z')).toBe(false)
  })

  it('a send with no ids falls back to the text match, labelled so, and never replaces an exact pairing', async () => {
    send(SAID_B, undefined)
    await until(async () => (await sentOf(REC_B)) === SAID_B)
    expect(await compareStore.get(`rec-${REC_B}`)).toMatchObject({ sentMatch: 'text-similarity', sentSimilarity: 1 })
    // Paired exactly, then a later send without ids that matches it by text: the exact one stays.
    send(`${SAID_A} ok`, [REC_A])
    await until(async () => (await sentOf(REC_A)) === `${SAID_A} ok`)
    expect(await recordSentText({ kind: 'recording', id: REC_A }, SAID_A)).toBe(false)
    expect(await compareStore.get(`rec-${REC_A}`)).toMatchObject({ sentText: `${SAID_A} ok`, sentMatch: 'recording-id' })
  })

  it('the same words going out again without ids (an engine switch\'s held message) are not guessed onto the other take', async () => {
    const words = `${SAID_B} please`
    send(words, [REC_A])
    await until(async () => (await sentOf(REC_A)) === words)
    send(words, undefined)
    await new Promise((r) => setTimeout(r, 150))
    expect(await sentOf(REC_B)).toBeUndefined()
  })

  it('writes nothing while the experiment is off, and ignores ids that are no recording', async () => {
    state.config = {}
    expect(await recordSentByIds([REC_A], { message: 'anything', boxText: 'anything' })).toEqual([])
    state.config = { experimental: { stt_compare: true } }
    expect(await recordSentByIds(['2026-11-21T00-00-00-000Z'], { message: 'anything', boxText: 'anything' })).toEqual([])
    compareStore._forget()
    expect(await compareStore.count()).toBe(0)
  })
})

describe('engineTextKept', () => {
  it('is the engine text word for word, whitespace ignored', () => {
    expect(engineTextKept('  hello   world\n', 'hello world')).toBe(true)
    expect(engineTextKept('hello world. And more', 'hello world')).toBe(true)
    expect(engineTextKept('hello there world', 'hello world')).toBe(false)
    expect(engineTextKept('\u4eca\u5929 \u5f00\u4f1a', '\u4eca\u5929\u5f00\u4f1a')).toBe(true)
  })
})

describe('sentAgainstDictation', () => {
  it('a correction anywhere is an edit; words typed before or after it are extra', () => {
    expect(sentAgainstDictation('the build is broken on mane', 'the build is broken on main')).toMatchObject({ extra: false })
    expect(sentAgainstDictation('restart the cube let on node seven', 'restart the Kubelet on node seven')).toMatchObject({ extra: false })
    expect(sentAgainstDictation('restart the Kubelet on node seven', 'restart the cube let on node seven')).toMatchObject({ extra: false })
    expect(sentAgainstDictation('the build is broken on main', 'the build is broken on main please')).toMatchObject({ extra: false })
    expect(sentAgainstDictation('the build is broken on main', 'Please check: the build is broken on main')).toMatchObject({ extra: true })
    // A typed prefix holding the dictation's own first word is still a prefix.
    expect(sentAgainstDictation('the build is broken on main', 'In the end, the build is broken on main')).toMatchObject({ extra: true })
    expect(sentAgainstDictation('\u6211\u89c9\u5f97\u53ef\u4ee5\u53d1\u5e03', '\u6211\u540c\u610f\u3002\u6211\u89c9\u5f97\u53ef\u4ee5\u53d1\u5e03')).toMatchObject({ extra: true })
    expect(sentAgainstDictation('the build is broken on main', 'the build is broken on main, and the tests too')).toMatchObject({ extra: true })
    expect(sentAgainstDictation('the build is broken on main', 'ship it tonight')).toEqual({ similarity: 0, extra: true })
    // Chinese: each character is a token (test data as escapes: "fix the test today", one character corrected).
    expect(sentAgainstDictation('\u4eca\u5929\u4fee\u4e00\u4e0b\u6d4b\u8bd5', '\u4eca\u5929\u4fee\u4e00\u4e0b\u6d4b\u8a66')).toMatchObject({ extra: false })
    expect(sentAgainstDictation('the build is broken on mane', 'the build is broken on main').similarity).toBeCloseTo(5 / 6, 3)
  })
})
