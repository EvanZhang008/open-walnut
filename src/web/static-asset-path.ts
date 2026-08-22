/**
 * Which GET paths must NEVER fall through to the SPA's index.html.
 *
 * The production server serves index.html for any non-API GET so client-side
 * deep links (`/sessions?id=…`) work on a cold load. Applied to a request for a
 * FILE, that rule lies: a missing `/assets/index-abc123.js` came back as
 * `200 text/html`, and the browser then failed to parse HTML as a module.
 *
 * That is the normal state of every tab that was open across a deploy, because
 * a deploy re-hashes and wipes the assets directory. The failure mode is silent
 * (best-effort `import()` calls have a `catch` that shrugs), so it surfaced as
 * a feature that just stopped working — a .go file rendering with no syntax
 * colors because its CodeMirror grammar chunk no longer existed.
 *
 * Anything matching here gets a real 404 instead, which is both honest and what
 * the client's stale-build recovery needs in order to reload onto the new build.
 */

/** Extensions that only ever name a file on disk, never an SPA route. */
const ASSET_EXT_RE = /\.(?:js|mjs|cjs|css|map|json|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|mp4|webm|txt|xml)$/i

/** True when a not-found GET must answer 404 rather than the SPA shell. */
export function isStaticAssetPath(pathname: string): boolean {
  return pathname.startsWith('/assets/') || ASSET_EXT_RE.test(pathname)
}
