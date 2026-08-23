import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetActionsForTesting,
  getAction,
  listActions,
  registerAction,
  registerOwnedAction,
  runAction,
  unregisterOwnedActions,
} from '../../src/core/cron/actions.js'

afterEach(() => _resetActionsForTesting())

describe('owner-scoped cron actions', () => {
  it('removes a plugin action when its disposable is released', async () => {
    const run = vi.fn(async () => ({ status: 'ok' as const, summary: 'done' }))
    const registration = registerOwnedAction('plugin-a', 'plugin-a:collect', run, 'Collect data')

    expect(listActions()).toEqual([{ id: 'plugin-a:collect', description: 'Collect data' }])
    expect((await runAction('plugin-a:collect', {})).status).toBe('ok')

    registration.dispose()

    expect(getAction('plugin-a:collect')).toBeUndefined()
    expect((await runAction('plugin-a:collect', {})).status).toBe('error')
    expect(run).toHaveBeenCalledOnce()
  })

  it('removes all contributions from one owner without touching another', () => {
    registerOwnedAction('plugin-a', 'plugin-a:first', async () => ({ status: 'ok' }), 'First')
    registerOwnedAction('plugin-a', 'plugin-a:second', async () => ({ status: 'ok' }), 'Second')
    registerOwnedAction('plugin-b', 'plugin-b:first', async () => ({ status: 'ok' }), 'Other')

    expect(unregisterOwnedActions('plugin-a')).toBe(2)
    expect(listActions()).toEqual([{ id: 'plugin-b:first', description: 'Other' }])
  })

  it('preserves the core overwrite behavior', async () => {
    const stale = registerAction('screenshot', async () => ({ status: 'ok', summary: 'old' }), 'Old')
    registerAction('screenshot', async () => ({ status: 'ok', summary: 'new' }), 'New')

    stale.dispose()

    expect((await runAction('screenshot', {})).summary).toBe('new')
  })
})
