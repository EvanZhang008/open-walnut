/**
 * The rules of the one tree by project (src/core/artifacts/unify/layout.ts): where each old place
 * of the notes vault and of the artifacts folder goes, collisions, drawings, and the way back.
 */
import { describe, it, expect } from 'vitest'
import {
  artifactRules, invertMap, mapPath, planArtifacts, planVault, projectDirOf, vaultRules,
} from '../../../src/core/artifacts/unify/layout.js'

const projects = ['Marina', 'Lagoon Work', 'Seawall', 'seawall']
const rules = vaultRules({ topFolders: ['marina', 'family', 'Projects', 'inbox', '.trash'], projectsFolders: ['Marina', 'Seawall', 'Tide'], projects })

describe('the vault', () => {
  it('puts a project\'s folders in its notes and keeps every other path under the root notes', () => {
    const map = { exact: {}, rules }
    expect(mapPath('Projects/Marina/Tracking.md', map)).toBe('projects/Marina/notes/Tracking.md')
    expect(mapPath('marina/plan/a.md', map)).toBe('projects/Marina/notes/plan/a.md')
    expect(mapPath('family/kids.md', map)).toBe('notes/family/kids.md')
    expect(mapPath('dd.md', map)).toBe('notes/dd.md')
    // A Projects/ folder no project is named for is still a project folder.
    expect(mapPath('Projects/Tide/x.md', map)).toBe('projects/Tide/notes/x.md')
    // A note an offline host writes later, never listed, maps the same way.
    expect(mapPath('marina/new-from-phone.md', map)).toBe('projects/Marina/notes/new-from-phone.md')
  })

  it('prefers the project named exactly like a folder, and leaves unmatched and hidden folders at the root', () => {
    const r = vaultRules({ topFolders: ['Seawall', 'seawall', '.obsidian', 'Lagoon Work'], projectsFolders: [], projects })
    const map = { exact: {}, rules: r }
    expect(mapPath('Seawall/a.md', map)).toBe('projects/Seawall/notes/a.md')
    expect(mapPath('seawall/a.md', map)).toBe('projects/seawall/notes/a.md')
    expect(mapPath('Lagoon Work/a.md', map)).toBe('projects/Lagoon Work/notes/a.md')
    expect(mapPath('.obsidian/app.json', map)).toBe('notes/.obsidian/app.json')
  })

  it('keeps both files when two old places meet, numbering the later, letter case aside', () => {
    const plan = planVault(['marina/Tracking.md', 'Projects/Marina/Tracking.md', 'marina/plan.md', 'marina/PLAN.MD'], rules)
    const to = Object.fromEntries(plan.moves)
    expect(to['Projects/Marina/Tracking.md']).toBe('projects/Marina/notes/Tracking.md')
    expect(to['marina/Tracking.md']).toBe('projects/Marina/notes/Tracking 2.md')
    expect(to['marina/PLAN.MD']).toBe('projects/Marina/notes/PLAN.MD')
    expect(to['marina/plan.md']).toBe('projects/Marina/notes/plan 2.md')
    expect(plan.exact).toEqual({ 'marina/Tracking.md': 'projects/Marina/notes/Tracking 2.md', 'marina/plan.md': 'projects/Marina/notes/plan 2.md' })
    expect(new Set(plan.moves.map(([, t]) => t.toLowerCase())).size).toBe(plan.moves.length)
  })

  it('moves a drawing\'s files together to its project\'s drawings, the task folder kept', () => {
    const files = [
      'Projects/Marina/Pier review (t-1)/Flow.excalidraw', 'Projects/Marina/Pier review (t-1)/Flow.drawing.md',
      'Projects/Marina/Pier review (t-1)/Flow.narration.json', 'inbox/Sketch.excalidraw', 'inbox/Sketch.drawing.md',
      'inbox/Loose idea (t-2)/Map.excalidraw', 'Projects/Marina/Pier review (t-1)/notes.md',
    ]
    const to = Object.fromEntries(planVault(files, rules).moves)
    expect(to['Projects/Marina/Pier review (t-1)/Flow.excalidraw']).toBe('projects/Marina/drawings/Pier review (t-1)/Flow.excalidraw')
    expect(to['Projects/Marina/Pier review (t-1)/Flow.narration.json']).toBe('projects/Marina/drawings/Pier review (t-1)/Flow.narration.json')
    expect(to['inbox/Sketch.drawing.md']).toBe('drawings/Sketch.drawing.md')
    expect(to['inbox/Loose idea (t-2)/Map.excalidraw']).toBe('drawings/Loose idea (t-2)/Map.excalidraw')
    expect(to['Projects/Marina/Pier review (t-1)/notes.md']).toBe('projects/Marina/notes/Pier review (t-1)/notes.md')
  })

  it('numbers a drawing\'s files together when its new place is taken', () => {
    const plan = planVault(['inbox/Sketch.excalidraw', 'inbox/Sketch.drawing.md', 'Projects/Marina/Sketch.excalidraw'], vaultRules({ topFolders: [], projectsFolders: [], projects: [] }))
    const to = Object.fromEntries(plan.moves)
    expect(to['Projects/Marina/Sketch.excalidraw']).toBe('drawings/Projects/Marina/Sketch.excalidraw')
    expect(to['inbox/Sketch.excalidraw']).toBe('drawings/Sketch.excalidraw')
  })
})

