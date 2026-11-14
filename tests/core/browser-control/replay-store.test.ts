/**
 * The Browser replay's store (src/core/browser-control/replay-store.ts). 2026-11-14, the user:
 * "can we make sure the browser action screenshot or video is saved for 7 days (configurable), and
 * can be played back".
 *
 *   - only a step Walnut sent is kept: a one-use token, for its browser, for a tab still the task's;
 *   - what a step did is in words, never the typed text;
 *   - the days kept: older steps are deleted with their pictures, a task with none loses its folder,
 *     0 deletes everything and records nothing; the disk cap drops the oldest of any task;
 *   - the pictures stay on this machine: `browser/` is out of the data repo's git sync and of the
 *     backup.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  DEFAULT_REPLAY_DAYS, _resetReplayForTesting, acceptStep, expectStep, listSteps, replayBytes, replaySummary, stepLabel, stepPicture, sweepReplays,
} from '../../../src/core/browser-control/replay-store.js'
import { readSites, setReplayDays } from '../../../src/core/browser-control/sites.js'
import { EXCLUDED_DIRS } from '../../../src/core/backup/scan.js'

const ROOT = path.join(WALNUT_HOME, 'browser', 'replays')
const DAY = 86_400_000
/** A small real JPEG header and some bytes. */
const jpeg = (n = 1000) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]).toString('base64')}`
const owners = new Map<string, string>()
const hub = { tabOwner: (device: string, tab: number) => owners.get(`${device}:${tab}`) }

async function record(taskId: string, o: { at: number; tab?: number; action?: string; args?: Record<string, unknown>; said?: string; image?: string | null; device?: string }) {
  const tab = o.tab ?? 5
  owners.set(`chrome-1:${tab}`, `task:${taskId}`)
  const token = await expectStep({ owner: `task:${taskId}`, device: 'chrome-1', action: o.action ?? 'click', args: o.args ?? { ref: 'e3' } }, o.at)
  expect(token).toBeTruthy()
  return acceptStep(hub, o.device ?? 'chrome-1', { token, tab, ok: true, said: o.said, url: 'https://mail.example.test/inbox?x=1', title: 'Inbox', at: new Date(o.at).toISOString(), ...(o.image === null ? {} : { image: o.image ?? jpeg() }) }, o.at)
}

beforeEach(async () => {
  await fsp.rm(path.join(WALNUT_HOME, 'browser'), { recursive: true, force: true })
  await fsp.rm(path.join(WALNUT_HOME, 'browser-control.json'), { force: true })
  _resetReplayForTesting()
  owners.clear()
})
afterAll(async () => {
  await fsp.rm(path.join(WALNUT_HOME, 'browser'), { recursive: true, force: true })
})

describe('recording a step', () => {
  it('keeps a step Walnut sent, once, with its picture and its words', async () => {
    const now = Date.now()
    expect(await record('t-1', { at: now, said: 'button "Send"' })).toEqual({ kept: true })
    const steps = await listSteps('t-1', now)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ action: 'click', label: 'Click button "Send"', ok: true, tab: 5, title: 'Inbox' })
    // The address without its query (a search's words, a token in a link).
    expect(steps[0].url).toBe('https://mail.example.test/inbox')
    expect(steps[0].bytes).toBeGreaterThan(1000)
    const pic = await stepPicture('t-1', steps[0].id, now)
    expect(pic?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(await replaySummary('t-1', now)).toMatchObject({ steps: 1 })
    // On disk only owner-readable.
    const mode = fs.statSync(path.join(ROOT, 't-1', 'index.jsonl')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('refuses a token it never gave, a second use, another browser, and a tab that is not the task\'s', async () => {
    const now = Date.now()
    owners.set('chrome-1:5', 'task:t-2')
    expect(await acceptStep(hub, 'chrome-1', { token: 'made-up', tab: 5, image: jpeg() }, now)).toEqual({ kept: false, why: 'unknown_step' })
    const token = await expectStep({ owner: 'task:t-2', device: 'chrome-1', action: 'click', args: {} }, now)
    expect(await acceptStep(hub, 'chrome-2', { token, tab: 5, image: jpeg() }, now)).toEqual({ kept: false, why: 'other_browser' })
    // Any check past the browser's spends the token: a second post never counts.
    expect(await acceptStep(hub, 'chrome-1', { token, tab: 9, image: jpeg() }, now)).toEqual({ kept: false, why: 'not_your_tab' })
    expect(await acceptStep(hub, 'chrome-1', { token, tab: 5, image: jpeg() }, now)).toEqual({ kept: false, why: 'unknown_step' })
    const good = await expectStep({ owner: 'task:t-2', device: 'chrome-1', action: 'click', args: {} }, now)
    const twice = await Promise.all([1, 2].map(() => acceptStep(hub, 'chrome-1', { token: good, tab: 5, image: jpeg() }, now)))
    expect(twice.filter((r) => r.kept)).toHaveLength(1)
    // A step the page held for a yes is sent again with its own token: the held one is no step.
    const held = await expectStep({ owner: 'task:t-2', device: 'chrome-1', action: 'click', args: {} }, now)
    expect(await acceptStep(hub, 'chrome-1', { token: held, tab: 5, ok: false, code: 'outward_needs_ok', image: jpeg() }, now)).toEqual({ kept: false, why: 'held' })
    expect(await listSteps('t-2', now)).toHaveLength(1)
    // A token too old.
    const old = await expectStep({ owner: 'task:t-2', device: 'chrome-1', action: 'click', args: {} }, now)
    expect(await acceptStep(hub, 'chrome-1', { token: old, tab: 5, image: jpeg() }, now + 4 * 60_000)).toEqual({ kept: false, why: 'unknown_step' })
  })

  it('gives no token to a session outside a task, nor while replays are off', async () => {
    expect(await expectStep({ owner: 'session:abc', device: 'chrome-1', action: 'click', args: {} })).toBeUndefined()
    expect(await expectStep({ owner: 'person', device: 'chrome-1', action: 'click', args: {} })).toBeUndefined()
    await setReplayDays(0)
    expect(await expectStep({ owner: 'task:t-3', device: 'chrome-1', action: 'click', args: {} })).toBeUndefined()
  })

  it('keeps a step with no picture, and refuses what is not a JPEG', async () => {
    const now = Date.now()
    await record('t-4', { at: now, image: null })
    await record('t-4', { at: now + 1, image: 'data:image/png;base64,iVBORw0KGgo=' })
    await record('t-4', { at: now + 2, image: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}` })
    const steps = await listSteps('t-4', now + 3)
    expect(steps).toHaveLength(3)
    expect(steps.every((s) => !s.file && s.bytes === 0)).toBe(true)
    expect(fs.readdirSync(path.join(ROOT, 't-4')).filter((f) => f.endsWith('.jpg'))).toEqual([])
  })

  it('never writes outside its folder for a strange task id', async () => {
    expect(await expectStep({ owner: 'task:../../etc', device: 'chrome-1', action: 'click', args: {} })).toBeUndefined()
    expect(await listSteps('../x')).toEqual([])
    expect(await stepPicture('t-1', '../../index')).toBeNull()
  })
})

