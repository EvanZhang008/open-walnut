/**
 * How the agent's cursor looks (page-cursor.ts draws it). Four designs in Walnut's own colors, each
 * bigger than a system pointer (about 40 px), with a white outline and a soft shadow so it reads on
 * white, dark and busy pages, a "Walnut" tag beside it, a click animation of its own, and a short
 * tilt while it glides. None is shaped like the person's own arrow pointer. All of it is inline SVG
 * and CSS for a closed shadow root: no external asset, no inline handler, no style attribute (only
 * CSSOM writes), so a page's CSP has nothing to refuse.
 *
 * The one shipped by default is DEFAULT_CURSOR_STYLE; the person can pick another in the popup's
 * Settings, stored as `settings.cursorStyle` in storage.local (page-cursor.ts reads it).
 *
 * Every look is drawn so that its tip, the point the agent acts on, is the box's (0, 0): `tip`
 * names it in the picture's own pixels and the shared rules place the picture from it.
 */

export const CURSOR_STYLES = ['nut', 'badge', 'arrow', 'paw'] as const
export type CursorStyle = typeof CURSOR_STYLES[number]
/** The shipped look: change this one line to ship another. */
export const DEFAULT_CURSOR_STYLE: CursorStyle = 'badge'
export const CURSOR_STYLE_LABELS: Record<CursorStyle, string> = {
  nut: 'Walnut buddy',
  badge: 'Walnut badge',
  arrow: 'Amber dart',
  paw: 'Squirrel paw',
}
export const isCursorStyle = (v: unknown): v is CursorStyle => typeof v === 'string' && (CURSOR_STYLES as readonly string[]).includes(v)
/**
 * The look stored settings ask for. An extension before `cursorStyleChosen` saved its default
 * ('nut') with every setting change, so a stored 'nut' counts only when the person picked it; any
 * other stored look could only come from a pick and is kept.
 */
export function storedCursorStyle(settings: unknown): CursorStyle {
  const s = (settings ?? {}) as { cursorStyle?: unknown; cursorStyleChosen?: unknown }
  if (!isCursorStyle(s.cursorStyle)) return DEFAULT_CURSOR_STYLE
  return s.cursorStyle === 'nut' && s.cursorStyleChosen !== true ? DEFAULT_CURSOR_STYLE : s.cursorStyle
}

/** How long a click's animation runs. */
export const CLICK_MS = 520
const SVG_NS = 'http://www.w3.org/2000/svg'

type Kid = Element | null
interface Look {
  /** The tip, in the picture's own pixels: the picture is placed (and leans and presses) around it. */
  tip: [number, number]
  /** The picture, the click effects drawn under it, and this look's own rules. */
  art: (s: Svg) => Element
  fx: (s: Svg) => Kid[]
  css: string
  /** Where the tag sits from the tip. */
  tag: [number, number]
}
type Svg = (tag: string, attrs?: Record<string, string | number>, ...kids: Kid[]) => Element

const WHITE_EDGE = { fill: '#fff', stroke: '#fff', 'stroke-width': 5, 'stroke-linejoin': 'round' }
const DARK_EDGE = { fill: 'none', stroke: 'rgba(28,16,6,.28)', 'stroke-width': 6.6, 'stroke-linejoin': 'round' }

