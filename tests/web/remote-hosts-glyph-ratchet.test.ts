/**
 * Settings > Remote Hosts is one of the panes C8 holds glyph free (settings-panes-addons.spec.ts
 * OWNED_PANES): no dashes, middle dots, arrows, triangles, check or cross marks, times signs or
 * ellipsis characters in what it shows. The browser audit reaches Remote Hosts only after every
 * pane before it passes, so this ratchet reads the pane's own sources: every string they hold,
 * comments left out. 2026-11-04: its lines were joined with middle dots, the Kind picker ended
 * in a triangle, and its busy words in an ellipsis character.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, '../../web/src/components/settings/sections')
const OWN = /^(RemoteHost|Host|host-|NetMachine|FleetHost|useLinkedHost|useHost|SecretsGroup|ReplicaKeep)/
// Em and en dash, middle dot, arrows, triangles, check and cross marks, times, ellipsis, as escapes.
const BANNED = /[\u2014\u2013\u00b7\u2192\u203a\u25b8\u25be\u2713\u2717\u00d7\u2026\u2197]/u

/** The file with its comments blanked (a `//` inside a string only loses coverage, never adds a hit). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const files = readdirSync(DIR).filter((f) => OWN.test(f) && /\.(tsx?|ts)$/.test(f))

describe('Remote Hosts sources show no banned glyph', () => {
  it('reads the pane files', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files)('%s', (file) => {
    const lines = code(readFileSync(join(DIR, file), 'utf8')).split('\n')
    const hits = lines.flatMap((line, i) => (BANNED.test(line) ? [`${file}:${i + 1}: ${line.trim().slice(0, 80)}`] : []))
    expect(hits).toEqual([])
  })
})
