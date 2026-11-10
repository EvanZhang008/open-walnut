/**
 * A GET to a service outside the rehearsal (GitHub's release downloads, npm's registry),
 * tried again past a passing failure: a dropped connection, a timeout, 429 or a 5xx. The
 * release scripts that download use it too (scripts/runtime-bundle/build.mjs,
 * scripts/components-release-ready.mjs; 2026-11-10, CI run 42831643140: the archive build's own
 * three tries spanned 16 s, all "fetch failed", and failed the required Archive job).
 * 2026-11-05: GitHub answered 504 for a release's SHA256SUMS and the field rehearsal's
 * archive scenario failed; its three tries spanned 15 seconds. Every outside GET of the
 * rehearsals goes through here (ratchet: tests/scripts/release-rehearsal-outside-fetch.test.ts).
 * Any other answer (200, 404, another 4xx) is returned at once for the caller to judge.
 */

/** The waits before each new attempt, in ms: about three and a half minutes in all. */
export const OUTSIDE_WAITS_MS = [10_000, 30_000, 60_000, 120_000]

const passing = (status) => status === 429 || status >= 500

/**
 * `fetch(url, init)` with a fresh `timeoutMs` deadline per attempt. Resolves the last
 * Response; rejects with the last error when every attempt failed to get one. With `read`, a
 * 2xx answer's body is read inside the attempt (its value is returned), so a download cut off
 * partway is fetched again.
 */
export async function outsideFetch(url, init = {}, {
  timeoutMs = 120_000,
  waits = OUTSIDE_WAITS_MS,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => process.stderr.write(`${line}\n`),
  read,
} = {}) {
  for (let i = 0; ; i++) {
    let res, err
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (read && res.ok) return await read(res)
    } catch (e) {
      res = undefined
      err = e
    }
    if (res && !passing(res.status)) return res
    if (i >= waits.length) {
      if (res) return res
      throw err
    }
    log(`GET ${url} ${res ? `answered HTTP ${res.status}` : `failed (${err?.message ?? err})`}; trying again in ${waits[i] / 1000}s`)
    await sleep(waits[i])
  }
}