describe('what a step did, in words', () => {
  it('names the step and never the typed text', () => {
    expect(stepLabel('open', { url: 'https://app.slack.com/client/T1/D2?x=secret' })).toBe('Open app.slack.com/client/T1/D2')
    expect(stepLabel('navigate', { url: 'https://example.com/' })).toBe('Go to example.com')
    expect(stepLabel('click', {}, 'button "Send"')).toBe('Click button "Send"')
    expect(stepLabel('click', { label: 4 })).toBe('Click label 4')
    expect(stepLabel('click', { x: 10.4, y: 20.6 })).toBe('Click at 10, 21')
    expect(stepLabel('type', { text: 'my password 123' }, '15 characters into textbox "Search"')).toBe('Type 15 characters into textbox "Search"')
    expect(stepLabel('type', { text: 'my password 123' })).toBe('Type')
    expect(stepLabel('press', { key: 'Enter' })).toBe('Press Enter')
    expect(stepLabel('fill_form', { fields: 3 })).toBe('Fill 3 fields')
    expect(stepLabel('upload', { files: 1 })).toBe('Upload 1 file')
    expect(stepLabel('dialog', { accept: false })).toBe('Dismiss a dialog')
  })

  it('keeps no typed text or file bytes from the step it was given', async () => {
    const now = Date.now()
    owners.set('chrome-1:5', 'task:t-5')
    const token = await expectStep({ owner: 'task:t-5', device: 'chrome-1', action: 'type', args: { ref: 'e1', text: 'hunter2-SECRET', fields: [{ value: 'x' }] } }, now)
    await acceptStep(hub, 'chrome-1', { token, tab: 5, ok: true, image: jpeg() }, now)
    const text = fs.readFileSync(path.join(ROOT, 't-5', 'index.jsonl'), 'utf8')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('"label":"Type"')
  })
})

