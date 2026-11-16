/**
 * The personal-matter hold on outward text (src/core/outbound/sensitive-hold.ts): with the person's
 * Approvals switch off, a text that reads as personal still waits for them. Three layers: a phrase
 * that says it outright holds with no model call; a two-way word or CJK text asks the judge; plain
 * work text sends with no judge call. A judge that cannot answer holds. The config can add phrases
 * or turn the check off. The judge is always a fake here; no model is called. All text is invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown>, fail: false }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => {
      if (config.fail) throw new Error('config unreadable')
      return { version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {}, ...config.value }
    }),
  }
})

import { needsJudgement, sensitiveHold, sensitivePhrase } from '../../src/core/outbound/sensitive-hold.js'

beforeEach(() => { config.value = {}; config.fail = false })

const judgeOf = (answer: string | null | Error) => vi.fn(async () => {
  if (answer instanceof Error) throw answer
  return answer
})

describe('layer 1: a phrase that says it outright', () => {
  it('finds the phrase case-insensitively, at a word start, and names it in lower case', () => {
    expect(sensitivePhrase('Here is my PROMOTION DOC for next cycle')).toBe('promotion doc')
    expect(sensitivePhrase('Notes from the performance review')).toBe('performance review')
    expect(sensitivePhrase('Her sick leave starts Monday')).toBe('sick leave')
    expect(sensitivePhrase('(peer feedback) for the team')).toBe('peer feedback')
    // A phrase inside another word is not that phrase.
    expect(sensitivePhrase('xpromotion doc')).toBeUndefined()
    expect(sensitivePhrase('Deploy the build to prod tonight')).toBeUndefined()
  })

  it('takes extra phrases, trimmed and lower-cased, with regex characters matched literally', () => {
    expect(sensitivePhrase('Status of Project Lantern (v2)', ['  project lantern (v2) '])).toBe('project lantern (v2)')
    expect(sensitivePhrase('a.b.c release', ['a.b.c'])).toBe('a.b.c')
    expect(sensitivePhrase('axbxc release', ['a.b.c'])).toBeUndefined()
    expect(sensitivePhrase('anything', ['', '   '])).toBeUndefined()
  })

  it('holds a phrase at once, without asking the judge', async () => {
    const judge = judgeOf(null)
    const held = await sensitiveHold('Attaching my promotion doc draft, can you read it?', { judge })
    expect(held).toEqual({ reason: 'It mentions "promotion doc", which reads as a personal or sensitive matter.' })
    expect(judge).not.toHaveBeenCalled()
  })

  it('holds a phrase the caller adds, and one the person added in config', async () => {
    const judge = judgeOf(null)
    expect(await sensitiveHold('The lantern plan is ready', { judge, phrases: ['lantern plan'] })).toMatchObject({ reason: expect.stringContaining('"lantern plan"') })
    config.value = { outbound: { sensitive_phrases: ['Quiet Meadow', 7] } }
    expect(await sensitiveHold('Update on quiet meadow', { judge })).toMatchObject({ reason: expect.stringContaining('"quiet meadow"') })
    expect(judge).not.toHaveBeenCalled()
  })
})

describe('layer 2: a word that can go either way, or CJK text', () => {
  it('says which text the judge must read', () => {
    expect(needsJudgement('Can we promote the build? The promotion step is red.')).toBe(true)
    expect(needsJudgement('Feedback on the design doc')).toBe(true)
    expect(needsJudgement('\u660e\u5929\u4e00\u8d77\u5403\u996d\u5417')).toBe(true)
    expect(needsJudgement('\u3053\u3093\u306b\u3061\u306f')).toBe(true)
    expect(needsJudgement('Deploy the build to prod and update the dashboard')).toBe(false)
  })

  it('sends ordinary work text as it is, with no judge call', async () => {
    const judge = judgeOf('should never be asked')
    expect(await sensitiveHold('Deploy the build to prod and update the dashboard', { judge })).toBeNull()
    expect(await sensitiveHold('   ', { judge })).toBeNull()
    expect(await sensitiveHold('', { judge })).toBeNull()
    expect(judge).not.toHaveBeenCalled()
  })

  it('a two-way word the judge calls work sends; one it calls personal holds with its reason', async () => {
    const no = judgeOf(null)
    expect(await sensitiveHold('The promotion step of the release pipeline is red', { judge: no })).toBeNull()
    expect(no).toHaveBeenCalledTimes(1)
    expect(no).toHaveBeenCalledWith('The promotion step of the release pipeline is red')

    const yes = judgeOf('It discusses a colleague\'s promotion.')
    expect(await sensitiveHold('Is Sam up for the promotion this round?', { judge: yes })).toEqual({ reason: 'It discusses a colleague\'s promotion.' })
  })

  // Test data only: Chinese text, written as escapes.
  it('CJK text with no English word goes to the judge', async () => {
    const judge = judgeOf(null)
    const text = '\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a'
    expect(await sensitiveHold(text, { judge })).toBeNull()
    expect(judge).toHaveBeenCalledWith(text)
  })

  it('a judge that throws holds the text, with a reason that says the check could not tell', async () => {
    const judge = judgeOf(new Error('model timed out'))
    expect(await sensitiveHold('Feedback on the design', { judge })).toEqual({ reason: 'It may touch a personal matter, and the check could not tell for sure.' })
  })

  it('the phrase layer reads the whole text; only the judge is cut to the first 8000 characters', async () => {
    const judge = judgeOf(null)
    await sensitiveHold(`feedback ${'x'.repeat(9000)}`, { judge })
    expect((judge.mock.calls[0] as unknown as [string])[0]).toHaveLength(8000)
    // A phrase past char 8000 (the bottom of a long quoted reply) still holds, with no judge call.
    const late = judgeOf(null)
    expect(await sensitiveHold(`${'x '.repeat(4500)}promotion doc`, { judge: late })).toMatchObject({ reason: expect.stringContaining('promotion doc') })
    expect(late).not.toHaveBeenCalled()
    // Past a million characters nothing more is read.
    expect(await sensitiveHold(`${'x'.repeat(1_000_000)} promotion doc`, { judge: judgeOf(null) })).toBeNull()
  })
})

describe('the person\'s switch', () => {
  it('outbound.sensitive_check: false turns every layer off', async () => {
    config.value = { outbound: { sensitive_check: false } }
    const judge = judgeOf('personal')
    expect(await sensitiveHold('My promotion doc', { judge })).toBeNull()
    expect(await sensitiveHold('Feedback on my salary', { judge })).toBeNull()
    expect(judge).not.toHaveBeenCalled()
  })

  it('an unreadable config keeps the check on', async () => {
    config.fail = true
    expect(await sensitiveHold('My promotion doc', { judge: judgeOf(null) })).toMatchObject({ reason: expect.stringContaining('promotion doc') })
  })

  it('with no judge given, inside a test the model is unavailable, so a two-way word holds', async () => {
    expect(await sensitiveHold('Feedback on the design')).toEqual({ reason: 'It may touch a personal matter, and the check could not tell for sure.' })
    expect(await sensitiveHold('Deploy the build to prod')).toBeNull()
  })
})
