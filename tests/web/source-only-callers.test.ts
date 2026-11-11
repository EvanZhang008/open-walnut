/**
 * Only a machine the person named is looked up alone (`sourceOnly`); a known writer's machine is
 * asked FIRST and the user's other machines answer when it lacks the file (files-locate.ts).
 *
 * 2026-11-11, on production: a lead (Walnut VP, on the primary) put a worker's evidence video,
 * recorded on another Mac, into its thread summary. The build before opened it on that Mac; once
 * the writer's machine was looked up alone, the card read "Couldn't find … on Local". Leads and
 * Main relay their workers' paths all the time, so a known writer is never a reason to look alone.
 *
 * Every file of the web app and the iPhone app that sets `sourceOnly` is listed here with why; a new
 * one fails until it is listed, and the openers of a known writer's words must not set it at all.
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

/** A line that gives `sourceOnly` a value (a declaration of its type is not one). */
const SETS = /\bsourceOnly\b\s*(?::|=|\?\s*\{|\)\s*\{|\s+\{)/
const DECLARES = /\bsourceOnly\??\s*:\s*(boolean|Bool)\b/
const settersIn = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter((l) => SETS.test(l) && !DECLARES.test(l) && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('///'))

/** Each file that may set it, and why. */
const ALLOWED: Record<string, string> = {
  'web/src/components/common/FileViewer.tsx': 'a machine the person picked for an unknown writer is looked up alone (`picked ? true`)',
  'web/src/components/common/AnywhereFileViewer.tsx': 'passes a request\'s own flag to the viewer',
  'web/src/components/inbox/LetterReader.tsx': 'passes a letter target\'s own flag to the viewer',
  'web/src/components/sessions/SessionPanel.tsx': 'passes a letter target\'s own flag to the lookup',
  'web/src/hooks/useClickedPathOpener.ts': 'passes the caller\'s context to the lookup',
  'web/src/hooks/useEntityClickHandler.ts': 'a RELATIVE path means something only in its session\'s folder on its host',
  'web/src/components/common/DocCommentCard.tsx': 'another idea: a doc comment shown only in the source view',
  'web/src/components/common/DocCommentsLayer.tsx': 'another idea: a doc comment shown only in the source view',
  'ios-native/Walnut/API/WalnutAPIWave2.swift': 'the request itself',
  'ios-native/Walnut/Views/ClickedPath.swift': 'passes the caller\'s flag to the request',
  'ios-native/Walnut/Views/Sessions/SessionFilesSheet.swift': 'the machine the person tapped is looked up alone',
}

describe('sourceOnly is set only where a person named the machine', () => {
  it('every file that sets it is listed with why', () => {
    const setting = SOURCES.filter((f) => settersIn(f.text).length > 0).map((f) => f.path).sort()
    expect(setting.filter((p) => !ALLOWED[p]), 'sets sourceOnly: a known writer is asked first, never alone; list it here only for a machine the person named').toEqual([])
    // A listed file that no longer sets it leaves the list too, so the list stays the truth.
    expect(Object.keys(ALLOWED).filter((p) => !setting.includes(p)), 'listed but sets nothing').toEqual([])
  })

  it("the openers of a known writer's words never look its machine up alone", () => {
    const openers = [
      'web/src/utils/agent-text-source.ts',
      'web/src/components/inbox/LetterView.tsx',
      'ios-native/Walnut/Views/Sessions/FileSourceLinesView.swift',
    ]
    for (const p of openers) {
      const text = SOURCES.find((f) => f.path === p)?.text
      expect(text, `${p} exists`).toBeDefined()
      expect(settersIn(text!), p).toEqual([])
    }
    // Only the person's own pick or tap is a literal `true`.
    const literal = SOURCES.filter((f) => settersIn(f.text).some((l) => /sourceOnly\s*:\s*true\b/.test(l) && !/\?\s*\{\s*sourceOnly:\s*true\s*\}/.test(l)))
    expect(literal.map((f) => f.path)).toEqual(['ios-native/Walnut/Views/Sessions/SessionFilesSheet.swift'])
  })

  it('catches the shapes it was written for', () => {
    expect(settersIn("deps.open({ ...req, host, sourceOnly: true });")).toHaveLength(1)
    expect(settersIn("await ClickedPath.locate(ref, host: h, cwd: nil, sessionID: nil, sourceOnly: from.hostKnown)")).toHaveLength(1)
    expect(settersIn('  sourceOnly?: boolean;')).toEqual([])
    expect(settersIn('    sessionID: String? = nil, sourceOnly: Bool = false) async throws -> PathLocation {')).toEqual([])
  })
})
