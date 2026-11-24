/**
 * A new task is never made for a start whose folder is gone (2026-11-23: a project's own folder
 * had been deleted on the Mac; the draft made the task, its session never started, and nothing
 * said why). quickStartSession asks missingStartFolder before it files anything, so every way in
 * (the web draft, the phone's v1 launch, a notification's action, a routine, a subagent) is
 * refused with 400 cwd_missing and the draft comes back with its words.
 *
 * The class is "a path that files a task and starts its session". This test enumerates, from the
 * source, every file that both files a task (addTask) and emits the session start, and fails when a
 * new one appears until it is listed here with why its folder cannot be a gone one.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { missingStartFolder } from '../../../src/core/sessions/folder-gone.js'
import { hostGateRelayFields } from '../../../src/core/sessions/mobile-launch.js'
import { CWD_MISSING_CODE, QuickStartError } from '../../../src/core/sessions/quick-start.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Files that file a task and start its session, and how a gone folder is kept out. */
const STARTERS: Record<string, string> = {
  'src/core/sessions/quick-start.ts': 'a new task: checks missingStartFolder before addTask (CWD_MISSING_CODE); an existing task keeps the spawn\'s remake and "Continue in a new folder"',
  'src/core/sessions/session-controls.ts': 'a fork: the folder is the running session\'s own; a gone one takes "Continue in a new folder"',
  'src/core/sessions/personal-ai-lane.ts': 'the Personal AI lane runs in Walnut\'s own folder, which Walnut makes',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('a start whose folder is gone files no task', () => {
  it('every file that files a task and starts its session is listed', () => {
    const found = walk(path.join(ROOT, 'src'))
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf-8')
        return /\baddTask\(/.test(src) && /EventNames\.SESSION_START\b/.test(src)
      })
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort()
    expect(found).toEqual(Object.keys(STARTERS).sort())
  })

  it('quickStartSession checks the folder before it files the task', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/sessions/quick-start.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export async function quickStartSession('))
    const check = body.indexOf('missingStartFolder(')
    const file = body.indexOf('addTask(')
    expect(check).toBeGreaterThan(0)
    expect(file).toBeGreaterThan(check)
  })

  it('missingStartFolder says a gone local folder, and nothing for one that is there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-gone-'))
    try {
      expect(await missingStartFolder(dir)).toBeNull()
      expect(await missingStartFolder(dir, '__local__')).toBeNull()
      expect(await missingStartFolder('~')).toBeNull()
      expect(await missingStartFolder(path.join(dir, 'nope'))).toMatch(/is gone\. Pick another folder\./)
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'x')
      expect(await missingStartFolder(file)).toMatch(/is gone/)
      expect(await missingStartFolder('~/anything')).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the refusal keeps its code and folder across the cloud relay (the phone reads cwd_missing, not bad_request)', () => {
    const err = new QuickStartError('The folder /x is gone. Pick another folder.', 400, { code: CWD_MISSING_CODE, cwd: '/x', host: 'devbox' })
    expect(hostGateRelayFields(err)).toEqual({ code: 'cwd_missing', details: { cwd: '/x', host: 'devbox' } })
    expect(hostGateRelayFields(new QuickStartError('bad', 400, { code: 'other' }))).toBeNull()
  })
})
