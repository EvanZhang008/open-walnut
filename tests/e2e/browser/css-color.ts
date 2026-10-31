/**
 * Read a CSS colour the way the browser paints it: the one colour parser for every spec that
 * measures contrast, alpha, hue or tint from getComputedStyle.
 *
 * Why (2026-10-30): specs pulled the numbers out of a computed colour with `c.match(/[\d.]+/g)`
 * and read them as 0..255 sRGB. Since the floating overlays moved to one frosted glass made with
 * color-mix() (web/src/styles/overlay-glass.css), Chromium and WebKit serialise those backgrounds
 * as `color(srgb 1 1 1 / 0.82)`, channels 0..1. The regex read that white glass as rgb(1, 1, 1),
 * nearly black, so dark text on it measured about 1.25:1 and the filter bar, Display menu and
 * mail context menu specs failed. `oklab()`, `oklch()`, `lab()` and `color(display-p3 ...)`
 * break the same regex in other ways. tests/web/spec-color-parse-ratchet.test.ts fails when a
 * spec parses a colour by hand again.
 *
 * `cssColorToRgba(value)` returns `[r, g, b, a]`: r, g, b in 0..255 sRGB (clipped to the sRGB
 * gamut, not rounded), a in 0..1. It reads every form getComputedStyle produces: `rgb()` and
 * `rgba()` (comma or space syntax), `color(<space> ...)` for every predefined space, `lab()`,
 * `lch()`, `oklab()`, `oklch()`, plus `hsl()`, `hwb()`, hex and `transparent` for specified
 * values read from a style rule. `transparent` and anything it cannot read come back fully
 * transparent, `[0, 0, 0, 0]`. An `rgb()` value comes back exactly as written.
 *
 * It is plain arithmetic with no imports and no outer references, so the SAME function runs in
 * both places a spec needs it:
 *
 * - In Node, on a string a spec already took out of the page:
 *     const [r, g, b, a] = cssColorToRgba(look.background)
 *
 * - In the page, inside page.evaluate / locator.evaluate, through withCssColor:
 *     await locator.evaluate(withCssColor((toRgba) => (el: Element) => toRgba(getComputedStyle(el).color)[3]))
 *   The factory gets the parser and returns the callback Playwright runs. Playwright sends an
 *   evaluate function to the page as its source text (String(fn)); withCssColor hands it a
 *   callback whose source is `(factory)(function cssColorToRgba(...) {...})`, so the parser
 *   arrives inlined in the one evaluate call. Nothing is installed on window, nothing has to be
 *   re-installed after a navigation, it works in every frame and in WebKit as in Chromium, and
 *   no eval runs in spec code. The factory keeps the usual evaluate rule: it may not use
 *   anything from outside itself except its `toRgba` parameter.
 *
 * In the page, a form the parser does not know (a named colour, say) falls back to a 1x1 canvas,
 * which paints whatever the engine accepts. Canvas pixels are 8-bit, so that path quantizes
 * alpha to 1/255; it never runs for a computed value.
 */

/** r, g, b in 0..255 sRGB, a in 0..1. */
export type Rgba = [number, number, number, number]
export type CssColorToRgba = (value: string) => Rgba

