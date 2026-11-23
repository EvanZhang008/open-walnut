/**
 * The phone's UI standard (.claude/skills/walnut-ui-requirements/standard.md, its iOS column): one
 * look per kind of control, built from the tokens in ios-native/Walnut/Core/ThemeTokens.swift and the
 * shared controls in ios-native/Walnut/Views/Shared/DesignSystem/.
 *
 * 2026-11-21, the user, on a pill-shaped box on the phone: why must everything be round? everything
 * should be consistent. The app had a colour system and nothing else, so every view picked a
 * `Capsule()` or any corner, its own button look and its own box.
 *
 * Each way a view still draws its own (ios-ui-standard-scan.ts) is counted per file; the counts in
 * ios-ui-standard-baseline.json may only go down. A new file or a higher count fails: use the design
 * system instead. A lower count fails too until the baseline is lowered with `IOS_UI_STANDARD_RECORD=1`
 * on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { countIos, countFile, IOS_KINDS, IOS_ROOT, DESIGN_SYSTEM_FILES, type IosCounts } from './ios-ui-standard-scan'

const BASELINE = path.join(import.meta.dirname, 'ios-ui-standard-baseline.json')
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md'

function compare(kind: string, now: Record<string, number>, was: Record<string, number>) {
  const grew: string[] = []
  const fell: string[] = []
  for (const [file, n] of Object.entries(now)) {
    const before = was[file] ?? 0
    if (n > before) grew.push(`${kind}: ios-native/${file} has ${n} (was ${before})`)
  }
  for (const [file, before] of Object.entries(was)) {
    const n = now[file] ?? 0
    if (n < before) fell.push(`${kind}: ios-native/${file} has ${n} (baseline ${before})`)
  }
  return { grew, fell }
}

describe('iOS UI standard: one look per kind of control', () => {
  const now = countIos()

  if (process.env.IOS_UI_STANDARD_RECORD === '1') {
    fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`)
  }
  const recorded = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Partial<IosCounts>

  for (const kind of IOS_KINDS) {
    it(`${kind}: no new second style`, () => {
      const { grew } = compare(kind, now[kind], recorded[kind] ?? {})
      expect(grew, `A view draws its own instead of the design system (${STANDARD}, iOS column):\n${grew.join('\n')}`).toEqual([])
    })
    it(`${kind}: the baseline follows every fix`, () => {
      const { fell } = compare(kind, now[kind], recorded[kind] ?? {})
      expect(fell, `Fewer exceptions than recorded: good. Lower the baseline with\nIOS_UI_STANDARD_RECORD=1 bun --bun vitest run tests/web/ios-ui-standard-ratchet.test.ts\n${fell.join('\n')}`).toEqual([])
    })
  }

  it('finds each shape of a view drawing its own', () => {
    const one = (src: string) => countFile('Walnut/Views/X.swift', src)
    // Round is the shape of what you press and of every tag (standard.md "Shapes"): not counted.
    expect(Object.values(one('Text("a").background(Theme.accent, in: Capsule())')).reduce((a, b) => a + b, 0)).toBe(0)
    expect(one('Color(red: 0.5, green: 0.2, blue: 0.1)').literalColour).toBe(1)
    expect(one('UIColor(white: 0.9, alpha: 1)').literalColour).toBe(1)
    expect(one('.foregroundStyle(.orange)').literalColour).toBe(1)
    expect(one('.tint(Color.red)').literalColour).toBe(1)
    expect(one('.foregroundStyle(Theme.danger)').literalColour).toBe(0)
    expect(one('case .red: 1').literalColour).toBe(0)
    expect(one('.font(.system(size: 15, weight: .semibold))').literalFont).toBe(1)
    expect(one('.font(Theme.Glyph.md.font(.semibold))').literalFont).toBe(0)
    expect(one('.font(.system(size: glyphSize))').literalFont).toBe(0)
    expect(one('RoundedRectangle(cornerRadius: 10, style: .continuous)').radiusLiteral).toBe(1)
    expect(one('RoundedRectangle(cornerRadius: Theme.Radius.sm)').radiusLiteral).toBe(0)
    expect(one('.buttonBorderShape(.roundedRectangle(radius: 16))').radiusLiteral).toBe(1)
    expect(one('.buttonStyle(.borderedProminent)').systemButtonStyle).toBe(1)
    expect(one('.buttonStyle(.bordered)').systemButtonStyle).toBe(1)
    expect(one('.buttonStyle(.plain)').systemButtonStyle).toBe(0)
    expect(one('.buttonStyle(.walnut(.primary))').systemButtonStyle).toBe(0)
    expect(one('struct RowActionStyle: ButtonStyle {').ownButtonStyle).toBe(1)
    expect(one('private struct X: View, ButtonStyle {').ownButtonStyle).toBe(1)
    expect(one('ContentUnavailableView("No results", systemImage: "magnifyingglass")').ownEmptyState).toBe(1)
    expect(one(['TextField("Reply", text: $t)', '    .padding(8)', '    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))'].join('\n')).ownReplyBox).toBe(1)
    expect(one(['TextField("Name", text: $t)', '    .textFieldStyle(.roundedBorder)'].join('\n')).ownReplyBox).toBe(1)
    expect(one(['TextField("Name", text: $t)', '    .textFieldStyle(.walnut)'].join('\n')).ownReplyBox).toBe(0)
    expect(one(['TextField("Reply", text: $t)', '    .background(Color(.tertiarySystemFill), in: Theme.Radius.shape(Theme.Radius.sm))'].join('\n')).ownReplyBox).toBe(1)
    expect(one('button.layer.cornerRadius = 18').radiusLiteral).toBe(1)
    expect(one('.shadow(color: .black.opacity(0.1), radius: 12, y: 4)').radiusLiteral).toBe(0)
    expect(one('var p = Path(roundedRect: CGRect(x: 7, y: 3, width: 2, height: 6), cornerRadius: 0.9, style: .circular)').radiusLiteral).toBe(0)
    expect(one('label.font = .systemFont(ofSize: 13, weight: .semibold)').literalFont).toBe(1)
    expect(one('.foregroundStyle(Color(.systemIndigo))').literalColour).toBe(1)
    expect(one('.buttonStyle(.walnut(.primary))').tintFill).toBe(0)
    expect(one('.background(Theme.tint, in: Circle())').tintFill).toBe(1)
    expect(one('.background(Theme.tint.opacity(0.12), in: Circle())').tintFill).toBe(0)
    expect(one('.background(Theme.tintSoft, in: Circle())').tintFill).toBe(0)
    expect(one(['.background(', '    on ? Theme.tint : Color(.tertiarySystemFill),'].join('\n')).tintFill).toBe(1)
    expect(one('.foregroundStyle(on ? Theme.tint : .secondary)').tintFill).toBe(0)
    expect(one('struct Pressable<Label: View>: ButtonStyle {').ownButtonStyle).toBe(1)
    // A long block is a rounded rectangle; only a small key or tag is round.
    expect(one(['Text(t)', '    .frame(maxWidth: .infinity, minHeight: 44)', '    .background(Theme.controlFill, in: Capsule(style: .continuous))'].join('\n')).wideCapsule).toBe(1)
    expect(one(['Button { } label: { Text(t) }', '    .buttonStyle(.walnut(.option(recommended: false)))', '    .overlay(', '        Capsule(style: .continuous)', '            .strokeBorder(Theme.tint, lineWidth: 1.5)'].join('\n')).wideCapsule).toBe(1)
    expect(one(['Button("Go") { }', '    .buttonStyle(.walnut(.primary, fullWidth: true))', '    .clipShape(Capsule())'].join('\n')).wideCapsule).toBe(1)
    expect(one(['Text(t)', '    .frame(maxWidth: .infinity)', '    .background(Theme.controlFill, in: WalnutButtonStyle.optionShape)'].join('\n')).wideCapsule).toBe(0)
    expect(one(['Text(t)', '    .padding(.horizontal, 8)', '    .background(Theme.controlFill, in: Capsule())'].join('\n')).wideCapsule).toBe(0)
    expect(one(['Text(t)', '    .frame(maxWidth: .infinity) // ui-standard-ok: one of three keys on a line', '    .background(Theme.controlFill, in: Capsule())'].join('\n')).wideCapsule).toBe(0)
  })

  it('the family draws a long key (an option row, a full-width key) as a rounded rectangle, a small one round', () => {
    const buttons = fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Views/Shared/DesignSystem/WalnutButtonStyle.swift'), 'utf8')
    expect(buttons).toMatch(/if case \.option = role \{ return AnyShape\(optionShape\) \}/)
    expect(buttons).toMatch(/fullWidth \? AnyShape\(optionShape\) : AnyShape\(Capsule\(style: \.continuous\)\)/)
    expect(buttons).toMatch(/static var optionShape: RoundedRectangle \{ Theme\.Radius\.shape\(Theme\.Radius\.md\) \}/)
    expect(buttons).toMatch(/let shape = Self\.shape\(role, fullWidth: fullWidth\)/)
  })

  it('the design system exists, and its own files are the only ones exempt', () => {
    for (const f of DESIGN_SYSTEM_FILES) expect(fs.existsSync(path.join(IOS_ROOT, f)), f).toBe(true)
    const tokens = fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Core/ThemeTokens.swift'), 'utf8')
    for (const t of ['enum Radius', 'enum Space', 'enum TextSize', 'enum Glyph', 'enum Control']) expect(tokens).toContain(t)
    const buttons = fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Views/Shared/DesignSystem/WalnutButtonStyle.swift'), 'utf8')
    for (const t of ['case primary, secondary, tool, destructive', 'case option(recommended: Bool)', 'struct WalnutChipStyle']) expect(buttons).toContain(t)
  })

  it('the main action is blue, and the brown is the brand only', () => {
    const theme = fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Core/Theme.swift'), 'utf8')
    expect(theme).toMatch(/static let tintColor = UIColor\(light: 0x006BE0, dark: 0x0A84FF\)/)
    expect(theme).toMatch(/static let accentColor = UIColor\(light: 0x006BE0, dark: 0x0A6CE0\)/)
    expect(theme).toMatch(/static let brandColor = UIColor\(light: 0x8B5A2B, dark: 0xC99659\)/)
    const accent = JSON.parse(fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Support/Assets.xcassets/AccentColor.colorset/Contents.json'), 'utf8'))
    expect(accent.colors[0].color.components).toMatchObject({ red: '0x00', green: '0x6B', blue: '0xE0' })
  })

  it('the standard it enforces names this test', () => {
    const text = fs.readFileSync(path.join(import.meta.dirname, '../..', STANDARD), 'utf8')
    expect(text).toContain('tests/web/ios-ui-standard-ratchet.test.ts')
  })
})
