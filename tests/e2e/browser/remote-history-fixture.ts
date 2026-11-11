/**
 * Fixture for session-history-remote.spec.ts: a stopped session whose archive files went to
 * remote storage (transcript-offload.ts), so the server boots with only its manifest on disk.
 * The storage is a fake S3 server in the fixture's own process (tests/helpers/fake-s3.ts) whose
 * downloads take a few seconds, long enough for the panel's loading line. Its credentials are a
 * fake profile in the fixture HOME's ~/.aws; the config names only that profile.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { offloadArchived, OFFLOAD_KEEP_MS } from '../../../src/providers/transcript-offload'
import { hostKeyPrefix, remoteStore, resolveRemote } from '../../../src/core/history-remote/store'
import type { FakeS3 } from '../../helpers/fake-s3'
import { writeArchivedHistory, type ArchivedIds } from './archived-history-fixture'

export const REMOTE_IDS: ArchivedIds = {
  sid: 'pw-remote-history-session', task: 'pw-task-remote-history', title: 'Remote history fixture task', dir: 'remote-history',
}
export const REMOTE_PROFILE = 'walnut-fixture-history'
/** How long the fake storage holds each download. */
export const REMOTE_GET_DELAY_MS = 3_500

export const remoteHistorySetting = (s3: FakeS3) => ({
  enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1', auth: { method: 'profile' as const, profile: REMOTE_PROFILE },
})

export async function writeRemoteHistory(tmpBase: string, s3: FakeS3): Promise<void> {
  await fs.mkdir(path.join(tmpBase, '.aws'), { recursive: true })
  await fs.writeFile(path.join(tmpBase, '.aws', 'credentials'),
    `[${REMOTE_PROFILE}]\naws_access_key_id = AKIAFIXTUREFIXTURE\naws_secret_access_key = fixture-secret\n`, { mode: 0o600 })
  await writeArchivedHistory(tmpBase, REMOTE_IDS)
  const r = resolveRemote(remoteHistorySetting(s3))
  const projects = [path.join(tmpBase, '.claude', 'projects')]
  const now = Date.now() + 400 * 86_400_000
  const opts = { olderThanMs: 180 * 86_400_000, keyPrefix: hostKeyPrefix(r, 'fixture-mac') }
  const up = await offloadArchived(projects, { ...opts, now, store: await remoteStore(r) })
  const off = await offloadArchived(projects, { ...opts, now: now + OFFLOAD_KEEP_MS, store: await remoteStore(r) })
  // Written before the other archived fixture session (test-server.ts), so this pass sees only this one.
  if (up.uploaded < 1 || off.offloaded < 1) throw new Error(`remote history fixture: expected an offloaded session, got ${JSON.stringify({ up, off })}`)
  s3.faults.getDelayMs = REMOTE_GET_DELAY_MS
}
