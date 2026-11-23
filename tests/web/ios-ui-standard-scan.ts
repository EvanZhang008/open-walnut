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
