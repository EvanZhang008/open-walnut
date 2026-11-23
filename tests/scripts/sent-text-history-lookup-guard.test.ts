/**
 * A browser spec that types words into a composer and then looks for them in the conversation looks
 * in the user's own bubble (`.session-history .session-msg-user`), never in the whole history.
 * The mock agent echoes what it was sent ("Hello! I processed your message: ..."), so the same
 * words come back in its reply; a lookup across the history then finds two elements once the reply
 * is drawn, and passes only while it reads first (2026-11-23, nightly 45241639472:
 * server-restart-upload.spec.ts read "didn't see this" twice, the user's message and the echo's
 * last paragraph, and was taken for a message sent twice).
 *
 * Members, from the source: a `.session-history').getByText(X` whose X the same file also types
 * (`.fill(X`, `.type(X`, `pressSequentially(X`, `keyboard.type(X`, `insertText(X`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../e2e/browser')
const LOOK = /session-history['"`]\)\.getByText\(\s*([^,)]+)/g

function typedLookups(file: string, text: string): string[] {
  return [...text.matchAll(LOOK)].flatMap((m) => {
    const arg = m[1].trim()
    const esc = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const typed = new RegExp(`(?:\\.fill|\\.type|pressSequentially|keyboard\\.type|insertText)\\(\\s*${esc}\\s*[,)]`)
    return typed.test(text) ? [`${file}: getByText(${arg})`] : []
  })
}

describe('a spec finds the words it sent in the user\'s own bubble', () => {
  it('catches the shape and leaves a scoped lookup alone', () => {
    const spec = `await box.fill("hi there")\nawait expect(panel.locator('.session-history').getByText("hi there")).toBeVisible()`
    expect(typedLookups('x.spec.ts', spec)).toHaveLength(1)
    const scoped = `await box.fill("hi there")\nawait expect(panel.locator('.session-history .session-msg-user').getByText("hi there")).toBeVisible()`
    expect(typedLookups('x.spec.ts', scoped)).toEqual([])
    const seeded = `await expect(page.locator('.session-history').getByText('Show me the rollout wizard')).toBeVisible()`
    expect(typedLookups('x.spec.ts', seeded)).toEqual([])
  })

  it('no browser spec looks for its own typed words across the whole history', () => {
    const files = (fs.readdirSync(DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))
    const found = files.flatMap((f) => typedLookups(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found, "the agent's reply echoes the words: look in '.session-history .session-msg-user'").toEqual([])
  })
})
