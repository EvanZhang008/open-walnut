/**
 * His explicit words switch a task's Threads (src/core/org/threads-word-switch.ts). 2026-11-21, the
 * user in the Interview task: "你不要再回复这个 thread 了，就回复我就好了"; the next message was filed
 * as a new thread anyway. Only an order counts: a long discussion of Threads, a question whether to,
 * or words about closing one thread leave them as they are.
 */
import { describe, expect, it } from 'vitest'
import { SWITCH_WORDS_MAX, threadsSwitchedText, threadsSwitchIn } from '../../../src/core/org/threads-word-switch.js'
import { threadHintText } from '../../../src/core/org/thread-capture.js'

describe('his words to stop or bring back Threads', () => {
  it('his own sentence turns them off', () => {
    expect(threadsSwitchIn('兄弟，你不要再去优先代理。哎，你不要再回复这个 thread 了，就回复我就好了。')).toBe('off')
  })

  it.each([
    '别回 thread，就回我',
    '别在 thread 里写了',
    '不用 thread 了',
    '不需要 Threads',
    'thread 别再更新了',
    '不要继续用 thread',
    '不要再用 thread 了',
    '把 thread 功能关掉',
    "don't use threads here",
    'Do not reply in the thread, just answer me',
    'no more threads please',
    'turn threads off',
    '以后都别用 thread 了',
    '这个任务不要再用 thread 了',
  ])('off: %s', (words) => {
    expect(threadsSwitchIn(words)).toBe('off')
  })

  it.each([
    '开回 thread',
    '恢复 thread 吧',
    '还是用 thread 吧',
    '打开 Threads 功能',
    'turn threads back on',
    'bring back threads again',
  ])('on: %s', (words) => {
    expect(threadsSwitchIn(words)).toBe('on')
  })

  it.each([
    // About one thread, not the switch.
    '关掉这个 thread',
    '这个 thread 不要了',
    "don't close the thread yet",
    // A question whether to.
    '要不要关掉 thread 功能？',
    'should we stop using threads?',
    // Remembering one.
    '别忘了看 thread',
    // Nothing about threads.
    '别回邮件，先回我',
    '',
    // Review 2026-11-22: words to one thread, words that use Threads, and questions (each was 'off').
    '不要开新的 thread，放到上一个里',
    '别在这个 thread 里聊别的了',
    '不用管那个 thread',
    '不用新建 thread，合并到原来那个',
    '不要在 thread 里写这么长',
    '别去 thread 里找了，直接看日志',
    '这个 thread 别再提醒我了',
    'thread 的标题别再改了',
    '别回 thread?',
    '别回 thread？',
    "don't open a new thread for this",
    "don't reply in that thread, reply in the other one",
    '这个问题不要放到 thread 里',
    '别回 thread 里的问题，先回我这个',
    '特别是 thread 的回复，回我',
    '别回 thread 好吗',
    // Review round 2: both places, or one question in a thread, or no verb.
    '不要只在 thread 里回复，也回我',
    '别把结果只写在 thread，回我一下',
    '不要回复 thread 里那个问题，先回我这个',
    'stop the thread, answer me',
  ])('neither: %s', (words) => {
    expect(threadsSwitchIn(words)).toBeNull()
  })

  it('with Threads off, words to open one thread never turn them back on', () => {
    expect(threadsSwitchIn('打开那个 thread 看看')).toBeNull()
    expect(threadsSwitchIn('打开 thread 看看')).toBeNull()
  })

  it('a long message that talks about Threads is no order', () => {
    const long = `${'我们讨论一下这个设计，'.repeat(20)}不要再回复这个 thread 了`
    expect(Array.from(long).length).toBeGreaterThan(SWITCH_WORDS_MAX)
    expect(threadsSwitchIn(long)).toBeNull()
  })

  it('the agent is told what Walnut did and how he undoes it, in place of a thread to keep', () => {
    const base = { threadId: '', title: '', created: false, followUp: false, duplicate: false, open: [], closed: [] }
    const off = threadHintText({ ...base, switched: 'off' })
    expect(off).toBe(threadsSwitchedText('off'))
    expect(off).toContain('turn threads back on')
    expect(off).not.toMatch(/thread_update|merge_into|short title/)
    expect(threadHintText({ ...base, switched: 'on' })).toBe(threadsSwitchedText('on'))
  })
})
