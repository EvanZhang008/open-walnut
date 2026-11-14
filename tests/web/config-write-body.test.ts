/**
 * updateConfigKeys (web/src/api/config.ts): write some keys of one config section and
 * leave the rest alone, on any server. A server that says it merges gets only those
 * keys, marked, with `undefined` sent as null (JSON drops undefined); an older server
 * or a replica gets the section read fresh with the keys over it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }))
vi.mock('../../web/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api/client')>()
  return { ...actual, apiGet: mocks.apiGet, apiPut: mocks.apiPut }
})

import { _resetServerFactsForTest, configMergeBody, updateConfigKeys } from '../../web/src/api/config'

const STORED = { ui: { show_priority: true, session_panels: 2, shortcuts: { a: 'b' } } }

beforeEach(() => {
  _resetServerFactsForTest()
  mocks.apiGet.mockReset()
  mocks.apiPut.mockReset()
  mocks.apiPut.mockResolvedValue({ ok: true })
})

describe('configMergeBody', () => {
  it('sends an undefined key as null and leaves the values as they are', () => {
    expect(JSON.parse(JSON.stringify(configMergeBody('ui', { taskbar_leaving: undefined, session_panels: 3, deep: { x: undefined } }))))
      .toEqual({ ui: { taskbar_leaving: null, session_panels: 3, deep: {} } })
  })
})

describe('updateConfigKeys', () => {
  it('a server that merges gets only the keys, marked', async () => {
    mocks.apiGet.mockResolvedValue({ config: STORED, role: 'leader', configWrites: 'merge' })
    await updateConfigKeys('ui', { session_panels: 3, taskbar_leaving: undefined } as never)
    expect(mocks.apiPut).toHaveBeenCalledTimes(1)
    const [, body, opts] = mocks.apiPut.mock.calls[0]
    expect(JSON.parse(JSON.stringify(body))).toEqual({ ui: { session_panels: 3, taskbar_leaving: null } })
    expect(opts).toEqual({ headers: { 'x-walnut-config-write': 'merge' } })
  })

  it('an older server gets the section read fresh with the keys over it, unmarked', async () => {
    mocks.apiGet.mockResolvedValue({ config: STORED, role: 'leader' })
    await updateConfigKeys('ui', { session_panels: 3 } as never)
    const [, body, opts] = mocks.apiPut.mock.calls[0]
    expect(body).toEqual({ ui: { show_priority: true, session_panels: 3, shortcuts: { a: 'b' } } })
    expect(opts).toBeUndefined()
  })

  it('a replica (its writes go on to a Mac of any version) gets the whole section too', async () => {
    mocks.apiGet.mockResolvedValue({ config: STORED, role: 'replica', configWrites: 'merge' })
    await updateConfigKeys('ui', { show_priority: false } as never)
    const [, body, opts] = mocks.apiPut.mock.calls[0]
    expect(body).toEqual({ ui: { show_priority: false, session_panels: 2, shortcuts: { a: 'b' } } })
    expect(opts).toBeUndefined()
  })
})
