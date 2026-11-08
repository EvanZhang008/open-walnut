/**
 * The host's read-only size walk of task directories (src/providers/task-dir-sizes.ts):
 * blocks, not apparent sizes; symlinks not followed; a budget that cuts the walk marks it partial.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { taskDirSizes } from '../../src/providers/task-dir-sizes.js'

let root = ''
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = '' })

describe('taskDirSizes', () => {
  it('sums a directory without following a symlink out of it, and names its largest folders', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sizes-')))
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'huge.bin'), Buffer.alloc(8 * 1024 * 1024, 1))
    const dir = path.join(root, 'task-a')
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'runs', 'one.bin'), Buffer.alloc(2 * 1024 * 1024, 1))
    fs.symlinkSync(outside, path.join(dir, 'link'))
    const [s] = await taskDirSizes(root, ['task-a', 'task-missing'])
    expect(s.taskId).toBe('task-a')
    expect(s.bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024)
    expect(s.bytes).toBeLessThan(8 * 1024 * 1024)
    expect(s.top[0].name).toBe('runs')
    expect(s.partial).toBe(false)
  })

  it('marks a walk cut short by its budget partial, its bytes a lower bound', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sizes-')))
    const dir = path.join(root, 'task-b')
    fs.mkdirSync(dir)
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x')
    const [s] = await taskDirSizes(root, ['task-b'], { files: 5 })
    expect(s.partial).toBe(true)
    const [late] = await taskDirSizes(root, ['task-b'], { perDirMs: -1 })
    expect(late.partial).toBe(true)
    expect(late.bytes).toBe(0)
  })

  // Review round 5: one budget shared by every directory left the later ones measured as 0 forever.
  it('gives each directory its own budget, and leaves out the ones the deadline did not reach', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sizes-')))
    for (const t of ['task-c', 'task-d']) {
      fs.mkdirSync(path.join(root, t))
      fs.writeFileSync(path.join(root, t, 'data.bin'), Buffer.alloc(8192, 1))
    }
    const both = await taskDirSizes(root, ['task-c', 'task-d'], { files: 1 })
    expect(both.map((s) => [s.taskId, s.bytes >= 8192])).toEqual([['task-c', true], ['task-d', true]])
    expect(await taskDirSizes(root, ['task-c', 'task-d'], { totalMs: -1 })).toEqual([])
  })

  it('stops reading a huge directory once the budget is spent, and lets timers run meanwhile', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sizes-')))
    const dir = path.join(root, 'task-e')
    fs.mkdirSync(dir)
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `f${i}`), '')
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 0)
    const [s] = await taskDirSizes(root, ['task-e'], { files: 2000 })
    clearInterval(timer)
    expect(s.partial).toBe(true)
    expect(s.top.length).toBeLessThanOrEqual(6)
    expect(ticks).toBeGreaterThan(0)
  })
})
