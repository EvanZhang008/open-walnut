/**
 * A failed host read that is only the host being away logs at info, never warn.
 *
 * boundHostRead/boundSharedHostRead answer a read degraded with a
 * HostReconnectingError while the host is not answering, and log why at info.
 * A caller that logs that error again at warn turns an outage into a flood of
 * warnings: on 2026-11-14 a dev host signed out for hours made the slash-command
 * palette log "remote discovery failed, degrading" on every open, and the
 * health monitor raised a log-spike alarm for it (session history logged the
 * same outage thousands of times an hour).
 *
 * The class: a `log.<x>.warn(` in a file that calls the bound. A caller that can
 * log a host read failure picks its level with hostReadFailureLevel(err). The
 * ratchet below counts the plain warns left in every such file; a new caller
 * file, or a new plain warn in one, fails until it is decided: route it through
 * hostReadFailureLevel, or raise the count here with the reason it never logs a
 * host-away read.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HostReconnectingError, HostStillLoadingError, hostReadFailureLevel } from '../../../src/core/hosts/remote-read-bound.js'

const ROOT = path.resolve(__dirname, '../../..')

/** Plain warns per caller file, reviewed 2026-11-14: none of these logs a HostReconnectingError. */
const PLAIN_WARNS: Record<string, number> = {
  'src/core/remote-image-mirror.ts': 0,
  'src/core/session-service-preview.ts': 1,
  'src/core/session-vscode-embed.ts': 0,
  'src/core/sessions/ensure-cwd.ts': 0,
  'src/core/sessions/session-controls.ts': 8,
  'src/core/sessions/session-extras.ts': 5,
  'src/core/sessions/task-dir-place.ts': 0,
  'src/web/routes/file-content-validator.ts': 0,
  'src/web/routes/file-content.ts': 5,
  'src/web/routes/files.ts': 0,
  'src/web/routes/media-v1.ts': 0,
  'src/web/routes/session-lifecycle-v1.ts': 0,
  'src/web/routes/sessions.ts': 14,
  'src/web/routes/slash-commands.ts': 0,
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function callerFiles(): Map<string, number> {
  const found = new Map<string, number>()
  for (const abs of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    if (rel === 'src/core/hosts/remote-read-bound.ts') continue
    const text = fs.readFileSync(abs, 'utf8')
    if (!/\bbound(?:Shared)?HostRead\b/.test(text)) continue
    found.set(rel, (text.match(/\blog\.[A-Za-z]+\.warn\(/g) ?? []).length)
  }
  return found
}

describe('hostReadFailureLevel', () => {
  it('a host that is away is info; any other failure stays a warn', () => {
    expect(hostReadFailureLevel(new HostReconnectingError('h', 'Host'))).toBe('info')
    expect(hostReadFailureLevel(new HostStillLoadingError('h', 'Host'))).toBe('info')
    expect(hostReadFailureLevel(new Error('EACCES: permission denied'))).toBe('warn')
    expect(hostReadFailureLevel('a string')).toBe('warn')
  })
})

describe('host read callers: no new plain warn for a host-away read', () => {
  it('every file that calls the bound is listed, and its plain warns do not grow', () => {
    const found = callerFiles()
    const problems: string[] = []
    for (const [file, count] of found) {
      if (!(file in PLAIN_WARNS)) problems.push(`${file}: new caller of boundHostRead with ${count} plain warn(s); list it here after checking each`)
      else if (count > PLAIN_WARNS[file]) problems.push(`${file}: ${count} plain warns, ratchet is ${PLAIN_WARNS[file]}; log a host read failure with log.<x>[hostReadFailureLevel(err)]`)
    }
    expect(problems).toEqual([])
  })

  it('the ratchet names only real callers (a file that no longer calls the bound is dropped)', () => {
    const found = callerFiles()
    expect(Object.keys(PLAIN_WARNS).filter((f) => !found.has(f))).toEqual([])
  })
})
