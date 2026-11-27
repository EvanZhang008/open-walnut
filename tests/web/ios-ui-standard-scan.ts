/**
 * Counts, per Swift file of the phone app and its extensions (ios-native/Walnut, Shared,
 * WalnutAutoFill, WalnutWidgets), each way a view draws a control
 * that is not the design system's (the iOS column of .claude/skills/walnut-ui-requirements/standard.md):
 *
 * (A `Capsule()` is not counted: what you press and every tag is round, standard.md "Shapes",
 * unless it is long: see wideCapsule.)
 *   - literalColour: a colour written as numbers (`Color(red:)`, `UIColor(white:)`, `0xRRGGBB`) or a
 *     system hue (`.red`, `.orange`, ...) where a `Theme` colour belongs.
 *   - literalFont: `.system(size: <number>)`: text takes a text style, a glyph `Theme.Glyph`.
 *   - radiusLiteral: a corner written as a number (`cornerRadius: 10`, `radius: 16`), not a
 *     `Theme.Radius` token.
 *   - systemButtonStyle: `.bordered`, `.borderedProminent` or `.borderless`, or a
 *     `.buttonBorderShape(...)`: the OS picks their shape and fill (a capsule on iOS 26).
 *   - ownButtonStyle: a `ButtonStyle` declared outside the design system (`WalnutButtonStyle`).
 *   - ownReplyBox: a `TextField` / `TextEditor` drawn in its own rounded box, where the shared reply
 *     box belongs.
 *   - ownEmptyState: the system's `ContentUnavailableView`, where `WalnutEmptyState` belongs.
 *   - tintFill: a solid `Theme.tint` fill (`.background(Theme.tint`, or `cond ? Theme.tint :` in a
 *     background): words on it read at 3.7:1 in dark; a solid fill is `Theme.accent`.
 *   - wideCapsule: a capsule drawn around something that spans its line (`.frame(maxWidth:
 *     .infinity)`, an option row or a full-width family key, in the same modifier chain): a long
 *     block is a rounded rectangle, only a small key or tag is round (Evan, 2026-11-22: "long and square is fine, small must be round").
 *
 * A line that has to keep its shape (a drag handle, a camera's shutter) says why with a
 * `ui-standard-ok: <why>` comment on that line.
 */
import fs from 'node:fs'
import path from 'node:path'

export const IOS_ROOT = path.resolve(import.meta.dirname, '../../ios-native')
/** The app and its extensions; tests and the UI tests are not views. */
export const IOS_DIRS = ['Walnut', 'Shared', 'WalnutAutoFill', 'WalnutWidgets']

export const IOS_KINDS = [
  'literalColour',
  'literalFont',
  'radiusLiteral',
  'systemButtonStyle',
  'ownButtonStyle',
  'ownReplyBox',
  'ownEmptyState',
  'tintFill',
  'wideCapsule',
] as const
export type IosKind = (typeof IOS_KINDS)[number]
export type IosCounts = Record<IosKind, Record<string, number>>

/** The design system's own files: they are where the tokens and shared styles live. */
export const DESIGN_SYSTEM_FILES = [
  'Walnut/Core/Theme.swift',
  'Walnut/Core/ThemeTokens.swift',
  'Walnut/Views/Shared/DesignSystem/WalnutButtonStyle.swift',
  'Walnut/Views/Shared/DesignSystem/WalnutSurfaces.swift',
  'Walnut/Views/Shared/DesignSystem/WalnutEmptyState.swift',
  'Walnut/Views/Shared/DesignSystem/WalnutTouchTarget.swift',
]

/** Colour tables that are data, not a view's choice (syntax colours, the HTML contrast table). */
const COLOUR_TABLES = [
  'Walnut/Timeline/CodeHighlighter.swift',
  'Walnut/Markdown/RichHTMLContrast.swift',
  'Walnut/Views/Chat/Camera/FakeCameraSource.swift',
]

const OK = /ui-standard-ok:/

