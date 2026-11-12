/**
 * Every way to change the Approvals switch goes through the signed check (src/core/approvals/ask-me.ts;
 * 2026-11-12, a review of the Git gate found an unsigned PUT /api/config turned every approval off).
 *
 *  - `setAskMe` is the one writer: no other source in src writes `ask_me` (a config.yaml write, a
 *    route, an op, a plugin), so a new path that sets it fails here until it calls setAskMe;
 *  - the one route that takes it (PUT /api/config) asks for a device signature before an off, and
 *    hands the rest of the body on without it;
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
    expect(writers, 'write the switch only through setAskMe (core/approvals/ask-me.ts), which asks for a device signature before an off').toEqual([])
  })

  it('setAskMe writes the latch and config.yaml, off to the latch first', () => {
    const text = fs.readFileSync(path.join(SRC, 'core/approvals/ask-me.ts'), 'utf8')
    expect(text).toMatch(/export async function setAskMe\(/)
    expect(text).toMatch(/if \(on\) \{ await writeConfig\(\); await writeLatch\(\) \} else \{ await writeLatch\(\); await writeConfig\(\) \}/)
    expect(text).toMatch(/return storedAskMe\(config, env\) \|\| latch\?\.on === true/)
  })

  it('PUT /api/config asks for a signature before an off and never merges approvals itself', () => {
    const text = fs.readFileSync(path.join(SRC, 'web/routes/config.ts'), 'utf8')
    const at = text.indexOf('if (body.approvals !== undefined)')
    expect(at).toBeGreaterThan(0)
    const block = text.slice(at, text.indexOf('delete body.approvals', at) + 'delete body.approvals'.length)
    expect(block).toMatch(/offNeedsSignature\(\)[\s\S]*requestAskMeOff\(/)
    expect(block).toMatch(/setAskMe\(true/)
    expect(block).toMatch(/setAskMe\(false, \{ unsigned:/)
    expect(block).toContain('delete body.approvals')
    // The only route that takes the section: no other route reads body.approvals.
    for (const f of files(path.join(SRC, 'web/routes'))) {
      if (f.endsWith(`${path.sep}config.ts`)) continue
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/body\.approvals|approvals:\s*\{\s*ask_me/)
    }
  })

  it('the answer route applies a signed turn-off, and only there', () => {
    const uses = files(SRC).filter((f) => /applyAskMeOff\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    expect(uses.sort()).toEqual(['core/approvals/ask-me.ts', 'web/routes/approvals-v1.ts'])
  })
})
