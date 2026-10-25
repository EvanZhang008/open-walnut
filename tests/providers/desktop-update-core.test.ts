import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createDesktopUpdate, type DesktopUpdateDeps } from '../../src/providers/desktop-update-core.js'

function setup(available = true) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void }
  child.unref = vi.fn()
  const spawn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child })
  const execFile = vi.fn((_file, _args, _opts, done) => done(null, JSON.stringify({ available, token: available ? '12:old:new' : null, version: '1.0' })))
  const readFileSync = vi.fn(() => Buffer.from('--desktop-update-bridge'))
  const deps = { platform: 'darwin', home: '/home/test', env: {}, fs: { promises: { readFile: readFileSync } }, execFile, spawn } as unknown as DesktopUpdateDeps
  return { core: createDesktopUpdate(deps), deps, spawn, execFile, readFileSync, child }
}

describe('installed desktop update', () => {
  it('reports an installed build even when the release version did not change', async () => {
    const s = setup()
    expect(await s.core.status()).toMatchObject({ available: true, token: '12:old:new', version: '1.0' })
    expect(s.spawn).not.toHaveBeenCalled()
  })
  it('never launches an old app that does not support the helper flag', async () => {
    const s = setup()
    s.readFileSync.mockReturnValue(Buffer.from('old app'))
    expect((await s.core.status()).available).toBe(false)
    expect(s.execFile).not.toHaveBeenCalled()
  })
  it('refuses stale tokens and duplicate requests without executing restart', async () => {
    const s = setup()
    expect(await s.core.restart('stale')).toEqual({ accepted: false })
    expect(s.spawn).not.toHaveBeenCalled()
    expect(await s.core.restart('12:old:new')).toEqual({ accepted: true })
    expect(await s.core.restart('12:old:new')).toEqual({ accepted: false })
    expect(s.spawn).toHaveBeenCalledTimes(1)
    expect(s.spawn.mock.calls[0]).toEqual(['/Applications/Walnut.app/Contents/MacOS/Walnut', ['--desktop-update-bridge', 'restart', '12:old:new'], { detached: true, stdio: 'ignore', env: {} }])
  })
  it('reports a failed restart and permits retry', async () => {
    const s = setup()
    await s.core.restart('12:old:new')
    s.child.emit('exit', 1)
    expect(await s.core.status()).toMatchObject({ restarting: false, error: expect.stringContaining('could not restart') })
    expect(await s.core.restart('12:old:new')).toEqual({ accepted: true })
  })
  it('passes force to the helper only when asked, and names the other-windows refusal', async () => {
    const s = setup()
    // A helper that reports `windows` knows --force.
    s.execFile.mockImplementation((_f, _a, _o, done) => done(null, JSON.stringify({ available: true, token: '12:old:new', version: '1.0', windows: 2 })))
    await s.core.restart('12:old:new', true)
    expect(s.spawn.mock.calls[0][1]).toEqual(['--desktop-update-bridge', 'restart', '12:old:new', '--force'])
    s.child.emit('exit', 3)
    expect((await s.core.status()).error).toContain('Another Walnut window is open')
    await s.core.restart('12:old:new', 'yes')
    expect(s.spawn.mock.calls[1][1]).toEqual(['--desktop-update-bridge', 'restart', '12:old:new'])
  })
  it('never sends --force to an older helper that does not report windows', async () => {
    const s = setup()
    await s.core.restart('12:old:new', true)
    expect(s.spawn.mock.calls[0][1]).toEqual(['--desktop-update-bridge', 'restart', '12:old:new'])
    s.child.emit('exit', 1)
    expect((await s.core.status()).error).toContain('close any extra app windows')
  })
  it('relays the open window count the helper reports', async () => {
    const s = setup()
    s.execFile.mockImplementation((_f, _a, _o, done) => done(null, JSON.stringify({ available: true, token: '12:old:new', version: '1.0', windows: 2 })))
    expect(await s.core.status()).toMatchObject({ windows: 2 })
  })
  it('an isolated test daemon cannot detect or restart the real app', async () => {
    const s = setup()
    s.deps.isolated = true
    expect((await s.core.status()).available).toBe(false)
    expect(await s.core.restart('12:old:new')).toEqual({ accepted: false })
    expect(s.spawn).not.toHaveBeenCalled()
    expect(s.execFile).not.toHaveBeenCalled()
  })
  it('does not run macOS helpers on other platforms', async () => {
    const s = setup()
    s.deps.platform = 'linux'
    expect((await s.core.status()).available).toBe(false)
    expect(s.readFileSync).not.toHaveBeenCalled()
  })
})
