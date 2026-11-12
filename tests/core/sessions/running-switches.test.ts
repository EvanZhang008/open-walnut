/**
 * The markers a running engine switch keeps for the deploy queue (running-switches.ts,
 * scripts/lib/deploy-queue.sh): one per task, written and removed by its own run only.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearSwitchRunning, markSwitchRunning, runningSwitchesDir, sweepRunningSwitchMarkers } from '../../../src/core/sessions/running-switches.js'

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-running-switches-')))
afterAll(() => { if (home.includes('walnut-running-switches-')) fs.rmSync(home, { recursive: true, force: true }) })
const file = (task: string) => path.join(runningSwitchesDir(home), task)

describe('running switch markers', () => {
  it('a run removes only its own marker: the next run of the same task keeps its one', async () => {
    const read = () => (fs.existsSync(file('task-a')) ? fs.readFileSync(file('task-a'), 'utf8') : '')
    const first = markSwitchRunning('task-a', 'move to cloud', home)
    await expect.poll(read).toContain(first)
    // The next run starts before the first one's clear ran (its work ended; its finally runs after).
    const second = markSwitchRunning('task-a', 'move to cloud', home)
    await expect.poll(read).toContain(second)
    await clearSwitchRunning('task-a', first, home)
    const line = fs.readFileSync(file('task-a'), 'utf8')
    expect(line).toMatch(new RegExp(`^${process.pid} \\d+ task-a ${second} move to cloud\\n$`))
    await clearSwitchRunning('task-a', second, home)
    expect(fs.existsSync(file('task-a'))).toBe(false)
  })

  it('a boot sweeps the markers an earlier server left, never its own', async () => {
    fs.mkdirSync(runningSwitchesDir(home), { recursive: true })
    fs.writeFileSync(file('task-old'), `1 ${Math.floor(Date.now() / 1000)} task-old 0123abcd move to cloud\n`)
    const mine = markSwitchRunning('task-new', 'switch to codex', home)
    await expect.poll(() => fs.existsSync(file('task-new'))).toBe(true)
    expect(await sweepRunningSwitchMarkers(home)).toBe(1)
    expect(fs.existsSync(file('task-old'))).toBe(false)
    expect(fs.existsSync(file('task-new'))).toBe(true)
    await clearSwitchRunning('task-new', mine, home)
  })

  it('a task id that is no file name writes nothing', async () => {
    const t = markSwitchRunning('../escape', 'move', home)
    await clearSwitchRunning('../escape', t, home)
    expect(fs.existsSync(path.join(home, 'local', 'escape'))).toBe(false)
  })
})
