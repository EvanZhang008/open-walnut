/**
 * Finds a view choice kept only in component state: the guard behind "Walnut remembers what was
 * open" (2026-11-02, the user: "it keep lost my state like the open state of the session, like
 * full screen, file ... make it default feature in walnut no matter where include plugin").
 *
 * The class: a `useState` whose name says it holds what the user picked to see (a tab, a
 * filter, a mode, a section, a pane shown or hidden, the item open or selected), started from a
 * literal (read from no storage, no URL, no prop), so it comes back reset when the component
 * mounts again. Walnut's own code keeps such a choice with usePageView (web/src/utils/
 * view-memory.ts) or lists it as a passing thing (tests/web/view-memory-guard.test.ts); a
 * plugin keeps it with `walnut.ui.useView`, and `walnut-plugin validate` warns on one kept in
 * `useState`. One matcher for both, so a plugin is held to the same rule as Walnut.
 */

/** Names that hold a view choice. */
export const VIEW_NAME = /^(?:\w*(?:Tab|Filter|View|Sort|Section|Scope|Mode|Group|Pick|Collapsed|Expanded|Hidden|Shown|Open|Target|Fullscreen|FullScreen|Maximized|Pane|Panel|Split|Page|Step)|tab|filter|view|sort|section|scope|mode|group|collapsed|expanded|hidden|fullscreen|maximized|pane|panel|split|page|step|show[A-Z]\w*|active[A-Z]\w*|selected\w*|open[A-Z]\w*)$/

/**
 * Names of a passing thing by its kind, whatever component holds it: a menu, picker, popover
 * or dialog open now (it closes on its own and opening it again starts it fresh), the keyboard
 * cursor in such a list, and a drag or a right-click in progress.
 */
export const PASSING_KIND = /^(?:\w*(?:Menu|menu|Picker|picker|Popup|popup|Popover|popover|Dropdown|dropdown|Flyout|flyout|Tip|tip|Palette|palette|Dialog|dialog|Confirm|confirm|Modal|modal|Overlay|overlay)Open|(?:menu|kebab|mention|plus|palette|tip|dropdown|popup|picker)Open|selected(?:Idx|Index)|\w*Drag\w*|ctxTarget|dropTarget)$/

/** A start that comes from nowhere: a literal, a constant, an empty collection (or a function returning one). */
export const LITERAL = /^(?:\(\)\s*=>\s*)?(?:'[^']*'|"[^"]*"|-?\d+|true|false|null|undefined|\[\]|\{\}|new (?:Set|Map)(?:<[^>]*>)?\(\)|[A-Z][A-Z0-9_]+)?$/

const DECL = /const\s*\[\s*(\w+)\s*,\s*\w+\s*,?\s*\]\s*=\s*(?:React\.)?useState\b\s*/g

export interface StateDecl { name: string; start: string; line: number }

/** Every `const [name, setName] = useState<T>(start)` in a source: its name, start and line, generics and line breaks skipped. */
export function useStates(src: string): StateDecl[] {
  const out: StateDecl[] = []
  for (const m of src.matchAll(DECL)) {
    let i = m.index! + m[0].length
    if (src[i] === '<') {
      // A generic, nested ones too (Record<string, Set<string>>); `=>` inside it is not a close.
      for (let depth = 0; i < src.length; i++) {
        if (src[i] === '<') depth++
        else if (src[i] === '>' && src[i - 1] !== '=' && --depth === 0) { i++; break }
      }
    }
    while (/\s/.test(src[i] ?? '')) i++
    if (src[i] !== '(') continue
    let j = i
    for (let depth = 0; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) break
    }
    const start = src.slice(i + 1, j).trim().replace(/,$/, '').trim().replace(/\s+as\s+[\w.<>[\]| '"]+$/, '').trim()
    out.push({ name: m[1], start, line: src.slice(0, m.index!).split('\n').length })
  }
  return out
}

/** The view choices a source keeps only in component state (passing kinds left out). */
export function viewStatesInMemory(src: string): StateDecl[] {
  return useStates(src).filter((d) => VIEW_NAME.test(d.name) && LITERAL.test(d.start) && !PASSING_KIND.test(d.name))
}

/**
 * Text the user is typing (a draft) has its own home: `walnut.ui.useDraft(name, { id })`, Walnut's
 * draft store, one key per draft, never in the synced settings. Kept in `useState` it is lost on a
 * reload; kept in `useView` it rides ui-prefs (a write into the synced config as the user types)
 * under one key per name, so the last writer of any item wins on every device and the oldest of
 * many items are dropped; kept in the plugin's own localStorage keys it is outside what Walnut
 * keeps across cleared browser data. 2026-11-02, found by a practice plugin moving onto useView.
 */
export const DRAFT_NAME = /draft/i

export type DraftHome = 'useState' | 'useView' | 'localStorage'
export interface DraftDecl { name: string; line: number; home: DraftHome }

/** A string start: what typed text begins as. */
const STRING_START = /^(?:\(\)\s*=>\s*)?(?:'[^']*'|"[^"]*"|`[^`$]*`)$/
const USE_VIEW_CALL = /\buseView\b/g
const STORAGE_SET = /\blocalStorage\s*\.\s*setItem\s*\(\s*([`'"])([^`'"]*)/g

/** The argument text of the first call after `from` (its `(` within a generic's reach), or null. */
function argsAfter(src: string, from: number): string | null {
  let open = from
  for (let depth = 0; open < src.length && open - from < 200; open++) {
    const c = src[open]
    if (c === '<') depth++
    else if (c === '>' && src[open - 1] !== '=') depth--
    else if (c === '(' && depth === 0) break
    else if (depth === 0 && !/[\s]/.test(c)) return null
  }
  if (src[open] !== '(') return null
  let j = open
  for (let depth = 0; j < src.length; j++) {
    if (src[j] === '(') depth++
    else if (src[j] === ')' && --depth === 0) break
  }
  return src.slice(open + 1, j)
}

const lineAt = (src: string, i: number) => src.slice(0, i).split('\n').length
/** Whether `i` sits in a `//` comment on its line. */
const inLineComment = (src: string, i: number) => /\/\//.test(src.slice(src.lastIndexOf('\n', i) + 1, i))

/** Every draft a source keeps anywhere but `walnut.ui.useDraft`. */
export function draftsOffDevice(src: string): DraftDecl[] {
  const out: DraftDecl[] = []
  for (const d of useStates(src)) {
    if (DRAFT_NAME.test(d.name) && STRING_START.test(d.start)) out.push({ name: d.name, line: d.line, home: 'useState' })
  }
  for (const m of src.matchAll(USE_VIEW_CALL)) {
    const args = argsAfter(src, m.index! + m[0].length)
    const name = args === null ? undefined : /^\s*([`'"])([^`'"]*)\1/.exec(args)?.[2]
    if (name && DRAFT_NAME.test(name) && !inLineComment(src, m.index!)) out.push({ name, line: lineAt(src, m.index!), home: 'useView' })
  }
  for (const m of src.matchAll(STORAGE_SET)) {
    if (DRAFT_NAME.test(m[2]) && !inLineComment(src, m.index!)) out.push({ name: m[2], line: lineAt(src, m.index!), home: 'localStorage' })
  }
  return out.sort((a, b) => a.line - b.line)
}
