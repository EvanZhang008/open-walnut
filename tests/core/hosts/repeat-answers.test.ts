/**
 * A final answer about an id with no run (a job the host does not hold, a copy Walnut does not
 * hold) says it is final, counts the reads of it, and a repeat logs at info, not warn
 * (src/core/hosts/repeat-answers.ts). 2026-11-22: a host_exec call's answer was lost while the
 * Mac's disk was full, and a session's shell loop read that job id every 10 s for 40 minutes, a
 * 404 warn line each, until the log-spike alarm rang.
 *
 * The class guard: every place that answers such an id goes through noteFinalAnswer, and every
 * route that answers a host refusal marks its repeats, so a new member of either cannot log a warn
 * line per poll again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { noteFinalAnswer, resetFinalAnswersForTest } from '../../../src/core/hosts/repeat-answers.js'
import { requestLogger } from '../../../src/web/middleware/request-logger.js'
import { markRepeatAnswerIf, markHostRefusalRepeat } from '../../../src/web/middleware/handled-failure.js'
import { log } from '../../../src/logging/index.js'
import { lostRunLines } from '../../../src/providers/host-exec-run-id.js'
import { daemonRuntimeText } from '../../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

afterEach(() => { vi.restoreAllMocks(); resetFinalAnswersForTest() })

describe('noteFinalAnswer', () => {
  it('counts the answers before this one for the same key, within an hour', () => {
    const t = 1_000_000
    expect(noteFinalAnswer('job\u0000t1\u0000mac\u0000hx-1', t)).toBe(0)
    expect(noteFinalAnswer('job\u0000t1\u0000mac\u0000hx-1', t + 10_000)).toBe(1)
    expect(noteFinalAnswer('job\u0000t1\u0000mac\u0000hx-1', t + 20_000)).toBe(2)
    // Another id, or the same one after an hour of quiet, starts again.
    expect(noteFinalAnswer('job\u0000t1\u0000mac\u0000hx-2', t + 20_000)).toBe(0)
    expect(noteFinalAnswer('job\u0000t1\u0000mac\u0000hx-1', t + 20_000 + 60 * 60_000)).toBe(0)
  })
})

describe('request log: a repeated final answer', () => {
  function fire(status: number, data: Record<string, unknown>): { warn: number; info: number } {
    const warn = vi.spyOn(log.web, 'warn')
    const info = vi.spyOn(log.web, 'info')
    const res = new EventEmitter() as unknown as Response & EventEmitter
    ;(res as unknown as { statusCode: number }).statusCode = status
    const sent: Record<string, string> = {}
    ;(res as unknown as Record<string, unknown>).setHeader = (name: string, value: string) => { sent[name.toLowerCase()] = value; return res }
    ;(res as unknown as Record<string, unknown>).getHeader = (name: string) => sent[name.toLowerCase()]
    const url = '/api/v1/hosts/__local__/exec/hx-d6914a0f?wait_ms=15000'
    const req = { method: 'GET', originalUrl: url, path: url.split('?')[0], query: {}, headers: {} } as unknown as Request
    requestLogger(req, res, () => {})
    markRepeatAnswerIf(res, data)
    res.emit('finish')
    const mine = (calls: unknown[][]) => calls.filter(([m]) => String(m).startsWith('GET /api/v1/hosts/__local__/exec/')).length
    return { warn: mine(warn.mock.calls), info: mine(info.mock.calls) }
  }

  it('the first 404 is a warn line, a repeat of it is info', () => {
    expect(fire(404, { final: true })).toEqual({ warn: 1, info: 0 })
    expect(fire(404, { final: true, repeats: 3 })).toEqual({ warn: 0, info: 1 })
  })

  it('a 5xx is never quieted by the mark', () => {
    expect(fire(503, { repeats: 3 })).toEqual({ warn: 1, info: 0 })
  })
})

describe('request log: a busy call asked again under its op id', () => {
  // 2026-11-23: eight host_exec calls the land link relay sent to clouddev waited for a slot, each
  // asked again by the gateway under its own op id about every 5 s: 92 warn lines in ten minutes.
  function fire(status: number, opId: string | undefined, url = '/api/v1/hosts/clouddev/exec', code = status === 429 ? 'busy' : 'exec_grant_required'): { warn: number; info: number } {
    const warn = vi.spyOn(log.web, 'warn')
    const info = vi.spyOn(log.web, 'info')
    const res = new EventEmitter() as unknown as Response & EventEmitter
    ;(res as unknown as { statusCode: number }).statusCode = status
    const sent: Record<string, string> = {}
    ;(res as unknown as Record<string, unknown>).setHeader = (name: string, value: string) => { sent[name.toLowerCase()] = value; return res }
    ;(res as unknown as Record<string, unknown>).getHeader = (name: string) => sent[name.toLowerCase()]
    const headers: Record<string, string> = opId ? { 'x-walnut-op-id': opId } : {}
    const req = { method: 'POST', originalUrl: url, path: url, query: {}, headers } as unknown as Request
    requestLogger(req, res, () => {})
    markHostRefusalRepeat(req, res, { code, data: {} })
    res.emit('finish')
    const mine = (calls: unknown[][]) => calls.filter(([m]) => String(m).startsWith(`POST ${url} `)).length
    const out = { warn: mine(warn.mock.calls), info: mine(info.mock.calls) }
    vi.restoreAllMocks()   // each call counts only its own lines
    return out
  }

  it('the first refusal of a call is a warn line, each resend of it is info', () => {
    expect(fire(429, 'oc-a-0')).toEqual({ warn: 1, info: 0 })
    for (let i = 0; i < 11; i++) expect(fire(429, 'oc-a-0')).toEqual({ warn: 0, info: 1 })
    // Another call is its own signal, and so is the same op id on another route.
    expect(fire(429, 'oc-b-0')).toEqual({ warn: 1, info: 0 })
    expect(fire(429, 'oc-a-0', '/api/v1/hosts/clouddev/http')).toEqual({ warn: 1, info: 0 })
  })

  it('a call with no op id, and a refusal that is not busy, stay a warn each', () => {
    expect(fire(429, undefined)).toEqual({ warn: 1, info: 0 })
    expect(fire(429, undefined)).toEqual({ warn: 1, info: 0 })
    expect(fire(403, 'oc-c-0')).toEqual({ warn: 1, info: 0 })
    expect(fire(403, 'oc-c-0')).toEqual({ warn: 1, info: 0 })
    // A 429 of another kind is no busy resend: a warn each.
    expect(fire(429, 'oc-d-0', undefined, 'throttled')).toEqual({ warn: 1, info: 0 })
    expect(fire(429, 'oc-d-0', undefined, 'throttled')).toEqual({ warn: 1, info: 0 })
  })

  it('every 429 a host call throws in src/core/hosts is a busy refusal (the kind a resend repeats)', () => {
    const dir = path.join(ROOT, 'src/core/hosts')
    const sites: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of text.matchAll(/new HostExecError\([^\n]*?,\s*429\s*,\s*'([a-z_]+)'/g)) { sites.push(f); expect(m[1], f).toBe('busy') }
      // A status table that maps a host's code to 429 maps only busy.
      for (const m of text.matchAll(/(\w+):\s*429\b/g)) expect(m[1], f).toBe('busy')
    }
    expect(new Set(sites)).toEqual(new Set(['host-copy.ts', 'host-exec.ts', 'host-http.ts', 'host-mcp.ts']))
  })
})

describe('the class: answers about an id with no run', () => {
  it('every 404 a host call throws in src/core/hosts counts its repeats (noteFinalAnswer)', () => {
    const dir = path.join(ROOT, 'src/core/hosts')
    const sites: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      const re = /new HostExecError\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        // The call's arguments, up to its closing paren at depth 0.
        let depth = 0, i = m.index + m[0].length - 1
        for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break }
        const call = text.slice(m.index, i + 1)
        if (!/,\s*404\s*,\s*'unknown_(job|copy)'/.test(call) && !/err\.status,\s*'unknown_job'/.test(call)) continue
        const before = text.slice(Math.max(0, m.index - 1200), m.index)
        sites.push(f)
        expect(before, `${f}: a 404 about an id with no run must count its repeats`).toMatch(/noteFinalAnswer\(/)
      }
    }
    // The known members: a job the host does not hold, a copy Walnut does not hold.
    expect(sites.sort()).toEqual(['host-copy.ts', 'host-exec-jobs.ts'])
  })

  it('a read and a stop of a job turn the host\'s unknown_job into the final answer', () => {
    const jobs = read('src/core/hosts/host-exec-jobs.ts')
    expect(jobs).toMatch(/return finalIfUnknown\(caller, host, String\(params\.job_id\), \(\) => readOnceKnown\(/)
    expect(jobs).toMatch(/err\.code === 'unknown_job' \? await unknownJob\(err, caller, host, String\(params\.job_id\), 'stop'\)/)
  })

  it('a daemon that stops ends the check runs it started (2026-11-23: orphaned runs got 403 session_only)', () => {
    // The whole runtime: the check runs are the trigger runs' (daemon-trigger-runs.ts).
    const text = daemonRuntimeText()
    const bodyOf = (name: string) => {
      const at = text.search(new RegExp(`\\nfunction ${name}\\(`))
      expect(at, name).toBeGreaterThan(0)
      return text.slice(at, text.indexOf('\n}\n', at))
    }
    // cleanup() stops the trigger runs, and that stop aborts the check runs' signal.
    expect(bodyOf('cleanup'), 'cleanup() must stop the trigger runs').toMatch(/triggerRuns\.stopTriggers\(\)/)
    expect(bodyOf('stopTriggers'), "cleanup() must abort the check runs' signal").toMatch(/demoTriggerChecks\.abort\(\)/)
    // The only signal every check run listens to is that one (checkRunFence): a new one would need its own abort here.
    expect(text.match(/signal: demoTriggerChecks\.signal|fence\.signal = demoTriggerChecks\.signal/g)?.length).toBe(1)
  })

  it('every route that answers a host refusal marks its repeats', () => {
    const dir = path.join(ROOT, 'src/web/routes')
    const routes = fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && /instanceof HostExecError/.test(fs.readFileSync(path.join(dir, n), 'utf8')))
    expect(routes.length).toBeGreaterThan(0)
    for (const r of routes) expect(fs.readFileSync(path.join(dir, r), 'utf8'), r).toMatch(/markHostRefusalRepeat\(req, res, err\)/)
  })

  it('a lost answer\'s hint says unknown_job is final and names the call that converges', () => {
    const [, , last] = lostRunLines('host_exec', { host: 'mac' }, 'hx-1234')
    expect(last).toContain('no later read finds it: stop reading, and send this host_exec call again with "job_id":"hx-1234", which runs it at most once')
  })
})
