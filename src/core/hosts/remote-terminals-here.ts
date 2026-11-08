/**
 * Whether this server opens terminals on remote hosts. The Walnut Demo does not
 * (src/web/terminal/spawn.ts refuses one: its reset must confirm every process stopped),
 * so on a Demo whatever keeps a remote terminal alive (dtach, a C compiler to build it)
 * is no problem to show or fix there (2026-11-10 review: a new Demo user's host details
 * read "No C compiler on demo-devbox ... Could not install gcc automatically (isolated)").
 */
import { IS_DEMO } from '../../constants.js'

export const REMOTE_TERMINALS_HERE = !IS_DEMO