const PATTERNS: Record<Exclude<IosKind, 'ownReplyBox' | 'tintFill' | 'wideCapsule'>, RegExp[]> = {
  literalColour: [
    /\b(?:Color|UIColor)\s*\(\s*(?:red|white|hue|displayP3)\s*:/,
    /\b0x[0-9A-Fa-f]{6}\b/,
    /(?:\bColor\.|[\s(,:?]\.)(?:red|orange|green|blue|yellow|purple|indigo|pink|teal|mint|cyan|brown|gray)\b(?!\s*[(:])/,
    /\b(?:Color|UIColor)\s*\(\s*\.system(?:Red|Orange|Green|Blue|Yellow|Purple|Indigo|Pink|Teal|Mint|Cyan|Brown)\s*\)/,
    /\bUIColor\.system(?:Red|Orange|Green|Blue|Yellow|Purple|Indigo|Pink|Teal|Mint|Cyan|Brown)\b/,
  ],
  literalFont: [/\bsystem\(\s*size:\s*[0-9]/, /\bsystemFont\(\s*ofSize:\s*[0-9]/],
  radiusLiteral: [
    // A glyph drawn by hand (`Path(roundedRect:cornerRadius:)`, an icon's stroke) is a drawing,
    // not a control's corner.
    /^(?!.*\bPath\(\s*roundedRect:).*\bcornerRadius:\s*[0-9]/,
    /\.cornerRadius\(\s*[0-9]/,
    /\broundedRectangle\(\s*radius:\s*[0-9]/,
    // UIKit: a layer's or a button background's corner.
    /\.cornerRadius\s*=\s*[0-9]/,
  ],
  systemButtonStyle: [
    /\.buttonStyle\(\s*\.(?:bordered|borderedProminent|borderless)\s*\)/,
    /\.buttonStyle\(\s*(?:Bordered|BorderedProminent|Borderless)ButtonStyle\(\)\s*\)/,
    /\.buttonStyle\([^)]*\?\s*\.(?:bordered|borderedProminent|borderless)\b/,
    /\.buttonBorderShape\(/,
  ],
  ownButtonStyle: [
    /\b(?:struct|enum)\s+\w+(?:<[^>]*>)?\s*:\s*(?:[\w.]+\s*,\s*)*(?:Primitive)?ButtonStyle\b/,
    /\bextension\s+\w+\s*:\s*(?:[\w.]+\s*,\s*)*(?:Primitive)?ButtonStyle\b/,
  ],
  ownEmptyState: [/\bContentUnavailableView\b/],
}

const FIELD = /\b(?:TextField|TextEditor|SecureField)\s*\(/
const SHAPE = String.raw`(?:RoundedRectangle\s*\(|Capsule\s*\(|Theme\.Radius\.shape\()`
const BOX = new RegExp(
  String.raw`\.(?:background|overlay)\s*\([^)]*` + SHAPE + '|' + String.raw`\bin:\s*` + SHAPE + '|'
    + String.raw`\.clipShape\(\s*` + SHAPE + '|' + String.raw`\.textFieldStyle\(\s*\.roundedBorder\s*\)`,
)
/** A solid tint fill: `.background(Theme.tint`, or a `cond ? Theme.tint :` inside a background. */
const TINT_FILL = /\.background\(\s*Theme\.tint\b(?!\.)/
const TINT_TERNARY = /\?\s*Theme\.tint\b(?!\.)\s*:/
/** A line that makes its view span the line, and a capsule drawn around a view. */
const SPANS = /\.frame\([^)]*\bmaxWidth:\s*\.infinity|\.walnut\(\s*\.option\b|\.walnut\(.*\bfullWidth:\s*true/
const CAPSULE_AROUND = /(?:\.(?:background|overlay|clipShape|contentShape)\s*[({][^)]*?|\bin:\s*)Capsule\b/

/** The code of each line: comments gone, string contents kept (a URL's `//` is not a comment). */
export function codeLines(src: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) { out.push(''); continue }
      line = line.slice(end + 2)
      inBlock = false
    }
    let code = ''
    let inString = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inString) {
        code += c
        if (c === '\\') { code += line[i + 1] ?? ''; i++ } else if (c === '"') inString = false
        continue
      }
      if (c === '"') { inString = true; code += c; continue }
      if (c === '/' && line[i + 1] === '/') {
        // Keep the marker of an allowed line so the counter can see it.
        if (OK.test(line.slice(i))) code += ' ui-standard-ok:'
        break
      }
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2)
        if (end < 0) { inBlock = true; break }
        i = end + 1
        continue
      }
      code += c
    }
    out.push(code)
  }
  return out
}

export function countFile(rel: string, src: string): Record<IosKind, number> {
  const lines = codeLines(src)
  const counts = Object.fromEntries(IOS_KINDS.map((k) => [k, 0])) as Record<IosKind, number>
  if (DESIGN_SYSTEM_FILES.includes(rel)) return counts
  lines.forEach((line, i) => {
    if (!line.trim() || OK.test(line)) return
    for (const kind of Object.keys(PATTERNS) as Array<keyof typeof PATTERNS>) {
      if (kind === 'literalColour' && (COLOUR_TABLES.includes(rel) || rel.startsWith('Walnut/Demo/'))) continue
      if (PATTERNS[kind].some((re) => re.test(line))) counts[kind]++
    }
    if (TINT_FILL.test(line)
      || (TINT_TERNARY.test(line) && (/\.(?:background|fill)\(/.test(line) || /\.(?:background|fill)\(\s*$/.test(lines[i - 1] ?? '')))) {
      counts.tintFill++
    }
    if (SPANS.test(line)) {
      // The rest of this modifier chain: the lines that go on with a `.modifier`, and the shape
      // an `.overlay(` or `.background {` opens on the next line.
      const chain: string[] = [line]
      for (let j = i + 1; j < lines.length && j < i + 10; j++) {
        const opens = /[({]\s*$/.test(lines[j - 1])
        if (!/^\s*\./.test(lines[j]) && !opens) break
        chain.push(lines[j])
      }
      const marked = chain.some((l) => OK.test(l))
      if (!marked && CAPSULE_AROUND.test(chain.join(' '))) counts.wideCapsule++
    }
    if (FIELD.test(line)) {
      // A field whose own box is drawn within the next lines of its modifier chain.
      const chain = lines.slice(i, i + 14)
      const end = chain.findIndex((l, j) => j > 0 && FIELD.test(l))
      const window = end > 0 ? chain.slice(0, end) : chain
      if (window.some((l) => BOX.test(l) && !OK.test(l))) counts.ownReplyBox++
    }
  })
  return counts
}

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? swiftFiles(p) : e.name.endsWith('.swift') ? [p] : []
  })
}

export function countIos(root = IOS_ROOT): IosCounts {
  const all = Object.fromEntries(IOS_KINDS.map((k) => [k, {}])) as IosCounts
  const files = IOS_DIRS.flatMap((d) => (fs.existsSync(path.join(root, d)) ? swiftFiles(path.join(root, d)) : []))
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const c = countFile(rel, fs.readFileSync(file, 'utf8'))
    for (const k of IOS_KINDS) if (c[k] > 0) all[k][rel] = c[k]
  }
  return all
}

export function totals(c: IosCounts): Record<IosKind, number> {
  return Object.fromEntries(IOS_KINDS.map((k) => [k, Object.values(c[k]).reduce((a, b) => a + b, 0)])) as Record<IosKind, number>
}

/** The app's Swift files (`IOS_DIRS`), relative to ios-native, sorted. */
export function appSwiftFiles(root = IOS_ROOT): string[] {
  return IOS_DIRS.flatMap((d) => (fs.existsSync(path.join(root, d)) ? swiftFiles(path.join(root, d)) : []))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort()
}

/** A line's code with every string literal emptied, so a `(` or `{` inside words is not counted. */
export function bareCode(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/**
 * The lines of the declaration or call that starts on line `start` of `lines` (code lines, see
 * `codeLines`): up to where its braces and parentheses close, through a trailing labelled closure
 * (`} label: {`) and the modifier chain that follows it (lines starting with `.`).
 */
export function blockAt(lines: string[], start: number): string[] {
  let depth = 0
  let opened = false
  let i = start
  for (; i < lines.length; i++) {
    const code = bareCode(lines[i])
    let closedAt = -1
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]
      if (ch === '{' || ch === '(') { depth++; opened = true }
      else if (ch === '}' || ch === ')') {
        depth--
        if (opened && depth === 0) closedAt = c
      }
    }
    if (opened && depth <= 0) {
      // A trailing labelled closure opens on the same line (`} label: {`): depth is back above 0.
      if (closedAt >= 0 && /^\s*\w+:\s*\{/.test(code.slice(closedAt + 1))) continue
      break
    }
  }
  let end = Math.min(i, lines.length - 1)
  // The modifier chain under it.
  while (end + 1 < lines.length && /^\s*\./.test(lines[end + 1])) {
    end++
    let d = 0
    for (const ch of bareCode(lines[end])) { if (ch === '(' || ch === '{') d++; else if (ch === ')' || ch === '}') d-- }
    while (d > 0 && end + 1 < lines.length) {
      end++
      for (const ch of bareCode(lines[end])) { if (ch === '(' || ch === '{') d++; else if (ch === ')' || ch === '}') d-- }
    }
  }
  return lines.slice(start, end + 1)
}

/**
 * Touch targets (standard.md "Sizes", iOS column): a control that draws under 44 pt keeps a 44 pt
 * touch through the one helper, `.walnutTouchTarget()` (WalnutTouchTarget.swift), or a family
 * style that applies it (`.walnut(...)`, `.walnutChip(...)`, `.walnutPickerKey(...)`, `PillChip`).
 *
 * A control is a `Button`, `Menu` or `Link`. It draws small when its block (the control with its
 * label and modifier chain, `blockAt`) sets a frame under 44 pt on an axis (a literal, or a token
 * known to be small: `MessageBox.keySize`, `Theme.Control.smallHeight`/`toolHeight`) and nothing in
 * it makes that axis 44 pt or more (a frame of 44 or `.infinity`, a `Spacer` across), or when it
 * takes a style known to draw small. A frame on a shape's own line (a status dot) is a drawing,
 * not the key. What a scan cannot see: a key whose size comes from padding alone.
 */
const TOUCH_START = /\bButton\s*[({]|\bMenu\s*[({]|\bLink\s*\(/
/** Goes through the helper: the modifier itself, or a style that applies it. */
export const TOUCH_THROUGH = /\.walnutTouchTarget\(|\.buttonStyle\(\s*\.walnut(?:Chip)?\(|\.buttonStyle\(\s*\.walnut(?:Primary|Secondary|Tool|Destructive)\b|\.walnutPickerKey\(|\bPillChip\s*\(/
const SMALL_STYLE = /\bsize:\s*\.small\b|\.walnutTool\b|\.walnut\(\s*\.tool\b|\.walnutChip\(|\.walnutPickerKey\(|\bPillChip\s*\(/
const SHAPE_LINE = /\b(?:Circle|Capsule|Ellipse|Rectangle|RoundedRectangle)\s*\(|Theme\.Radius\.shape\(/
/** Size tokens of the app, in points. */
const SIZE_TOKENS: Record<string, number> = {
  'MessageBox.keySize': 32,
  'Theme.Control.smallHeight': 32,
  'Theme.Control.toolHeight': 28,
  'Theme.Control.height': 44,
  'Theme.Control.target': 44,
  'TimelineHostedCell.minimumTapHeight': 44,
  // A voice key's seat (`VoiceGlyphSeat.target`): 44 pt at least.
  'size.target': 44,
}

/** The sizes an axis argument of a frame can take: a number, a token, or a choice of them
 *  (`compact ? 44 : 36` is 44 or 36). Arithmetic (`inner * 0.8`) is not a size the scan knows. */
function axisSizes(expr: string): number[] {
  const parts = expr.includes('?') ? expr.slice(expr.indexOf('?') + 1).split(':') : [expr]
  const out: number[] = []
  for (const raw of parts) {
    const part = raw.trim()
    if (/^\d+(?:\.\d+)?$/.test(part)) out.push(Number(part))
    else if (part in SIZE_TOKENS) out.push(SIZE_TOKENS[part])
  }
  return out
}

export interface TouchMember {
  /** `ios-native/<file>:<line>` */
  at: string
  rel: string
  /** The control's accessibility identifier as written, or its first line. */
  id: string
  /** Why it counts as drawn small. */
  small: string
  through: boolean
  /** A system `Menu`: it takes taps only inside its own frame, so it needs `.walnutMenuTouch()`. */
  menu: boolean
  /** The control's code (comments gone). */
  text: string
}

/** Every control of a file that draws under 44 pt on an axis (see above). */
export function touchMembers(rel: string, src: string): TouchMember[] {
  const lines = codeLines(src)
  const out: TouchMember[] = []
  lines.forEach((line, i) => {
    if (!TOUCH_START.test(line)) return
    const block = blockAt(lines, i)
    // The chain goes on past comment lines (empty here) to the next `.modifier`.
    for (let j = i + block.length; j < lines.length; j++) {
      if (lines[j].trim()) break
      let k = j
      while (k < lines.length && !lines[k].trim()) k++
      if (k >= lines.length || !/^\s*\./.test(lines[k])) break
      const more = blockAt(lines, k)
      block.push(...lines.slice(j, k), ...more)
      j = k + more.length - 1
    }
    const text = block.join('\n')
    let smallW: string | null = null
    let smallH: string | null = null
    let bigW = /\bSpacer\s*\(/.test(text)
    let bigH = false
    for (const l of block) {
      if (SHAPE_LINE.test(l)) continue
      for (const m of l.matchAll(/\.frame\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
        const args = m[1]
        if (/\bmaxWidth:\s*\.infinity/.test(args)) bigW = true
        if (/\bmaxHeight:\s*\.infinity/.test(args)) bigH = true
        for (const a of args.matchAll(/\b(width|minWidth|height|minHeight):\s*([^,]+)/g)) {
          const sizes = axisSizes(a[2])
          if (!sizes.length) continue
          const wide = a[1] === 'width' || a[1] === 'minWidth'
          if (Math.min(...sizes) < 44) {
            if (wide) smallW ??= `${a[1]}: ${a[2].trim()}`
            else smallH ??= `${a[1]}: ${a[2].trim()}`
          } else if (wide) bigW = true
          else bigH = true
        }
      }
    }
    const style = text.match(SMALL_STYLE)?.[0]
    const small = (smallW && !bigW ? smallW : null) ?? (smallH && !bigH ? smallH : null) ?? style ?? null
    if (!small) return
    const id = text.match(/\.accessibilityIdentifier\(([^)]*(?:\([^)]*\)[^)]*)*)\)/)?.[1]?.trim() ?? line.trim()
    out.push({ at: `ios-native/${rel}:${i + 1}`, rel, id, small, through: TOUCH_THROUGH.test(text), menu: /^\s*Menu\s*[({]/.test(line), text })
  })
  return out
}
