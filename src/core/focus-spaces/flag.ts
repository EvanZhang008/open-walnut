/**
 * The focus_workspace experiment as every server reader asks it: one cache, so the route, the
 * plugin API, the hint, the quick bar and the lifecycle agree on the switch.
 */
import { experimentCache } from '../experimental-cache.js'

export const focusSpacesFlag = experimentCache('focus_workspace')
