/**
 * The verifier's own measurements of the mail right-click slice.
 *
 * Run it TWICE, once per engine, because the engine must come from the PROJECT: Playwright refuses
 * `use({ browserName })` inside a describe ("it forces a new worker"), and a file-level `test.use`
 * does not reach tests a helper module registers (measured: the first attempt ran the WebKit half in
 * Chromium and its own `engine` check caught it).
 *
 *   npx playwright test tests/e2e/browser/mail-context-independent.spec.ts
 *   PW_WEBKIT=1 npx playwright test tests/e2e/browser/mail-context-independent.spec.ts --project=webkit
 */
import { registerIndependentAll } from './mail-context-independent-core'

registerIndependentAll('chromium')
