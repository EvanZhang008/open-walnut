/**
 * Ratchet: every memory and skill write route the Mac mounts (routes/memory.ts,
 * routes/skills.ts) is one the companion carries to the Mac while it answers (policy.ts
 * CONSOLE_COPY_WRITES), so a change made on the box goes to the Mac instead of failing
 * there with needs-the-Mac while the Mac is up. A write route added later fails here until
 * it is listed on purpose (or named below as one the box answers itself).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-copy-writes-ratchet'))

import { memoryRouter } from '../../../src/web/routes/memory.js'
import { createSkillsRouter } from '../../../src/web/routes/skills.js'
import { parseConsoleCopyCall } from '../../../src/web/v1-forward/policy.js'

interface RouteLayer { route?: { path: unknown; methods?: Record<string, boolean> } }

function writeRoutes(router: Router, prefix: string): string[] {
  const out: string[] = []
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue
    for (const [m, on] of Object.entries(layer.route.methods ?? {})) {
      const method = m.toUpperCase()
      if (!on || method === 'GET' || method === 'HEAD') continue
      out.push(`${method} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`)
    }
  }
  return out.sort()
}

const sample = (route: string): string => route.replace(/:[A-Za-z]+/g, 'acme-tool')

describe('ratchet: memory and skill writes go to the Mac from the companion', () => {
  const routes = [...writeRoutes(memoryRouter, '/api/memory'), ...writeRoutes(createSkillsRouter(), '/api/skills')].sort()

  it('the write routes are exactly the expected ones', () => {
    expect(routes).toEqual([
      'DELETE /api/skills/:dirName', 'PATCH /api/skills/:dirName', 'POST /api/memory/daily-log/compact', 'POST /api/skills',
      'PUT /api/memory/global', 'PUT /api/memory/user', 'PUT /api/skills/:dirName',
    ])
  })

  it.each(routes.map((r) => [r]))('%s is carried to the Mac', (r) => {
    const [method, route] = r.split(' ') as [string, string]
    expect(parseConsoleCopyCall(method, sample(route))?.pathname).toBe(sample(route))
  })

  it('a path that only begins like one is not', () => {
    for (const [m, u] of [
      ['POST', '/api/memory/daily-log/compact/x'], ['PUT', '/api/memory/knowledge/a.md'], ['DELETE', '/api/memory/global'],
      ['POST', '/api/skills/acme-tool'], ['PUT', '/api/skills/acme-tool/references/a.md'], ['POST', '/api/memory/daily-log/compact?x=1'],
    ]) expect([m, u, parseConsoleCopyCall(m, u)]).toEqual([m, u, null])
  })
})
