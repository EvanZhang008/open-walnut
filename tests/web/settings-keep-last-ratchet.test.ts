/**
 * A Settings value stays on screen until a newer one comes (2026-11-04, the user: "cache should
 * cache for long tie until the real data come"). The common way to break that is a failed read
 * that clears what the page showed: `.catch(() => setX(null))`, `setX([])` and the like. This scan
 * fails on any such handler in the Settings sections and the hooks they read through; a failed
 * read keeps the old value (`() => {}`, or `setX((x) => x ?? [])` to end a first load) and says
 * the error beside it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The Settings sections, and the hooks they read slow or remote data through.
const ROOTS = ['web/src/components/settings', 'web/src/hooks/useUsageCosts.ts', 'web/src/hooks/useHostStatus.ts', 'web/src/hooks/useSttStatus.ts']
/** A clear that is right, with why: the answer belonged to an input that has since changed. */
const ALLOWED: Record<string, string> = {
  'web/src/components/settings/sections/TaskProvidersSection.tsx:setMatch': 'the match is for the title being typed now; an old match would name the wrong line',
  'web/src/components/settings/sections/ProvidersSection.tsx:setPicked': 'it undoes the pick the person just made when saving it failed',
  'web/src/components/settings/sections/TaskProviderRulesGroup.tsx:setRules': 'the rules are per plugin; a kept value could be another plugin\'s',
}
/** A setter that clears a shown value; clearing an error, a busy or loading flag is not that. */
const CLEAR = /\b(set[A-Z]\w*)\(\s*(?:\(\s*\)\s*=>\s*)?(?:null|undefined|\[\]|\{\})\s*\)/g
const FLAG = /^set(?:\w*Error|Busy|Loading|Saving|Testing|Downloading|Answering|Pending|\w*ing)$/

/** The text of every catch handler: `.catch(...)`'s argument, or a `catch (e) { ... }` block. */
export function catchBodies(src: string): Array<{ at: number; body: string }> {
  const out: Array<{ at: number; body: string }> = []
  const re = /\.catch\s*\(|\bcatch\s*(?:\(\s*\w*\s*\)\s*)?\{/g
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1
    const [o, c] = src[open] === '(' ? ['(', ')'] : ['{', '}']
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === o) depth++
      else if (src[i] === c && --depth === 0) { out.push({ at: m.index!, body: src.slice(open + 1, i) }); break }
    }
  }
  return out
}

export function clearsIn(src: string): Array<{ at: number; setter: string; text: string }> {
  const out: Array<{ at: number; setter: string; text: string }> = []
  for (const { at, body } of catchBodies(src)) {
    for (const m of body.matchAll(CLEAR)) if (!FLAG.test(m[1])) out.push({ at, setter: m[1], text: m[0] })
  }
  return out
}

function files(dir: string): string[] {
  if (!statSync(dir).isDirectory()) return [dir]
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []
  })
}

describe('a failed read never clears what Settings showed', () => {
  it('no catch handler sets a shown value to null, undefined or an empty list', () => {
    const found: string[] = []
    for (const f of ROOTS.flatMap(files)) {
      const src = readFileSync(f, 'utf8')
      for (const c of clearsIn(src)) {
        if (ALLOWED[`${f}:${c.setter}`]) continue
        found.push(`${f}:${src.slice(0, c.at).split('\n').length}: ${c.text}`)
      }
    }
    expect(found).toEqual([])
  })
  it('the scan sees the shapes it bans', () => {
    for (const bad of [
      '.catch(() => setKaStatus(null))', '.catch((err) => { setCounts([]); setError(err) })', '.catch(e => setX(undefined))',
      'try { await load() } catch (e) { log.warn({ a: 1 }); setDevices([]) }', '} catch { setView(() => null) }',
    ]) {
      expect(clearsIn(bad), bad).not.toEqual([])
    }
    for (const ok of [
      '.catch(() => {})', '.catch((err) => { setCounts((c) => c ?? []); setError(err) })',
      'try { save() } catch (err) { setError(String(err)) } finally { setBusy(null) }', '} catch { setLoadError(null) }; setEditingId(null)',
    ]) {
      expect(clearsIn(ok), ok).toEqual([])
    }
  })
})
