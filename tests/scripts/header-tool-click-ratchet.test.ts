/**
 * A browser spec presses a session header's Files key through `pressHeaderTool(page, panel, 'files')`
 * (tests/e2e/browser/header-tool-helpers.ts), which takes the key on the row or its row in the
 * header's "..." menu, whichever the layout shows. The header folds keys into that menu when the
 * row is too narrow (useSessionHeaderFit.ts), and the keys are the button family's width since
 * 2026-11-22: with a second Home column, Files folded and fullscreen-yields-to-column-open waited
 * out its click on the hidden key (2026-11-23). The same fix as the Board chip's
 * (board-chip-click-ratchet.test.ts).
 *
 * The direct presses that exist today (one-column layouts, where Files stays on the row) are
 * counted here and may only fall: move a spec to pressHeaderTool, then lower its count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../e2e/browser')
const HELPER = 'header-tool-helpers.ts'

/** Direct presses of the header's Files key per file, as of 2026-11-23. Counts only fall. */
const PINNED: Record<string, number> = {
  'ask-about-this-focus.spec.ts': 1,
  'changed-code-intel.spec.ts': 1,
  'chat-reading.spec.ts': 1,
  'escape-key-editor.spec.ts': 1,
  'file-angle-brackets.spec.ts': 1,
  'file-doc-bar-demo.spec.ts': 1,
  'file-doc-bar.spec.ts': 1,
  'file-draft-persistence.spec.ts': 2,
  'file-explorer-live-directory.spec.ts': 1,
  'file-explorer-mutations.spec.ts': 1,
  'file-explorer-reconnect-retry.spec.ts': 3,
  'file-explorer-refresh.spec.ts': 1,
  'file-explorer-tree-collapse.spec.ts': 3,
  'file-history.spec.ts': 1,
  'file-html-preview-links.spec.ts': 1,
  'file-html-preview-state.spec.ts': 1,
  'file-html-preview-storage.spec.ts': 1,
  'file-image-refresh.spec.ts': 1,
  'file-live-edit-inflight.spec.ts': 1,
  'file-live-edit-markdown.spec.ts': 1,
  'file-live-edit-offline.spec.ts': 1,
  'file-live-edit.spec.ts': 1,
  'file-markdown-copy.spec.ts': 1,
  'file-open-instant.spec.ts': 1,
  'file-panel-tour.spec.ts': 2,
  'file-preview-kinds.spec.ts': 1,
  'file-search-and-references.spec.ts': 1,
  'file-selection-dismiss.spec.ts': 2,
  'file-stale-writeback.spec.ts': 1,
  'file-view-history.spec.ts': 4,
  'file-view-resume.spec.ts': 2,
  'first-use-files.spec.ts': 18,
  'fullscreen-close-exits-fullscreen.spec.ts': 1,
  'home-divider-follows-pointer.spec.ts': 1,
  'notes-sync-cross-surface.spec.ts': 1,
  'panel-resize-drag.spec.ts': 1,
  'pdf-preview.spec.ts': 1,
  'session-error-banner-layout.spec.ts': 1,
  'session-file-questions.spec.ts': 1,
  'session-thread-mark-live.spec.ts': 1,
  'task-board-items.spec.ts': 3,
  'task-board-view.spec.ts': 1,
  'time-tracking-views.spec.ts': 1,
  'todo-panel-helpers.ts': 1,
}

const DIRECT = /getByRole\(\s*'button',\s*\{\s*name:\s*'Files',\s*exact:\s*true\s*\}\s*\)\s*\.(?:click|tap|dblclick)\(/g

export function filesPresses(text: string): number {
  return (text.match(DIRECT) ?? []).length
}

describe('a spec that opens a session header tool', () => {
  it('presses Files through pressHeaderTool; the direct presses only fall', () => {
    const grew: string[] = []
    const fell: string[] = []
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== HELPER)) {
      const n = filesPresses(fs.readFileSync(path.join(DIR, file), 'utf8'))
      const was = PINNED[file] ?? 0
      if (n > was) grew.push(`${file}: ${n} (pinned ${was})`)
      if (n < was) fell.push(`${file}: ${n} (pinned ${was}): lower PINNED`)
    }
    expect(grew, "press the header's Files key with pressHeaderTool(page, panel, 'files')").toEqual([])
    expect(fell).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(filesPresses("  await panel.getByRole('button', { name: 'Files', exact: true }).click()")).toBe(1)
    expect(filesPresses("  await pressHeaderTool(page, panel, 'files')")).toBe(0)
  })
})
