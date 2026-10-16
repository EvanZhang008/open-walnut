/**
 * The inbox copy accepts exactly the letter ids and body names the Mac's
 * store accepts (human-inbox/normalize.ts). Here the store's shapes are
 * widened: a copy that kept its own patterns would refuse the whole batch
 * (400 bad_rows) and the inbox copy would fail every round.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-inbox-shapes', { CLOUD_MODE: false }))
vi.mock('../../../../src/core/human-inbox/normalize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A future, longer id shape.
  LETTER_ID_RE: /^lt-[0-9a-z]{1,16}-[0-9a-z]{4,16}$/,
  BODY_FILE_RE: /^lt-[0-9a-z]{1,16}-[0-9a-z]{4,16}(?:\.r\d{1,4})?\.(?:html|md)$/,
}))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { _resetInboxCopyForTesting, inboxBodiesFollower, inboxFollower } from '../../../../src/core/replication/kinds/inbox.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
const WIDE = 'lt-abcdefghijklmn-abcdefghijklmn'

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  _resetInboxCopyForTesting()
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the inbox copy\'s shapes', () => {
  it('are the store\'s: a letter id and a body name the store accepts are stored', async () => {
    const letter = { id: WIDE, type: 'report', title: 'Wide id', createdAt: '2026-10-15T08:00:00.000Z', read: false }
    expect(await inboxFollower().put({ rows: [letter], last: true })).toMatchObject({ ok: true, stored: 1 })
    const index = JSON.parse(await fsp.readFile(path.join(WALNUT_HOME, 'human-inbox', 'index.json'), 'utf8')) as { letters: Array<{ id: string }> }
    expect(index.letters.map((l) => l.id)).toEqual([WIDE])
    expect(await inboxBodiesFollower().put({ rows: [{ name: `${WIDE}.md`, body: 'Hello' }], last: true })).toMatchObject({ ok: true, stored: 1 })
    expect(await fsp.readFile(path.join(WALNUT_HOME, 'human-inbox', 'bodies', `${WIDE}.md`), 'utf8')).toBe('Hello')
  })
})
