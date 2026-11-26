/**
 * Every UI test starts with no copy of the server's data an earlier test left. UI tests share one
 * simulator and the same fixture ids, and a launch paints each store's disk copy before it asks the
 * server (ios-launch-cache-first-guard.test.ts), so TaskThreadsUITests' Threads-off test opened the
 * Threads sheet over the leader's chat from the copies its sibling had read with Threads on: the
 * cached row said on, and the sheet showed the cached thread under "as the phone last saw them",
 * though this test's server never served one (2026-11-26, CI run 45784774186, ui 4/8).
 *
 * The rule: every launch through UITestLaunch passes its test's own generation id
 * (`TestCacheGeneration`, new at each test case's start); WalnutApp.init, before any store exists,
 * sweeps the app's Caches as a disconnect does when the id is new to the install
 * (`LocalDataReset.eraseCachesForNewUITest`), so a relaunch within the test keeps its own copies.
 * The members are read from source: every store's `adoptCache()` paints only what DiskCache holds
 * (directly or one call deep), and every cache the app keeps on disk lives in Caches, so the sweep
 * covers each; a copy kept anywhere else fails here until it is swept too or named below with why.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { code, swiftFiles } from './ios-timed-hide-scan'
import { body, awaits } from './ios-swift-source'

const IOS = path.resolve(import.meta.dirname, '../../ios-native')
const read = (rel: string) => fs.readFileSync(path.join(IOS, rel), 'utf8')

/** Launch reads that are not a copy of the server's data, so no test inherits one through them. */
const NOT_SERVER_COPIES: Record<string, string> = {
  restoreQueuedSendsFromDisk: 'banked sends the person typed (DurableStore); nothing erases them wholesale',
}

describe('iOS UI tests: no test paints the copies an earlier test left', () => {
  it('every UI test launch passes its test generation, under the name the app reads', () => {
    const launch = read('WalnutUITests/UITestLaunch.swift')
    const name = /static let cacheGenerationArgument = "-([\w.]+)"/.exec(launch)?.[1]
    const appName = /static let uiTestGenerationArgument = "([\w.]+)"/.exec(read('Walnut/Core/LocalDataReset.swift'))?.[1]
    expect(name, 'UITestLaunch.cacheGenerationArgument is gone').toBeTruthy()
    expect(name).toBe(appName)
    const app = code(body(launch, 'app') ?? '')
    expect(app).toMatch(/let generation: \[String\] = \[cacheGenerationArgument,\s*TestCacheGeneration\.current\]/)
    expect(app, 'the generation is built but not launched with').toMatch(/launchArguments\s*=[^;]*\+ generation\b/)
    // A new id per test case, the same id for each launch within it.
    const generation = code(launch.slice(launch.indexOf('final class TestCacheGeneration')))
    expect(generation).toMatch(/func testCaseWillStart\([^)]*\)\s*\{\s*id = nil\s*\}/)
  })

  it('the app sweeps before any store exists, as a plain statement of init', () => {
    const src = code(read('Walnut/App/WalnutApp.swift'))
    // `init` is no `func`: its body from the `init() {` of the App, braces matched.
    const open = src.indexOf('{', src.search(/\binit\(\)\s*\{/))
    let end = open
    for (let depth = 0; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    const init = src.slice(open + 1, end)
    const call = 'LocalDataReset.eraseCachesForNewUITest()'
    const at = init.indexOf(call)
    expect(at, 'WalnutApp.init no longer sweeps an earlier test\'s copies').toBeGreaterThan(0)
    expect(init.search(/\b\w+Store\(\)/), 'a store is made before the sweep').toBeGreaterThan(at)
    // Directly in init's body (inside `#if DEBUG` only): not in a Task, closure or branch that
    // could run after a store has read its copy.
    let depth = 0
    for (const ch of init.slice(0, at)) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    expect(depth, 'the sweep sits inside a block').toBe(0)
    expect(init.slice(0, at).split('\n').pop()!.trim(), 'the sweep is part of a larger expression').toBe('')
    // The same sweep, and the same keep rule, as a disconnect's Caches sweep.
    const reset = read('Walnut/Core/LocalDataReset.swift')
    expect(code(body(reset, 'eraseCachesForNewUITest') ?? '')).toMatch(
      /sweep\(\(explicit \?\? defaultLocations\)\.caches,\s*keep:\s*keepsCacheEntry\)/,
    )
    expect(code(body(reset, 'sweepFolders') ?? '')).toMatch(/sweep\(locations\.caches,\s*keep:\s*keepsCacheEntry\)/)
  })

  it('every cache the app keeps on disk is under Caches', () => {
    const offenders = swiftFiles(path.join(IOS, 'Walnut')).flatMap((f) => {
      const src = code(fs.readFileSync(f, 'utf8'))
      // A cache kept outside Caches would outlive the sweep.
      return /\bcache\w*\s*[:=][^\n]*\.(applicationSupportDirectory|documentDirectory)\b/i.test(src)
        ? [path.relative(IOS, f)]
        : []
    })
    expect(offenders).toEqual([])
    expect(code(read('Walnut/Core/DiskCache.swift'))).toMatch(/urls\(for:\s*\.cachesDirectory/)
  })

  it('every store paints only what DiskCache holds at launch', () => {
    const sources = swiftFiles(path.join(IOS, 'Walnut')).map((f) => code(fs.readFileSync(f, 'utf8')))
    const bodies = (name: string) => sources.map((s) => body(s, name)).filter((b): b is string => b !== null)
    const stores = fs.readdirSync(path.join(IOS, 'Walnut/Stores')).filter((f) => f.endsWith('.swift'))
    const offenders: string[] = []
    let guarded = 0
    for (const file of stores) {
      const adopt = body(code(fs.readFileSync(path.join(IOS, 'Walnut/Stores', file), 'utf8')), 'adoptCache')
      if (adopt === null) continue
      guarded++
      for (const call of awaits(adopt)) {
        if (call === 'DiskCache.loadAsync') continue
        const name = call.split('.').pop()!
        if (NOT_SERVER_COPIES[name]) continue
        const fromCache = bodies(name).some(
          (b) => /\bDiskCache\.loadAsync\b/.test(b) && !/\b(UserDefaults|DurableStore|FileManager)\b|contentsOf:/.test(b),
        )
        if (!fromCache) offenders.push(`${file}: adoptCache() awaits ${call}, which reads a launch copy DiskCache does not hold`)
      }
    }
    expect(guarded, 'no store with adoptCache() found: the launch this guards moved').toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })
})