describe('the artifacts folder', () => {
  const nodes = [{ id: 'vp-1', project: 'Marina' }, { id: 't-2', project: 'Marina' }, { id: 'main', project: '' }]
  const ar = artifactRules(nodes)

  it('files each task under its project, or the root when it has none', () => {
    const map = { exact: {}, rules: ar }
    expect(mapPath('nodes/vp-1/MEMORY.md', map)).toBe('projects/Marina/memory/vp-1/MEMORY.md')
    expect(mapPath('nodes/vp-1/reflections/2026-11-19.md', map)).toBe('projects/Marina/memory/vp-1/reflections/2026-11-19.md')
    expect(mapPath('nodes/vp-1/skills/pier-steps/SKILL.md', map)).toBe('projects/Marina/skills/pier-steps/SKILL.md')
    expect(mapPath('nodes/main/MEMORY.md', map)).toBe('memory/main/MEMORY.md')
    expect(mapPath('nodes/main/skills/x/SKILL.md', map)).toBe('memory/main/skills/x/SKILL.md')
    expect(mapPath('org/skills/proof-video/SKILL.md', map)).toBe('skills/proof-video/SKILL.md')
    expect(mapPath('shared/notes/skills-index.md', map)).toBe('memory/_shared/notes/skills-index.md')
    expect(projectDirOf('')).toBeNull()
  })

  it('gives a skill a new name when two tasks of one project have it', () => {
    const plan = planArtifacts(['nodes/vp-1/skills/pier-steps/SKILL.md', 'nodes/t-2/skills/pier-steps/SKILL.md', 'nodes/t-2/skills/other/SKILL.md'], ar)
    const to = Object.fromEntries(plan.moves)
    expect(to['nodes/t-2/skills/pier-steps/SKILL.md']).toBe('projects/Marina/skills/pier-steps/SKILL.md')
    expect(to['nodes/vp-1/skills/pier-steps/SKILL.md']).toBe('projects/Marina/skills/pier-steps-2/SKILL.md')
    expect(plan.exact).toEqual({ 'nodes/vp-1/skills/pier-steps/SKILL.md': 'projects/Marina/skills/pier-steps-2/SKILL.md' })
  })
})

describe('the way back', () => {
  it('maps every moved path back to where it was', () => {
    const files = ['Projects/Marina/Tracking.md', 'marina/Tracking.md', 'marina/a.md', 'family/b.md', 'inbox/Sketch.excalidraw']
    const plan = planVault(files, rules)
    const back = invertMap({ exact: plan.exact, rules }, plan.moves)
    for (const [from, to] of plan.moves) expect(mapPath(to, back), to).toBe(from)
    // A note made after the move, in a folder two old ones met in, goes back to the Projects/ one.
    expect(mapPath('projects/Marina/notes/new.md', back)).toBe('Projects/Marina/new.md')
    expect(mapPath('notes/family/new.md', back)).toBe('family/new.md')
  })
})
