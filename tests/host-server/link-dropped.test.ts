/**
 * A read whose stream closed because the link under it dropped goes to the same
 * target once more (src/host-server/proxy.ts isLinkDropped). 2026-10-31: the
 * Mac's stream lane was stopped as a read went out; the daemon had routed the
 * read to the lane and closed it, and the browser read "Neither your Mac nor
 * your cloud companion is answering" while the Mac's session link was up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLinkDropped, LINK_DROPPED } from '../../src/host-server/proxy.js'

const SRC = path.resolve(import.meta.dirname, '../../src')
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8')

describe('a stream whose link dropped', () => {
  it('is told by the words the daemon\'s relay closes it with', () => {
    // The relay and the check must say the same words, or every such read is lost again.
    expect(read('providers/stream-relay-core.ts')).toContain(`'${LINK_DROPPED}'`)
    expect(isLinkDropped(new Error(`stream closed: ${LINK_DROPPED}`))).toBe(true)
    expect(isLinkDropped(new Error('the Mac is not linked to this host'))).toBe(false)
    expect(isLinkDropped(undefined)).toBe(false)
  })

  it('both fronts that forward a read send it again once (the host server and a host replica)', () => {
    for (const f of ['host-server/main.ts', 'replica/dispatch.ts']) {
      expect(read(f), f).toMatch(/!again && isLinkDropped\(err\)/)
    }
  })
})
