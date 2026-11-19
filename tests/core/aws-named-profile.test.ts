/**
 * A storage setting that says "sign in with a named AWS profile" but names none still signs in
 * as it always did (the SDK's default profile), so a working setup keeps working, and its
 * failures say the setting names no profile and where to name one (2026-11-19: Backup and the
 * remote history tier both read [default], whose stale token every run then reported only as
 * "The provided token is malformed"). The class: every place that builds profile credentials.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { namedProfileCredentials, unnamedProfileHint } from '../../src/core/aws-named-profile.js'
import { resolveRemote } from '../../src/core/history-remote/store.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('a named-profile setting with no name', () => {
  it('signs in as before, and its failures name the setting and the fix', () => {
    expect(typeof namedProfileCredentials(undefined)).toBe('function')
    expect(typeof namedProfileCredentials('p1')).toBe('function')
    expect(unnamedProfileHint({ method: 'profile' }, 'Backup')).toMatch(/Backup is set to sign in with an AWS profile but names none, so it used the default AWS credentials: name the profile in its settings/)
    expect(unnamedProfileHint({ method: 'profile', profile: '  ' }, 'Backup')).not.toBe('')
    expect(unnamedProfileHint({ method: 'profile', profile: 'p1' }, 'Backup')).toBe('')
    expect(unnamedProfileHint({ method: 'aws_chain' }, 'Backup')).toBe('')
    expect(unnamedProfileHint(undefined, 'Backup')).toBe('')
  })

  it('remote history: no name signs in with the default chain, as before', () => {
    expect(resolveRemote({ enabled: true, bucket: 'b', auth: { method: 'profile' } }).auth).toEqual({ method: 'aws_chain' })
    expect(resolveRemote({ enabled: true, bucket: 'b', auth: { method: 'profile', profile: 'p1' } }).auth).toEqual({ method: 'profile', profile: 'p1' })
  })

  it('both storage failures carry the hint', () => {
    expect(read('src/core/backup/s3-backup.ts')).toMatch(/unnamedProfileHint\(cfg\.auth, 'Backup'\)[\s\S]{0,80}backup: run failed/)
    const svc = read('src/core/history-remote/service.ts')
    expect(svc.match(/unnamedProfileHint\(setting\?\.auth, 'Remote history storage'\)/g)).toHaveLength(2)
  })

  it('every profile sign-in in the source goes through namedProfileCredentials', () => {
    const allowed = new Set([
      'src/core/aws-named-profile.ts',
      // Its profile always carries a name (credential-resolver.ts sets it from AWS_PROFILE or the setting).
      'src/core/credential-verify.ts',
    ])
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name) && /\bfromIni\(/.test(read(rel))) hits.push(rel)
      }
    }
    walk('src')
    expect(hits.filter((h) => !allowed.has(h))).toEqual([])
  })
})
