/**
 * Switching the experiment host_service_sets on starts the look at every connected host at once
 * (watchServiceSetsSwitch), instead of at each host's next connect (the cutover runbook's step 1
 * asked whether it did). Off to on only; staying on, or switching off, looks at nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const looks = vi.fn()
vi.mock('../../src/providers/daemon-connection.js', () => ({ lookAtServiceSetsOnAllHosts: () => looks() }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { watchServiceSetsSwitch } from '../../src/providers/service-set-leader.js'

const settle = () => new Promise((r) => setTimeout(r, 30))
const changed = async () => { bus.emit(EventNames.CONFIG_CHANGED, { key: 'experimental' }, ['web-ui'], { source: 'test' }); await settle() }

describe('the service sets switch', () => {
  const prior = process.env.WALNUT_HOST_SERVICE_SETS
  afterEach(() => {
    if (prior === undefined) delete process.env.WALNUT_HOST_SERVICE_SETS
    else process.env.WALNUT_HOST_SERVICE_SETS = prior
    looks.mockClear()
  })

  it('off to on looks at every host once; on again, other config edits and off look at nothing', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const stop = watchServiceSetsSwitch()
    await settle()
    await changed()
    expect(looks).not.toHaveBeenCalled()
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await changed()
    expect(looks).toHaveBeenCalledTimes(1)
    await changed()
    expect(looks).toHaveBeenCalledTimes(1)
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    await changed()
    expect(looks).toHaveBeenCalledTimes(1)
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await changed()
    expect(looks).toHaveBeenCalledTimes(2)
    stop()
  })
})
