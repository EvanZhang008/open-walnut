/**
 * The parts of a Drawing scene both sides need, with no Node import, so the server
 * (scene.ts, the companion note, agents' reads) and the browser's drawing editor
 * (web/src/components/drawing/drawing-scene.ts) answer them the same way: what a new scene
 * holds, and which words a scene shows.
 */

export const SCENE_TYPE = 'excalidraw'
export const SCENE_VERSION = 2
export const SCENE_SOURCE = 'walnut'

/** The appState keys the library keeps in an exported file (cleanAppStateForExport), at their defaults. */
export function emptySceneValue(): {
  type: typeof SCENE_TYPE; version: number; source: string
  elements: Array<Record<string, unknown> & { id: string; type: string }>
  appState: Record<string, unknown>; files: Record<string, unknown>
} {
  return {
    type: SCENE_TYPE,
    version: SCENE_VERSION,
    source: SCENE_SOURCE,
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

/** The visible words of a scene, top to bottom then left to right: what the companion note carries. */
export function sceneText(scene: { elements: ReadonlyArray<Record<string, unknown>> }): string[] {
  const items: Array<{ x: number; y: number; text: string }> = []
  for (const el of scene.elements) {
    if (!el || el.isDeleted === true) continue
    let text: unknown
    if (el.type === 'text') text = typeof el.originalText === 'string' && el.originalText ? el.originalText : el.text
    else if (el.type === 'frame' || el.type === 'magicframe') text = el.name
    if (typeof text !== 'string') continue
    const flat = text.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    items.push({ x: Number(el.x) || 0, y: Number(el.y) || 0, text: flat })
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  return items.map((i) => i.text)
}
