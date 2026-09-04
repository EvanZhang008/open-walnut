/**
 * pickBatchUuid — which pre-assigned user-message uuid a DRAINED BATCH carries.
 *
 * A drain joins every pending row into ONE stream-json user message, so the CLI
 * writes ONE user line and only one uuid can survive. The harness already
 * decided which one: its own enqueue path takes `batch.findLast(c => c.uuid)`,
 * i.e. the LAST uuid in the batch wins. We port that rule verbatim rather than
 * inventing a Walnut-side convention (first-wins, or refusing to batch), because
 * the CLI owns the transcript and any disagreement here shows up as an anchor
 * pointing at a line that doesn't exist.
 *
 * Rows without a uuid are skipped, so a batch that mixes pre-assigned and plain
 * sends still delivers the newest pre-assigned uuid. No rows carry one ⇒
 * `undefined`, and callers must then omit the `uuid` key entirely so the payload
 * is byte-identical to the pre-feature envelope.
 */
export function pickBatchUuid(rows: ReadonlyArray<{ userUuid?: string }>): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const uuid = rows[i]?.userUuid;
    if (uuid) return uuid;
  }
  return undefined;
}
