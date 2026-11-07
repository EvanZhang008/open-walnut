/**
 * A narrow session column keeps its header readable, in Chromium. The scenarios and
 * why they are what they are: session-header-narrow-helpers.ts. The same scenarios run
 * in WebKit, the Mac app's engine, in session-header-narrow.webkit.spec.ts.
 */
import { headerNarrowTests } from './session-header-narrow-helpers'

headerNarrowTests()
