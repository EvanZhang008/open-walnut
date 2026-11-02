/**
 * Every surface that opens a path in a viewer looks it up first.
 *
 * A session on one host often names a file on another (a Mac handoff, a video
 * recorded on the Mac). A viewer opened straight on the session's host sent
 * those clicks to a folder that does not exist there, healed to `/`
 * (2026-11-01). The lookup is useClickedPathOpener / locateClickedPath
 * (web/src/hooks/useClickedPathOpener.ts); this enumerates every file under
 * web/src that opens a path viewer (renders the Files explorer or opens a file
 * popout) and fails on one that neither looks up nor is listed below with why.
 *
 * The phone has the same rule: ClickedPath.locate (ios-native/Walnut/Views/
 * ClickedPath.swift) is the one place a tapped path becomes a sheet target, so
 * a Swift file that builds one itself is caught below.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(__dirname, '../..')

/** Opens a viewer on a path that did NOT come from a click, so it needs no lookup. */
const EXEMPT: Record<string, string> = {
  'web/src/components/sessions/SessionFileExplorer.tsx': 'the explorer itself; its popout opens a file from its own tree, on its own host',
  'web/src/components/common/FileContentView.tsx': 'the preview; its popout opens the file it already shows, on its host',
  'web/src/plugins/views.tsx': 'the plugin view registry: a plugin passes its own folder and host',
}

const OPENS_VIEWER = /<SessionFileExplorer\b|openPopout\(\s*['"]file['"]/
const LOOKS_UP = /\buseClickedPathOpener\(|\blocateClickedPath\(/

function webSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'web/src/*.ts', 'web/src/*.tsx'], {
    cwd: REPO, encoding: 'utf-8', maxBuffer: 32 << 20,
  })
  return out.split('\0').filter((f) => f && fs.existsSync(path.join(REPO, f)))
}

describe('clicked paths are looked up before a viewer opens', () => {
  const openers = webSources().filter((f) => OPENS_VIEWER.test(fs.readFileSync(path.join(REPO, f), 'utf-8')))

  it('finds the known openers (the scan itself works)', () => {
    expect(openers).toContain('web/src/components/sessions/SessionPanel.tsx')
    expect(openers).toContain('web/src/components/common/FileViewer.tsx')
  })

  it('every opener looks the path up or is exempt with a reason', () => {
    const offenders = openers.filter((f) => !EXEMPT[f] && !LOOKS_UP.test(fs.readFileSync(path.join(REPO, f), 'utf-8')))
    expect(offenders, `open a clicked path through useClickedPathOpener, or list the file in EXEMPT with why`).toEqual([])
  })

  it('every exemption still opens a viewer (no stale entries)', () => {
    for (const f of Object.keys(EXEMPT)) expect(openers, f).toContain(f)
  })
})

/** Builds a sheet target from a path it did NOT get from a tap. */
const IOS_EXEMPT: Record<string, string> = {
  'ios-native/Walnut/Views/ClickedPath.swift': 'the lookup itself',
  'ios-native/Walnut/Views/HTMLFilePreview.swift': 'the HTML preview names the file it already shows (its dock seat)',
  'ios-native/Walnut/Timeline/TimelineCollectionController.swift': 'only parses the tap and hands it to its body as .previewFile, which looks it up',
}
const IOS_BUILDS_TARGET = /\b(DirectoryTarget|FilePreviewTarget|TextFileTarget)\(/
const IOS_TAP_ROUTER = /case \.previewFile\(|FilePreviewLink\.reference\(from:/

function iosSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'ios-native/Walnut/*.swift'], {
    cwd: REPO, encoding: 'utf-8', maxBuffer: 32 << 20,
  })
  return out.split('\0').filter((f) => f && fs.existsSync(path.join(REPO, f)))
}

describe('iOS: tapped paths are looked up before a sheet opens', () => {
  const files = iosSources().map((f) => ({ f, src: fs.readFileSync(path.join(REPO, f), 'utf-8') }))

  it('finds the tap routers (the scan itself works)', () => {
    const routers = files.filter(({ src }) => IOS_TAP_ROUTER.test(src)).map(({ f }) => f)
    expect(routers).toEqual(expect.arrayContaining([
      'ios-native/Walnut/Timeline/SessionTimelineBody.swift',
      'ios-native/Walnut/Timeline/ChatTimelineBody.swift',
      'ios-native/Walnut/Views/Sessions/FileSourceLinesView.swift',
    ]))
  })

  it('no file but the lookup builds a sheet target', () => {
    const offenders = files
      .filter(({ f, src }) => !IOS_EXEMPT[f] && src.split('\n').some((l) => IOS_BUILDS_TARGET.test(l) && !/^\s*(\/\/|struct |init\()/.test(l)))
      .map(({ f }) => f)
    expect(offenders, 'route a tapped path through ClickedPath.locate, or list the file in IOS_EXEMPT with why').toEqual([])
  })

  it('every tap router goes through ClickedPath.locate', () => {
    const offenders = files.filter(({ f, src }) => IOS_TAP_ROUTER.test(src) && !IOS_EXEMPT[f] && !/ClickedPath\.locate\(/.test(src)).map(({ f }) => f)
    expect(offenders).toEqual([])
  })
})
