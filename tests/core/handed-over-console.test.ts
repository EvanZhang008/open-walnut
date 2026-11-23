/**
 * The console files of a machine that handed the leader over (src/core/handed-over-console.ts):
 * what reads as a console, when it stands (the home's own marker decides), and the holder file a
 * replica keeps. Every file in a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearHolder, consoleRefusal, consolesOfHome, readConsoleFile, readHolder, writeConsoleFile, writeHolder, type HandedOverConsole,
} from '../../src/core/handed-over-console.js'

let root: string
let dir: string
let home: string

const WALNUT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function consoleOf(over: Partial<HandedOverConsole> = {}): HandedOverConsole {
  return {
    v: 1, walnutId: WALNUT, home, port: 4802, host: '127.0.0.1', switchId: 'sw-1', to: 'machine-b',
    device: 'console-machine-a', token: 'f'.repeat(32), at: new Date().toISOString(), ...over,
  }
}

function marker(m: Record<string, unknown> | string): void {
  const f = path.join(home, 'local', 'leader-switch', 'handed-over.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof m === 'string' ? m : JSON.stringify(m))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-console-'))
  dir = path.join(root, 'console')
  home = path.join(root, 'home')
  fs.mkdirSync(home)
})

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('the console file', () => {
  it('reads back what was written, owner-only', () => {
    writeConsoleFile(consoleOf(), dir)
    expect(readConsoleFile(WALNUT, dir)).toEqual(consoleOf({ at: readConsoleFile(WALNUT, dir)!.at }))
    expect(fs.statSync(path.join(dir, `${WALNUT}.json`)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('reads nothing from a missing, broken or incomplete file', () => {
    expect(readConsoleFile(WALNUT, dir)).toBeNull()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${WALNUT}.json`), '{not json')
    expect(readConsoleFile(WALNUT, dir)).toBeNull()
    for (const bad of [{ token: 'short' }, { port: 0 }, { port: 70000 }, { home: 'relative/home' }, { switchId: '' }, { v: 2 }]) {
      fs.writeFileSync(path.join(dir, `${WALNUT}.json`), JSON.stringify({ ...consoleOf(), ...bad }))
      expect(readConsoleFile(WALNUT, dir), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refuses an id that is not a Walnut id (no path out of the folder)', () => {
    expect(() => writeConsoleFile(consoleOf({ walnutId: '../x' }), dir)).toThrow(/not a Walnut id/)
    expect(readConsoleFile('../x', dir)).toBeNull()
  })

  it('lists the consoles of one home only', () => {
    writeConsoleFile(consoleOf(), dir)
    writeConsoleFile(consoleOf({ walnutId: 'other0000', home: path.join(root, 'elsewhere') }), dir)
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port: 4802, host: '127.0.0.1', since: 'now' }, dir)
    expect(consolesOfHome(home, dir).map((c) => c.walnutId)).toEqual([WALNUT])
    expect(consolesOfHome(path.join(home, '.'), dir).length).toBe(1)
  })
})

describe('when the console stands', () => {
  it('stands only on a committed hand-over of the same switch', () => {
    const c = consoleOf()
    expect(consoleRefusal(c)).toMatch(/no handed-over marker/)
    marker('{torn')
    expect(consoleRefusal(c)).toMatch(/does not read/)
    marker({ switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    expect(consoleRefusal(c)).toMatch(/has not committed/)
    marker({ switchId: 'sw-2', to: 'machine-b', state: 'handed-over', at: 'x' })
    expect(consoleRefusal(c)).toMatch(/another switch/)
    marker({ switchId: 'sw-1', to: 'machine-b', state: 'handed-over', at: 'x' })
    expect(consoleRefusal(c)).toBeNull()
  })

  it('ends when the home is moved aside (a switch back) or its marker removed (a cancel)', () => {
    marker({ switchId: 'sw-1', to: 'machine-b', state: 'handed-over', at: 'x' })
    const c = consoleOf()
    expect(consoleRefusal(c)).toBeNull()
    fs.renameSync(home, `${home}.before-sw-2`)
    fs.mkdirSync(home)
    expect(consoleRefusal(c)).toMatch(/no handed-over marker/)
  })
})

describe('the holder file', () => {
  it('names a live process only', async () => {
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port: 4802, host: '127.0.0.1', since: 'now' }, dir)
    expect(readHolder(WALNUT, dir)?.state).toBe('waiting')
    // A process that is gone: its file reads as no holder.
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid!
    await new Promise((r) => child.on('exit', r))
    writeHolder(WALNUT, { pid, state: 'serving', port: 4802, host: '127.0.0.1', since: 'now' }, dir)
    expect(readHolder(WALNUT, dir)).toBeNull()
  })

  it('is cleared only by the process that wrote it', () => {
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port: 4802, host: '127.0.0.1', since: 'now' }, dir)
    clearHolder(WALNUT, process.pid + 1, dir)
    expect(readHolder(WALNUT, dir)).not.toBeNull()
    clearHolder(WALNUT, process.pid, dir)
    expect(readHolder(WALNUT, dir)).toBeNull()
  })
})
