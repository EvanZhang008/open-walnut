/**
 * Every way to change the Approvals switch goes through one writer and one person check
 * (src/core/approvals/ask-me.ts; 2026-11-12, a review of the Git gate found an agent's PUT
 * /api/config turned every approval off; 2026-11-21, the user: no signing key, a signed-in device
 * turns it off like it approves).
 *
 *  - `setAskMe` is the one writer: no other source in src writes `ask_me` (a config.yaml write, a
 *    route, an op, a plugin), so a new path that sets it fails here until it calls setAskMe;
 *  - the one route that takes it (PUT /api/config) lets only a person change it (the same check
 *    as answering an approval, person-caller.ts), and hands the rest of the body on without it;
 *  - the effective switch reads on while either the latch or config.yaml says on, so any other
 *    write to config.yaml can turn it on but never off.
 * The behaviour itself, on a real server: tests/e2e/approvals-off.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Places that may name `ask_me` with a value without writing the switch, each with why. */
const NOT_WRITERS: Record<string, string> = {
  'core/replication/config-allowlist.ts': 'which config keys a replica copies (a spec, true = copied)',
}

describe('the Approvals switch has one writer', () => {
  it('only ask-me.ts setAskMe writes ask_me', () => {
    const writers: string[] = []
    for (const f of files(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/')
      if (rel === 'core/approvals/ask-me.ts' || NOT_WRITERS[rel]) continue
      const text = fs.readFileSync(f, 'utf8')
      text.split('\n').forEach((line, i) => {
        // A value given to ask_me (not a type: `ask_me?: boolean`), or an assignment to it.
        if (/\bask_me\s*:\s*(?!boolean\b)[\w!(]/.test(line) || /\.ask_me\s*=[^=]/.test(line) || /\['ask_me'\]\s*=[^=]/.test(line)) writers.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(writers, 'write the switch only through setAskMe (core/approvals/ask-me.ts), behind the person check').toEqual([])
  })

  it('only ask-me.ts names the switch file', () => {
    const named = files(SRC).filter((f) => fs.readFileSync(f, 'utf8').includes("'switch.json'")).map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    expect(named).toEqual(['core/approvals/ask-me.ts'])
  })

  it('setAskMe writes the latch and config.yaml, off to the latch first', () => {
    const text = fs.readFileSync(path.join(SRC, 'core/approvals/ask-me.ts'), 'utf8')
    expect(text).toMatch(/export async function setAskMe\(/)
    expect(text).toMatch(/if \(on\) \{ await writeConfig\(\); await writeLatch\(\) \} else \{ await writeLatch\(\); await writeConfig\(\) \}/)
    expect(text).toMatch(/return storedAskMe\(config, env\) \|\| latch\?\.on === true/)
  })

  it('PUT /api/config lets only a person change it, with no signature, and never merges approvals itself', () => {
    const text = fs.readFileSync(path.join(SRC, 'web/routes/config.ts'), 'utf8')
    const at = text.indexOf('if (body.approvals !== undefined)')
    expect(at).toBeGreaterThan(0)
    const block = text.slice(at, text.indexOf('delete body.approvals', at) + 'delete body.approvals'.length)
    // The person check (a browser under automation is no person either) comes before the one
    // write, and nothing asks a device to sign.
    expect(block).toMatch(/if \(!isPersonNotAutomation\(req\)\) \{[\s\S]*human_only[\s\S]*setAskMe\(want, \{ person: true \}\)/)
    expect(block).not.toMatch(/offNeedsSignature|requestAskMeOff|signature_needed|unsigned/)
    expect(block).toContain('delete body.approvals')
    // The only route that takes the section: no other route reads body.approvals.
    for (const f of files(path.join(SRC, 'web/routes'))) {
      if (f.endsWith(`${path.sep}config.ts`)) continue
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/body\.approvals|approvals:\s*\{\s*ask_me/)
    }
  })

  it('no approval turns the switch off: only the person\'s own Settings or card does', () => {
    const uses = files(SRC).filter((f) => /applyAskMeOff|turnsAskMeOff\s*:/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    expect(uses).toEqual([])
  })
})
