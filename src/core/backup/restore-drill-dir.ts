/**
 * The name of a restore drill's folder (restore-drill.ts): `walnut-restore-drill-XXXXXX` under
 * the OS temp dir, the restored copy in its `home/`. Its own module with no imports, because the
 * trial start (src/core/trial-start/ticket.ts) checks a home against it at boot, before anything
 * else of the backup code may load.
 */
export const DRILL_DIR_PREFIX = 'walnut-restore-drill-';
export const DRILL_DIR_RE = /^walnut-restore-drill-[A-Za-z0-9]{6}$/;
/** The restored copy inside the drill's folder. */
export const DRILL_HOME_NAME = 'home';
