/**
 * "Does the local daemon serve?" is LocalDaemon.serving, never its port: in process (experiment
 * in_process_daemon, or every experiment on) the runtime has no WebSocket door, so its port
 * stays null while it serves (2026-11-24: a boot with the daemon in process never retired the start
 * card an earlier life left, as server.ts read `localDaemon.port !== null`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('the local daemon serving check', () => {
  it('no source reads the local daemon\'s port as "it serves"', () => {
    const offenders: string[] = []
    for (const file of sources(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (/localDaemon\.port\s*[!=]==?\s*null|!!\s*localDaemon\.port\b|if\s*\(\s*!?\s*localDaemon\.port\s*\)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`)
      }
    }
    expect(offenders, 'use localDaemon.serving: the port is null while the daemon runs in process').toEqual([])
  })
})
