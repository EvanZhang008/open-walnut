/**
 * exec-grants onAccessChange: what a waiting read hears (host-exec-grant.ts readStopWatch). One
 * answer per change, built from the grants just written; only a change to who may use a host tells
 * the listeners, never a run noted on a grant (2026-11-05 code review: each waiting read re-read and
 * parsed both grant files on every run's noteRun write, 404 ms of the loop at 2000 grants).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as grants from '../../../src/core/hosts/exec-grants.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-access-'))
  grants.setExecGrantsFileForTest(path.join(dir, 'exec-grants.json'))
})
afterEach(() => {
  grants.setExecGrantsFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('onAccessChange', () => {
  it('tells a grant, a revoke and a closed host, each with one check of who may use which host; a run noted tells nothing', async () => {
    const heard: Array<[boolean, boolean]> = []
    const off = grants.onAccessChange((may) => heard.push([may('t1', 'macbox'), may('t2', 'macbox')]))
    const g = await grants.grant('t1', 'macbox', 'letter')
    expect(heard).toEqual([[true, false]])
    await grants.noteRun(g.id, 'echo hi')
    await grants.noteRun(g.id, 'echo again')
    expect(heard).toHaveLength(1)
    await grants.setHostClosed('macbox', true)
    expect(heard.at(-1)).toEqual([false, false])
    await grants.setHostClosed('macbox', false)
    expect(heard.at(-1)).toEqual([true, false])
    await grants.revokeGrant(g.id)
    expect(heard.at(-1)).toEqual([false, false])
    off()
    await grants.grant('t1', 'macbox', 'letter')
    expect(heard).toHaveLength(4)
  })

  it('a listener that throws does not keep the others from hearing', async () => {
    let told = 0
    const offA = grants.onAccessChange(() => { throw new Error('boom') })
    const offB = grants.onAccessChange(() => { told += 1 })
    await grants.grant('t1', 'macbox', 'letter')
    expect(told).toBe(1)
    offA(); offB()
  })
})
