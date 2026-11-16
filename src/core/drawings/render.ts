/**
 * A drawing as an SVG picture, so an agent can LOOK at it (pure: no fs, no drawing library).
 *
 * Not a copy of the editor's hand-drawn style: shapes are clean outlines. What must be right is
 * what an agent reasons about: where each shape is, its colours, every line of text, and where
 * each arrow and line runs, with its arrowheads. Covered: rectangle, ellipse, diamond, text
 * (several lines, left/center/right), line and arrow (with heads), freedraw (as a polyline),
 * image (from the scene's own data URL), frame (a dashed box with its name), iframe/embeddable
 * (an outlined box). Deleted elements are skipped. Every value is escaped; a colour that is not
 * a plain colour falls back to the default, so a scene cannot inject markup.
 */

import { pointsExtent } from './elements.js'
import type { DrawingScene, SceneElement } from './scene.js'

const PADDING = 20
/** The longest side of the picture, so a scene spread far apart still renders to a sane size. */
export const MAX_RENDER_SIDE = 4096
const FONT_STACK: Record<number, string> = {
  1: 'Virgil, Segoe Print, Comic Sans MS, sans-serif',
  2: 'Helvetica, Arial, sans-serif',
  3: 'Cascadia Code, Menlo, monospace',
  5: 'Excalifont, Segoe Print, Comic Sans MS, sans-serif',
  6: 'Nunito, Arial, sans-serif',
  7: 'Lilita One, Arial, sans-serif',
  8: 'Comic Shanns, Comic Sans MS, sans-serif',
  9: 'Liberation Sans, Arial, sans-serif',
}

type Obj = Record<string, unknown>

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/

function color(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) return fallback
  return v
}

function fill(v: unknown): string {
  const c = color(v, 'transparent')
  return c === 'transparent' ? 'none' : c
}

function points(el: Obj): Array<[number, number]> {
  const raw = Array.isArray(el.points) ? el.points : []
  return raw
    .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [n(el.x) + p[0], n(el.y) + p[1]])
}

/** The box an element covers (before rotation), in scene coordinates. */
function bounds(el: Obj): [number, number, number, number] {
  if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
    const pts = points(el)
    if (pts.length) {
      const e = pointsExtent(pts)
      return [e.minX, e.minY, e.maxX, e.maxY]
    }
  }
  return [n(el.x), n(el.y), n(el.x) + n(el.width), n(el.y) + n(el.height)]
}

function strokeAttrs(el: Obj): string {
  const width = n(el.strokeWidth, 2)
  const dash = el.strokeStyle === 'dashed' ? ` stroke-dasharray="${width * 4} ${width * 3}"` : el.strokeStyle === 'dotted' ? ` stroke-dasharray="${width} ${width * 2}"` : ''
  return `stroke="${esc(color(el.strokeColor, '#1e1e1e'))}" stroke-width="${width}"${dash}`
}

function common(el: Obj): string {
  const opacity = n(el.opacity, 100)
  const angle = n(el.angle)
  let out = opacity < 100 ? ` opacity="${Math.max(0, opacity) / 100}"` : ''
  if (angle) {
    const cx = n(el.x) + n(el.width) / 2
    const cy = n(el.y) + n(el.height) / 2
    out += ` transform="rotate(${(angle * 180) / Math.PI} ${cx} ${cy})"`
  }
  return out
}

