/**
 * The Alfred workflow's object graph (desktop/launchers/alfred/build.mjs).
 *
 * Alfred 5.6 never shows a Text View reached through a utility (a Conditional, an Arg and
 * Vars) placed right after a Script Filter: it runs the view's script, then neither shows the
 * window nor reads the output (2026-11-01, every keyword ask streamed into a hidden window).
 * A Run Script in between fixes it, so no Script Filter may connect straight to a utility.
 * Checked against every Script Filter the build makes, so a new one is held to it too.
 */
import { describe, expect, it } from 'vitest'
import { workflow } from '../../desktop/launchers/alfred/build.mjs'

interface AlfredObject { uid: string; type: string }
interface Link { destinationuid: string; modifiers: number }

const objects = workflow.objects as AlfredObject[]
const connections = workflow.connections as Record<string, Link[]>
const byUid = new Map(objects.map((o) => [o.uid, o]))
const TEXT_VIEW = 'alfred.workflow.userinterface.text'

/** Every object a plain Enter (no modifier) reaches from `uid`. */
function reachable(uid: string, seen = new Set<string>()): Set<string> {
  for (const link of connections[uid] ?? []) {
    if (link.modifiers !== 0 || seen.has(link.destinationuid)) continue
    seen.add(link.destinationuid)
    reachable(link.destinationuid, seen)
  }
  return seen
}

describe('Alfred workflow graph', () => {
  const filters = objects.filter((o) => o.type === 'alfred.workflow.input.scriptfilter')

  it('has a Script Filter', () => {
    expect(filters.length).toBeGreaterThan(0)
  })

  it('never connects a Script Filter straight to a utility', () => {
    const bad = filters.flatMap((f) => (connections[f.uid] ?? [])
      .map((link) => byUid.get(link.destinationuid))
      .filter((o): o is AlfredObject => !!o && o.type.startsWith('alfred.workflow.utility.'))
      .map((o) => `${f.uid} -> ${o.type} ${o.uid}`))
    expect(bad).toEqual([])
  })

  it('still reaches the Text View from every entry', () => {
    const view = objects.find((o) => o.type === TEXT_VIEW)
    expect(view).toBeTruthy()
    const entries = objects.filter((o) => /\.(input\.scriptfilter|trigger\.)/.test(o.type))
    expect(entries.length).toBeGreaterThanOrEqual(4)
    for (const entry of entries) expect([entry.type, reachable(entry.uid).has(view!.uid)]).toEqual([entry.type, true])
  })

  it('links every connection to an object that exists', () => {
    const dangling = Object.entries(connections).flatMap(([from, links]) => [from, ...links.map((l) => l.destinationuid)])
      .filter((uid) => !byUid.has(uid))
    expect(dangling).toEqual([])
  })
})
