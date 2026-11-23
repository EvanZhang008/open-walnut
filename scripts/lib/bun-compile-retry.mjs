/**
 * Bun.build with `compile` fetches the runtime of its target on first use, the only network
 * step of a build. 2026-11-23 (Nightly extra tests run 45131663248): "Failed to download
 * 'bun-linux-x64-v1.4.4': DNSResolveFailed" on a GitHub runner ended the build. A build that
 * failed only on that download runs again; any other failure is returned at once. The shell
 * twin is scripts/lib/bun-compile.sh (tests/scripts/bun-compile-retry.test.ts).
 */
export const RUNTIME_DOWNLOAD_FAILED = /Failed to download 'bun-[^']*'/

/** Runs `build` (a Bun.build call with throw: false) up to `tries` times while it fails on the runtime download. */
export async function buildWithRuntimeRetry(build, { tries = 3, delayMs = 10_000, log = (line) => console.error(line) } = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await build()
    if (result.success) return result
    const text = (result.logs ?? []).map(String).join('\n')
    if (attempt >= tries || !RUNTIME_DOWNLOAD_FAILED.test(text)) return result
    log(`bun compile: try ${attempt} of ${tries} could not download the bun runtime; trying again`)
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
  }
}
