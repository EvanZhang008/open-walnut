/**
 * A Walnut notification's `title` attribute is its folded title in the chat, as it is for a peer
 * note and a reply (src/lib/history-session-envelope.ts). 2026-11-03: Talk to CEO's attached mail
 * folded to `<external-content source="Mail">`, and the trigger-health and org hand-over notices
 * set titles nobody saw. Every notice Walnut builds with a title (enumerated from the source) must
 * come back with it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSessionEnvelopes } from '../../src/lib/history-session-envelope'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit'
import { ceoMessage } from '../../src/web/routes/content-v1'

const kit = createEnvelopeKit()

function envelopes(text: string) {
  return (parseSessionEnvelopes(text) ?? []).flatMap((s) => (s.kind === 'envelope' ? [s.envelope] : []))
}

describe('notification titles', () => {
  it("Talk to CEO's attached content folds to its title, under the person's words", () => {
    const text = ceoMessage({ source: 'Mail', title: 'Lunch tomorrow', text: 'At one?' }, 'Is she free Friday?')
    const segs = parseSessionEnvelopes(text) ?? []
    expect(segs[0]).toMatchObject({ kind: 'text' })
    const [env] = envelopes(text)
    expect(env).toMatchObject({ kind: 'notification', title: 'Attached Mail: Lunch tomorrow' })
  })

  it('a notice with a title keeps it; one without still has none', () => {
    const titled = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', title: 'Trigger output repaired', outcome: 'check_repaired' }, body: 'Fixed.' })
    expect(envelopes(titled)[0].title).toBe('Trigger output repaired')
    const plain = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'stopped' }, body: 'It stopped.' })
    expect(envelopes(plain)[0].title).toBeUndefined()
  })

  it('every source file that builds a titled notification is one this rule reads', () => {
    // The class: a buildWalnutMessage of kind notification with a title attribute. A new member
    // shows up here; its title is read by the same rule, so nothing more is needed than a look.
    const root = path.resolve(import.meta.dirname, '../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts')) {
          const src = fs.readFileSync(full, 'utf8')
          if (/kind: 'notification',[\s\S]{0,200}?\btitle[:,]/.test(src)) files.push(path.relative(root, full))
        }
      }
    }
    walk(root)
    expect(files).toEqual(expect.arrayContaining(['core/routines/trigger-health.ts', 'web/routes/content-v1.ts']))
  })
})
