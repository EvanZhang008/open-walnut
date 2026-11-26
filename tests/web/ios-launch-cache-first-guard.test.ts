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
 * (WalnutApp.swift) awaits each store's `adoptCache()` (each store once, by its type) before its first
 * other await. Since the copy is adopted before the status probe, an app sent to the background
 * during the probe skips the store's server part (`refreshAfterLaunch` reads nothing while the store
 * is inactive), so each store's foreground resume reads the server again.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { code } from './ios-timed-hide-scan'
import { body, awaits } from './ios-swift-source'

const APP = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

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
    // Each receiver by its declared type: one store adopted twice never stands in for one left out.
    const app = code(fs.readFileSync(path.join(APP, 'App/WalnutApp.swift'), 'utf8'))
    const typeOf = new Map([...app.matchAll(/\b(\w+)\s*:\s*(\w+Store)\b/g)].map((m) => [m[1], m[2]]))
    const adoptedTypes = adopted.map((a) => typeOf.get(a.split('.')[0]) ?? a).sort()
    expect(adoptedTypes, 'adoptCache calls before the first request').toEqual(stores.map((s) => s.file.replace(/\.swift$/, '')).sort())
    expect(order.slice(adopted.length).filter((a) => a.endsWith('.adoptCache'))).toEqual([])
  })

  it('a store whose launch was sent to the background reads the server when it is back', () => {
    const offenders = stores.flatMap((s) => {
      const resume = body(s.src, 'resumeForForeground') ?? ''
      // What resume runs, one call deep (ChatStore resumes through resumeStream).
      const called = [...resume.matchAll(/\b(\w+)\s*\(/g)].map((m) => body(s.src, m[1]) ?? '').join('\n')
      return /refreshAfterLaunch\(|\brefresh\w*\(|connectFeed\(/.test(resume + called)
        ? []
        : [`${s.file}: resumeForForeground() reads nothing from the server; a launch that went to the background skipped it`]
    })
    expect(offenders).toEqual([])
  })

  it('reads bodies and awaits as Swift writes them', () => {
    const src = 'func initialize() async { await adoptCache(); if x { y() } }\nfunc adoptCache() async { z() }'
    expect(body(src, 'initialize')).toBe(' await adoptCache(); if x { y() } ')
    expect(awaits('await tasks.adoptCache()\nawait connection.refreshStatus()')).toEqual(['tasks.adoptCache', 'connection.refreshStatus'])
  })
})
