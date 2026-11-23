/**
 * Every key that opens a picker shows MenuCaret and carries aria-haspopup (2026-11-23, the UI audit:
 * the new task draft's "Auto model" key had neither, while "Default mode" beside it had both and the
 * session composer's "Opus 5.5 · High" showed its caret). A picker key shows words or a current value
 * (a model, a mode, a project, a date, "Snooze", "More") and opens a list of choices. The caret
 * shows a person it opens a choice; aria-haspopup tells a screen reader the same.
 *
 * Not picker keys: an icon key (⋮, ···, a gear, a bell; it opens a menu with no caret), a fold
 * (aria-expanded and DisclosureChevron), a row inside a menu or list (role menuitem or option, or a
 * row that opens more and so ends with DisclosureChevron: standard.md, Big menus 6), and a key whose
 * dialog is not a choice (a side chat drawer, a comment box, a status pill's card).
 *
 * Three checks over web/src, plugin-store and examples/plugins (menu-key-scan.ts reads the AST),
 * each baseline 0:
 *  1. a MenuCaret sits in a key that carries aria-haspopup;
 *  2. a key with aria-haspopup that shows words holds MenuCaret, when what it opens is a list
 *     (menu, listbox, true) or a picker (it shows a `*Picker` / `*Menu` / `*Dropdown`, or hands its
 *     press to the draft menu);
 *  3. a key whose press opens a picker, menu or popover (a toggle of a state the file shows one
 *     under, `toggle*Picker()`, `open*Menu()`, `onOpen*Picker`) carries aria-haspopup.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './css-scan'
import { scanKeys, type KeyFindings } from './menu-key-scan'

const ROOT = join(__dirname, '..', '..')
const FILES = ['web/src', 'plugin-store', 'examples/plugins']
  .flatMap((d) => walk(join(ROOT, d), ['.tsx']))
  .filter((f) => !/\.test\.|\.spec\./.test(f))
const rel = (f: string) => relative(ROOT, f)

/**
 * The carets that stay outside a key, each with why. Keep it short; a new entry needs the same kind
 * of reason.
 */
const CARET_OUTSIDE_KEY: Record<string, string> = {
  'web/src/components/sessions/DraftWhereRow.tsx':
    "the draft's Project field draws its caret in its value line; the field's own key (FieldOpen, a button laid under the field's parts) carries aria-haspopup",
}

const lines = (r: KeyFindings, k: keyof KeyFindings) => r[k].map((f) => f.line)

