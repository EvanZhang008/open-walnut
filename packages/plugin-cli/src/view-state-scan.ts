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
