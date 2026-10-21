/**
 * The WP5 copy kinds (routines, conversations, prefs, config) live only on a host
 * running the replica program (docs/plan/walnut-replica-servers-impl.md, WP4 "as
 * built", kinds/index.ts copyKeepersOnly). The leader (the Mac) and the plain host
 * server answer every step of them `404 unknown_kind`, any op, any schema, exactly
 * as for a kind nobody registered, and write nothing; on the leader getConfig(),
 * the routines list and the conversation list read the Mac's own files. The
 * companion's answer is pinned by tests/web/routes/bridge-replica-cloud.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-wp5-gate', { CLOUD_MODE: false }))

import { CONFIG_FILE, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting, isHostReplica, isHostReplicaProgram } from '../../../../src/core/server-role.js'
import { followerStep } from '../../../../src/core/replication/kind-follower.js'
import { registerCopyFollowerKinds, copyKinds } from '../../../../src/core/replication/kinds/index.js'
import { COPY_KIND_NAMES, DEFAULT_COPY_CHOICE, copyChoiceFrom } from '../../../../src/core/replication/kinds/copy-kind.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
const WP5 = ['routines', 'conversations', 'prefs', 'config']
/** WP12's copy (the Ask personas), kept on a host replica only, like the WP5 ones. */
const HOST_ONLY = [...WP5, 'personas']
const BODIES: Array<Record<string, unknown>> = [
  { op: 'status', digest: '0.0' },
  { op: 'sync', entries: [{ k: 'ui', h: 'aaaaaaaaaaaa' }], asOf: 1, schemaVersion: 99 },
  { op: 'put', rows: [{ key: 'ui', value: { session_panels: 'auto' } }, { id: 'rt-1', job: { id: 'rt-1' }, status: {} }, { agent: 'general', meta: { id: 'conv-acme-1', title: 'Acme', createdAt: '2026-10-01T00:00:00.000Z', lastMessageAt: '2026-10-01T00:00:00.000Z' } }], last: true, schemaVersion: 1 },
  { op: 'purge' },
]

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  registerCopyFollowerKinds()
})

afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

function nothingWritten(): void {
  expect(fs.existsSync(path.join(WALNUT_HOME, 'cache', 'replica'))).toBe(false)
  expect(fs.existsSync(path.join(WALNUT_HOME, 'cron-jobs.json'))).toBe(false)
  expect(fs.existsSync(path.join(WALNUT_HOME, 'conversations'))).toBe(false)
}

describe('the WP5 kinds are registered and chosen like the WP4 ones', () => {
  it('each is a leader kind, a confirmable name, and on by default in the host choice', () => {
    expect(copyKinds().map((k) => k.kind)).toEqual(['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies', ...HOST_ONLY])
    for (const k of HOST_ONLY) expect(COPY_KIND_NAMES).toContain(k)
    expect(DEFAULT_COPY_CHOICE).toMatchObject({ routines: true, conversations: true, prefs: true, config: true, personas: true })
    expect(copyChoiceFrom({ config: false, prefs: 'no' })).toMatchObject({ config: false, prefs: true })
  })
})

describe('off a host replica', () => {
  it('the leader answers 404 unknown_kind for each WP5 kind, and reads its own files', async () => {
    for (const k of ENV) delete process.env[k]
    _resetServerRoleForTesting()
    expect(isHostReplica()).toBe(false)
    for (const kind of HOST_ONLY) for (const body of BODIES) {
      expect([kind, body.op, await followerStep({ ...body, kind })]).toEqual([kind, body.op, { ok: false, status: 404, error: 'unknown_kind' }])
    }
    nothingWritten()
    await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'Marina' }, providers: { acme: { type: 'openai' } } }))
    const { getConfig } = await import('../../../../src/core/config-manager.js')
    const c = await getConfig()
    expect(c.user.name).toBe('Marina')
    expect(c.providers).toEqual({ acme: { type: 'openai' } })
    await fsp.rm(CONFIG_FILE)
  })

  it('the plain host server (WALNUT_HOST_SERVER=1 alone) keeps none of them either', async () => {
    delete process.env.WALNUT_ROLE
    delete process.env.WALNUT_PLACEMENT
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    expect([isHostReplica(), isHostReplicaProgram()]).toEqual([true, false])
    for (const kind of HOST_ONLY) for (const body of BODIES) {
      expect([kind, body.op, await followerStep({ ...body, kind })]).toEqual([kind, body.op, { ok: false, status: 404, error: 'unknown_kind' }])
    }
    nothingWritten()
  })
})
