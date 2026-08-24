/**
 * The app's stylesheet, injected once through `walnut.ui.injectCss`.
 *
 * Split only to keep each file readable: page chrome and the reports in
 * styles-base.ts, the timeline shell plus the two vertical views in styles-views.ts,
 * the swimlanes in styles-lanes.ts.
 *
 * ORDER MATTERS: a media query adds no specificity, so the narrow-canvas overrides at
 * the end of styles-views.ts only win because that file is injected last.
 */

import { BASE_CSS } from './styles-base'
import { LANES_CSS } from './styles-lanes'
import { VIEWS_CSS } from './styles-views'

export const TIME_CSS = [BASE_CSS, LANES_CSS, VIEWS_CSS].join('\n')
