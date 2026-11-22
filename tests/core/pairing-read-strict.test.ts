/**
 * Every read of the companion pairing either asks for `strict` (a git that cannot answer
 * throws) or is listed here with why a wrong "none" does no lasting harm.
 *
 * The class (2026-11-22): the pairing reads (getCloudRemoteCredentials[Async],
 * getCloudPairingEndpoint[Async]) answer null both when there is no companion and when git
 * cannot answer right now (timed out at load 400, a lock). A caller that ACTS on "none" turned
 * a slow read into a lasting change: the host network moved every machine to the public relay
 * (clouddev and olddev out of reach for 33 minutes), the cloud box probe dropped its host, a
 * revoked device's copy on the companion was marked removed while it stayed, and cloud setup
 * could build a second companion. A new caller fails here until it is strict or listed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..', '..')

/** Callers where a wrong "none" is shown or skipped once and read again soon: file -> count, why. */
const LENIENT: Record<string, { count: number; why: string }> = {
  'src/core/pairing-targets.ts': { count: 1, why: 'getPairingTargets lists where a phone can pair; the list is read again on the next open' },
  'src/integrations/cloud-bridge-config.ts': { count: 1, why: 'the machine-token probe skips this round and runs again later' },
  'src/web/routes/browser-v1.ts': { count: 1, why: "this server's own origins, cached for 60 s and read again" },
  'src/web/routes/device-twins.ts': { count: 1, why: 'adoptOnCloud makes no copy now; the next sign-in asks again' },
  'src/web/routes/devices.ts': { count: 4, why: 'each answers this one request (a list or an error), changing nothing' },
}

const CALL = /\b(getCloudRemoteCredentials|getCloudPairingEndpoint)(?:Async)?\(([^)]*)\)/g

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

function calls() {
  const found: Array<{ file: string; args: string; text: string }> = []
  for (const abs of tsFiles(path.join(ROOT, 'src'))) {
    const file = path.relative(ROOT, abs)
    for (const line of fs.readFileSync(abs, 'utf-8').split('\n')) {
      if (/^\s*(\/\/|\*|import\b)/.test(line) || /\bfunction\s+(getCloudRemoteCredentials|getCloudPairingEndpoint)/.test(line)) continue
      for (const m of line.matchAll(CALL)) found.push({ file, args: m[2].trim(), text: line.trim() })
    }
  }
  return found
}

const strict = (args: string) => /\bstrict:\s*true\b/.test(args) || args === 'options'

describe('reads of the companion pairing', () => {
  const all = calls()

  it('finds the callers (the scan is not empty)', () => {
    expect(all.length).toBeGreaterThan(10)
    expect(all.some((c) => c.file === 'src/core/net/net-mac.ts')).toBe(true)
  })

  it('every caller that acts on "no companion" reads strictly; the rest are listed with why', () => {
    const lenient = new Map<string, string[]>()
    for (const c of all) if (!strict(c.args)) lenient.set(c.file, [...lenient.get(c.file) ?? [], c.text])
    const wrong: string[] = []
    for (const [file, lines] of lenient) {
      const ok = LENIENT[file]
      if (!ok) wrong.push(`${file}: not listed, read strictly or list it with why: ${lines.join(' | ')}`)
      else if (lines.length > ok.count) wrong.push(`${file}: ${lines.length} lenient reads, ${ok.count} listed: ${lines.join(' | ')}`)
    }
    for (const [file, ok] of Object.entries(LENIENT)) {
      if ((lenient.get(file)?.length ?? 0) < ok.count) wrong.push(`${file}: listed for ${ok.count}, has ${lenient.get(file)?.length ?? 0}: lower the count`)
    }
    expect(wrong).toEqual([])
  })

  it('the callers that changed the network, a host or a removal read strictly', () => {
    const strictIn = (file: string) => all.filter((c) => c.file === file && strict(c.args)).length
    expect(strictIn('src/core/net/net-mac.ts')).toBe(2)
    expect(strictIn('src/core/hosts/cloud-box-probe.ts')).toBe(1)
    expect(strictIn('src/web/routes/device-twins.ts')).toBe(1)
    expect(strictIn('src/core/cloud-setup/steps.ts')).toBe(2)
  })
})
