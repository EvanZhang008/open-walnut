/**
 * The shared CLI loops on a host (walnut browser, pass, approve: wn-cli.ts gatewayOpCall) give the
 * daemon as long as a `walnut tools call` (cliWaitMs): a browser step that waits for the person
 * holds up to 25 s on the Mac, and the gateway's 20 s default cut it off (2026-11-16: an upload the
 * person approved came back "primary server timed out" on clouddev).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cliWaitMs } from '../../../src/providers/wn-cli.js'
import { GATEWAY_HUB_TIMEOUT_MS } from '../../../src/providers/gateway-core.js'

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/providers/wn-cli.ts'), 'utf8')

describe('the shared CLI loops wait as long as a tools call', () => {
  it('gatewayOpCall sends waitMs, with the socket open past it', () => {
    const body = SRC.slice(SRC.indexOf('function gatewayOpCall('), SRC.indexOf('/** `walnut pass` on a host'))
    expect(body).toMatch(/const waitMs = cliWaitMs\(\)/)
    expect(body).toMatch(/requestOverSocket\(socketPath, \{ v: 1, op: 'tools\.call', sid, args: \{[^}]*\}, waitMs \}, waitMs \+ 10_000\)/)
  })

  it('that wait is longer than a browser step holds for the person (25 s), the gateway default is not', () => {
    expect(cliWaitMs({})).toBeGreaterThan(25_000 + 5_000)
    expect(GATEWAY_HUB_TIMEOUT_MS).toBeLessThan(25_000)
  })
})
