/**
 * The cloud box's next steps never name the companion's address (gate links P5:
 * a host error shows no URL, and the folder picker shows the hint as it is).
 * Each still says where to look: the Cloud Companion section of Settings ›
 * Phones & Cloud, which is where the address is shown.
 */
import { describe, expect, it } from 'vitest'
import { classifyHostConnectError, hintForKind } from '../../../src/core/sessions/host-connect-hint.js'
import { CLOUD_BOX_HOST_LABEL } from '../../../src/core/hosts/cloud-box-host.js'

const PLACE = 'Settings › Phones & Cloud › Cloud Companion'
const CLOUD_KINDS = ['cloud_update', 'cloud_exec_off', 'cloud_other_mac', 'cloud_tunnel'] as const

/** Each hostname, and the parts of it a hint must not carry either. */
const HOSTNAMES: Array<{ hostname: string; parts: string[] }> = [
  { hostname: '127.0.0.1:54591', parts: ['127.0.0.1', '54591'] },
  { hostname: 'https://companion.example.test', parts: ['https://', 'companion.example.test'] },
  { hostname: 'companion.example.test', parts: ['companion.example.test'] },
]

describe('the cloud box hints name no companion address', () => {
  for (const { hostname, parts } of HOSTNAMES) {
    for (const kind of CLOUD_KINDS) {
      it(`${kind}, hostname ${hostname}`, () => {
        const hint = hintForKind(kind, hostname, { label: CLOUD_BOX_HOST_LABEL, hostname })
        expect(hint.trim().length).toBeGreaterThan(0)
        expect(hint).toContain(PLACE)
        expect(hint).not.toContain(hostname)
        for (const p of parts) expect(hint).not.toContain(p)
      })
    }
  }

  it('the path the folder picker takes (a tunnel failure, classified) names no address either', () => {
    const hostname = '127.0.0.1:54591'
    const out = classifyHostConnectError(
      'Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET (host=Cloud, url=ws://127.0.0.1:54591/daemon-tunnel)',
      hostname, ['__cloudbox__', CLOUD_BOX_HOST_LABEL, hostname], { label: CLOUD_BOX_HOST_LABEL, hostname },
    )
    expect(out.kind).toBe('cloud_tunnel')
    expect(out.hint).toContain(PLACE)
    expect(out.hint).not.toContain('127.0.0.1')
    expect(out.hint).not.toContain('54591')
  })
})
