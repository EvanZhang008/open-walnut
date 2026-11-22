/**
 * The switch's own files in a home (src/core/leader/switch/records.ts): one switch command at a
 * time, and the permission log rotated instead of growing for good.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetMayActSizes, appendMayAct, readMayAct, switchDir, takeSwitchLock } from '../../../../src/core/leader/switch/records.js'

let home = ''
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-records-')); _resetMayActSizes() })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('takeSwitchLock', () => {
  it('refuses a second switch command while the first holds it, and frees it on release', () => {
    const release = takeSwitchLock(home)
    expect(() => takeSwitchLock(home)).toThrow(/another `walnut leader switch` runs on this home/)
    release()
    const again = takeSwitchLock(home)
    again()
  })

  it('takes over a lock whose process is gone', () => {
    fs.mkdirSync(switchDir(home), { recursive: true })
    // A pid that cannot be alive: above the kernel's pid_max.
    fs.writeFileSync(path.join(switchDir(home), 'switch.lock'), JSON.stringify({ pid: 4_194_305, at: new Date().toISOString() }))
    const release = takeSwitchLock(home)
    release()
  })
})

describe('the permission log', () => {
  it('rotates at 4 MB into one older file, and reads both', () => {
    const big = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 70; i++) appendMayAct(home, { machine: 'm', event: 'door', mayAct: true, opId: `op-${i}`, why: big })
    const files = fs.readdirSync(switchDir(home)).filter((f) => f.startsWith('may-act')).sort()
    expect(files).toEqual(['may-act.1.jsonl', 'may-act.jsonl'])
    expect(fs.statSync(path.join(switchDir(home), 'may-act.jsonl')).size).toBeLessThan(4 * 1024 * 1024)
    const lines = readMayAct(home)
    expect(lines.at(-1)?.opId).toBe('op-69')
  })
})
