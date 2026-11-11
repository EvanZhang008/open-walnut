/**
 * First-run setup's rules (src/core/first-run.ts): only a config with nothing stored is
 * stamped, an install from before (no `first_run`) is never asked, a step a later release
 * adds never reaches an install created before it, and a test server stamps nothing
 * unless it asks.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FIRST_RUN_STEPS, firstRunStampAllowed, homeHoldsWork, USED_HOME_DIRS, USED_HOME_MARKERS, pendingFirstRunSteps, recordFirstRunAnswer, stampFirstRun } from '../../src/core/first-run.js'

const now = new Date('2026-11-11T12:00:00.000Z')

describe('first-run stamp', () => {
  it('stamps only a config with nothing stored', () => {
    const fresh: Record<string, unknown> = {}
    expect(stampFirstRun(fresh, now)).toBe(true)
    expect(fresh.first_run).toEqual({ at: now.toISOString(), steps: [...FIRST_RUN_STEPS] })
    // Any key at all is a config someone saved: an existing install.
    for (const existing of [{ hosts: {} }, { agent: { main_model: 'x' } }, { version: 1 }]) {
      const doc: Record<string, unknown> = { ...existing }
      expect(stampFirstRun(doc, now)).toBe(false)
      expect(doc.first_run).toBeUndefined()
    }
  })

  it('a test server stamps only when it asks; a cloud companion never', () => {
    expect(firstRunStampAllowed({}, false)).toBe(true)
    expect(firstRunStampAllowed({}, true)).toBe(false)
    expect(firstRunStampAllowed({ VITEST: 'true' }, false)).toBe(false)
    expect(firstRunStampAllowed({ WALNUT_TEST_SERVER: '1' }, false)).toBe(false)
    expect(firstRunStampAllowed({ VITEST: 'true', WALNUT_FIRST_RUN_SETUP: '1' }, false)).toBe(true)
    expect(firstRunStampAllowed({ WALNUT_FIRST_RUN_SETUP: '0' }, false)).toBe(false)
  })
})

describe('pending steps', () => {
  it('an install from before asks nothing', () => {
    expect(pendingFirstRunSteps({})).toEqual([])
    expect(pendingFirstRunSteps({ first_run: {} })).toEqual([])
  })
  it('asks the steps fixed at creation that are not answered yet', () => {
    expect(pendingFirstRunSteps({ first_run: { steps: ['hosts'] } })).toEqual(['hosts'])
    expect(pendingFirstRunSteps({ first_run: { steps: ['hosts'], answered: { hosts: now.toISOString() } } })).toEqual([])
    // A step a later release adds is not in an older install's list, and an unknown one is ignored.
    expect(pendingFirstRunSteps({ first_run: { steps: [] } })).toEqual([])
    expect(pendingFirstRunSteps({ first_run: { steps: ['hosts', 'from-the-future'] } })).toEqual(['hosts'])
  })
})

describe('recording an answer', () => {
  it('records once, and writes nothing into a config from before', () => {
    const doc: Record<string, unknown> = { first_run: { at: 'a', steps: ['hosts'] } }
    expect(recordFirstRunAnswer(doc, 'hosts', now)).toBe(true)
    expect(doc.first_run).toEqual({ at: 'a', steps: ['hosts'], answered: { hosts: now.toISOString() } })
    expect(recordFirstRunAnswer(doc, 'hosts', new Date())).toBe(false)
    const old: Record<string, unknown> = { hosts: {} }
    expect(recordFirstRunAnswer(old, 'hosts', now)).toBe(false)
    expect(old.first_run).toBeUndefined()
  })
})

describe('a data home with someone\'s work is never a fresh install', () => {
  it('an empty config beside tasks, sessions or a config backup is not fresh; an empty home is', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'first-run-home-'))
    try {
      expect(await homeHoldsWork(root)).toBe(false)
      for (const marker of USED_HOME_MARKERS) {
        const home = path.join(root, marker.replace(/[/.]/g, '_'))
        await fs.mkdir(path.dirname(path.join(home, marker)), { recursive: true })
        await fs.writeFile(path.join(home, marker), '')
        expect(await homeHoldsWork(home), marker).toBe(true)
      }
      // Boot makes some dirs empty before the seed: empty they say nothing, with a file they do.
      for (const dir of USED_HOME_DIRS) {
        const home = path.join(root, 'dir_' + dir.replace(/[/.]/g, '_'))
        await fs.mkdir(path.join(home, dir), { recursive: true })
        expect(await homeHoldsWork(home), `${dir} empty`).toBe(false)
        await fs.writeFile(path.join(home, dir, 'x.md'), 'note')
        expect(await homeHoldsWork(home), dir).toBe(true)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
