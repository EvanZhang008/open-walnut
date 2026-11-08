/**
 * A sign-in ask lives on its tab's holding (src/core/browser-control/sign-in-ask.ts): it ends when
 * the holding does (the tab given to another task, released, closed), and only its own task reads
 * or answers it (review 2026-11-08: one task's ask showed on the next task's view, and that task's
 * Hand back answered it).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetBrowserHubForTesting, ownTab, releaseTab } from '../../../src/core/browser-control/hub.js'
import { _resetSignInAsksForTesting, askSignIn, endSignIn, getAsk, openAsk, waitSignIn } from '../../../src/core/browser-control/sign-in-ask.js'

beforeEach(() => {
  _resetBrowserHubForTesting()
  _resetSignInAsksForTesting()
})

describe('a sign-in ask', () => {
  it('ends as gone when its tab goes to another task', async () => {
    ownTab('dev', 5, 'task:a')
    const a = askSignIn({ owner: 'task:a', device: 'dev', tab: 5 })
    const waiting = waitSignIn(a.id, 5000)
    ownTab('dev', 5, 'task:b')
    expect((await waiting)?.end?.why).toBe('gone')
    expect(openAsk('dev', 5)).toBeUndefined()
  })

  it('ends as gone when its tab is released', () => {
    ownTab('dev', 6, 'task:a')
    const a = askSignIn({ owner: 'task:a', device: 'dev', tab: 6 })
    releaseTab('dev', 6, 'stopped')
    expect(getAsk(a.id)?.end?.why).toBe('gone')
  })

  it('only its own task reads it or answers it', () => {
    ownTab('dev', 7, 'task:a')
    askSignIn({ owner: 'task:a', device: 'dev', tab: 7 })
    expect(openAsk('dev', 7, 'task:b')).toBeUndefined()
    expect(endSignIn('dev', 7, 'done', 'task:b')).toBeUndefined()
    expect(openAsk('dev', 7, 'task:a')).toBeDefined()
    expect(endSignIn('dev', 7, 'done', 'task:a')?.end?.why).toBe('done')
  })
})
