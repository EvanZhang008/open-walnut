import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../web/src')
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : []
  })
}

describe('pin and tier writes do not race a timer', () => {
  it('no surface schedules a tier write after a fixed delay', () => {
    const offenders = files(root).filter(p => /setTimeout\([^;\n]*onSetTier/.test(fs.readFileSync(p, 'utf8'))).map(p => path.relative(root, p))
    expect(offenders).toEqual([])
  })

  it('real task menus use the atomic undoable pin action', () => {
    const menu = fs.readFileSync(path.join(root, 'components/tasks/TaskKebabMenu.tsx'), 'utf8')
    expect(menu).toContain('undo.pinToTier(id, t.value)')
    expect(menu).toContain('focusBar.setTierBulk([id], t.value)')
    const undo = fs.readFileSync(path.join(root, 'undo/TaskUndoContext.tsx'), 'utf8')
    const body = undo.slice(undo.indexOf('const pinToTier ='), undo.indexOf('const unpin ='))
    expect(body).toContain('focusBar.setTierBulk([id], tier')
    expect(body).not.toContain('focusBar.pin(')
    expect(body).toContain('else restorePin(id, snap)')
    expect(body).toContain('if (undone) restorePin(id, snap)')
  })
})
