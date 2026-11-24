/**
 * Ratchet: a caller alias (acp-caller-sid.ts setCallerAlias) lives only in the server's memory, so
 * one a server cannot set again from disk before it listens makes the first minutes after every
 * restart read that session's calls as no task's (2026-11-24: a subagent's host_exec_read refused
 * session_only for one to five minutes after each deploy, 75 an hour). Every file that sets one
 * must keep what it set in state the next server restores before its first request: today only
 * the subagent run, whose saved handles server.ts restores before createServer
 * (registry.ts restoreSubagentCallerAliases). A new caller of setCallerAlias fails here until its
 * aliases are restored the same way and the file is listed below.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '../../..')
const RESTORED_BEFORE_LISTEN = ['src/core/subagents/on-host.ts', 'src/core/subagents/registry.ts']

describe('caller aliases are in place before the server listens', () => {
  it('only files whose aliases are restored before listen set one', () => {
    const out = execFileSync('git', ['grep', '-l', '-E', 'setCallerAlias\\(', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
    const setters = out.split('\n').filter(Boolean).filter((f) => f !== 'src/core/sessions/acp-caller-sid.ts').sort()
    expect(setters).toEqual(RESTORED_BEFORE_LISTEN)
  })

  it('server.ts restores the saved subagent aliases before it creates the HTTP server', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    const restore = src.indexOf('restoreSubagentCallerAliases()')
    const listen = src.indexOf('httpServer = createServer(app)')
    expect(restore).toBeGreaterThan(0)
    expect(listen).toBeGreaterThan(0)
    expect(restore).toBeLessThan(listen)
  })
})
