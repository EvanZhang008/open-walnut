/**
 * The lines the CLI put into a conversation itself (a loaded skill's text, a
 * hook's added context, a continuation summary) on the phone's transcript.
 *
 * They are not rows of their own: an older phone draws any user row it does not
 * know as the person's bubble, so a skill's text would read as something the
 * person typed. Each one rides the row just before it instead (`injectedAfter`;
 * `injectedBefore` on the first row when nothing came before it), a field an
 * older phone ignores and a current one draws as one closed row that opens to
 * the text, the way the web chat draws them. Both transcript builders (the
 * primary's projection and the JSONL reader of the companion and a host server)
 * collect them here, so the two answer alike.
 */
import { cliAddedOf, type CliAddedItem } from '../../lib/walnut-added.js'
import { clipTranscriptText, type TranscriptClipBudget } from './transcript-clip.js'

export interface InjectedCarrier {
  /** Lines the CLI put in right after this row, in order. */
  injectedAfter?: CliAddedItem[]
  /** On the first row only: lines the CLI put in before any row of this read. */
  injectedBefore?: CliAddedItem[]
}

export class InjectedLines {
  private readonly before: CliAddedItem[] = []

  /** `clip`: the budget the row texts of this read use; null = whole (a `full` read). */
  constructor(private readonly clip: TranscriptClipBudget | null) {}

  /**
   * Take one CLI-injected user line. `'message'` when it is a Walnut message the
   * CLI delivered as an injected line: the caller draws it as the row it is.
   * Otherwise it is kept (or, the interrupt marker, dropped) and nothing is drawn.
   */
  take(text: string, rows: readonly InjectedCarrier[]): 'message' | 'kept' {
    const item = cliAddedOf(text)
    if (item === 'message') return 'message'
    if (!item) return 'kept'
    const kept = this.clip ? { ...item, text: clipTranscriptText(item.text, this.clip) } : item
    const last = rows[rows.length - 1]
    if (last) (last.injectedAfter ??= []).push(kept)
    else this.before.push(kept)
    return 'kept'
  }

  /** Hand the lines that came before every row to the first row, once the rows are built. */
  finish(rows: readonly InjectedCarrier[]): void {
    const first = rows[0]
    if (first && this.before.length) first.injectedBefore = [...this.before, ...(first.injectedBefore ?? [])]
  }
}