describe('the days kept', () => {
  it('is 7 by default', async () => {
    expect(DEFAULT_REPLAY_DAYS).toBe(7)
    expect((await readSites()).replayDays).toBe(7)
  })

  it('deletes steps older than the days kept, with their pictures, and a task folder left empty', async () => {
    const t0 = Date.now() - 10 * DAY
    await record('old-task', { at: t0 })
    await record('old-task', { at: t0 + 1000 })
    await record('mixed', { at: t0 })
    await record('mixed', { at: t0 + 5 * DAY })
    expect(fs.readdirSync(path.join(ROOT, 'old-task')).filter((f) => f.endsWith('.jpg'))).toHaveLength(2)
    const out = await sweepReplays(t0 + 8 * DAY)
    expect(out.deleted).toBe(3)
    expect(fs.existsSync(path.join(ROOT, 'old-task'))).toBe(false)
    const left = await listSteps('mixed', t0 + 8 * DAY)
    expect(left).toHaveLength(1)
    expect(fs.readdirSync(path.join(ROOT, 'mixed')).filter((f) => f.endsWith('.jpg'))).toEqual([left[0].file])
    expect(await replayBytes()).toBe(left[0].bytes)
  })

  it('shows nothing past the days kept even before the sweep runs', async () => {
    const t0 = Date.now() - 9 * DAY
    await record('late', { at: t0 })
    expect(await listSteps('late', t0 + 8 * DAY)).toEqual([])
    expect(await stepPicture('late', (await listSteps('late', t0))[0].id, t0 + 8 * DAY)).toBeNull()
  })

  it('a shorter setting deletes more; off deletes all and keeps nothing new', async () => {
    const now = Date.now()
    await record('a', { at: now - 2 * DAY })
    await record('a', { at: now - 1000 })
    await setReplayDays(1)
    await sweepReplays(now)
    expect(await listSteps('a', now)).toHaveLength(1)
    await setReplayDays(0)
    await sweepReplays(now)
    expect(fs.existsSync(path.join(ROOT, 'a'))).toBe(false)
    expect(await expectStep({ owner: 'task:a', device: 'chrome-1', action: 'click', args: {} })).toBeUndefined()
  })

  it('a token given before off was set keeps nothing', async () => {
    const now = Date.now()
    owners.set('chrome-1:5', 'task:b')
    const token = await expectStep({ owner: 'task:b', device: 'chrome-1', action: 'click', args: {} }, now)
    await setReplayDays(0)
    expect(await acceptStep(hub, 'chrome-1', { token, tab: 5, image: jpeg() }, now)).toEqual({ kept: false, why: 'off' })
    expect(fs.existsSync(path.join(ROOT, 'b'))).toBe(false)
  })

  it('over the disk cap, the oldest steps of any task go first', async () => {
    const now = Date.now()
    await record('x', { at: now - 5000, image: jpeg(20_000) })
    await record('y', { at: now - 4000, image: jpeg(20_000) })
    await record('x', { at: now - 3000, image: jpeg(20_000) })
    await record('y', { at: now - 2000, image: jpeg(20_000) })
    const out = await sweepReplays(now, 50_000)
    expect(out.bytes).toBeLessThanOrEqual(45_000)
    expect((await listSteps('x', now)).map((s) => s.at)).toEqual([new Date(now - 3000).toISOString()])
    expect((await listSteps('y', now)).map((s) => s.at)).toEqual([new Date(now - 2000).toISOString()])
  })

  it('deletes a picture no index line names (a crash between the two)', async () => {
    const now = Date.now()
    await record('c', { at: now })
    fs.writeFileSync(path.join(ROOT, 'c', 'zzz-1.jpg'), 'orphan')
    await sweepReplays(now)
    expect(fs.existsSync(path.join(ROOT, 'c', 'zzz-1.jpg'))).toBe(false)
    expect(await listSteps('c', now)).toHaveLength(1)
  })
})

describe('sweeps and writes at once', () => {
  it('a step written while a sweep runs is kept, and counts toward the disk used', async () => {
    const now = Date.now()
    await record('s', { at: now - 1000 })
    const [, , out] = await Promise.all([sweepReplays(now), record('s', { at: now }), sweepReplays(now)])
    expect(out.deleted).toBe(0)
    expect(await listSteps('s', now)).toHaveLength(2)
    expect(await replayBytes()).toBe((await listSteps('s', now)).reduce((n, x) => n + x.bytes, 0))
  })

  it('off while a sweep runs: the sweep after it deletes everything', async () => {
    const now = Date.now()
    await record('o', { at: now })
    const first = sweepReplays(now)
    await setReplayDays(0)
    await sweepReplays(now)
    await first
    expect(fs.existsSync(path.join(ROOT, 'o'))).toBe(false)
  })
})

describe('the pictures stay on this machine', () => {
  it('browser/ is out of the data repo\'s git sync and of the backup', () => {
    expect(EXCLUDED_DIRS.has('browser')).toBe(true)
    const src = fs.readFileSync(path.join(import.meta.dirname, '../../../src/integrations/git-sync.ts'), 'utf8')
    const body = src.slice(src.indexOf('const GITIGNORE_BODY'), src.indexOf('const GITIGNORE_CONTENT'))
    expect(body.split('\n')).toContain('browser/')
    // And the store writes under WALNUT_HOME/browser/.
    expect(path.relative(WALNUT_HOME, ROOT).split(path.sep)[0]).toBe('browser')
  })
})
