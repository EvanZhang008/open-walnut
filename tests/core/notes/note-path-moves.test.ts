/**
 * Where an old note path lives once the notes are in the one tree (src/core/notes/note-path-moves.ts):
 * a path in the tree's terms is its own place, an old one maps by the record (exact entries first,
 * asked with or without ".md"), and asking twice changes nothing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { movedNotePath, setNoteMoves } from '../../../src/core/notes/note-path-moves.js'

const map = {
  exact: { 'marina/Tracking.md': 'projects/Marina/notes/Tracking 2.md', 'memory/kids.md': 'notes/memory/kids.md' },
  rules: [
    { from: 'Projects/Marina/', to: 'projects/Marina/notes/' },
    { from: 'marina/', to: 'projects/Marina/notes/' },
    { from: '', to: 'notes/' },
  ],
}

afterEach(() => setNoteMoves(null))

describe('an old note path', () => {
  it('is its own place before the move', () => {
    expect(movedNotePath('family/kids.md')).toBe('family/kids.md')
  })

  it('maps to the tree once the record is set, and the tree\'s own paths stay as they are', () => {
    setNoteMoves(map)
    expect(movedNotePath('family/kids.md')).toBe('notes/family/kids.md')
    expect(movedNotePath('marina/plan.md')).toBe('projects/Marina/notes/plan.md')
    expect(movedNotePath('Projects/Marina/x.md')).toBe('projects/Marina/notes/x.md')
    expect(movedNotePath('notes/family/kids.md')).toBe('notes/family/kids.md')
    expect(movedNotePath('projects/Marina/notes/new.md')).toBe('projects/Marina/notes/new.md')
    expect(movedNotePath('memory/t-1/MEMORY.md')).toBe('memory/t-1/MEMORY.md')
    // An old folder named like one of the tree's own: the tree's path wins, so the index and the
    // watcher never land on another note (an old link into that folder reads as a tree path).
    expect(movedNotePath('memory/kids.md')).toBe('memory/kids.md')
    // A project made after the move: its tracking folder is its folder in the tree.
    expect(movedNotePath('Projects/Lagoon/plan.md')).toBe('projects/Lagoon/notes/plan.md')
    expect(movedNotePath('Projects/Lagoon/Pier (t-9)/scene.excalidraw')).toBe('projects/Lagoon/drawings/Pier (t-9)/scene.excalidraw')
  })

  it('finds a renamed note asked with or without ".md"', () => {
    setNoteMoves(map)
    expect(movedNotePath('marina/Tracking.md')).toBe('projects/Marina/notes/Tracking 2.md')
    expect(movedNotePath('marina/Tracking')).toBe('projects/Marina/notes/Tracking 2')
  })

  it('changes nothing when asked twice', () => {
    setNoteMoves(map)
    for (const p of ['family/kids.md', 'marina/Tracking.md', 'marina/Tracking', 'Projects/Marina/x.md', 'dd.md', 'memory/kids.md']) {
      expect(movedNotePath(movedNotePath(p)), p).toBe(movedNotePath(p))
    }
  })
})
