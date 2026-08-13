import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// 2026-08-12 clouddev outage: the remote daemon start command was built as
// `nohup WALNUT_ENFORCE_SESSION_CRON=1 <bun> daemon.cjs --start`. nohup does
// not understand VAR=value prefixes — it exec'd the string as the program
// ("nohup: failed to run command ...: No such file or directory"), the daemon
// never booted, and every connect attempt fell into a redeploy loop.
//
// The real guarantee is now structural: buildDaemonStartCmd() renders env as
// `nohup env K=V cmd` and its tests EXECUTE the generated command
// (daemon-start-cmd.test.ts). This ratchet is the cheap backstop: no source
// file under src/providers may hand-write the broken `nohup VAR=` shape.
describe('nohup env prefix ratchet (src/providers)', () => {
  const providersDir = path.join(__dirname, '../../src/providers')

  it('no provider source places a bare VAR=value right after nohup', () => {
    const offenders: string[] = []
    for (const file of readdirSync(providersDir, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts')) continue
      const src = readFileSync(path.join(providersDir, file), 'utf-8')
      for (const [idx, line] of src.split('\n').entries()) {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*')) continue // comments may quote the broken shape
        if (/nohup +[A-Z_]+=/.test(line)) offenders.push(`${file}:${idx + 1}: ${t}`)
      }
    }
    expect(offenders, `bare env prefix after nohup (use buildDaemonStartCmd / 'nohup env'):\n${offenders.join('\n')}`).toEqual([])
  })
})