/** Walnut's mark (web/public/walnut-icon.png): half a brain, half circuit traces, on 24 px. */
function mark(s: Svg, ink: string, fold: string): Element {
  const trace = { fill: 'none', stroke: ink, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  const ring = { fill: 'none', stroke: ink, 'stroke-width': 1.3 }
  return s('g', { class: 'mark' },
    s('path', { fill: ink, d: 'M11.6 3.6C9.6 2.9 7.7 3.7 7 5.2 5.1 5.2 3.8 6.9 4.3 8.6 2.9 9.6 2.7 11.9 3.9 13 3.1 14.7 4 16.8 5.9 17.3 6.1 19.3 8.2 20.6 10.2 20 10.8 20.5 11.2 20.6 11.6 20.5Z' }),
    s('path', { fill: 'none', stroke: fold, 'stroke-width': 1.05, 'stroke-linecap': 'round', d: 'M7 5.2C7.6 6.6 9 7.1 10.4 6.8M4.3 8.6C5.4 9.4 6.9 9.3 7.8 8.4M3.9 13C5.3 13.4 6.6 12.8 7.3 11.8M8.6 11.2C9.6 12 10.3 13.4 11.6 13.6M5.9 17.3C7 16.4 8.6 16.2 9.6 17' }),
    s('path', { ...trace, class: 'tr', d: 'M13.2 5.2H15.2L16.8 3.6M13.2 8.6H18.4M13.2 12H20M13.2 15.4H18.4M13.2 18.8H15.2L16.8 20.4' }),
    s('circle', { ...ring, class: 'tr', cx: 18, cy: 2.6, r: 1.4 }),
    s('circle', { ...ring, class: 'tr', cx: 19.8, cy: 8.6, r: 1.4 }),
    s('circle', { ...ring, class: 'tr', cx: 21.4, cy: 12, r: 1.4 }),
    s('circle', { ...ring, class: 'tr', cx: 19.8, cy: 15.4, r: 1.4 }),
    s('circle', { ...ring, class: 'tr', cx: 18, cy: 21.4, r: 1.4 }))
}

const GROOVES = 'M11 9.8Q14.2 12.4 18.2 11.2Q21.4 10.4 23.6 12.6M8.8 12.6Q11.6 16.4 10.6 20.4M15.4 16Q18.8 15 21.6 17'
const ring = (s: Svg, cls = 'ring') => s('div', { class: cls })
const sparks = (s: Svg, n: number) => Array.from({ length: n }, () => s('div', { class: 'sp' }))

const LOOKS: Record<CursorStyle, Look> = {
  // The app's icon as a pin with its corner at the tip: the brand, unmistakable, calm.
  badge: {
    tip: [4, 4], tag: [27, 30],
    art: (s) => {
      const d = 'M3 6.2Q3 3 6.2 3H21.5A18.5 18.5 0 1 1 3 21.5Z'
      return s('svg', { viewBox: '0 0 42 42', width: 42, height: 42 },
        s('defs', {}, s('linearGradient', { id: 'wb-g', x1: 0, y1: 0, x2: 0.3, y2: 1 },
          s('stop', { offset: 0, 'stop-color': '#7a401b' }), s('stop', { offset: 1, 'stop-color': '#b08c74' }))),
        s('path', { ...DARK_EDGE, d }), s('path', { ...WHITE_EDGE, d }),
        s('path', { d, fill: 'url(#wb-g) #8a5a3b' }),
        s('path', { class: 'tip', d: 'M3 6.2Q3 3 6.2 3H12.6L3 12.6Z', fill: '#f0a75a' }),
        s('path', { d: 'M6.6 5.4H21.5A16 16 0 0 1 36.6 16', fill: 'none', stroke: 'rgba(255,240,226,.28)', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
        s('g', { transform: 'translate(10.4 10.2) scale(0.93)' }, mark(s, '#f8ece3', '#8a5a2b')))
    },
    fx: (s) => [ring(s, 'dot'), ring(s), ring(s, 'ring r2')],
    css: `.c.on .b{animation:w-pop var(--click) cubic-bezier(.3,1.4,.5,1)}
.c.on .tr{animation:w-glow var(--click) ease-out}
@keyframes w-pop{0%{transform:none}28%{transform:scale(.84)}62%{transform:scale(1.1)}100%{transform:none}}
@keyframes w-glow{0%,100%{stroke:#f8ece3}25%,60%{stroke:#ffbe6e}}`,
  },
  // A small walnut with a face: blinks now and then, squashes and sparkles on a click.
  nut: {
    tip: [3, 3], tag: [27, 33],
    art: (s) => {
      const d = 'M3 3L29.2 10.6A15 15 0 1 1 10.6 29.2Z'
      const eye = (cx: number) => s('g', {}, s('ellipse', { cx, cy: 26.6, rx: 2.3, ry: 2.9, fill: '#22130a' }), s('circle', { cx: cx + 0.8, cy: 25.5, r: 0.85, fill: '#fff' }))
      return s('svg', { viewBox: '0 0 44 44', width: 44, height: 44 },
        s('defs', {}, s('radialGradient', { id: 'wn-g', cx: 0.4, cy: 0.36, r: 0.7 },
          s('stop', { offset: 0, 'stop-color': '#cf9762' }), s('stop', { offset: 0.55, 'stop-color': '#9a6334' }), s('stop', { offset: 1, 'stop-color': '#5e3417' }))),
        s('path', { ...DARK_EDGE, d }), s('path', { ...WHITE_EDGE, d }),
        s('path', { d, fill: 'url(#wn-g) #9a6334' }),
        // The shell's ridges: a groove with a lit edge under it, kept to the top, away from the face.
        s('path', { fill: 'none', stroke: '#4a250d', 'stroke-opacity': 0.5, 'stroke-width': 1.3, 'stroke-linecap': 'round', d: GROOVES }),
        s('path', { fill: 'none', stroke: '#f2c491', 'stroke-opacity': 0.45, 'stroke-width': 1, 'stroke-linecap': 'round', d: GROOVES, transform: 'translate(.7 .9)' }),
        s('path', { fill: 'none', stroke: '#fff1de', 'stroke-opacity': 0.55, 'stroke-width': 2, 'stroke-linecap': 'round', d: 'M28.6 14.4Q33.8 16.6 35.6 21.4' }),
        s('ellipse', { cx: 18, cy: 31, rx: 2.5, ry: 1.45, fill: '#ff9b85', 'fill-opacity': 0.6 }),
        s('ellipse', { cx: 33.4, cy: 31, rx: 2.5, ry: 1.45, fill: '#ff9b85', 'fill-opacity': 0.6 }),
        s('g', { class: 'eyes' }, eye(21.6), eye(29.8)),
        s('path', { d: 'M24.2 31.2Q25.7 32.9 27.2 31.2', fill: 'none', stroke: '#22130a', 'stroke-width': 1.3, 'stroke-linecap': 'round' }))
    },
    fx: (s) => [ring(s), ...sparks(s, 6), ring(s, 'dot')],
    css: `.c .eyes{transform-box:fill-box;transform-origin:center;animation:w-blink 4.6s infinite}
.c.on .b{animation:w-squash var(--click) cubic-bezier(.3,1.4,.5,1)}
.c.on .eyes{animation:w-happy var(--click) ease-out}
@keyframes w-blink{0%,92%,100%{transform:none}95%{transform:scaleY(.12)}}
@keyframes w-happy{0%,100%{transform:none}20%,60%{transform:scaleY(.18)}}
@keyframes w-squash{0%{transform:none}28%{transform:scale(.8) rotate(-7deg)}62%{transform:scale(1.09) rotate(2deg)}100%{transform:none}}`,
  },
  // A bold amber dart with a pill tag, the multiplayer-cursor idiom, never the system arrow's shape.
  arrow: {
    tip: [4, 4], tag: [21, 23],
    art: (s) => {
      const d = 'M4 4L32.6 15.2Q35.4 16.4 33 18.4L21.4 21.4 18.4 33Q16.4 35.4 15.2 32.6Z'
      return s('svg', { viewBox: '0 0 40 40', width: 40, height: 40 },
        s('defs', {}, s('linearGradient', { id: 'wa-g', x1: 0, y1: 0, x2: 1, y2: 1 },
          s('stop', { offset: 0, 'stop-color': '#ffbf73' }), s('stop', { offset: 0.5, 'stop-color': '#e88a32' }), s('stop', { offset: 1, 'stop-color': '#b4530c' }))),
        s('path', { ...DARK_EDGE, d }), s('path', { ...WHITE_EDGE, d }),
        s('path', { d, fill: 'url(#wa-g) #e88a32' }),
        s('path', { d: 'M7.4 7.6L27.6 15.6', fill: 'none', stroke: '#fff4e6', 'stroke-opacity': 0.6, 'stroke-width': 1.4, 'stroke-linecap': 'round' }))
    },
    fx: (s) => [ring(s, 'dot'), ring(s), ring(s, 'ring r2')],
    css: `.c .tag{background:#5c3216}
.c.on .b{animation:w-press var(--click) cubic-bezier(.3,1.4,.5,1)}
@keyframes w-press{0%{transform:none}28%{transform:translate(1.5px,1.5px) scale(.82)}62%{transform:scale(1.07)}100%{transform:none}}`,
  },
  // A squirrel's paw reaching with one claw: pats the spot and leaves a fading print.
  paw: {
    tip: [3, 3], tag: [28, 33],
    art: (s) => pawSvg(s, ''),
    fx: (s) => [ring(s, 'dot'), ring(s), pawSvg(s, 'stamp')],
    css: `.c .stamp{position:absolute;left:-3px;top:-3px;opacity:0;transform-origin:22px 22px;pointer-events:none}
.c.on .b{animation:w-pat var(--click) cubic-bezier(.3,1.4,.5,1)}
.c.on .stamp{animation:w-stamp var(--click) ease-out}
@keyframes w-pat{0%{transform:none}25%{transform:scale(.8) rotate(4deg)}60%{transform:scale(1.07)}100%{transform:none}}
@keyframes w-stamp{0%,20%{opacity:0;transform:scale(.9)}35%{opacity:.5}100%{opacity:0;transform:scale(1.45)}}`,
  },
}

function pawSvg(s: Svg, cls: string): Element {
  // One gradient id per copy: the stamp is a second picture in the same shadow root.
  const id = cls ? `wp-g-${cls}` : 'wp-g'
  const pad = 'M-9 3C-9 -4-4.2-7.4 0-7.4 4.2-7.4 9-4 9 3 9 7.6 5.4 9.6 2.6 8.6 1 8-1 8-2.6 8.6-5.4 9.6-9 7.6-9 3Z'
  const claw = 'M0-30.5L3.4-21.2Q0-19.8-3.4-21.2Z'
  const toes: Array<[number, number, number]> = [[-10.4, -8.6, -28], [-4.2, -14.2, -9], [4.2, -14.2, 9], [10.4, -8.6, 28]]
  const shapes = (attrs: Record<string, string | number>, toeAttrs = attrs) => [
    s('path', { ...attrs, d: claw }),
    s('path', { ...attrs, d: pad }),
    ...toes.map(([x, y, r]) => s('ellipse', { ...toeAttrs, cx: 0, cy: 0, rx: 3.5, ry: 4.4, transform: `translate(${x} ${y}) rotate(${r})` })),
  ]
  const fill = `url(#${id}) #7a4a26`
  return s('svg', { viewBox: '0 0 44 44', width: 44, height: 44, ...(cls ? { class: cls } : {}) },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { offset: 0, 'stop-color': '#a8703e' }), s('stop', { offset: 1, 'stop-color': '#5e3417' }))),
    s('g', { transform: 'translate(25.86 25.86) rotate(-45) scale(1.06)' },
      ...shapes({ fill: 'none', stroke: 'rgba(28,16,6,.28)', 'stroke-width': 6.2, 'stroke-linejoin': 'round' }),
      ...shapes({ fill: '#fff', stroke: '#fff', 'stroke-width': 4.6, 'stroke-linejoin': 'round' }),
      s('path', { d: claw, fill: '#f0a75a' }),
      s('path', { d: pad, fill }),
      ...toes.map(([x, y, r]) => s('ellipse', { fill, cx: 0, cy: 0, rx: 3.5, ry: 4.4, transform: `translate(${x} ${y}) rotate(${r})` })),
      s('path', { d: 'M-5.2-2.6Q0-5.6 5.2-2.6', fill: 'none', stroke: '#ffe2c2', 'stroke-opacity': 0.4, 'stroke-width': 1.6, 'stroke-linecap': 'round' })))
}

