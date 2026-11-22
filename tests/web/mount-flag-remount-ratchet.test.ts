/**
 * Ratchet: a "still mounted" flag (`const live = useRef(true)`, cleared in an effect's cleanup so a
 * late answer is dropped after unmount) is set true again on every mount.
 *
 * 2026-11-21: Settings › Voice Accuracy stayed on its first read's spinner forever. Its flag was
 * cleared by an unmount-only effect (`useEffect(() => () => { live.current = false }, [])`), and
 * StrictMode (development, every fixture server) unmounts and mounts each component once more: the
 * flag stayed false, so every answer, the one that ends the spinner included, was dropped. The same
 * shape sat in the model picker (a refresh never landed) and the mail console (a reconnect never
 * refreshed). A flag a cleanup clears must be set true in the mount that follows.
 *
 * Fails when a file declares a ref with `useRef(true)`, clears it inside an effect cleanup, and
 * never sets it true again. First-render flags cleared in an effect's body are not this class.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve('web/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The flags in one source that a cleanup clears and nothing sets true again. */
function clearedForGood(src: string): string[] {
  const names = [...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?useRef(?:<boolean>)?\(true\)/g)].map((m) => m[1])
  return names.filter((n) => {
    const name = escape(n)
    const inCleanup = new RegExp(`(?:return\\s*\\(\\)\\s*=>|\\(\\)\\s*=>\\s*\\(\\)\\s*=>)\\s*\\{?[^}]*\\b${name}\\.current\\s*=\\s*false`).test(src)
    const setAgain = new RegExp(`\\b${name}\\.current\\s*=\\s*true`).test(src)
    return inCleanup && !setAgain
  })
}

describe('mount flags survive a remount', () => {
  it('finds the shape that froze Voice Accuracy, and passes the fixed one', () => {
    expect(clearedForGood('const live = useRef(true);\nuseEffect(() => () => { live.current = false }, []);')).toEqual(['live'])
    expect(clearedForGood('const a = React.useRef(true);\nuseEffect(() => { go(); return () => { a.current = false; }; }, []);')).toEqual(['a'])
    expect(clearedForGood('const live = useRef(true);\nuseEffect(() => { live.current = true; return () => { live.current = false }; }, []);')).toEqual([])
    // A first-render flag cleared in the effect's body is another thing.
    expect(clearedForGood('const first = useRef(true);\nuseEffect(() => { if (first.current) { first.current = false; return; } run(); }, [x]);')).toEqual([])
  })

  it('every flag a cleanup clears in web/src is set true again on mount', () => {
    const offenders = walk(WEB).flatMap((f) => clearedForGood(fs.readFileSync(f, 'utf-8')).map((n) => `${path.relative(WEB, f)}: ${n}`))
    expect(offenders).toEqual([])
  })
})
