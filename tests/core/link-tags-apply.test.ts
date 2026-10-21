/**
 * Link tags written onto real tasks (src/core/link-tags-apply.ts + updateTask add_link_tags):
 * a person's launch prompt and sends are tagged at once, automated sends never; the self-report
 * LINKS field adds the links no pattern knows; one URL is tagged once, under whatever key the
 * user gave it, and a link tag the user removed is never added back. Real SQLite under a temp
 * home; only the constants and the config read are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-link-tags-apply'))

const config = vi.hoisted(() => ({ linkTags: undefined as Record<string, string> | undefined }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return { ...actual, getConfig: async () => ({ ...(await actual.getConfig()), link_tags: config.linkTags }) }
})

import { _resetForTesting, addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addLinkTags, startLinkTagWatcher, tagLinksFromReportField, tagLinksInText } from '../../src/core/link-tags-apply.js'

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-link-tags-apply')) throw new Error(`refusing to run against ${WALNUT_HOME}`)
  closeDb()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

beforeEach(async () => { config.linkTags = undefined; await freshHome() })
afterEach(freshHome)

async function newTask(tags?: string[]): Promise<string> {
  const { task } = await addTask({ title: 'Fix the sync', project: 'Local', source: 'local', ...(tags ? { tags } : {}) } as never)
  return task.id
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition never held')
}

describe('link tags on a task', () => {
  it('tags the links in a message once, and emits the task update', async () => {
    const id = await newTask(['sev:2'])
    const updates: string[][] = []
    bus.subscribe('test-link-tags', (e) => { if (e.name === EventNames.TASK_UPDATED) updates.push((e.data as { task: { tags?: string[] } }).task.tags ?? []) }, { global: true })
    try {
      const added = await tagLinksInText(id, 'Please fix https://github.com/acme/app/issues/42 (see https://github.com/acme/app/pull/43).', 'test')
      expect(added).toEqual(['issue:https://github.com/acme/app/issues/42', 'pr:https://github.com/acme/app/pull/43'])
      expect(await tagLinksInText(id, 'again: https://github.com/acme/app/issues/42', 'test')).toEqual([])
      const task = await getTask(id)
      expect(task.tags).toEqual(['sev:2', 'issue:https://github.com/acme/app/issues/42', 'pr:https://github.com/acme/app/pull/43'])
      expect(task.auto_links).toEqual(['https://github.com/acme/app/issues/42', 'https://github.com/acme/app/pull/43'])
      expect(updates).toHaveLength(1)
    } finally {
      bus.unsubscribe('test-link-tags')
    }
  })

  it('never adds back a link the user removed or relabelled', async () => {
    const id = await newTask()
    await tagLinksInText(id, 'https://github.com/acme/app/pull/1 https://github.com/acme/app/pull/2', 'test')
    await updateTask(id, { remove_tags: ['pr:https://github.com/acme/app/pull/1'] })
    await updateTask(id, { remove_tags: ['pr:https://github.com/acme/app/pull/2'], add_tags: ['cr:https://github.com/acme/app/pull/2'] })
    expect(await tagLinksInText(id, 'https://github.com/acme/app/pull/1 and https://github.com/acme/app/pull/2/files', 'test')).toEqual([])
    expect((await getTask(id)).tags).toEqual(['cr:https://github.com/acme/app/pull/2'])
  })

  it('keeps a link the user added by hand under the user\'s key', async () => {
    const id = await newTask(['design:https://github.com/acme/app/issues/5'])
    expect(await tagLinksInText(id, 'https://github.com/acme/app/issues/5', 'test')).toEqual([])
    expect((await getTask(id)).tags).toEqual(['design:https://github.com/acme/app/issues/5'])
  })

  it('reads the user\'s patterns from config', async () => {
    config.linkTags = { cr: String.raw`https://reviews\.example\.com/r/RV-\d+` }
    const id = await newTask()
    expect(await tagLinksInText(id, 'CR: https://reviews.example.com/r/RV-4242', 'test')).toEqual(['cr:https://reviews.example.com/r/RV-4242'])
  })

  it('adds the LINKS a self-report names, a pattern key over the session\'s word', async () => {
    const id = await newTask()
    expect(await tagLinksFromReportField(id, 'unchanged')).toEqual([])
    expect(await tagLinksFromReportField(id, '- doc: https://docs.example.com/d/sync\n- ticket: https://github.com/acme/app/issues/8')).toEqual([
      'doc:https://docs.example.com/d/sync', 'issue:https://github.com/acme/app/issues/8',
    ])
  })

  it('a better kind for a link Walnut tagged generically renames it in place', async () => {
    const id = await newTask(['sev:2'])
    await addLinkTags(id, ['link:https://docs.example.com/d/sync', 'file:/tmp/run/out.txt'], 'test')
    expect(await tagLinksFromReportField(id, '- design doc: https://docs.example.com/d/sync\n- report: /tmp/run/out.txt')).toEqual([
      'design-doc:https://docs.example.com/d/sync', 'report:/tmp/run/out.txt',
    ])
    expect((await getTask(id)).tags).toEqual(['sev:2', 'design-doc:https://docs.example.com/d/sync', 'report:/tmp/run/out.txt'])
    // Once named, a generic mention never renames it back.
    expect(await addLinkTags(id, ['link:https://docs.example.com/d/sync'], 'test')).toEqual([])
  })

  it('concurrent writers of one link tag it once', async () => {
    const id = await newTask()
    await Promise.all([
      addLinkTags(id, ['pr:https://github.com/acme/app/pull/3'], 'a'),
      addLinkTags(id, ['cr:https://github.com/acme/app/pull/3'], 'b'),
      addLinkTags(id, ['pr:https://github.com/acme/app/pull/3'], 'c'),
    ])
    const tags = (await getTask(id)).tags ?? []
    expect(tags.filter((t) => t.endsWith('/pull/3'))).toHaveLength(1)
  })

  it('never stores a link tag clipped to the tag length', async () => {
    const id = await newTask()
    const long = `design-document:https://docs.example.com/${'a'.repeat(170)}`
    expect(await addLinkTags(id, [long], 'test')).toEqual([])
    await updateTask(id, { add_link_tags: [long] })
    expect((await getTask(id)).tags ?? []).toEqual([])
  })

  it('a missing task is a no-op, never a throw', async () => {
    expect(await tagLinksInText('no-such-task', 'https://github.com/a/b/pull/1', 'test')).toEqual([])
  })
})

describe('the watcher', () => {
  it('tags a person\'s launch prompt and sends, never an automated send or launch', async () => {
    const stop = startLinkTagWatcher()
    try {
      const id = await newTask()
      bus.emit(EventNames.SESSION_START, { taskId: id, message: 'Look at https://github.com/acme/app/issues/1' }, ['session-runner'], { source: 'quick-start' })
      await until(async () => ((await getTask(id)).tags ?? []).length === 1)

      bus.emit(EventNames.SESSION_SEND, { sessionId: 's-1', taskId: id, message: 'auto: https://github.com/acme/app/issues/2' }, ['session-runner'], { source: 'trigger' })
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's-1', taskId: id, message: 'peer: https://github.com/acme/app/issues/3' }, ['session-runner'], { source: 'peer' })
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's-1', taskId: id, message: 'mine: https://github.com/acme/app/pull/4' }, ['session-runner'], { source: 'ui' })
      await until(async () => ((await getTask(id)).tags ?? []).length === 2)

      // Launches Walnut makes carry text it wrote (a recap, a persona, a replayed prompt).
      bus.emit(EventNames.SESSION_START, { taskId: id, message: 'recap: https://github.com/acme/app/issues/5' }, ['session-runner'], { source: 'personal-ai-lane' })
      bus.emit(EventNames.SESSION_START, { taskId: id, message: 'retry: https://github.com/acme/app/issues/6' }, ['session-runner'], { source: 'retry' })
      bus.emit(EventNames.SESSION_START, { taskId: id, message: 'fork: https://github.com/acme/app/issues/7', forkedFromSessionId: 's-0' }, ['session-runner'], { source: 'quick-start' })
      await new Promise((r) => setTimeout(r, 200))
      expect((await getTask(id)).tags).toEqual(['issue:https://github.com/acme/app/issues/1', 'pr:https://github.com/acme/app/pull/4'])
    } finally {
      stop()
    }
  })
})
