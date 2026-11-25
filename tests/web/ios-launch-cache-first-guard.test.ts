/**
 * A launch reads every store's own copy from disk before it makes any request. Offline a request
 * waits out its timeout, and what the phone holds must not wait for the network: a thread push at
 * an offline cold launch gave up on the VP's chat the phone held, because the phone's copy of its
 * sessions was read only after the status probe, the chat's and the notes' requests had answered
 * (2026-11-25 CI, ThreadPushColdOfflineReviewUITests: the page never came, the last saved chat
 * came back instead; the green runs before it made it with two seconds to spare).
 *
 * The members are read from source: every store under ios-native/Walnut/Stores whose launch reads
 * `DiskCache` does it in `adoptCache()`, never in `initialize()`, and `hydrateStores`
 * (WalnutApp.swift) awaits each store's `adoptCache()` before its first other await.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:\\.|[^"\\\n])*"/g, '""')

/** The body of the first `func <name>(...)` in `src`, braces matched; null when there is none. */
export function body(src: string, name: string): string | null {
  const m = new RegExp(`func\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** The awaited calls of a body, in order (`await x.y()` gives `x.y`). */
export function awaits(src: string): string[] {
  return [...src.matchAll(/\bawait\s+([\w.]+)\s*\(/g)].map((m) => m[1])
}

const stores = fs
  .readdirSync(path.join(APP, 'Stores'))
  .filter((f) => f.endsWith('.swift'))
  .map((f) => ({ file: f, src: code(fs.readFileSync(path.join(APP, 'Stores', f), 'utf8')) }))
  .filter((s) => /func\s+initialize\s*\(\s*\)\s*async/.test(s.src))

describe('iOS: a launch reads every store\'s own copy before any request', () => {
  it('finds the stores it guards', () => {
    expect(stores.map((s) => s.file)).toEqual(
      expect.arrayContaining(['ChatStore.swift', 'NotesStore.swift', 'TasksStore.swift', 'InboxStore.swift']),
    )
  })

  it('a store reads its copy in adoptCache, never in initialize', () => {
    const offenders = stores.flatMap((s) => {
      const init = body(s.src, 'initialize') ?? ''
      const adopt = body(s.src, 'adoptCache')
      const out: string[] = []
      if (/DiskCache\.load/.test(init)) out.push(`${s.file}: initialize() reads DiskCache; move it to adoptCache()`)
      if (adopt === null) out.push(`${s.file}: no adoptCache()`)
      else if (/\bapi\.|transport\.|WalnutAPI\(/.test(adopt)) out.push(`${s.file}: adoptCache() makes a request`)
      return out
    })
    expect(offenders).toEqual([])
  })

  it('hydrateStores awaits every adoptCache before its first other await', () => {
    const hydrate = body(code(fs.readFileSync(path.join(APP, 'App/WalnutApp.swift'), 'utf8')), 'hydrateStores')
    expect(hydrate, 'WalnutApp.hydrateStores is gone: the launch order this guards moved').not.toBeNull()
    const order = awaits(hydrate!)
    const firstOther = order.findIndex((a) => !a.endsWith('.adoptCache'))
    const adopted = order.slice(0, firstOther < 0 ? order.length : firstOther)
    expect(adopted.length, `adoptCache calls before the first request: ${adopted.join(', ')}`).toBe(stores.length)
    expect(order.slice(adopted.length).filter((a) => a.endsWith('.adoptCache'))).toEqual([])
  })

  it('reads bodies and awaits as Swift writes them', () => {
    const src = 'func initialize() async { await adoptCache(); if x { y() } }\nfunc adoptCache() async { z() }'
    expect(body(src, 'initialize')).toBe(' await adoptCache(); if x { y() } ')
    expect(awaits('await tasks.adoptCache()\nawait connection.refreshStatus()')).toEqual(['tasks.adoptCache', 'connection.refreshStatus'])
  })
})
