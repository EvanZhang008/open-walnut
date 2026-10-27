/**
 * A test window (web/src/api/test-run.ts): which page is one, the header its API calls carry
 * (web/src/api/auth-fetch.ts), and how it holds a test run's task. 2026-10-27: an Org chart
 * acceptance run driven by Playwright put its tasks and projects on the user's live board.
 */
import { describe, it, expect } from 'vitest'
import { decideTestRun, forThisWindow, TEST_RUN_HEADER, TEST_RUN_OWNER } from '@/api/test-run'
import { initWithTestRun } from '@/api/auth-fetch'

const PAGE = 'http://localhost:3456/'

describe('decideTestRun', () => {
  it('a person\'s window is not one; an automated one is', () => {
    expect(decideTestRun(PAGE, null, false)).toEqual({ label: null, store: undefined })
    expect(decideTestRun(PAGE, null, true)).toEqual({ label: 'webdriver', store: undefined })
  })

  it('?walnut-test-run=<label> starts one for the tab, =0 ends it', () => {
    expect(decideTestRun(`${PAGE}?walnut-test-run=org%20chart`, null, false)).toEqual({ label: 'org chart', store: 'org chart' })
    expect(decideTestRun(PAGE, 'org chart', false)).toEqual({ label: 'org chart', store: undefined })
    expect(decideTestRun(`${PAGE}?walnut-test-run=0`, 'org chart', false)).toEqual({ label: null, store: '0' })
  })

  it('=0 turns an automated tab off too, and it stays off for the tab', () => {
    // A demo an agent records for the user in an automated browser is real work.
    expect(decideTestRun(`${PAGE}?walnut-test-run=0`, null, true)).toEqual({ label: null, store: '0' })
    expect(decideTestRun(PAGE, '0', true)).toEqual({ label: null, store: undefined })
    expect(decideTestRun(`${PAGE}?walnut-test-run=again`, '0', true)).toEqual({ label: 'again', store: 'again' })
  })
})

describe('initWithTestRun', () => {
  it('adds the header to same-origin /api/ calls only, and never overrides one', () => {
    const init = initWithTestRun('/api/tasks', { method: 'POST' }, PAGE, 'probe')
    expect(new Headers(init!.headers).get(TEST_RUN_HEADER)).toBe('probe')
    expect(init!.method).toBe('POST')
    expect(initWithTestRun('/assets/x.js', undefined, PAGE, 'probe')).toBeNull()
    expect(initWithTestRun('https://example.com/api/tasks', undefined, PAGE, 'probe')).toBeNull()
    expect(initWithTestRun('/api/tasks', undefined, PAGE, null)).toBeNull()
    expect(initWithTestRun('/api/tasks', { headers: { [TEST_RUN_HEADER]: 'mine' } }, PAGE, 'probe')).toBeNull()
  })

  it('keeps the headers already on the call (the device token)', () => {
    const init = initWithTestRun('/api/tasks', { headers: { Authorization: 'Bearer t' } }, PAGE, 'probe')
    const headers = new Headers(init!.headers)
    expect(headers.get('Authorization')).toBe('Bearer t')
    expect(headers.get(TEST_RUN_HEADER)).toBe('probe')
  })
})

describe('forThisWindow', () => {
  it('a test window holds a test task unmarked; a person\'s window and other kept tasks are untouched', () => {
    const t = { id: 'a', plugin_only: TEST_RUN_OWNER }
    expect(forThisWindow(t, 'probe').plugin_only).toBeUndefined()
    expect(forThisWindow(t, null)).toBe(t)
    const plugin = { id: 'b', plugin_only: 'keeper' }
    expect(forThisWindow(plugin, 'probe')).toBe(plugin)
  })
})
