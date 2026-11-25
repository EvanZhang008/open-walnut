/**
 * A new field of a history row moves the parse's shape version (HISTORY_CACHE_SCHEMA), or every
 * parse cached before the deploy keeps serving rows without it (2026-11-25: `hidden`, the lines
 * Walnut left out of a reply, shipped without a bump, and no reply parsed before the deploy had it;
 * history-disk-cache.ts has the bump log). When this fails: bump HISTORY_CACHE_SCHEMA in
 * src/core/history-parse.ts, add a line to the log, then record the fields and the number here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HISTORY_CACHE_SCHEMA } from '../../src/core/history-parse.js'

const RECORDED = {
  schema: 17,
  fields: [
    'role', 'text', 'timestamp', 'systemVariant', 'systemDetail', 'cliError', 'tools', 'thinking', 'hidden',
    'model', 'effort', 'usage', 'msgId', 'walnutMessageId', 'sourceUuid', 'mergedUuids', 'lineUuid', 'unsettled',
    'queued', 'injected', 'agentOrigin', 'hints', 'rawText', 'about', 'aboutTagged', 'opensTurn',
  ],
}

/** The top-level field names of an interface in a source file. */
function fieldsOf(file: string, name: string): string[] {
  const src = fs.readFileSync(file, 'utf8')
  const at = src.indexOf(`export interface ${name} {`)
  if (at < 0) throw new Error(`${name} not found in ${file}`)
  const open = src.indexOf('{', at)
  let depth = 0
  let end = open
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}' && --depth === 0) { end = k; break }
  }
  const out: string[] = []
  let d = 0
  for (const line of src.slice(open + 1, end).split('\n')) {
    const m = d === 0 ? /^\s{2}(\w+)\??:/.exec(line) : null
    if (m) out.push(m[1])
    d += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }
  return out
}

describe('history rows and the parse\'s shape version', () => {
  it('a field added to or taken from SessionHistoryMessage comes with a new HISTORY_CACHE_SCHEMA', () => {
    const now = fieldsOf(path.resolve(__dirname, '../../src/core/history-parse.ts'), 'SessionHistoryMessage')
    const same = JSON.stringify([...now].sort()) === JSON.stringify([...RECORDED.fields].sort())
    if (!same) {
      expect(HISTORY_CACHE_SCHEMA, 'The row\'s fields changed: bump HISTORY_CACHE_SCHEMA, then record the fields here').not.toBe(RECORDED.schema)
    }
    expect({ schema: HISTORY_CACHE_SCHEMA, fields: [...now].sort() }, 'Record the new fields and number in RECORDED').toEqual({ schema: RECORDED.schema, fields: [...RECORDED.fields].sort() })
  })
})
