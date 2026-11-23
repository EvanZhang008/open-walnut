/**
 * Walnut finds which machine a clicked path is on; it never asks the person to pick one.
 *
 * 2026-11-23, Evan, on a Threads card whose summary's writer Walnut had not recorded: the viewer
 * read "Couldn't find … on home-pc" over a row of machine buttons. "Why walnut not auto pic the host
 * it need me to pick bro", "or which task it is acutlaly", "then waln ut will take care find it".
 * A writer that is unknown, a session that is gone or cannot be read, or several writers on several
 * machines now look the path up on every machine (files-locate.ts `anywhere`), the task the words
 * belong to first.
 *
 * The class is every surface that, for a path, asks the person which machine has it. This scans
 * every file of the web app and the iPhone app for the words such a question is made of and for the
 * pieces that drew one (the viewer's machine row, the per-tab memory of a pick, the Board's and the
 * Brief's chooser); a new one fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p, ext))
    else if (ext.test(name)) out.push(p)
  }
  return out
}

const SOURCES = [
  ...files(join(ROOT, 'web/src'), /\.(ts|tsx)$/),
  ...files(join(ROOT, 'ios-native/Walnut'), /\.swift$/),
  ...files(join(ROOT, 'ios-native/Shared'), /\.swift$/),
].map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }))

/** Words of a question to the person about which machine has a file. */
const ASKS = [
  /choose a machine/i,
  /pick the machine/i,
  /choose the machine/i,
  /path'?s source/i,
  /will not guess which machine/i,
  /so walnut will not guess/i,
  /it will not guess which machine/i,
]

/** Pieces that drew such a question. */
const PIECES = [
  /\bPathSourceChooser\b/,
  /\brememberedMachine\b/,
  /walnut\.pathMachine/,
  /\bSourceChoices\b/,
  /\bsourceFailureNeedsPick\b/,
  /data-testid="file-source-(choice|local|host)"/,
]

/** Files still asking, each with why, until they are moved to the lookup on every machine. */
const NOT_YET: Record<string, string> = {}

const hits = (res: RegExp[]) => SOURCES
  .filter((f) => res.some((re) => f.text.split('\n').some((l) => re.test(l))))
  .map((f) => f.path)
  .sort()

describe('a clicked path is found, never asked about', () => {
  it('no surface asks the person which machine has a file', () => {
    const asking = [...new Set([...hits(ASKS), ...hits(PIECES)])].sort()
    expect(asking.filter((p) => !NOT_YET[p]), 'asks which machine has a path: look it up on every machine instead (anywhereRequest / files-locate `anywhere`)').toEqual([])
    expect(Object.keys(NOT_YET).filter((p) => !asking.includes(p)), 'listed but no longer asks: drop it from NOT_YET').toEqual([])
  })

  it('the web openers of an unknown writer hand the path to the lookup on every machine', () => {
    for (const p of [
      'web/src/utils/agent-text-source.ts',
      'web/src/hooks/useAgentFileOpener.ts',
      'web/src/components/org/useBriefFileOpener.tsx',
      'web/src/components/board/TaskBoardPane.tsx',
    ]) {
      const text = SOURCES.find((f) => f.path === p)?.text
      expect(text, `${p} exists`).toBeDefined()
      expect(text!, `${p} opens an unknown writer's path on every machine`).toMatch(/\banywhereRequest\(/)
    }
  })

  it('the line for a path no machine had names who was asked and who did not answer, never "this machine" for no one', async () => {
    const { missingPathLine } = await import('../../web/src/hooks/useClickedPathOpener')
    expect(missingPathLine('/a/b', ['Local', 'Dev box'], true)).toBe("Couldn't find /a/b on Local or Dev box.")
    expect(missingPathLine('/a/b', ['Local'], true, ['home-pc'])).toBe("Couldn't find /a/b on Local. home-pc did not answer, so the file may be there.")
    expect(missingPathLine('/a/b', [], true, ['home-pc', 'Dev box'])).toBe("Couldn't look for /a/b: home-pc or Dev box did not answer, so the file may be there.")
    expect(missingPathLine('/a/b', [], true)).toBe("Couldn't look for /a/b: no machine could be asked.")
    expect(missingPathLine('src/a.ts', [], true)).toMatch(/relative path/)
    // A named machine's miss reads as before.
    expect(missingPathLine('/a/b', ['Dev box'])).toBe("Couldn't find /a/b on Dev box.")
  })

  it('catches the shapes it was written for', () => {
    const asks = (line: string) => [...ASKS, ...PIECES].some((re) => re.test(line))
    expect(asks('<div className="file-viewer-source-choices-title">Choose a machine</div>')).toBe(true)
    expect(asks('Label("Choose a machine", systemImage: "desktopcomputer")')).toBe(true)
    expect(asks("title=\"Choose the path's source\"")).toBe(true)
    expect(asks('import { PathSourceChooser } from "x"')).toBe(true)
    expect(asks('Opened on Local.')).toBe(false)
  })
})
