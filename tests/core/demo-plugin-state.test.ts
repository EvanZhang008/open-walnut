import { describe, expect, it, vi } from 'vitest'
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'
import { safeActionError } from '../../examples/plugins/walnut-demo/src/server/actions.js'
import { DemoServerState } from '../../examples/plugins/walnut-demo/src/server/state.js'

interface PersistedState {
  counters: Record<string, number>
  demoTaskId: string | null
}

function sharedStorage() {
  let persisted: PersistedState | undefined
  let tail = Promise.resolve()
  const updateJson = vi.fn(<T>(
    _name: string,
    fallback: T,
    update: (current: T) => T | Promise<T>,
  ): Promise<T> => {
    const run = tail.then(async () => {
      const current = structuredClone((persisted ?? fallback) as T)
      const next = await update(current)
      persisted = structuredClone(next as PersistedState)
      return structuredClone(next)
    })
    tail = run.then(() => undefined, () => undefined)
    return run
  })
  const api = {
    storage: {
      updateJson,
      writeJson: vi.fn(() => { throw new Error('writeJson must not be used for shared state') }),
    },
    log: { warn: vi.fn() },
  } as unknown as WalnutServerApi
  return { api, updateJson, read: () => structuredClone(persisted) }
}

describe('Demo Plugin state', () => {
  it('merges concurrent counter deltas without overwriting task ownership', async () => {
    const storage = sharedStorage()
    const first = new DemoServerState(storage.api)
    const second = new DemoServerState(storage.api)
    await Promise.all([first.load(), second.load()])

    first.setDemoTaskId('demo-task')
    first.bump('runs', 2)
    second.bump('events', 3)
    await Promise.all([first.flush(), second.flush()])

    expect(storage.read()).toMatchObject({
      demoTaskId: 'demo-task',
      counters: { activations: 2, runs: 2, events: 3 },
    })
    expect(storage.updateJson).toHaveBeenCalledTimes(4)
  })

  it('never returns a host path from an unexpected action failure', () => {
    const message = safeActionError(
      'storage-roundtrip',
      new Error('ENOENT: /Users/example/.open-walnut/plugin-data/walnut-demo/state.json'),
    )

    expect(message).toBe('storage-roundtrip failed. Check Walnut logs for details.')
    expect(message).not.toContain('/Users/')
  })
})
