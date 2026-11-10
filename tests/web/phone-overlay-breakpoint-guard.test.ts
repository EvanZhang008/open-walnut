/**
 * Leaving the phone layout (a wider window) closes every phone layer (usePhoneOverlayHistory.ts
 * closeAllForBreakpoint, onClose with `breakpoint: true`). For a layer that is the same thing on the
 * desktop and holds work a close would end, that is a loss: 2026-11-10, widening the Mac app's
 * window closed a plugin dialog mid sign-in and cancelled the sign-in. Every owner of a phone layer
 * is listed here with what it does on that close, and a new owner fails until it is listed. Owners call
 * usePhoneOverlay or its wrapper usePhoneLayerWithBar (phone-session-layer.tsx, itself not an owner).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../web/src')
/** Owners whose layer stays open across the breakpoint: their onClose ignores `info.breakpoint`. */
const KEEPS: Record<string, string> = {
  'plugins/PluginDialogHost.tsx': 'the same modal on the desktop; closing it ends the plugin\'s work (a sign-in)',
  'components/sessions/SessionPanel.tsx': 'the split view is the same on the desktop',
  'components/tasks/TaskDetailModal.tsx': 'the same task modal on the desktop, with anything half typed in it',
  'components/sessions/DraftSessionPanel.tsx': 'a new session being written; the desktop shows it as a column',
}
/** Owners whose layer closes: the desktop draws it differently or not at all, and it holds no work a close would end. */
const CLOSES: Record<string, string> = {
  'components/settings/usePhoneSettingsPane.ts': 'a phone-only pane of Settings',
  'components/tasks/PhoneSearchLayer.tsx': 'phone-only search layer',
  'components/tasks/PhonePhaseSheet.tsx': 'phone-only phase picker',
  'components/chat/AskWalnutSlot.tsx': 'the asks drawer and the phone chat page, both phone-only layouts',
  'components/layout/AppShell.tsx': 'the phone navigation drawer',
  'components/common/NotificationPanel.tsx': 'the desktop has its own popover',
  'components/common/PhoneConfirmSheet.tsx': 'a phone-only confirm; a close is a cancel',
  'components/sessions/PromptCards.tsx': 'the full plan view, a phone-only reader',
  'components/sessions/SessionFileExplorer.tsx': 'the phone file view; the desktop shows the file beside the tree',
  'components/notes/usePhoneNoteLayer.tsx': 'phone-only note layer; the desktop shows tree and note side by side',
  'pages/CalendarPage.tsx': 'the phone calendar rail',
  'apps/mail/MailReader.tsx': 'the desktop shows the reader pane beside the list',
}

function files(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('phone layers across the breakpoint', () => {
  const owners = files(ROOT)
    .filter((f) => !f.endsWith(path.join('hooks', 'usePhoneOverlayHistory.ts')) && !f.endsWith(path.join('sessions', 'phone-session-layer.tsx')))
    .filter((f) => /\busePhone(?:Overlay|LayerWithBar)\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))

  it('every owner of a phone layer says whether it stays open when the window widens', () => {
    const unlisted = owners.filter((f) => !(f in KEEPS) && !(f in CLOSES))
    expect(unlisted, 'list each new phone layer owner in KEEPS or CLOSES with why').toEqual([])
    const gone = [...Object.keys(KEEPS), ...Object.keys(CLOSES)].filter((f) => !owners.includes(f))
    expect(gone, 'a listed owner no longer uses usePhoneOverlay: remove it').toEqual([])
  })

  it('an owner listed as staying open ignores the breakpoint close', () => {
    for (const f of Object.keys(KEEPS)) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/info\.breakpoint/)
    }
  })
})
