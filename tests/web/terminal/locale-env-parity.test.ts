/**
 * The locale a terminal over the daemon link carries: the server sends it (link-pty.ts
 * localeEnv) and the daemon takes it (providers/pty-stream-core.ts loginEnv), each with
 * its own copy of the key and value patterns (the daemon core is inlined into the source
 * twin by toString, so it can import nothing). They stay identical, or one side drops what
 * the other passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { localeEnv } from '../../../src/web/terminal/link-pty.js'

const ROOT = path.resolve(__dirname, '../../..')

function patterns(file: string): Record<'LOCALE_KEY' | 'LOCALE_VALUE', string> {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const out = {} as Record<'LOCALE_KEY' | 'LOCALE_VALUE', string>
  for (const name of ['LOCALE_KEY', 'LOCALE_VALUE'] as const) {
    const all = [...src.matchAll(new RegExp(`const ${name} = (/.+/[a-z]*)\\s*$`, 'gm'))]
    expect(all.length, `${name} in ${file}`).toBe(1)
    out[name] = all[0]![1]!
  }
  return out
}

describe('the locale a link terminal carries', () => {
  it('the server and the daemon use the same key and value patterns', () => {
    expect(patterns('src/web/terminal/link-pty.ts')).toEqual(patterns('src/providers/pty-stream-core.ts'))
  })

  it('sends LANG and LC_* with a locale-name value, and nothing else', () => {
    expect(localeEnv({ LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'bad value; rm -rf', LANGUAGE: '', TERM: 'xterm', HOME: '/h' })).toEqual({ LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8' })
  })
})
