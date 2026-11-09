/**
 * The input an extension understands only from the build that brought it (its cap `input-v2`,
 * packages/browser-extension/src/agent.ts): an older extension does something else with such a
 * command and says it went fine (review 2026-11-09: `dialog {read}` accepted the dialog,
 * `type {x, y}` typed into whatever had the focus, `scroll {ref, direction}` only brought the
 * element into view). So the act route refuses one before it is sent to a browser without the cap.
 */
export const INPUT_V2 = 'input-v2'

/** What in this command an older extension does not understand, in words for the agent, or null. */
export function needsInputV2(action: string, args: Record<string, unknown>): string | null {
  const point = typeof args.x === 'number' && typeof args.y === 'number'
  const moves = args.direction !== undefined || args.to !== undefined || args.by !== undefined || args.amount !== undefined
  if (action === 'drag') return 'drag'
  if (action === 'zoom') return 'zoom'
  if (typeof args.label === 'number') return 'a label from an annotated screenshot (click_label)'
  if ((action === 'click' || action === 'hover') && typeof args.text === 'string' && args.text && args.ref === undefined && !point) return `${action} by its words (text)`
  if (action === 'type' && point && args.ref === undefined) return 'typing at a point (type with x and y)'
  if (action === 'dialog' && args.read === true) return 'reading a dialog (dialog with read)'
  if (args.all_frames === true) return 'all_frames'
  if (args.slowly === true) return 'slowly'
  if (args.annotate === true) return 'annotate'
  if (action === 'scroll' && (point || args.trusted === true || (args.ref !== undefined && moves))) return 'scrolling inside a box or with the wheel'
  return null
}

export function outdatedWords(what: string, browser: string): string {
  return `The Walnut extension in ${browser} is older than ${what}, so it would not do what you asked: ask the person to update it `
    + '(in Walnut: Settings, Browser extension), then try again. Until then, do the step without it.'
}
