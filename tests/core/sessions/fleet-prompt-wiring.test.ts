/**
 * The session prompt carries the host line (core/hosts/fleet-prompt.ts) as
 * state: present in the spawn prompt, absent from the default instructions, so
 * a change of hosts never reaches a running session as an instruction notice.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('fleet-prompt-wiring'))
vi.mock('../../../src/core/hosts/fleet-prompt.js', () => ({
  buildFleetPromptLine: async (host: string | undefined) => `Hosts: test line for ${host ?? 'none'}\n\n`,
}))

import { buildSessionContext, defaultInstructions } from '../../../src/core/sessions/session-context.js'

describe('the host line in the session prompt', () => {
  it('rides the spawn prompt for the session\'s host and stays out of the default instructions', async () => {
    const { systemPrompt } = await buildSessionContext('', undefined, 'devbox')
    expect(systemPrompt).toContain('Hosts: test line for devbox')
    expect(defaultInstructions({})).not.toContain('Hosts: test line')
  })
})