/** The rules every look shares: no pointer events anywhere, the glide, the tag, the click ring. */
const BASE = `.c,.c *{pointer-events:none !important}
.c{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;transition:transform var(--ms,0ms) cubic-bezier(.22,.8,.24,1);will-change:transform;--click:${CLICK_MS}ms}
.c.hid{visibility:hidden}
.c .b{position:absolute;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.28)) drop-shadow(0 6px 10px rgba(0,0,0,.14));transition:transform 220ms cubic-bezier(.3,1.5,.5,1)}
.c.go .b{transform:rotate(var(--tilt,0deg)) scale(1.05)}
.c svg{position:absolute;left:0;top:0;display:block;overflow:visible;pointer-events:none}
.c .fx{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.c .tag{position:absolute;padding:3px 8px 3px 7px;border-radius:999px;background:#2b2118;color:#fff8f0;font:700 11.5px/1.25 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;white-space:nowrap;box-shadow:0 0 0 1.5px rgba(255,255,255,.95),0 3px 8px rgba(0,0,0,.28);pointer-events:none}
.c .tag::before{content:"";display:inline-block;width:6px;height:6px;margin:0 5px 1px 0;border-radius:50%;background:#f0a75a;vertical-align:middle}
.c .ring{position:absolute;left:-20px;top:-20px;width:40px;height:40px;border-radius:50%;border:3px solid #f0a75a;box-shadow:0 0 0 1.5px #fff,inset 0 0 0 1.5px #fff;box-sizing:border-box;opacity:0;pointer-events:none}
.c .dot{position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:#f0a75a;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35);opacity:0;pointer-events:none}
.c .r2{border-width:2px;border-color:#ffd6a3;box-shadow:0 0 0 1px rgba(180,83,9,.45)}
.c.on .ring{animation:w-ring var(--click) cubic-bezier(.2,.7,.3,1)}
.c.on .r2{animation-delay:110ms;animation-duration:calc(var(--click) - 110ms)}
.c.on .dot{animation:w-dot var(--click) ease-out}
.c .sp{position:absolute;left:-3.5px;top:-3.5px;width:7px;height:7px;border-radius:50%;background:#f0a75a;box-shadow:0 0 0 1.2px #fff;opacity:0;pointer-events:none}
.c .sp:nth-child(odd){background:#ffd6a3}
.c .sp:nth-child(2){--a:120deg}.c .sp:nth-child(3){--a:165deg}.c .sp:nth-child(4){--a:210deg}.c .sp:nth-child(5){--a:255deg}.c .sp:nth-child(6){--a:300deg}.c .sp:nth-child(7){--a:345deg}
.c.on .sp{animation:w-spark var(--click) cubic-bezier(.2,.7,.3,1)}
@keyframes w-ring{0%{transform:scale(.2);opacity:1}60%{opacity:.8}100%{transform:scale(1.35);opacity:0}}
@keyframes w-dot{0%{transform:scale(0);opacity:1}25%{transform:scale(1.15);opacity:1}100%{transform:scale(.4);opacity:0}}
@keyframes w-spark{0%{transform:rotate(var(--a)) translateX(5px) scale(.6);opacity:1}55%{opacity:1}100%{transform:rotate(var(--a)) translateX(28px) scale(.35);opacity:0}}`

