/**
 * Every versioned block of the default instructions has a kind and a source (block-sources.ts), so
 * none is told gone where its source was not read.
 *
 * 2026-11-24 the user's profile and the Threads rules, 2026-11-25 "Language for other people"
 * (v9c7fc7a0): a block added after the first fix had no kind yet, was named by where it sat, and a
 * host replica with no copy of the setting told two sessions it was gone. The guard for the class:
 * every place that writes a versioned block is listed here with the kinds it writes, a new one fails
 * until it is, every kind it writes parses as that kind, and every kind names its source.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BLOCK_KIND_IDS, dueChanges, parseInstructions, renderDue, viewsAfter } from '../../../src/core/sessions/instruction-diff.js'
import { BLOCK_SOURCE_READ, goneKnownHere } from '../../../src/core/sessions/block-sources.js'
import { outwardLanguageLine, replyLanguageLine } from '../../../src/core/sessions/reply-language-context.js'
import { userProfileLine } from '../../../src/core/sessions/user-profile-context.js'

const ROOT = path.resolve(__dirname, '../../..')

/** Each file that writes a versioned block, and the kinds its calls write, in order. */
const WRITERS: Record<string, string[]> = {
  'src/core/sessions/reply-language-context.ts': ['reply-language', 'outward-language'],
  'src/core/sessions/user-profile-context.ts': ['user-profile'],
  'src/core/sessions/session-context.ts': ['task-threads', 'core-instructions', 'core-instructions', 'core-instructions'],
}

function calls(): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      const rel = path.relative(ROOT, p).split(path.sep).join('/')
      if (rel === 'src/core/sessions/instruction-diff.ts') continue // the definition
      const n = (fs.readFileSync(p, 'utf8').match(/\bversionedBlock\(/g) ?? []).length
      if (n) out[rel] = n
    }
  }
  walk(path.join(ROOT, 'src'))
  return out
}

describe('every versioned block has a kind and a source', () => {
  it('every place that writes one is listed with the kinds it writes', () => {
    const want = Object.fromEntries(Object.entries(WRITERS).map(([f, kinds]) => [f, kinds.length]))
    // A new versionedBlock call: name its kind in instruction-diff.ts BLOCK_KINDS, its source in
    // block-sources.ts BLOCK_SOURCE_READ, then list it here.
    expect(calls()).toEqual(want)
    for (const kinds of Object.values(WRITERS)) for (const k of kinds) expect(BLOCK_KIND_IDS).toContain(k)
  })

  it('each kind written parses as that kind', () => {
    const outward = outwardLanguageLine({ language: 'English', tools: [], commands: [] } as never)
    const reply = replyLanguageLine('Talk to the user in French.')
    const profile = userProfileLine({ text: '- A rule.', savedAt: '2026-11-25T00:00:00.000Z', exists: true })
    const ids = [...parseInstructions(`## A\n\n${outward}\n${reply}\n${profile}`).blocks.keys()].sort()
    expect(ids).toEqual(['outward-language', 'reply-language', 'user-profile'])
  })

  it('every kind names the source its absence is read against', () => {
    expect(BLOCK_KIND_IDS.filter((id) => !(id in BLOCK_SOURCE_READ))).toEqual([])
    expect(Object.keys(BLOCK_SOURCE_READ).filter((id) => !BLOCK_KIND_IDS.includes(id))).toEqual([])
  })

  it('a block of a kind not named is never told gone', () => {
    expect(goneKnownHere('#0')).toBe(false)
    expect(goneKnownHere('## Somewhere#1')).toBe(false)
  })
})

describe('a session told a block was gone while it had no kind hears it still applies', () => {
  it('the gone mark under its old name ("#0") is answered by the block of the same version, once', () => {
    const outward = outwardLanguageLine({ language: 'English', tools: [], commands: [] } as never)
    const current = parseInstructions(`## A\n\n${outward}`)
    const block = current.blocks.get('outward-language')!
    // What the night's notice recorded: the block named by where it sat, told gone.
    const views = { '#0': { version: block.version, words: [], gone: true as const } }
    const due = dueChanges(current, current, new Set(), views)!
    expect(renderDue(due)).toContain(`An earlier notice said this part of your instructions (${block.version}) was gone. It was not: it still applies`)
    const after = viewsAfter(views, due)
    expect(Object.keys(after)).toEqual(['outward-language'])
    expect(dueChanges(current, current, new Set(), after)).toBeNull()
  })
})