export function cssColorToRgba(value: string): Rgba {
  const text = String(value ?? '').trim().toLowerCase()

  // [r, g, b] in 0..255 plus alpha 0..1, or null when the text is not a colour this reads.
  const read = (): number[] | null => {
    if (text === 'transparent') return [0, 0, 0, 0]
    if (text.startsWith('#')) {
      const hex = text.slice(1)
      if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null
      const full = hex.length < 6 ? hex.split('').map((h) => h + h).join('') : hex
      const byte = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16)
      return [byte(0), byte(1), byte(2), full.length === 8 ? byte(3) / 255 : 1]
    }
    // Nested functions (an unresolved color-mix(), say) are left to the canvas.
    const fn = /^([a-z0-9-]+)\(([^()]*)\)$/.exec(text)
    if (!fn) return null
    const name = fn[1]
    const halves = fn[2].split('/')
    if (halves.length > 2) return null
    const parts = halves[0].split(/[\s,]+/).filter(Boolean)
    const space = name === 'color' ? parts.shift() : ''
    let alphaToken = halves.length === 2 ? halves[1].trim() : undefined
    // Legacy comma syntax carries alpha as a fourth argument: rgba(0, 0, 0, 0.5).
    if (alphaToken === undefined && parts.length === 4) alphaToken = parts.pop()
    if (parts.length !== 3) return null

    // A channel: a number, a percentage of `full`, or `none` (0).
    const num = (token: string, full: number): number =>
      token === 'none' ? 0 : token.endsWith('%') ? (Number(token.slice(0, -1)) / 100) * full : Number(token)
    const hue = (token: string): number => {
      if (token === 'none') return 0
      const unit = /(deg|grad|rad|turn)$/.exec(token)
      const n = Number(unit ? token.slice(0, -unit[1].length) : token)
      const deg = !unit ? n : unit[1] === 'rad' ? (n * 180) / Math.PI : unit[1] === 'grad' ? n * 0.9 : unit[1] === 'turn' ? n * 360 : n
      return ((deg % 360) + 360) % 360
    }
    const alpha = alphaToken === undefined ? 1 : num(alphaToken, 1)
    const [p, q, r] = parts

    // The matrices and transfer functions are the CSS Color 4 sample code's.
    const mul = (m: number[][], v: number[]): number[] => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
    const encode = (c: number): number => {
      const a = Math.abs(c)
      return a > 0.0031308 ? Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055) : 12.92 * c
    }
    const decode = (c: number): number => {
      const a = Math.abs(c)
      return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4
    }
    const D50_TO_D65 = [
      [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
      [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
      [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
    ]
    const XYZ_TO_LINEAR_SRGB = [
      [12831 / 3959, -329 / 214, -1974 / 3959],
      [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
      [705 / 12673, -2585 / 12673, 705 / 667],
    ]
    const fromLinear = (rgb: number[]): number[] => rgb.map((c) => encode(c) * 255)
    const fromXyzD65 = (xyz: number[]): number[] => fromLinear(mul(XYZ_TO_LINEAR_SRGB, xyz))
    const fromXyzD50 = (xyz: number[]): number[] => fromXyzD65(mul(D50_TO_D65, xyz))
    const fromLab = (l: number, a: number, b: number): number[] => {
      const k = 24389 / 27
      const e = 216 / 24389
      const fy = (l + 16) / 116
      const fx = a / 500 + fy
      const fz = fy - b / 200
      const xyz = [fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k, l > k * e ? fy ** 3 : l / k, fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k]
      const white = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]
      return fromXyzD50(xyz.map((v, i) => v * white[i]))
    }
    const fromOklab = (l: number, a: number, b: number): number[] => {
      const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
      const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
      const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
      return fromLinear([
        4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
        -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
        -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
      ])
    }
    // h in degrees, s and l in 0..1; returns 0..1.
    const hslUnit = (h: number, s: number, l: number): number[] => {
      const f = (n: number) => {
        const k = (n + h / 30) % 12
        return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
      }
      return [f(0), f(8), f(4)]
    }
    const polar = (c: number, h: number): number[] => [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]

    let rgb: number[] | null = null
    if (name === 'rgb' || name === 'rgba') {
      rgb = [num(p, 255), num(q, 255), num(r, 255)]
    } else if (name === 'hsl' || name === 'hsla') {
      rgb = hslUnit(hue(p), num(q, 100) / 100, num(r, 100) / 100).map((c) => c * 255)
    } else if (name === 'hwb') {
      const w = num(q, 100) / 100
      const k = num(r, 100) / 100
      rgb = w + k >= 1
        ? [0, 0, 0].map(() => (w / (w + k)) * 255)
        : hslUnit(hue(p), 1, 0.5).map((c) => (c * (1 - w - k) + w) * 255)
    } else if (name === 'lab') {
      rgb = fromLab(num(p, 100), num(q, 125), num(r, 125))
    } else if (name === 'lch') {
      const [a, b] = polar(num(q, 150), hue(r))
      rgb = fromLab(num(p, 100), a, b)
    } else if (name === 'oklab') {
      rgb = fromOklab(num(p, 1), num(q, 0.4), num(r, 0.4))
    } else if (name === 'oklch') {
      const [a, b] = polar(num(q, 0.4), hue(r))
      rgb = fromOklab(num(p, 1), a, b)
    } else if (name === 'color') {
      const c = [num(p, 1), num(q, 1), num(r, 1)]
      if (space === 'srgb') {
        rgb = c.map((v) => v * 255)
      } else if (space === 'srgb-linear') {
        rgb = fromLinear(c)
      } else if (space === 'display-p3') {
        rgb = fromXyzD65(mul([
          [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
          [35783 / 156275, 247089 / 357200, 198249 / 2500400],
          [0, 32229 / 714400, 5220557 / 5000800],
        ], c.map(decode)))
      } else if (space === 'a98-rgb') {
        rgb = fromXyzD65(mul([
          [573536 / 994567, 263643 / 1420810, 187206 / 994567],
          [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
          [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
        ], c.map((v) => Math.sign(v) * Math.abs(v) ** (563 / 256))))
      } else if (space === 'prophoto-rgb') {
        rgb = fromXyzD50(mul([
          [0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
          [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
          [0, 0, 0.8251046025104602],
        ], c.map((v) => (Math.abs(v) <= 16 / 512 ? v / 16 : Math.sign(v) * Math.abs(v) ** 1.8))))
      } else if (space === 'rec2020') {
        const A = 1.09929682680944
        const B = 0.018053968510807
        rgb = fromXyzD65(mul([
          [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
          [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
          [0, 19567812 / 697040785, 295819943 / 278816314],
        ], c.map((v) => (Math.abs(v) < B * 4.5 ? v / 4.5 : Math.sign(v) * ((Math.abs(v) + A - 1) / A) ** (1 / 0.45)))))
      } else if (space === 'xyz' || space === 'xyz-d65') {
        rgb = fromXyzD65(c)
      } else if (space === 'xyz-d50') {
        rgb = fromXyzD50(c)
      }
    }
    if (!rgb) return null
    const out = [rgb[0], rgb[1], rgb[2], alpha]
    return out.every((v) => Number.isFinite(v)) ? out : null
  }

  const parsed = read()
  if (parsed) {
    const clip = (v: number, hi: number): number => (v > hi ? hi : v > 0 ? v : 0)
    return [clip(parsed[0], 255), clip(parsed[1], 255), clip(parsed[2], 255), clip(parsed[3], 1)]
  }
  if (typeof document === 'undefined') return [0, 0, 0, 0]
  // In the page: let the engine paint it. A value it cannot parse leaves the transparent fill.
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return [0, 0, 0, 0]
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'
  ctx.fillStyle = text
  ctx.fillRect(0, 0, 1, 1)
  const px = ctx.getImageData(0, 0, 1, 1).data
  return [px[0], px[1], px[2], px[3] / 255]
}

/**
 * An evaluate callback with cssColorToRgba in scope as the factory's `toRgba` parameter (see the
 * header). Use it for page.evaluate, locator.evaluate, evaluateAll and $$eval alike:
 *   page.evaluate(withCssColor((toRgba) => (sel: string) => ...), selector)
 */
export function withCssColor<F extends (...args: never[]) => unknown>(factory: (toRgba: CssColorToRgba) => F): F {
  const run = factory(cssColorToRgba)
  const source = `(${String(factory)})(${String(cssColorToRgba)})`
  return Object.defineProperty(run, 'toString', { value: () => source })
}