function arrowhead(kind: unknown, tip: [number, number], from: [number, number], el: Obj): string {
  if (typeof kind !== 'string') return ''
  const dx = tip[0] - from[0]
  const dy = tip[1] - from[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const size = Math.min(20, Math.max(8, len / 3)) + n(el.strokeWidth, 2)
  const back: [number, number] = [tip[0] - ux * size, tip[1] - uy * size]
  const wing = size * 0.5
  const left: [number, number] = [back[0] - uy * wing, back[1] + ux * wing]
  const right: [number, number] = [back[0] + uy * wing, back[1] - ux * wing]
  const stroke = strokeAttrs({ ...el, strokeStyle: 'solid' })
  const pt = (p: [number, number]) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`
  if (kind === 'triangle' || kind === 'triangle_outline') {
    return `<polygon points="${pt(tip)} ${pt(left)} ${pt(right)}" fill="${kind === 'triangle' ? esc(color(el.strokeColor, '#1e1e1e')) : 'none'}" ${stroke}/>`
  }
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
    return `<circle cx="${tip[0]}" cy="${tip[1]}" r="${wing}" fill="${kind === 'circle_outline' ? 'none' : esc(color(el.strokeColor, '#1e1e1e'))}" ${stroke}/>`
  }
  if (kind === 'bar') {
    const a: [number, number] = [tip[0] - uy * wing, tip[1] + ux * wing]
    const b: [number, number] = [tip[0] + uy * wing, tip[1] - ux * wing]
    return `<polyline points="${pt(a)} ${pt(b)}" fill="none" ${stroke}/>`
  }
  // arrow, diamond, crowfoot and the rest: an open arrowhead keeps the direction readable.
  return `<polyline points="${pt(left)} ${pt(tip)} ${pt(right)}" fill="none" ${stroke} stroke-linecap="round" stroke-linejoin="round"/>`
}

function textSvg(el: Obj): string {
  const fontSize = n(el.fontSize, 20)
  const lineHeight = n(el.lineHeight, 1.25) * fontSize
  const lines = String(el.text ?? '').split('\n')
  const align = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start'
  const x = el.textAlign === 'center' ? n(el.x) + n(el.width) / 2 : el.textAlign === 'right' ? n(el.x) + n(el.width) : n(el.x)
  const firstBaseline = n(el.y) + (lineHeight - fontSize) / 2 + fontSize * 0.8
  const family = FONT_STACK[n(el.fontFamily, 5)] ?? FONT_STACK[5]!
  const spans = lines.map((line, i) => `<tspan x="${x}" y="${(firstBaseline + i * lineHeight).toFixed(2)}">${esc(line) || ' '}</tspan>`).join('')
  return `<text font-family="${esc(family)}" font-size="${fontSize}" fill="${esc(color(el.strokeColor, '#1e1e1e'))}" text-anchor="${align}" xml:space="preserve"${common(el)}>${spans}</text>`
}

function elementSvg(el: Obj, files: Record<string, unknown>): string {
  const x = n(el.x)
  const y = n(el.y)
  const w = n(el.width)
  const h = n(el.height)
  const shape = `fill="${esc(fill(el.backgroundColor))}" ${strokeAttrs(el)}${common(el)}`
  switch (el.type) {
    case 'rectangle': {
      const r = el.roundness ? Math.min(32, Math.min(w, h) * 0.25) : 0
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${r ? ` rx="${r}"` : ''} ${shape}/>`
    }
    case 'ellipse':
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${shape}/>`
    case 'diamond':
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${shape}/>`
    case 'text':
      return textSvg(el)
    case 'line':
    case 'arrow': {
      const pts = points(el)
      if (pts.length < 2) return ''
      const line = `<polyline points="${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')}" fill="none" ${strokeAttrs(el)} stroke-linecap="round" stroke-linejoin="round"/>`
      const heads = arrowhead(el.endArrowhead, pts[pts.length - 1]!, pts[pts.length - 2]!, el) + arrowhead(el.startArrowhead, pts[0]!, pts[1]!, el)
      return `<g${common(el)}>${line}${heads}</g>`
    }
    case 'freedraw': {
      const pts = points(el)
      if (pts.length < 2) return ''
      return `<polyline points="${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')}" fill="none" ${strokeAttrs({ ...el, strokeStyle: 'solid' })} stroke-linecap="round" stroke-linejoin="round"${common(el)}/>`
    }
    case 'image': {
      const file = typeof el.fileId === 'string' ? files[el.fileId] as Obj | undefined : undefined
      // Raster pictures only: an embedded SVG is a document of its own (script, links, fetches).
      const href = typeof file?.dataURL === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(file.dataURL) ? file.dataURL : null
      if (!href) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#868e96" stroke-dasharray="6 4"/>`
      // The data URL was checked to be base64 only: it needs no escaping (skipping it keeps a big picture cheap).
      return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${href}" preserveAspectRatio="none"${common(el)}/>`
    }
    case 'frame':
    case 'magicframe': {
      const name = typeof el.name === 'string' && el.name ? `<text x="${x}" y="${y - 6}" font-family="Arial, sans-serif" font-size="14" fill="#868e96">${esc(el.name)}</text>` : ''
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#868e96" stroke-dasharray="8 4"/>${name}`
    }
    case 'iframe':
    case 'embeddable':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${shape}/>`
    default:
      return ''
  }
}

export interface RenderedSvg {
  svg: string
  /** The picture's size in pixels (scaled down when the scene is larger than MAX_RENDER_SIDE). */
  width: number
  height: number
}

type RenderInput = Pick<DrawingScene, 'elements' | 'appState' | 'files'>

/** The scene as one standalone SVG document. */
export function renderSceneSvg(scene: RenderInput): RenderedSvg {
  const parts: string[] = []
  const live = liveElements(scene)
  for (const el of live) parts.push(elementSvg(el, scene.files ?? {}))
  return assemble(scene, live, parts)
}

/** Elements drawn per turn of the event loop by renderSceneSvgYielding. */
const RENDER_BATCH = 200

/** renderSceneSvg for the server: it gives the event loop a turn every RENDER_BATCH elements. */
export async function renderSceneSvgYielding(scene: RenderInput): Promise<RenderedSvg> {
  const parts: string[] = []
  const live = liveElements(scene)
  for (let i = 0; i < live.length; i++) {
    parts.push(elementSvg(live[i]!, scene.files ?? {}))
    if (i % RENDER_BATCH === RENDER_BATCH - 1) await new Promise<void>((r) => setImmediate(r))
  }
  return assemble(scene, live, parts)
}

function liveElements(scene: RenderInput): Obj[] {
  return scene.elements.filter((el: SceneElement) => el && el.isDeleted !== true)
}

function assemble(scene: RenderInput, live: Obj[], parts: string[]): RenderedSvg {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of live) {
    const [x1, y1, x2, y2] = bounds(el)
    minX = Math.min(minX, x1); minY = Math.min(minY, y1); maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2)
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 100 }
  minX -= PADDING; minY -= PADDING; maxX += PADDING; maxY += PADDING
  const vw = Math.max(1, maxX - minX)
  const vh = Math.max(1, maxY - minY)
  const scale = Math.min(1, MAX_RENDER_SIDE / Math.max(vw, vh))
  const width = Math.max(1, Math.round(vw * scale))
  const height = Math.max(1, Math.round(vh * scale))
  const background = color((scene.appState as Obj | undefined)?.viewBackgroundColor, '#ffffff')
  const body = parts.filter(Boolean).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${vw} ${vh}">\n`
    + `<rect x="${minX}" y="${minY}" width="${vw}" height="${vh}" fill="${esc(background === 'transparent' ? '#ffffff' : background)}"/>\n${body}\n</svg>\n`
  return { svg, width, height }
}