describe('a picker key shows MenuCaret and carries aria-haspopup', () => {
  it('the scan catches what it guards and passes what it does not', () => {
    // The draft's model key before the fix: words, a toggle, a picker under it, and neither mark.
    const draft = '<>\n<button className="composer-model-pill" onClick={() => { setFallbackView(null); setOpen((v) => !v); }}>\n{label}\n</button>\n{open && <ModelPicker onClose={() => setOpen(false)} />}\n</>'
    expect(lines(scanKeys(draft), 'silentOpener')).toEqual([2])
    // Fixed as the composer's pill: aria-haspopup and the caret.
    expect(scanKeys(draft.replace('onClick', 'aria-haspopup="dialog" aria-expanded={open} onClick').replace('{label}', '{label}<MenuCaret />'))).toEqual({ caretNoPopup: [], popupNoCaret: [], silentOpener: [] })
    // With aria-haspopup but no caret, a picker dialog still needs one.
    expect(lines(scanKeys(draft.replace('onClick', 'aria-haspopup="dialog" onClick')), 'popupNoCaret')).toEqual([2])
    // A handler named by the key, and a toggle call.
    expect(lines(scanKeys('const flip = () => setPickerOpen((o) => !o)\nconst a = <button onClick={flip}>Host</button>'), 'silentOpener')).toEqual([2])
    expect(lines(scanKeys('<button onClick={(e) => { ref.current = e.currentTarget; togglePicker(); }}>Model</button>'), 'silentOpener')).toEqual([1])
    expect(lines(scanKeys('<button onClick={onOpenPicker}>Folder</button>'), 'silentOpener')).toEqual([1])
    // A fold is not an opener; nor a press that opens nothing.
    expect(scanKeys('<button aria-expanded={open} onClick={() => setMenuOpen((v) => !v)}><DisclosureChevron open={open} />Group</button>').silentOpener).toEqual([])
    expect(scanKeys('<button onClick={() => setCount((n) => n + 1)}>Add</button>').silentOpener).toEqual([])

    // A caret's key carries aria-haspopup: on the key, through a prop, or by the shared menu hook's props.
    expect(lines(scanKeys('<button onClick={f}>\nDetails <MenuCaret />\n</button>'), 'caretNoPopup')).toEqual([1])
    expect(lines(scanKeys('<div>\n<span>Project <MenuCaret /></span>\n</div>'), 'caretNoPopup')).toEqual([2])
    expect(scanKeys('<button aria-haspopup="menu" onClick={f}>Snooze <MenuCaret /></button>').caretNoPopup).toEqual([])
    expect(scanKeys('<Chip aria-haspopup="menu" trailing={<MenuCaret />} onClick={f}>{label}</Chip>').caretNoPopup).toEqual([])
    expect(scanKeys('<button {...buttonProps}>{words} <MenuCaret /></button>').caretNoPopup).toEqual([])

    // A list key that shows words holds the caret; an icon key, a count, a glyph, a row in a menu do not.
    expect(lines(scanKeys('<button aria-haspopup="menu" onClick={f}>What changed</button>'), 'popupNoCaret')).toEqual([1])
    expect(lines(scanKeys('<button aria-haspopup={sub ? "menu" : undefined}>{current || `+ ${field.label}`}</button>'), 'popupNoCaret')).toEqual([1])
    expect(lines(scanKeys('<button aria-haspopup="menu">{ids.length} more</button>'), 'popupNoCaret')).toEqual([1])
    expect(scanKeys('<button aria-haspopup="menu" aria-label="More">{ICON_MORE}</button>').popupNoCaret).toEqual([])
    expect(scanKeys('<button aria-haspopup="menu" aria-label="More">&#8942;</button>').popupNoCaret).toEqual([])
    expect(scanKeys('<button aria-haspopup="menu" aria-label="Notifications"><BellIcon />{count > 0 && <span className="badge">{count}</span>}</button>').popupNoCaret).toEqual([])
    expect(scanKeys('<button aria-haspopup="menu" role="menuitem"><span>More actions</span></button>').popupNoCaret).toEqual([])
    expect(scanKeys('<button aria-haspopup="listbox"><span>{name}</span><DisclosureChevron open={open} /></button>').popupNoCaret).toEqual([])
    // A dialog that is not a choice (a drawer, a card) takes no caret.
    expect(scanKeys('<><button aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Note</button>{open && <NoteDrawer />}</>').popupNoCaret).toEqual([])
    // A spread naming the popup counts as the attribute.
    expect(scanKeys("<button {...(talk ? { 'aria-haspopup': 'dialog' as const } : {})}>Ask</button>").popupNoCaret).toEqual([])
  })

  it('the scan sees the UI it guards', () => {
    expect(FILES.length).toBeGreaterThan(500)
    const src = FILES.map((f) => readFileSync(f, 'utf8')).join('\n')
    expect((src.match(/<MenuCaret\b/g) ?? []).length).toBeGreaterThan(30)
  })

  const findings = FILES.map((f) => ({ file: rel(f), r: scanKeys(readFileSync(f, 'utf8'), f) }))
  const list = (k: keyof KeyFindings, skip: (file: string) => boolean = () => false) =>
    findings.filter(({ file }) => !skip(file)).flatMap(({ file, r }) => r[k].map((x) => `${file}:${x.line}: ${x.what}`))

  it('a MenuCaret sits in a key that carries aria-haspopup', () => {
    expect(list('caretNoPopup', (f) => f in CARET_OUTSIDE_KEY), 'give the key aria-haspopup (menu, listbox or dialog, what it opens) and aria-expanded; a fold takes DisclosureChevron instead').toEqual([])
    for (const file of Object.keys(CARET_OUTSIDE_KEY)) {
      const left = findings.find((x) => x.file === file)?.r.caretNoPopup ?? []
      expect(left.length, `${file} no longer needs its CARET_OUTSIDE_KEY entry`).toBeGreaterThan(0)
      expect(left.every((x) => x.what === 'MenuCaret in no key'), `${file}: its entry covers only a caret outside any key`).toBe(true)
    }
  })

  it('a key that opens a list or a picker and shows words holds MenuCaret', () => {
    expect(list('popupNoCaret'), 'add <MenuCaret /> (components/controls) after its words; a row inside a menu that opens more ends with DisclosureChevron').toEqual([])
  })

  it('a key that opens a picker, menu or popover carries aria-haspopup', () => {
    expect(list('silentOpener'), "add aria-haspopup ('menu', 'listbox' or 'dialog') and aria-expanded; a key with words takes MenuCaret too").toEqual([])
  })
})
