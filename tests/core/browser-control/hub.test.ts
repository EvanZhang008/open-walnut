/**
 * core/browser-control/hub.ts: the relay between an agent's command and the person's browser.
 * A command waits for the extension's poll, the answer comes only from the browser it went to,
 * a lost browser fails what waits on it, and tab owners come back from the extension's report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as hub from '../../../src/core/browser-control/hub'

const info = (device = 'extension-aaaaaa', extra: Partial<hub.ControllerInfo> = {}): hub.ControllerInfo => ({ device, label: 'Walnut extension (Chrome on Mac)', browser: 'chrome', version: '1', caps: [], ...extra })
const ALLOW = { any: false, sites: ['example.test'] }

afterEach(() => { hub._resetBrowserHubForTesting(); vi.useRealTimers() })

describe('browser hub', () => {
  it('a command reaches a waiting poll, and its answer comes back to the sender', async () => {
    const polled = hub.poll(info(), 5000)
    const done = hub.send('extension-aaaaaa', 'snapshot', { tab: 3 }, ALLOW)
    const cmds = await polled
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ action: 'snapshot', args: { tab: 3 }, allow: ALLOW })
    // Another browser cannot answer it.
    expect(hub.answer('extension-bbbbbb', cmds[0].id, true, { snapshot: 'forged' })).toBe(false)
    expect(hub.answer('extension-aaaaaa', cmds[0].id, true, { snapshot: 'ok' })).toBe(true)
    await expect(done).resolves.toEqual({ snapshot: 'ok' })
  })

  it('a command sent between polls waits in the queue for the next one', async () => {
    const first = hub.poll(info(), 10)
    await first
    const done = hub.send('extension-aaaaaa', 'tabs', {}, ALLOW)
    const cmds = await hub.poll(info(), 5000)
    expect(cmds.map((c) => c.action)).toEqual(['tabs'])
    hub.answer('extension-aaaaaa', cmds[0].id, false, undefined, { message: 'no', code: 'not_your_tab' })
    await expect(done).rejects.toMatchObject({ code: 'not_your_tab', status: 403 })
  })

  it('a browser that does not answer in time times the command out', async () => {
    vi.useFakeTimers()
    void hub.poll(info(), 25_000)
    const done = hub.send('extension-aaaaaa', 'wait', {}, ALLOW, 1000)
    const check = expect(done).rejects.toMatchObject({ code: 'browser_timeout' })
    await vi.advanceTimersByTimeAsync(1100)
    await check
  })

  it('a second poll takes over from the first; a disconnect fails what waits', async () => {
    const one = hub.poll(info(), 5000)
    const two = hub.poll(info(), 5000)
    await expect(one).resolves.toEqual([])
    const done = hub.send('extension-aaaaaa', 'open', { url: 'http://a.example.test/' }, ALLOW)
    expect((await two).length).toBe(1)
    hub.disconnect('extension-aaaaaa')
    await expect(done).rejects.toMatchObject({ code: 'browser_off' })
    expect(hub.connected()).toEqual([])
    // It left on purpose: the next command says so at once.
    expect(() => hub.pickController()).toThrow(/turned agents off/)
  })

  it('a browser the person disconnected: what waits fails, the next command fails at once and says so', async () => {
    const polled = hub.poll(info(), 5000)
    const done = hub.send('extension-aaaaaa', 'text', { tab: 3 }, ALLOW)
    await polled
    hub.disconnect('extension-aaaaaa', 'disconnected')
    await expect(done).rejects.toMatchObject({ code: 'browser_disconnected' })
    expect(hub.lastGone()).toMatchObject({ label: 'Walnut extension (Chrome on Mac)', why: 'disconnected' })
    let err: unknown
    try { hub.pickController() } catch (e) { err = e }
    expect(err).toMatchObject({ code: 'browser_disconnected', status: 409 })
    expect((err as Error).message).toContain('disconnected this browser from Walnut')
    // No wait for a poll that will not come.
    const t = Date.now()
    await hub.waitConnected(3000)
    expect(Date.now() - t).toBeLessThan(500)
    // Connected again: nothing of it is left.
    void hub.poll(info(), 10)
    expect(hub.lastGone()).toBeUndefined()
    expect(hub.pickController().device).toBe('extension-aaaaaa')
  })

  it('a browser never connected is not named as gone', () => {
    expect(hub.lastGone()).toBeUndefined()
    hub.disconnect('extension-never')
    expect(hub.lastGone()).toBeUndefined()
    expect(() => hub.pickController()).toThrow(/turns it on/)
  })

  it('tab owners: set at open, read back, restored from the extension\'s report', async () => {
    void hub.poll(info(), 10)
    hub.ownTab('extension-aaaaaa', 7, 'task:t1')
    hub.ownTab('extension-aaaaaa', 8, 'task:t2')
    expect(hub.tabsOf('extension-aaaaaa', 'task:t1')).toEqual([7])
    expect(hub.tabOwner('extension-aaaaaa', 8)).toBe('task:t2')
    hub._resetBrowserHubForTesting()
    // A restarted server: the next poll says which tabs are whose.
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 7, owner: 'task:t1' }] }), 10)
    expect(hub.tabsOf('extension-aaaaaa', 'task:t1')).toEqual([7])
    expect(hub.tabOwner('extension-aaaaaa', 8)).toBeUndefined()
  })

  it('a report read before an open\'s result keeps the new tab; one a minute later drops it', async () => {
    vi.useFakeTimers()
    void hub.poll(info('extension-aaaaaa', { tabs: [] }), 10)
    hub.ownTab('extension-aaaaaa', 9, 'task:t1')
    void hub.poll(info('extension-aaaaaa', { tabs: [] }), 10)
    expect(hub.tabOwner('extension-aaaaaa', 9)).toBe('task:t1')
    await vi.advanceTimersByTimeAsync(61_000)
    void hub.poll(info('extension-aaaaaa', { tabs: [] }), 10)
    expect(hub.tabOwner('extension-aaaaaa', 9)).toBeUndefined()
  })

  it('a tab a report listed and a later report lacks is gone at once, not after the grace', async () => {
    // The extension took a tab and let go of it (Walnut's own page): its next report lacks it. An
    // agent's next step with no tab must not be asked "which tab" between the one left and that one.
    vi.useFakeTimers()
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 1, owner: 'agent' }, { id: 2, owner: 'agent' }] }), 10)
    expect(hub.tabsOf('extension-aaaaaa', 'agent').sort()).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(1_000)
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 1, owner: 'agent' }] }), 10)
    expect(hub.tabsOf('extension-aaaaaa', 'agent')).toEqual([1])
    // A tab known from an open's answer alone still waits out the grace.
    hub.ownTab('extension-aaaaaa', 3, 'agent')
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 1, owner: 'agent' }] }), 10)
    expect(hub.tabsOf('extension-aaaaaa', 'agent').sort()).toEqual([1, 3])
    // Once a report has listed it, the same rule holds for it.
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 1, owner: 'agent' }, { id: 3, owner: 'agent' }] }), 10)
    void hub.poll(info('extension-aaaaaa', { tabs: [{ id: 1, owner: 'agent' }] }), 10)
    expect(hub.tabsOf('extension-aaaaaa', 'agent')).toEqual([1])
  })

  it('the extension saying a tab is not the agent\'s any more releases it', async () => {
    const polled = hub.poll(info(), 5000)
    hub.ownTab('extension-aaaaaa', 4, 'task:t1')
    const done = hub.send('extension-aaaaaa', 'snapshot', { tab: 4 }, ALLOW)
    const [cmd] = await polled
    hub.answer('extension-aaaaaa', cmd.id, false, undefined, { message: 'Stop', code: 'not_your_tab' })
    await expect(done).rejects.toMatchObject({ code: 'not_your_tab', status: 403 })
    expect(hub.tabOwner('extension-aaaaaa', 4)).toBeUndefined()
  })

  it('a poll whose client went away hands nothing to it; what it took goes to the next poll', async () => {
    const gone = hub.poll(info(), 5000)
    hub.dropPoll('extension-aaaaaa', gone)
    await expect(gone).resolves.toEqual([])
    // A browser whose poll went away is not connected until it polls again.
    expect(hub.connected()).toEqual([])
    const done = hub.send('extension-aaaaaa', 'tabs', {}, ALLOW)
    const taken = await hub.poll(info(), 5000)
    hub.requeue('extension-aaaaaa', taken)
    const again = await hub.poll(info(), 5000)
    expect(again.map((c) => c.id)).toEqual(taken.map((c) => c.id))
    hub.answer('extension-aaaaaa', again[0].id, true, { tabs: [] })
    await expect(done).resolves.toEqual({ tabs: [] })
    // Connected browsers carry no tab owners.
    expect(JSON.stringify(hub.connected())).not.toContain('owner')
  })

  it('finds the browser holding an owner\'s tab', async () => {
    void hub.poll(info('extension-aaaaaa'), 10)
    void hub.poll(info('extension-bbbbbb'), 10)
    hub.ownTab('extension-aaaaaa', 3, 'task:t1')
    hub.ownTab('extension-bbbbbb', 3, 'task:t2')
    expect(hub.deviceForTab('task:t1', 3)).toBe('extension-aaaaaa')
    expect(hub.deviceForTab('task:t2')).toBe('extension-bbbbbb')
    expect(hub.deviceForTab('task:t1', 4)).toBeUndefined()
  })

  it('picks the named browser, else the most recent', async () => {
    void hub.poll(info('extension-aaaaaa'), 10)
    await new Promise((r) => setTimeout(r, 5))
    void hub.poll(info('extension-bbbbbb', { label: 'Walnut extension (Firefox on Mac)', browser: 'firefox' }), 10)
    expect(hub.pickController().device).toBe('extension-bbbbbb')
    expect(hub.pickController('Walnut extension (Chrome on Mac)').device).toBe('extension-aaaaaa')
    expect(() => hub.pickController('extension-cccccc')).toThrow(/No browser named/)
  })
})
