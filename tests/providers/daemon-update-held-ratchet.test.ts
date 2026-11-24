/**
 * Class guard (2026-11-24): a daemon update try that changed nothing ends either 'held' (the HOST
 * refused it: any other host name of the same daemon would meet the same refusal, so the update
 * claim holds them within their turn) or 'own-path' (this name's own way there failed: its SSH
 * login, its upload, its file, its cooldown; the claim is freed so another name goes now).
 * newdev's SSH login was refused at every try and each try ended 'held', so clouddev, the same
 * daemon over the host network, deferred to it at every try (daemon-update-claim.ts).
 *
 * Every such end in every file that takes an update claim is listed here with its class, found by
 * the nearest reason above it. A new end, a moved reason or a new file taking claims fails here
 * until it is classified.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

type Class = 'held' | 'own-path'
interface Site { file: string; symbol: string; ends: RegExp; reasons: Record<string, Class> }

const SITES: Site[] = [
  {
    file: 'src/providers/daemon-connection.ts',
    symbol: 'private async updateManagedDaemon(',
    // `return 'held'`, `return 'own-path'` and the helper's own return.
    ends: /\breturn '(held|own-path)'/,
    reasons: {
      // Own path: this link's reads of the service config failed.
      'the service config could not be read': 'own-path',
      // Host: an earlier update's runner may still work there.
      'the previous daemon update is still running on the host': 'held',
      // Own path: this name's own cooldown.
      'an update to this build was tried': 'own-path',
      // Host: the build did not stay serving on that machine.
      'this build did not stay serving on the host': 'held',
      // Own path: the file this server would send is missing here.
      'the daemon artifact is not available': 'own-path',
      // Host: the last update's probation still watches the daemon there.
      'probation still watches the new daemon on the host': 'held',
      // Own path: the file could not be made here or put there over this link (an SSH login refused).
      'the new daemon could not be put on the host': 'own-path',
      // Host: work that started on the daemon during the upload holds the swap.
      "if (done === 'held')": 'held',
      // Host: another update's runner or a hold there.
      'NetUpdateHeldError': 'held',
      // Host: launchd starts no jobs now.
      "'update deferred: '": 'held',
      // Host: the daemon refused, busy.
      "the host's daemon is busy": 'held',
    },
  },
  {
    file: 'src/providers/daemon-net-update.ts',
    symbol: 'private async attempt(',
    ends: /\bclaimKept = '(held|own-path)'/,
    reasons: {
      // Host: another runner there, a probation, the install lock.
      'err instanceof NetUpdateHeldError': 'held',
      // Host: launchd starts no jobs now.
      'deferredAt >= 0': 'held',
      // Host: the daemon refused, busy.
      'daemonBusyRefusal(err)': 'held',
      // Own path: this link cut the upload.
      'stageCutByLink(err': 'own-path',
      // Own path: the walnut file did not reach the host over this link.
      "'DaemonUpdateStageError'": 'own-path',
    },
  },
]

/** The method's body: from its signature to the first line closing it at two spaces. */
function body(text: string, symbol: string): string[] {
  const at = text.indexOf(symbol)
  expect(at, `${symbol} not found`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n  }\n', at)
  return text.slice(at, end).split('\n')
}

describe('every update try that changed nothing says whose side refused it', () => {
  it('only the known files take an update claim', () => {
    const dir = path.join(ROOT, 'src')
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name)
      return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : []
    })
    const takers = walk(dir)
      .filter((f) => /\bclaimDaemonUpdate\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .filter((f) => f !== 'src/providers/daemon-update-claim.ts')
      .sort()
    expect(takers, 'a new file takes an update claim: add its ends to SITES').toEqual(SITES.map((s) => s.file).sort())
  })

  for (const site of SITES) {
    it(`${site.file}: each end is classified by the reason above it`, () => {
      const lines = body(read(site.file), site.symbol)
      const used = new Map<string, number>()
      const wrong: string[] = []
      lines.forEach((line, i) => {
        const end = site.ends.exec(line)
        if (!end) return
        // The nearest reason on this line or up to 10 lines above.
        let reason: string | null = null
        for (let j = i; j >= Math.max(0, i - 10) && !reason; j--) {
          reason = Object.keys(site.reasons).find((r) => lines[j].includes(r)) ?? null
        }
        if (!reason) { wrong.push(`unclassified: ${line.trim()}`); return }
        used.set(reason, (used.get(reason) ?? 0) + 1)
        if (site.reasons[reason] !== end[1]) wrong.push(`${reason}: ends '${end[1]}', classified '${site.reasons[reason]}'`)
      })
      expect(wrong).toEqual([])
      // Each reason names exactly one end: a stale or doubled entry is a classification nobody checks.
      expect(Object.fromEntries(used)).toEqual(Object.fromEntries(Object.keys(site.reasons).map((r) => [r, 1])))
    })
  }

  it("the SSH path's caller hands the outcome to the claim as it came, and nobody releases a bare 'held'", () => {
    const text = read('src/providers/daemon-connection.ts')
    expect(text).toContain("if (updated === 'held' || updated === 'own-path') { held.claim?.release(updated); return false }")
    expect(text).not.toMatch(/\.release\('held'\)/)
    expect(read('src/providers/daemon-net-update.ts')).not.toMatch(/\.release\('held'\)/)
  })
})
