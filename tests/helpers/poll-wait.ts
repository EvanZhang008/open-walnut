/** Poll `cond` every 25 ms until it holds; throws `timed out waiting for <label>` after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}