const REDUCED = `@media (prefers-reduced-motion: reduce){.c{transition:none}.c .b{transition:none}.c.go .b{transform:none}.c *,.c.on *{animation:none !important}.c.on .ring{opacity:.9;transform:none}.c.on .r2{opacity:0}.c.on .dot{opacity:1;transform:none}}`

/** The style text for one look: shared rules, then the look's own, then reduced motion. */
export function cursorCss(style: CursorStyle): string {
  const [tx, ty] = LOOKS[style].tag
  const [px, py] = LOOKS[style].tip
  return `${BASE}\n.c .b{left:${-px}px;top:${-py}px;transform-origin:${px}px ${py}px}\n.c .tag{left:${tx}px;top:${ty}px}\n${LOOKS[style].css}\n${REDUCED}`
}

export interface CursorParts { box: HTMLElement; body: HTMLElement; tag: HTMLElement }

/** The cursor's elements for one look, made in `doc`; `label` is the tag's text. */
export function cursorParts(doc: Document, style: CursorStyle, label = 'Walnut'): CursorParts {
  const look = LOOKS[style]
  const s: Svg = (tag, attrs = {}, ...kids) => {
    const el = tag === 'div' ? doc.createElement('div') : doc.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    for (const k of kids) if (k) el.append(k)
    return el
  }
  const box = doc.createElement('div')
  box.className = 'c'
  box.dataset.look = style
  // A picture of where an agent acts: nothing for a screen reader to read out (set inside the shadow root, never on the host).
  box.setAttribute('aria-hidden', 'true')
  const fx = doc.createElement('div')
  fx.className = 'fx'
  for (const k of look.fx(s)) if (k) fx.append(k)
  const body = doc.createElement('div')
  body.className = 'b'
  body.append(look.art(s))
  const tag = doc.createElement('div')
  tag.className = 'tag'
  tag.textContent = label
  box.append(fx, body, tag)
  return { box, body, tag }
}
