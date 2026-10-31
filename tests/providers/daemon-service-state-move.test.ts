import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_DURABLE_STATE_DIRS, moveDaemonState } from '../../src/providers/daemon-service-state-move.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-state-move-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('moving a daemon\'s durable state between an unmanaged daemon and a service', () => {
  it('moves each dir only the source has, with its files, and keeps a target that already exists', async () => {
    const from = path.join(dir, 'tmp')
    const to = path.join(dir, 'root')
    fs.mkdirSync(path.join(from, 'plugin-jobs', 'k1'), { recursive: true })
    fs.writeFileSync(path.join(from, 'plugin-jobs', 'k1', 'run.json'), '{"pid":42}')
    fs.mkdirSync(path.join(from, 'host-server'), { recursive: true })
    fs.mkdirSync(path.join(to, 'host-server'), { recursive: true })
    fs.writeFileSync(path.join(to, 'host-server', 'newer'), 'x')
    expect(await moveDaemonState(from, to)).toEqual(['plugin-jobs'])
    expect(fs.readFileSync(path.join(to, 'plugin-jobs', 'k1', 'run.json'), 'utf8')).toBe('{"pid":42}')
    expect(fs.existsSync(path.join(from, 'plugin-jobs'))).toBe(false)
    expect(fs.existsSync(path.join(from, 'host-server'))).toBe(true)
    expect(fs.readdirSync(path.join(to, 'host-server'))).toEqual(['newer'])
  })

  it('leaves a symlink and a missing source alone', async () => {
    const from = path.join(dir, 'tmp')
    fs.mkdirSync(from)
    fs.symlinkSync('/etc', path.join(from, 'resume-records'))
    expect(await moveDaemonState(from, path.join(dir, 'root'))).toEqual([])
  })

  it('names every durable dir the standalone daemon moves to its state dir in service mode', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    const named = [...src.matchAll(/SERVICE_MODE && DAEMON_STATE_DIR\s*\?\s*path\.join\(DAEMON_STATE_DIR, '([^']+)'\)\s*:\s*[^\n]*\.open-walnut', 'tmp'/g)].map((m) => m[1])
    expect([...named].sort()).toEqual([...DAEMON_DURABLE_STATE_DIRS].sort())
  })
})
