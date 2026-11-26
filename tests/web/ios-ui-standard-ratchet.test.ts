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
import { countIos, countFile, codeLines, blockAt, appSwiftFiles, IOS_KINDS, IOS_ROOT, DESIGN_SYSTEM_FILES, type IosCounts } from './ios-ui-standard-scan'

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

  it("the accent is Walnut's brown, a fill's words are onTint", () => {
    // 2026-11-24, the user: the earlier yellow-based look is nicer, "because it's Walnut".
    const theme = fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Core/Theme.swift'), 'utf8')
    expect(theme).toMatch(/static let tintColor = UIColor\(light: 0x8B5A2B, dark: 0xC99659\)/)
    expect(theme).toMatch(/static let accentColor = tintColor/)
    expect(theme).toMatch(/static let onTintColor = UIColor\(light: 0xFFFFFF, dark: 0x1C1207\)/)
    const accent = JSON.parse(fs.readFileSync(path.join(IOS_ROOT, 'Walnut/Support/Assets.xcassets/AccentColor.colorset/Contents.json'), 'utf8'))
    expect(accent.colors[0].color.components).toMatchObject({ red: '0x8B', green: '0x5A', blue: '0x2B' })
    // White on the golden dark fill reads 2.2:1: no view draws white words or glyphs on an accent fill.
    const files = (fs.readdirSync(path.join(IOS_ROOT, 'Walnut'), { recursive: true }) as string[]).filter((f) => f.endsWith('.swift'))
    const offenders: string[] = []
    for (const f of files) {
      const lines = fs.readFileSync(path.join(IOS_ROOT, 'Walnut', f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/(?:background|fill)\([^)]*Theme\.accent\b/.test(line)) return
        const near = lines.slice(Math.max(0, i - 4), i + 2)
        if (near.some((l) => /foregroundStyle\(/.test(l) && /(?:Color\.white|\.white)\b/.test(l) && !/Theme\.onTint/.test(l))) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  describe("the chat paints with the web's grey chat palette", () => {
    // 2026-11-24, the user: the phone's chat should look like the web's chat, "white, black,
    // grey, and maybe a bit of yellow as our main tone". Theme.Chat mirrors chat-palette.css;
    // every chat root sets `.walnutPalette(.chat)`; what waits on the person sets `.app` back.
    const read = (rel: string) => fs.readFileSync(path.join(IOS_ROOT, rel), 'utf8')
    const CSS = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/styles/chat-palette.css'), 'utf8')

    /** A CSS block's custom properties, by the block's selector line. */
    function cssVars(selector: string): Record<string, string> {
      const start = CSS.indexOf(`${selector} {`)
      expect(start, `chat-palette.css has a "${selector}" block`).toBeGreaterThanOrEqual(0)
      const block = CSS.slice(start, CSS.indexOf('}', start))
      const vars: Record<string, string> = {}
      for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim().toUpperCase()
      return vars
    }

    /** Theme.Chat's `<name> = UIColor(light: 0x.., dark: 0x..)` values as #RRGGBB. */
    function swiftPair(name: string): { light: string; dark: string } {
      const theme = read('Walnut/Core/Theme.swift')
      const chat = theme.slice(theme.indexOf('enum Chat {'), theme.indexOf('\n    }\n', theme.indexOf('enum Chat {')))
      const m = chat.match(new RegExp(String.raw`static let ${name} = UIColor\(light: 0x([0-9A-Fa-f]{6}), dark: 0x([0-9A-Fa-f]{6})\)`))
      expect(m, `Theme.Chat.${name} is a light/dark hex pair`).not.toBeNull()
      return { light: `#${m![1].toUpperCase()}`, dark: `#${m![2].toUpperCase()}` }
    }

    it("Theme.Chat's values are chat-palette.css's", () => {
      const light = cssVars(':root')
      const dark = cssVars(':root[data-theme="dark"]')
      const pairs: [string, string][] = [
        ['chat-user-bubble', 'userBubbleColor'],
        ['chat-panel', 'panelColor'],
        ['chat-grey-strong', 'accentColor'],
        ['chat-grey-soft', 'softColor'],
      ]
      for (const [css, swift] of pairs) {
        expect(swiftPair(swift), `--${css} vs Theme.Chat.${swift}`).toEqual({ light: light[css], dark: dark[css] })
      }
    })

    /** The roots of every chat surface: each sets the chat's palette for all below it. */
    const CHAT_ROOTS = [
      'Walnut/Views/Chat/ChatView.swift',
      'Walnut/Views/Chat/ChatDrawer.swift',
      'Walnut/Views/Chat/ComposerView.swift',
      'Walnut/Views/Sessions/SessionConversationView.swift',
      'Walnut/Views/Sessions/NewSessionChatView.swift',
      // A hosted timeline cell does not inherit the SwiftUI environment: it sets its own.
      'Walnut/Timeline/TimelineComponentCells.swift',
    ]
    /** What waits on the person keeps the app's colour inside a chat (the web's is-pending card). */
    const KEEPS_COLOUR = [
      'Walnut/Views/Sessions/PermissionRequestCard.swift',
      'Walnut/Views/Tasks/ActionNeededView.swift',
      // An Org node's pages (Threads, Tasks, Brief) open over its chat and are not a chat.
      'Walnut/Views/Org/OrgNodePage.swift',
    ]
    /** Views that draw in a chat: never the app's accent directly. Every timeline file is one. */
    const CHAT_FILES = [
      'Walnut/Views/Chat/ChatView.swift',
      'Walnut/Views/Chat/ChatDrawer.swift',
      'Walnut/Views/Chat/ChatDrawerOrg.swift',
      'Walnut/Views/Chat/ChatDrawerDirectors.swift',
      'Walnut/Views/Chat/ComposerView.swift',
      'Walnut/Views/Chat/ComposerFileCard.swift',
      'Walnut/Views/Chat/MessageRow.swift',
      'Walnut/Views/Chat/ModelSheetColumns.swift',
      'Walnut/Views/Chat/ModelSheetFolds.swift',
      'Walnut/Views/Sessions/NewSessionChatView.swift',
      'Walnut/Views/Sessions/SessionConversationView.swift',
      'Walnut/Views/Sessions/SessionQueueViews.swift',
      'Walnut/Views/Sessions/VoiceModeBar.swift',
      'Walnut/Views/Shared/VoiceInputControls.swift',
      'Walnut/Views/Shared/VoiceDictation.swift',
      'Walnut/Views/Shared/DesignSystem/WalnutButtonStyle.swift',
      'Walnut/Views/Shared/DesignSystem/WalnutSurfaces.swift',
      ...(fs.readdirSync(path.join(IOS_ROOT, 'Walnut/Timeline')) as string[])
        .filter((f) => f.endsWith('.swift')).map((f) => `Walnut/Timeline/${f}`),
    ]
    const DIRECT_ACCENT = /\bTheme\.(?:tint|accent|tintSoft|chipSelected|onTint)(?:Color)?\b/

    it('every chat root applies .walnutPalette(.chat), and an ask keeps .app', () => {
      for (const f of CHAT_ROOTS) expect(read(f), f).toContain('.walnutPalette(.chat)')
      for (const f of KEEPS_COLOUR) expect(read(f), f).toContain('.walnutPalette(.app)')
    })

    it("a chat's views paint with the palette, never the app's accent directly", () => {
      const offenders: string[] = []
      for (const f of CHAT_FILES) {
        const raw = read(f).split('\n')
        codeLines(raw.join('\n')).forEach((code, i) => {
          if (DIRECT_ACCENT.test(code) && !/chat-palette-ok:/.test(raw[i])) offenders.push(`ios-native/${f}:${i + 1}: ${raw[i].trim()}`)
        })
      }
      expect(offenders, `Use the environment's palette (\`@Environment(\\.walnutPalette)\`, palette.tint) or Theme.Chat, or mark the line // chat-palette-ok: <why>:\n${offenders.join('\n')}`).toEqual([])
    })

    it('finds a direct accent and honours the marker', () => {
      expect(DIRECT_ACCENT.test('.foregroundStyle(Theme.tint)')).toBe(true)
      expect(DIRECT_ACCENT.test('config.baseBackgroundColor = Theme.accentColor')).toBe(true)
      expect(DIRECT_ACCENT.test('.foregroundStyle(Theme.Chat.accent)')).toBe(false)
      expect(DIRECT_ACCENT.test('.foregroundStyle(palette.tint)')).toBe(false)
    })
  })

  describe('picker keys on a tool row are round, drawn by one helper', () => {
    // 2026-11-26: "Default", "Opus 5.5 · High", "Mode", "Model" and the new-session row's "Default
    // model" were 8 pt rounded rectangles beside the round +, mic and send. A small key is round
    // (a capsule); the shared `walnutPickerKey` draws every one (a wrapped key takes the 12 pt corner).
    const read = (rel: string) => fs.readFileSync(path.join(IOS_ROOT, rel), 'utf8')
    /** The files that hold the composer's and the new-session page's tool rows. */
    const TOOL_ROW_FILES = [
      'Walnut/Views/Chat/ComposerControls.swift',
      'Walnut/Views/Chat/ComposerView.swift',
      'Walnut/Views/Sessions/NewSessionChatView.swift',
    ]
    /** Where a key on those rows starts: a menu, a picker, the shared pill, the page's own keys. */
    const KEY_START = /\bMenu\s*[{(]|\bPicker\s*\(|\bPillChip\s*\(|\bstruct PillChip\b|\bfunc pill\s*\(|\bvar quickFolderRow\b|\bvar pillRow\b/
    /** A key drawing its own shape instead of the helper. */
    const OWN_SHAPE = /RoundedRectangle\s*\(|Theme\.Radius\.shape\(|\boptionShape\b|PillChipShape|\bCapsule\s*\(/

    function keyBlocks(rel: string, src: string) {
      const lines = codeLines(src)
      const out: { at: string; block: string }[] = []
      lines.forEach((line, i) => {
        const m = line.match(KEY_START)
        if (m) out.push({ at: `ios-native/${rel}:${i + 1} ${m[0]}`, block: blockAt(lines, i).join('\n') })
      })
      return out
    }

    it('no key on the composer and new-session rows draws its own corner or capsule', () => {
      const offenders: string[] = []
      const members: string[] = []
      for (const rel of TOOL_ROW_FILES) {
        for (const k of keyBlocks(rel, read(rel))) {
          members.push(k.at)
          if (OWN_SHAPE.test(k.block)) offenders.push(k.at)
        }
      }
      // The members: the pill's view, its four uses (live mode and model, draft mode and model),
      // the folder/project/sync key and the quick folders.
      expect(members.filter((m) => /PillChip\($/.test(m)).length, members.join('\n')).toBeGreaterThanOrEqual(4)
      expect(members.some((m) => /struct PillChip$/.test(m))).toBe(true)
      expect(members.some((m) => /func pill\($/.test(m))).toBe(true)
      expect(offenders, `Draw the key with .walnutPickerKey(active:wraps:) (WalnutButtonStyle.swift):\n${offenders.join('\n')}`).toEqual([])
    })

    it('the keys that draw go through the helper, and the helper is round', () => {
      const drawers = TOOL_ROW_FILES.flatMap((rel) => keyBlocks(rel, read(rel)))
        .filter((k) => /struct PillChip$|func pill\($|var quickFolderRow$/.test(k.at))
      expect(drawers.length).toBe(3)
      for (const k of drawers) expect(k.block, k.at).toContain('.walnutPickerKey(')
      // Every file that uses the pill is a tool-row file named above.
      const users = appSwiftFiles().filter((rel) => /\bPillChip\s*\(/.test(codeLines(read(rel)).join('\n')))
      expect(users.filter((rel) => !TOOL_ROW_FILES.includes(rel))).toEqual([])
      const buttons = read('Walnut/Views/Shared/DesignSystem/WalnutButtonStyle.swift')
      expect(buttons).toMatch(/wraps \? WalnutButtonStyle\.optionShape\.path\(in: inner\) : Capsule\(style: \.continuous\)\.path\(in: inner\)/)
      expect(buttons).toMatch(/func walnutPickerKey\(active: Bool = false, wraps: Bool = false\)/)
    })

    it('finds a key that draws its own shape', () => {
      const one = (src: string) => keyBlocks('Walnut/Views/X.swift', src).filter((k) => OWN_SHAPE.test(k.block)).length
      expect(one(['Menu {', '    Button("A") { }', '} label: {', '    Text("Mode")', '        .background(.gray, in: RoundedRectangle(cornerRadius: 8))', '}'].join('\n'))).toBe(1)
      expect(one(['Menu {', '    Button("A") { }', '} label: {', '    Text("Mode")', '}', '.background(Color.gray, in: Theme.Radius.shape(Theme.Radius.sm))'].join('\n'))).toBe(1)
      expect(one(['Menu {', '    Button("A") { }', '} label: {', '    Text("Mode").walnutPickerKey()', '}'].join('\n'))).toBe(0)
      expect(one(['Menu {', '    Button("A") { }', '} label: {', '    Text("Mode").walnutPickerKey()', '}', 'Text("x").background(.gray, in: Capsule())'].join('\n'))).toBe(0)
    })
  })

  describe("every permission and question choice is the family's option row", () => {
    // 2026-11-26: permission cards drew their choices three ways (hairline rows, solid grey rows,
    // two half-width keys). Each choice of a question is `.walnut(.option(recommended:))` with
    // `WalnutOptionLabel` (standard.md, the iOS column's Option row).
    const read = (rel: string) => fs.readFileSync(path.join(IOS_ROOT, rel), 'utf8')
    /** A file that draws choices: it uses the option row, or holds a permission's or question's options. */
    const DRAWS_CHOICES = /\.walnut\(\s*\.option\b|\bPermissionChoice\b|\bAskQuestionOption\b|\bWalnutAskOption\b/
    /** Option rows that are not a question's choices, each with why. */
    const NOT_A_QUESTION: Record<string, string> = {
      'Walnut/Views/Inbox/InboxItemTaskSelector.swift': 'a task picker: each row is a task (title, project, phase), not a choice of a question',
    }
    /** A button whose action answers a choice. */
    const ANSWERS = /\btap\(choice\)|\bselections\[|\bonPick\(|\bpick\(o\)|\banswer\(action\)/
    /** The card's own keys beside its choices (the ask card's Submit and Dismiss). */
    const OWN_KEYS = /session\.askQuestion\.(?:submit|dismiss)/

    /** Each `.buttonStyle(` of a file with the code of its button, from the `Button` line on. */
    function styledButtons(src: string) {
      const lines = codeLines(src)
      const out: { line: number; style: string; button: string; after: string }[] = []
      lines.forEach((line, i) => {
        if (!/\.buttonStyle\(/.test(line)) return
        let b = i
        while (b > 0 && i - b < 30 && !/\bButton\b/.test(lines[b])) b--
        out.push({ line: i + 1, style: line, button: lines.slice(b, i + 1).join('\n'), after: lines.slice(i, i + 6).join('\n') })
      })
      return out
    }

    const files = appSwiftFiles().filter((rel) => !DESIGN_SYSTEM_FILES.includes(rel) && rel.startsWith('Walnut/Views/') && DRAWS_CHOICES.test(codeLines(read(rel)).join('\n')))

    it('finds the files that draw choices', () => {
      for (const f of ['Walnut/Views/Sessions/PermissionRequestCard.swift', 'Walnut/Views/Tasks/ActionNeededView.swift', 'Walnut/Views/Org/OrgThreadsView.swift', 'Walnut/Views/Inbox/LetterReaderView.swift']) {
        expect(files, f).toContain(f)
      }
      for (const f of Object.keys(NOT_A_QUESTION)) expect(fs.existsSync(path.join(IOS_ROOT, f)), f).toBe(true)
    })

    it('a button that answers a choice is an option row with WalnutOptionLabel', () => {
      const offenders: string[] = []
      for (const rel of files) {
        if (NOT_A_QUESTION[rel]) continue
        for (const b of styledButtons(read(rel))) {
          const option = /\.walnut\(\s*\.option\(/.test(b.style)
          const answers = ANSWERS.test(b.button)
          if ((answers || option) && !option) offenders.push(`ios-native/${rel}:${b.line}: a choice styled ${b.style.trim()}`)
          if (option && !/\bWalnutOptionLabel\(/.test(b.button)) offenders.push(`ios-native/${rel}:${b.line}: an option row without WalnutOptionLabel`)
        }
      }
      expect(offenders, `Draw each choice as .buttonStyle(.walnut(.option(recommended:))) with WalnutOptionLabel:\n${offenders.join('\n')}`).toEqual([])
    })

    it('a permission or question card has no other key look than its own Submit and Dismiss', () => {
      const rel = 'Walnut/Views/Sessions/PermissionRequestCard.swift'
      const offenders = styledButtons(read(rel))
        .filter((b) => !/\.walnut\(\s*\.option\(/.test(b.style) && !OWN_KEYS.test(b.after))
        .map((b) => `ios-native/${rel}:${b.line}: ${b.style.trim()}`)
      expect(offenders).toEqual([])
      // The first Allow is always filled (PendingPermission.strongChoiceID).
      expect(read(rel)).toMatch(/\.buttonStyle\(\.walnut\(\.option\(recommended: strong\)\)\)/)
    })

    it('finds a choice drawn another way', () => {
      const bad = ['Button {', '    tap(choice)', '} label: {', '    Text(choice.label)', '}', '.buttonStyle(.walnut(.primary, size: .small, fullWidth: true))'].join('\n')
      const good = ['Button {', '    tap(choice)', '} label: {', '    WalnutOptionLabel(label: choice.label)', '}', '.buttonStyle(.walnut(.option(recommended: false)))'].join('\n')
      const bare = ['Button { pick(o) } label: {', '    Text(o.label)', '}', '.buttonStyle(.walnut(.option(recommended: false)))'].join('\n')
      expect(styledButtons(bad).some((b) => ANSWERS.test(b.button) && !/\.option\(/.test(b.style))).toBe(true)
      expect(styledButtons(good).every((b) => /\.option\(/.test(b.style) && /WalnutOptionLabel\(/.test(b.button))).toBe(true)
      expect(styledButtons(bare).some((b) => !/WalnutOptionLabel\(/.test(b.button))).toBe(true)
    })
  })

  describe('the main action and the recommended choice are always filled in the main colour', () => {
    // 2026-11-26, the team's rule (Walnut VP): "when a set of keys is made one look, keep the main
    // action and the recommended choice in the main colour; never make every key the same colour".
    // 942e9326b2 had made a permission list that names rules, and the ask card, all plain rows.
    const read = (rel: string) => fs.readFileSync(path.join(IOS_ROOT, rel), 'utf8')
    const WEB = path.join(__dirname, '../../web/src')
    const readWeb = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

    it('no phone choice row is hard-wired never to fill', () => {
      const offenders = appSwiftFiles()
        .filter((rel) => !DESIGN_SYSTEM_FILES.includes(rel))
        .flatMap((rel) => codeLines(read(rel)).flatMap((l, i) => (/\.option\(\s*recommended:\s*false\s*\)/.test(l) ? [`ios-native/${rel}:${i + 1}: ${l.trim()}`] : [])))
      expect(offenders, `A choice row takes its recommended (or main) flag from the data, never a literal false:\n${offenders.join('\n')}`).toEqual([])
    })

    it("the phone's strong choice is always the first Allow, and the ask card fills its recommended one", () => {
      const models = read('Walnut/API/ModelsWave1.swift')
      const body = models.slice(models.indexOf('static func strongChoiceID'), models.indexOf('static func strongChoiceID') + 200)
      expect(body).toMatch(/choices\.first\(where: \\\.allow\)\?\.id/)
      expect(body).not.toMatch(/guard|detail|takesNote/)
      const card = read('Walnut/Views/Sessions/PermissionRequestCard.swift')
      expect(card).toMatch(/let recommended = WalnutOptionLabel\.shown\(option\.label\)\.marked/)
      expect(card).toMatch(/\.buttonStyle\(\.walnut\(\.option\(recommended: recommended\)\)\)/)
      expect(read('Walnut/Views/Inbox/LetterReaderView.swift')).toMatch(/\.option\(recommended: action\.recommended == true\)/)
    })

    it("the web's permission prompts fill their main action through strongChoiceId, whatever the list names", () => {
      for (const rel of ['components/common/PermissionPromptControls.tsx', 'components/common/NotificationToaster.tsx']) {
        const src = readWeb(rel)
        expect(src, rel).toMatch(/const strong = strongChoiceId\(acpOptions\)/)
        // Every btn-primary on a choice is the strong one, never gated on what the list names.
        const gates = [...src.matchAll(/\$\{([^{}]*)\? '' : ' btn-primary[^']*'\}/g)].map((m) => m[1])
        expect(gates, `${rel}: a btn-primary that depends on the list's details or notes`).toEqual([])
        expect(src, rel).toMatch(/o\.optionId === strong \? ' btn-primary/)
      }
    })

    it('strongChoiceId picks the first plain yes, a list with rules and a note-taking deny included', async () => {
      const { strongChoiceId } = await import('../../web/src/contexts/notifications/notification-model')
      const rules = [
        { optionId: 'always', kind: 'allow_always', name: 'Always allow', detail: 'Bash(npm test:*)' },
        { optionId: 'once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'no', kind: 'reject_once', name: 'Deny', takesNote: true },
      ]
      expect(strongChoiceId(rules as never)).toBe('once')
      expect(strongChoiceId([rules[0], rules[2]] as never)).toBe('always')
      expect(strongChoiceId([rules[2]] as never)).toBeUndefined()
    })
  })

  describe('a diff count shows only its sides above zero, written in one place', () => {
    // 2026-11-26: the Changed page read "+7 −0" and "+0 −3", the zero side in a state colour.
    // `DiffCount` (SessionChangesSheet.swift) writes every "+N −M"; `LineCounts` draws it.
    const read = (rel: string) => fs.readFileSync(path.join(IOS_ROOT, rel), 'utf8')
    const HOME = 'Walnut/Views/Sessions/Changes/SessionChangesSheet.swift'
    /** A count written with a sign: "+\(n)", and a removed count "\u{2212}\(n)" or "−\(n)"; a
     *  hyphen "-\(n)" counts only beside a "+\(n)" (a log line's "-\(age)s" is not a diff). */
    const PLUS = /\+\\\(/
    const MINUS = /(?:\\u\{2212\}|−)\\\(/
    const HYPHEN = /-\\\(/

    /** The lines that write a signed count pair (or a removed count), outside `enum DiffCount`. */
    function writers(rel: string, src: string): string[] {
      const lines = codeLines(src)
      const start = lines.findIndex((l) => /\benum DiffCount\b/.test(l))
      const home = start >= 0 ? new Set(blockAt(lines, start).map((_, k) => start + k)) : new Set<number>()
      const out: string[] = []
      lines.forEach((line, i) => {
        if (home.has(i)) return
        const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
        if (MINUS.test(line) || (PLUS.test(line) && (MINUS.test(near) || HYPHEN.test(near)))) out.push(`ios-native/${rel}:${i + 1}: ${line.trim()}`)
      })
      return out
    }

    it('no view writes "+N −M" itself', () => {
      const offenders = appSwiftFiles().flatMap((rel) => writers(rel, read(rel)))
      expect(offenders, `Show a diff's counts with LineCounts (DiffCount.parts):\n${offenders.join('\n')}`).toEqual([])
    })

    it('the one formatter drops the zero side and LineCounts uses it', () => {
      const src = read(HOME)
      expect(src).toMatch(/if additions > 0 \{ out\.append\(Part\(text: "\+\\\(additions\)", added: true\)\) \}/)
      expect(src).toMatch(/if deletions > 0 \{ out\.append\(Part\(text: "\\u\{2212\}\\\(deletions\)", added: false\)\) \}/)
      expect(src).toMatch(/let parts = DiffCount\.parts\(additions: additions, deletions: deletions\)/)
    })

    it('finds a count pair written outside it', () => {
      expect(writers('Walnut/Views/X.swift', 'Text(verbatim: "+\\(a) \\u{2212}\\(d)")')).toHaveLength(1)
      expect(writers('Walnut/Views/X.swift', ['Text("+\\(a)")', 'Text("-\\(d)")'].join('\n'))).toHaveLength(1)
      expect(writers('Walnut/Views/X.swift', ['Text("+\\(a)")', 'Text("−\\(d)")'].join('\n'))).toHaveLength(2)
      expect(writers('Walnut/Views/X.swift', 'parts.append("-\\(age)s \\(label)")')).toHaveLength(0)
      expect(writers('Walnut/Views/X.swift', 'Text("+\\(n) more")')).toHaveLength(0)
      expect(writers('Walnut/Views/X.swift', ['enum DiffCount {', '    static let a = "+\\(x)"', '    static let b = "\\u{2212}\\(y)"', '}'].join('\n'))).toHaveLength(0)
    })
  })

  it('the standard it enforces names this test', () => {
    const text = fs.readFileSync(path.join(import.meta.dirname, '../..', STANDARD), 'utf8')
    expect(text).toContain('tests/web/ios-ui-standard-ratchet.test.ts')
  })
})
